/**
 * src/session-api/worktree-rebind.ts
 *
 * ADR-0037 — the session-api host seam of the worktree isolation pipeline:
 * create a per-conversation task worktree (via the harness git layer) and
 * rebind the CURRENT session's workspaceRoot to it, so the next turn's
 * per-root engine cache resolves an engine rooted at the task worktree.
 *
 * Module boundary:
 *   - owns ONLY the host-side rebind: per-conversation naming, the session
 *     file update, and the bound-root registry. No LLM/session-runtime
 *     imports; the git worktree creation is delegated to
 *     `harness/isolation/worktree-gate.ts` (single git-layer SSOT).
 *
 * Deterministic naming (ADR-0037):
 *   - worktree path `<repoRoot>/.iknow/worktrees/<label>--<conversationId>` or
 *     the historical `<conversationId>` leaf (`.iknow` is the per-root state
 *     anchor and gitignored, so the nested checkout never pollutes the main
 *     repo's status);
 *   - branch `iknow/task/<label>-<uuid8>` when labeled, otherwise
 *     `iknow/task-<conversationId>`.
 *   The naming makes ownership unambiguous, but a pre-existing branch /
 *   worktree path is still fail-closed (`branch_exists` / `worktree_exists`
 *   from the git layer) — no silent overwrite, no reuse of unknown trees,
 *   no checkout of other sessions' HEADs.
 *
 * Failure semantics: every failure exits typed (`WorktreeIsolationError`)
 * and the session file is left untouched — the rebind happens only after
 * the tree was created successfully.
 *
 * Passthrough: a mutate arriving while the session is already on its own
 * task worktree (deterministic naming, restart-safe) is a zero-side-effect
 * no-op; a root belonging to another conversation or an unrelated linked
 * worktree fails closed with `foreign_worktree`.
 */
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";

import {
  createTaskWorktree,
  isTaskWorktreePath,
  mainCheckoutOf,
  resolveTaskWorktreeLabel,
  taskWorktreeOwnerOf,
  taskWorktreePath,
  taskWorktreeBranch,
  taskWorktreeLabelOf,
  WorktreeIsolationError,
  defaultGitRunner,
  SAFE_CONVERSATION_ID_RE,
  SAFE_WORKTREE_SLUG_RE,
} from "../harness/isolation/worktree-gate.js";
import type {
  GitRunner,
  GitResult,
  TaskWorktreeInfo,
  WorktreeListContext,
  WorktreeRemoval,
  WorktreeRemoveContext,
  WorktreeProvisionContext,
  WorktreeEnterContext,
  WorktreeEnterResult,
  WorktreeExitContext,
} from "../harness/isolation/worktree-gate.js";
import { errorMessage } from "../harness/errors.js";
import {
  createProjectDepProvisioner,
  type ProjectDepProvisionResult,
  type ProjectDepProvisioner,
} from "./worktree-deps.js";
import type { SessionFileV1, SessionListEntry } from "./store/index.js";

/** Minimal store surface the provisioner needs (SessionStore satisfies it). */
export interface WorktreeRebindStore {
  load(conversationId: string): Promise<SessionFileV1>;
  save(opts: { id: string; file: SessionFileV1 }): Promise<void>;
}

export interface TaskWorktreeProvisionerOpts {
  /**
   * Optional legacy persistence hook for callers outside SessionHub.
   * SessionHub deliberately omits it and persists the returned root through
   * its dirty-root conditional-save protocol.
   */
  readonly store?: WorktreeRebindStore;
  readonly runGit?: GitRunner;
  readonly now?: () => string;
  /**
   * Stable project identity root used by `.iknow/worktreeinclude`.
   * When omitted, the main checkout derived from the request root is used.
   */
  readonly projectIdentityRoot?: string;
  /**
   * ADR-0070 — enter-worktree exclusive-claim (occupancy lock) switch.
   * Boolean-only; missing or non-`true` is OFF (fail-closed, same value
   * discipline as `worktreeOnMutate`). When OFF, `enter()` behaves exactly
   * as before: same checks, no new rejection path.
   *
   * Read exactly once at assembly time: absence is equivalent to the
   * `isolation.worktreeExclusive` setting being absent → OFF; later
   * `enter()` calls reuse this frozen closure value and never re-evaluate
   * per entry (ADR-0037).
   */
  readonly worktreeExclusive?: boolean;
  /**
   * ADR-0070 — session enumerator for the occupancy check. Required when
   * `worktreeExclusive === true`; returns the same shape as
   * `SessionStore.list()` (an absent `workspaceRoot` means the session
   * claims no worktree → passes as unclaimed).
   *
   * I/O failure: a non-ENOENT throw becomes typed `rebind_failed`
   * (host-side rerun_after_change). Never silently passed — that would
   * auto-release the lock exactly when an admin needs it most.
   *
   * Weak-mode disclosure: the check only scans this process's single dataDir
   * project namespace (`SessionStore` is single-process, single cwd);
   * claims held by other processes or CLI instances are invisible. This is
   * decided semantics, not a bug — disclosed in the settings doc, the
   * receipt text, and the spec.
   */
  readonly listSessions?: () => Promise<ReadonlyArray<SessionListEntry>>;
  /**
   * Project dependency install seam. Default =
   * `createProjectDepProvisioner()` (lockfile-driven, fail-open, async).
   * Tests inject a scripted provisioner so no case shells out to a real
   * installer.
   *
   * The install runs on TWO paths, both fail-open:
   *   - `provision` right after the tree exists (beside the worktreeinclude
   *     mirror) — the create-worktree tool result then carries the outcome;
   *   - `enter` as an idempotent ensure — a tree provisioned by another
   *     session (or before this feature) gets the same treatment; the
   *     resolved-marker skip keeps a second enter a no-op.
   */
  readonly projectDepProvisioner?: ProjectDepProvisioner;
}

export interface TaskWorktreeProvisioner {
  /**
   * Create (or no-op-return) the conversation's task worktree and rebind the
   * session root. Resolves with the worktree path. Idempotent per
   * conversation: once provisioned, subsequent calls return the same root
   * without running `git worktree add` again (same-process concurrency latch
   * lives in the harness gate; this covers engine rebuilds).
   *
   * Passthrough: when `ctx.root` IS this conversation's own task
   * worktree (deterministic naming, restart-safe), `provision` is a no-op
   * that returns the same root — zero git calls, zero rebind writes. When
   * `ctx.root` is another conversation's task worktree or an unrelated
   * linked worktree, it rejects with a typed `foreign_worktree`
   * (fail-closed; ADR-0037 defines only the main repo and the own task tree).
   *
   * Adoption anchor: `anchor.sessionWorkspaceRoot` (the caller's PERSISTED
   * workspaceRoot, loaded by the hub) equal to `ctx.root` on a
   * task-worktree-shaped root admits the mutate even when the tree belongs
   * to ANOTHER conversation — that durable record is written only by an
   * explicit enter/create tool success, so it is the restart-safe explicit
   * opt-in. Non-shaped roots (manual worktrees) are never adopted.
   */
  provision(
    ctx: WorktreeProvisionContext,
    anchor?: WorktreeProvisionAnchor
  ): Promise<string>;
  /**
   * Explicit enter: move a session anchored at the MAIN repo onto an
   * EXISTING task worktree of THIS repository (listing/path SSOT, selector =
   * `targetConversationId`). Creates no tree and touches no foreign
   * HEAD — the only effect is the caller's own rebind (store-mode persists
   * workspaceRoot; hub-mode returns the root for the dirty-root
   * conditional-save protocol). Idempotent per conversation.
   *
   * Fail-closed: missing target → `worktree_not_found`; target that is not a
   * linked checkout or belongs to another repository → `foreign_worktree`;
   * caller already inside a worktree → `foreign_worktree` (exit first);
   * unsafe ids → `rebind_failed` before any fs/git access.
   */
  enter(req: WorktreeEnterRequest): Promise<WorktreeEnterResult>;
  /**
   * Symmetric exit: return the conversation to its MAIN repo root. No
   * tree is deleted (orphan cleanup is an explicit plan non-goal) and no
   * foreign HEAD is touched — the only effect is the caller's own rebind
   * back (store-mode persists workspaceRoot; hub-mode returns the root for
   * the dirty-root conditional-save protocol).
   *
   * The main repo root is derived from the tree itself
   * (`git rev-parse --path-format=absolute --git-common-dir` of the tree,
   * then up one level) — restart-safe, no recorded state. Rebound detection:
   * in-process bound entry, the durable workspaceRoot anchor
   * (`sessionWorkspaceRoot`), or a task-worktree-shaped current root;
   * anything else fails closed with typed `rebind_failed`.
   */
  exit(req: WorktreeExitRequest): Promise<string>;
  /** List active task worktrees, optionally including orphaned task branches. */
  list(ctx: WorktreeListContext): Promise<ReadonlyArray<TaskWorktreeInfo>>;
  /** Remove a clean, safe task worktree and optionally its task branch. */
  remove(ctx: WorktreeRemoveContext): Promise<WorktreeRemoval>;
  /**
   * True when `root` is a task worktree this provisioner created (or
   * recognized as a conversation's own tree — passthrough registration).
   * Ownership-AGNOSTIC introspection: it does NOT answer "is this root
   * conversation X's own tree" — the per-conversation passthrough anchor is
   * `provision` itself, never this predicate.
   */
  isTaskWorktreeRoot(root: string): boolean;
}

/**
 * Adoption input: the caller's persisted workspace root (loaded from the
 * session file by the hub before invoking `provision`). Undefined / absent
 * = no durable record → the fail-closed passthrough contract stands
 * unchanged.
 */
export interface WorktreeProvisionAnchor {
  readonly sessionWorkspaceRoot?: string;
}

/**
 * Enter request — the harness `WorktreeEnterContext` SSOT (no local copy).
 */
export type WorktreeEnterRequest = WorktreeEnterContext;

/**
 * Exit request: the harness `WorktreeExitContext` SSOT (engine root is
 * `root`) plus the durable rebind anchor.
 */
export interface WorktreeExitRequest extends WorktreeExitContext {
  /**
   * The caller's persisted workspaceRoot (loaded by the hub) — the durable
   * rebind record that identifies a rebound session across restarts.
   */
  readonly sessionWorkspaceRoot?: string;
}

/**
 * Ownership anchor: decompose a root against the deterministic naming.
 * The implementation is kept in the harness isolation module so the gate,
 * provisioner, and read-only display consumers cannot disagree.
 *
 * Single SSOT lives in `harness/isolation/worktree-gate.ts` (the mutate gate
 * routes on the same predicate); re-exported here for the provisioner and
 * read-only display consumers (TUI environment pane): "workspaceRoot looks
 * like a task worktree" is the display condition, NOT "workspaceRoot is any
 * non-empty string" — serve's `bindWorkspace` legitimately persists the MAIN
 * root as workspaceRoot, and that must never render as a worktree binding.
 */
export {
  isTaskWorktreePath,
  mainCheckoutOf,
  resolveTaskWorktreeLabel,
  taskWorktreeBranch,
  taskWorktreeLabelOf,
  taskWorktreeOwnerOf,
  taskWorktreePath,
};

/**
 * The conversationId is concatenated verbatim into the worktree path
 * (`<repoRoot>/.iknow/worktrees/<id>`) and the branch name
 * (`iknow/task-<id>`). The store layer has no id-shape contract (ids are
 * host-generated UUIDs joined into file paths as-is), so the provisioner owns
 * the segment-safety gate: fail closed on anything that is not a single safe
 * path/branch segment, BEFORE any git call or store write.
 *
 * Contract: first char alphanumeric; remainder alphanumeric / `_` / `-`.
 * This rejects path traversal (`..`, `a/b`), leading dashes/dots (option or
 * glob ambiguity in `git worktree add -b`), whitespace / shell metacharacters,
 * and empty strings. The regex SSOT lives in
 * `harness/isolation/worktree-gate.ts` (the enter-worktree tool validates its
 * model-supplied id against the same contract); re-exported here for existing
 * importers.
 */
export { SAFE_CONVERSATION_ID_RE };

/** True when `root` is a LINKED git worktree checkout (`.git` is a file, not a dir). */
function isLinkedWorktreeRoot(root: string): boolean {
  const dotGit = join(root, ".git");
  if (!existsSync(dotGit)) return false;
  try {
    return statSync(dotGit).isFile();
  } catch {
    return false;
  }
}

interface WorktreePorcelainRecord {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
}

function parseWorktreePorcelain(raw: string): WorktreePorcelainRecord[] {
  const records: WorktreePorcelainRecord[] = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  const flush = (): void => {
    if (current.path !== undefined) {
      records.push({
        path: current.path,
        ...(current.head !== undefined ? { head: current.head } : {}),
        ...(current.branch !== undefined ? { branch: current.branch } : {}),
      });
    }
    current = {};
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) {
      flush();
    } else if (line.startsWith("worktree ")) {
      if (current.path !== undefined) flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
    }
  }
  flush();
  return records;
}

function splitGitLines(raw: string): string[] {
  return raw.split(/\r?\n/).filter((line) => line.length > 0);
}

function splitGitNul(raw: string): string[] {
  return raw.split("\0").filter((line) => line.length > 0);
}

interface ParsedTaskBranch {
  readonly label: string | undefined;
  readonly conversationId: string;
}

function parseTaskBranch(branch: string): ParsedTaskBranch | undefined {
  const legacyPrefix = "iknow/task-";
  if (branch.startsWith(legacyPrefix)) {
    const conversationId = branch.slice(legacyPrefix.length);
    return conversationId.length > 0
      ? { label: undefined, conversationId }
      : undefined;
  }

  const labeledPrefix = "iknow/task/";
  if (!branch.startsWith(labeledPrefix)) return undefined;
  const body = branch.slice(labeledPrefix.length);
  const separator = body.lastIndexOf("-");
  if (separator <= 0) return undefined;
  const label = body.slice(0, separator);
  const conversationId = body.slice(separator + 1);
  if (
    !SAFE_WORKTREE_SLUG_RE.test(label) ||
    conversationId.length < 1 ||
    conversationId.length > 8 ||
    !SAFE_CONVERSATION_ID_RE.test(conversationId)
  ) {
    return undefined;
  }
  // A labeled branch stores only the id prefix by design. It is still useful
  // in the stale report, while active trees recover the complete id from the
  // path leaf.
  return { label, conversationId };
}

function selectTaskWorktree(
  entries: ReadonlyArray<TaskWorktreeInfo>,
  selector: string
): TaskWorktreeInfo | undefined {
  const active = entries.filter((entry) => entry.path.length > 0);
  const byConversation = active.filter(
    (entry) => entry.conversationId === selector
  );
  if (byConversation.length === 1) return byConversation[0];
  if (byConversation.length > 1) {
    throw new WorktreeIsolationError(
      "ambiguous_worktree",
      `worktree isolation: conversation selector '${selector}' matches multiple task worktrees: ${byConversation
        .map((entry) => entry.conversationId)
        .join(", ")}`
    );
  }

  const byLabel = active.filter((entry) => entry.label === selector);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) {
    throw new WorktreeIsolationError(
      "ambiguous_worktree",
      `worktree isolation: label '${selector}' is ambiguous; matching conversation ids: ${byLabel
        .map((entry) => entry.conversationId)
        .join(", ")}`
    );
  }
  return undefined;
}

async function runGitForLifecycle(
  runGit: GitRunner,
  args: readonly string[],
  cwd: string,
  failureKind:
    | "worktree_list_failed"
    | "worktree_status_failed"
    | "worktree_remove_failed"
    | "branch_delete_failed",
  action: string
): Promise<GitResult> {
  let result: GitResult;
  try {
    result = await runGit(args, cwd);
  } catch (err) {
    throw gitUnavailable(action, err);
  }
  if (result.code !== 0) {
    throw new WorktreeIsolationError(
      failureKind,
      `worktree isolation: ${action}: ${
        result.stderr.trim().length > 0
          ? result.stderr.trim()
          : `git exited with code ${result.code}`
      }`
    );
  }
  return result;
}

function gitUnavailable(action: string, err: unknown): WorktreeIsolationError {
  return new WorktreeIsolationError(
    "git_unavailable",
    `worktree isolation: ${action}: git is not available (spawn failed): ${errorMessage(err)}`
  );
}

async function readWorktreeDirty(
  runGit: GitRunner,
  worktreePath: string
): Promise<boolean> {
  const result = await runGitForLifecycle(
    runGit,
    ["status", "--porcelain", "--untracked-files=all"],
    worktreePath,
    "worktree_status_failed",
    `cannot inspect task worktree ${worktreePath}`
  );
  return result.stdout.trim().length > 0;
}

async function exclusiveUnpushedCommitCount(
  runGit: GitRunner,
  repoRoot: string,
  branch: string
): Promise<number> {
  if (branch.length === 0) return 0;
  const mainHead = await runGitForLifecycle(
    runGit,
    ["rev-parse", "HEAD"],
    repoRoot,
    "worktree_status_failed",
    "cannot inspect the main checkout HEAD"
  );
  const unique = await runGitForLifecycle(
    runGit,
    ["rev-list", "--count", `${mainHead.stdout.trim()}..${branch}`],
    repoRoot,
    "worktree_status_failed",
    `cannot inspect exclusive commits on ${branch}`
  );
  const uniqueCount = parseGitCount(unique.stdout, branch);
  if (uniqueCount === 0) return 0;

  let upstream: GitResult;
  try {
    upstream = await runGit(
      [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        `${branch}@{upstream}`,
      ],
      repoRoot
    );
  } catch (err) {
    throw gitUnavailable(`cannot inspect upstream for ${branch}`, err);
  }
  if (upstream.code !== 0 || upstream.stdout.trim().length === 0) {
    // EXIT: no configured upstream means every commit unique to this branch
    // remains unconfirmed as pushed.
    return uniqueCount;
  }

  let ahead: GitResult;
  try {
    ahead = await runGit(
      ["rev-list", "--count", `${upstream.stdout.trim()}..${branch}`],
      repoRoot
    );
  } catch (err) {
    throw gitUnavailable(`cannot inspect upstream commits for ${branch}`, err);
  }
  if (ahead.code !== 0) {
    // EXIT: an unreadable upstream comparison is conservatively treated as
    // unpublished rather than allowing removal.
    return uniqueCount;
  }
  return parseGitCount(ahead.stdout, branch);
}

function parseGitCount(raw: string, branch: string): number {
  const normalized = raw.trim();
  const value = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(value) || value < 0) {
    throw new WorktreeIsolationError(
      "worktree_status_failed",
      `worktree isolation: git returned an invalid commit count for ${branch}`
    );
  }
  return value;
}

interface CopyWorktreeIncludeOpts {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly projectIdentityRoot: string;
  readonly runGit: GitRunner;
}

/**
 * Best-effort mirror for ignored local configuration selected by the identity
 * root's `.iknow/worktreeinclude`. The candidate set comes from Git's own
 * ignore engine first, then the include file acts as an allowlist. This keeps
 * tracked files and ordinary untracked files out of the new checkout.
 */
async function copyWorktreeInclude(
  opts: CopyWorktreeIncludeOpts
): Promise<void> {
  const includePath = join(
    opts.projectIdentityRoot,
    ".iknow",
    "worktreeinclude"
  );
  let includeText: string;
  try {
    includeText = await readFile(includePath, "utf8");
  } catch {
    return;
  }
  const patterns = parseIncludePatterns(includeText);
  if (patterns.length === 0) return;

  let ignored: GitResult;
  try {
    ignored = await opts.runGit(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      opts.repoRoot
    );
  } catch {
    return;
  }
  if (ignored.code !== 0) return;

  for (const repoRelative of splitGitNul(ignored.stdout)) {
    const source = resolve(opts.repoRoot, repoRelative);
    const identityRelative = relative(
      resolve(opts.projectIdentityRoot),
      source
    );
    if (
      identityRelative === "" ||
      identityRelative.startsWith("..") ||
      resolve(opts.projectIdentityRoot, identityRelative) !== source ||
      !matchesInclude(identityRelative, patterns)
    ) {
      continue;
    }

    let sourceInfo: Awaited<ReturnType<typeof lstat>>;
    try {
      sourceInfo = await lstat(source);
    } catch {
      continue;
    }
    if (!sourceInfo.isFile()) continue;

    const destinationRelative = relative(resolve(opts.repoRoot), source);
    const destination = resolve(opts.worktreePath, destinationRelative);
    if (
      destinationRelative === "" ||
      destinationRelative.startsWith("..") ||
      resolve(opts.worktreePath, destinationRelative) !== destination
    ) {
      continue;
    }
    try {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } catch {
      // Include mirrors are optional. A permission race or a disappearing
      // ignored file must not turn a successfully-created worktree into a
      // failed provision.
    }
  }
}

interface IncludePattern {
  readonly pattern: string;
  readonly negated: boolean;
}

function parseIncludePatterns(text: string): IncludePattern[] {
  const patterns: IncludePattern[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = (negated ? line.slice(1) : line).replace(/^\\#/, "#");
    if (pattern.length > 0) {
      patterns.push({ pattern, negated });
    }
  }
  return patterns;
}

function matchesInclude(
  candidate: string,
  patterns: ReadonlyArray<IncludePattern>
): boolean {
  const normalized = candidate.split("\\").join("/");
  let included = false;
  for (const entry of patterns) {
    if (matchesGitignorePattern(normalized, entry.pattern)) {
      included = !entry.negated;
    }
  }
  return included;
}

function matchesGitignorePattern(candidate: string, source: string): boolean {
  let pattern = source.replace(/\\/g, "/");
  const directoryPattern = pattern.endsWith("/");
  pattern = pattern.replace(/\/+$/, "");
  // A leading `/` anchors the pattern to the include root (gitignore
  // semantics): the candidate must match from its first path segment.
  // Stripping it instead would degrade `/.env` to "any `.env` segment",
  // pulling nested files into the mirrored tree.
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  if (pattern.length === 0) return false;
  const regex = globPatternRegex(pattern, directoryPattern, anchored);
  if (!pattern.includes("/") && !anchored) {
    return candidate.split("/").some((segment) => regex.test(segment));
  }
  return regex.test(candidate);
}

function globPatternRegex(
  pattern: string,
  directoryPattern: boolean,
  anchored: boolean
): RegExp {
  let body = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i += 1;
        if (pattern[i + 1] === "/") {
          body += "(?:.*/)?";
          i += 1;
        } else {
          body += ".*";
        }
      } else {
        body += "[^/]*";
      }
    } else if (ch === "?") {
      body += "[^/]";
    } else {
      body += escapeRegExpChar(ch);
    }
  }
  const suffix = directoryPattern ? "(?:/.*)?" : "";
  // Anchored patterns match from the include root; unanchored ones keep the
  // historical any-segment / any-depth semantics via the `(?:.*/)?` prefix.
  const prefix = anchored ? "" : "(?:.*/)?";
  return new RegExp(`^${prefix}${body}${suffix}$`);
}

function escapeRegExpChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Compose the enter success receipt. The tree's owner sidecar (via
 * `taskWorktreeOwnerOf`) discloses WHO created the tree being entered —
 * disclosure, never authorization. The read is a single best-effort fs
 * access: `taskWorktreeOwnerOf` already degrades missing / empty /
 * unreadable sidecars to `undefined` (typed catch: an absent owner record
 * is a legal legacy state, not an I/O fault), so the ownership sentence is
 * simply omitted — no throw, no placeholder.
 *
 * Constant-on: this path reads no setting — the exclusive-lock gate is a
 * separate concern and must not gate this.
 */
function enterResultOf(
  path: string,
  /**
   * Project-dep outcome, already rendered by `projectDepsLine` (the
   * one place that turns an install attempt into text); a no-op skip
   * contributes no line. The separator lives here so the caller never has to
   * know whether the line exists.
   */
  depLine?: string
): WorktreeEnterResult {
  const owner = taskWorktreeOwnerOf(path);
  const disclosure =
    owner !== undefined
      ? ` This tree was created by conversation '${owner}'.`
      : "";
  return {
    path,
    receipt:
      `entered task worktree: ${path} (session root rebound; ` +
      `re-issue pending writes in the entered tree in the next wave of tool calls in this run)` +
      disclosure +
      (depLine === undefined ? "" : ` ${depLine}`),
  };
}

export function createTaskWorktreeProvisioner(
  opts: TaskWorktreeProvisionerOpts
): TaskWorktreeProvisioner {
  const runGit = opts.runGit ?? defaultGitRunner;
  const now = opts.now ?? (() => new Date().toISOString());
  const projectIdentityRoot = opts.projectIdentityRoot;
  /**
   * Project-dep seam. Frozen at assembly time (same discipline as
   * `worktreeExclusive`): `provision` / `enter` never re-read opts.
   */
  const installProjectDeps: ProjectDepProvisioner =
    opts.projectDepProvisioner ?? createProjectDepProvisioner();
  /**
   * The SINGLE point where an install attempt becomes model-facing
   * TEXT. Both seams consume this one function and differ only in what they do
   * with the string (`provision` reports it, `enter` appends it to a receipt),
   * so the skip/failure wording cannot drift between the two.
   *
   * Returns `undefined` when there is nothing to say: a tree whose deps are
   * already resolvable is the routine idempotent case (second provision /
   * enter ensure), and narrating that non-event in every receipt is noise.
   * `no_package_json` / `no_lockfile` / a failure are actionable and returned.
   *
   * Fail-open by construction: the seam is documented never to throw, but a
   * host-supplied provisioner must not be able to turn a successfully created
   * tree into a failed provision by throwing, so the throw is caught here and
   * converted into the same kind of line.
   */
  async function projectDepsLine(
    worktreePath: string
  ): Promise<string | undefined> {
    let result: ProjectDepProvisionResult;
    try {
      result = await installProjectDeps(worktreePath);
    } catch (err) {
      return `project deps install failed: ${errorMessage(err)} — the worktree still exists; install manually if the task needs node_modules`;
    }
    if (result.reason === "already_resolved") return undefined;
    return result.line;
  }

  /**
   * `projectDepsLine` routed through the optional report channel. Kept apart
   * from the producer so the (linear) `provisionOnce` body does not have to
   * carry the undefined check itself.
   */
  async function reportProjectDeps(
    report: WorktreeProvisionContext["report"],
    worktreePath: string
  ): Promise<void> {
    const line = await projectDepsLine(worktreePath);
    if (line !== undefined) report?.(line);
  }
  /**
   * ADR-0070 — enter-worktree exclusive-claim switch. Read once at
   * assembly time (ADR-0037): the frozen closure value spans this
   * provisioner's lifetime and `enter()` never re-reads opts. Missing /
   * non-`true` is OFF (fail-closed).
   */
  const worktreeExclusive = opts.worktreeExclusive === true;
  /**
   * ADR-0070 — occupancy enumerator. NEVER called while
   * `worktreeExclusive === false` (OFF must not regress). When ON it is
   * required; absence throws at assembly time (fail-closed: an enabled
   * lock without its enumerator would silently behave like OFF, so refuse
   * to construct the provisioner).
   */
  const listSessions = opts.listSessions;
  if (worktreeExclusive && listSessions === undefined) {
    throw new Error(
      "worktree isolation: worktreeExclusive is true but listSessions is undefined; an enabled occupancy check without an enumerator would silently behave like OFF — refuse to construct the provisioner"
    );
  }
  /** conversationId → worktree path (provisioned / entered set). */
  const bound = new Map<string, string>();
  /** Coalesce concurrent first provisions for the same conversation. */
  const pending = new Map<string, Promise<string>>();
  /** All task worktree roots created or entered here (per-root engine flag source). */
  const taskRoots = new Set<string>();

  /**
   * Absolute git common dir of `cwd` (`<repoRoot>/.git` for a repo and all
   * its linked worktrees). Used by `enter` to prove the target tree belongs
   * to the SAME repository as the caller's root, regardless of where the
   * checkout physically lives.
   */
  async function gitCommonDir(
    cwd: string,
    failureKind: "not_a_git_repo" | "foreign_worktree" | "rebind_failed"
  ): Promise<string> {
    let res: GitResult;
    try {
      res = await runGit(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd
      );
    } catch (err) {
      throw new WorktreeIsolationError(
        "git_unavailable",
        `git is not available (spawn failed): ${errorMessage(err)}`
      );
    }
    if (res.code !== 0) {
      throw new WorktreeIsolationError(
        failureKind,
        `worktree isolation: ${cwd} is not a usable git repository${
          res.stderr.trim().length > 0 ? ` — ${res.stderr.trim()}` : ""
        }`
      );
    }
    return res.stdout.trim();
  }

  /**
   * Legacy standalone persistence hook shared by provision / enter / exit:
   * callers outside SessionHub rebind the session file here (store mode);
   * SessionHub omits the store and persists the returned root through
   * conditionalSave. `action` keeps the per-seam error wording ("rebind" /
   * "enter rebind" / "exit rebind") — the typed exit (rebind_failed) and the
   * load-then-save discipline are identical across all three seams.
   */
  async function persistWorkspaceRoot(
    conversationId: string,
    workspaceRoot: string,
    action: "rebind" | "enter rebind" | "exit rebind"
  ): Promise<void> {
    if (opts.store === undefined) return;
    let file: SessionFileV1;
    try {
      file = await opts.store.load(conversationId);
    } catch (err) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: cannot load session ${conversationId} for ${action}: ${errorMessage(err)}`
      );
    }
    const updated: SessionFileV1 = {
      ...file,
      workspaceRoot,
      updatedAt: now(),
    };
    try {
      await opts.store.save({ id: conversationId, file: updated });
    } catch (err) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: cannot persist ${action} for session ${conversationId}: ${errorMessage(err)}`
      );
    }
  }

  async function provision(
    ctx: WorktreeProvisionContext,
    anchor?: WorktreeProvisionAnchor
  ): Promise<string> {
    const conversationId = ctx.conversationId;
    if (
      conversationId !== undefined &&
      conversationId.length > 0 &&
      SAFE_CONVERSATION_ID_RE.test(conversationId)
    ) {
      const existing = bound.get(conversationId);
      if (existing !== undefined) return existing;
      const inFlight = pending.get(conversationId);
      if (inFlight !== undefined) return inFlight;
      const operation = provisionOnce(ctx, anchor);
      pending.set(conversationId, operation);
      try {
        return await operation;
      } finally {
        if (pending.get(conversationId) === operation) {
          pending.delete(conversationId);
        }
      }
    }
    return provisionOnce(ctx, anchor);
  }

  async function provisionOnce(
    ctx: WorktreeProvisionContext,
    anchor?: WorktreeProvisionAnchor
  ): Promise<string> {
    const conversationId = ctx.conversationId;
    if (conversationId === undefined || conversationId.length === 0) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        "worktree isolation: the mutate call carried no conversation id; cannot rebind a session root without one"
      );
    }
    // Segment-safety gate BEFORE path/branch construction — an unsafe id
    // must never reach `git worktree add`, the worktree path, or a
    // session-file write (typed rebind_failed, zero side effects).
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: conversation id ${JSON.stringify(conversationId)} is not a safe path/branch segment (expected ^[A-Za-z0-9][A-Za-z0-9_-]*$); refusing to build a task worktree or rebind with it`
      );
    }

    const existing = bound.get(conversationId);
    if (existing !== undefined) {
      return existing; // idempotent rebind (no second `worktree add`, no second install)
    }

    // Adoption via the durable enter record: a session whose PERSISTED
    // workspaceRoot equals this engine's root has explicitly entered (or
    // created) this tree — the anchor is written only by a tool success plus
    // a session save, so it is the restart-safe explicit opt-in. Admit the
    // mutate even when the tree belongs to ANOTHER conversation, but ONLY on
    // task-worktree-shaped roots: an unrelated (manual) worktree persisted as
    // workspaceRoot is never adopted and stays fail-closed foreign_worktree.
    if (
      anchor?.sessionWorkspaceRoot === ctx.root &&
      isTaskWorktreePath(ctx.root)
    ) {
      bound.set(conversationId, ctx.root);
      taskRoots.add(ctx.root);
      return ctx.root;
    }

    // Passthrough anchored to THIS conversation's own task worktree
    // (deterministic naming is the ownership anchor, valid across restarts):
    //   - own tree → no-op passthrough: return the same root with zero git
    //     calls and zero rebind writes (no second tree, idempotent);
    //   - another session's tree / any other linked worktree → typed
    //     `foreign_worktree` fail-closed (ADR-0037 covers only the main repo
    //     and the session's own task tree; a foreign root never gets a nested
    //     tree, never sees a write, never has its HEAD touched).
    const owner = taskWorktreeOwnerOf(ctx.root);
    if (owner !== undefined) {
      if (owner === conversationId) {
        bound.set(conversationId, ctx.root);
        taskRoots.add(ctx.root);
        return ctx.root;
      }
      throw new WorktreeIsolationError(
        "foreign_worktree",
        `worktree isolation: session ${conversationId} is anchored at task worktree ${ctx.root} owned by conversation '${owner}'; a foreign task tree is never written or rebound — move this session back to the main repo first`
      );
    }
    if (isLinkedWorktreeRoot(ctx.root)) {
      throw new WorktreeIsolationError(
        "foreign_worktree",
        `worktree isolation: session root ${ctx.root} is a git worktree outside this session's task worktree contract; mutates fail closed here — run the session from the main repo (or its own task worktree) so the first mutate can provision an isolated tree`
      );
    }

    // 1. create the tree (typed fail-closed: not_a_git_repo / git_unavailable /
    //    branch_exists / worktree_exists / worktree_add_failed)
    const label = resolveTaskWorktreeLabel(ctx.name);
    const worktreePath = taskWorktreePath(
      ctx.root,
      conversationId,
      label.label
    );
    const branch = taskWorktreeBranch(conversationId, label.label);
    try {
      await createTaskWorktree({
        repoRoot: ctx.root,
        worktreePath,
        branch,
        conversationId,
        runGit,
      });
    } catch (err) {
      if (err instanceof WorktreeIsolationError) throw err;
      throw new WorktreeIsolationError(
        "worktree_add_failed",
        errorMessage(err)
      );
    }

    // Optional local mirrors are copied only after the linked checkout exists.
    // Their contents are deliberately best-effort: an include file is a
    // convenience for ignored local configuration, never a prerequisite for
    // isolation itself.
    await copyWorktreeInclude({
      repoRoot: mainCheckoutOf(ctx.root),
      worktreePath,
      projectIdentityRoot: projectIdentityRoot ?? mainCheckoutOf(ctx.root),
      runGit,
    });

    // Make the new tree runnable without the model inventing an install.
    // Best-effort and fail-open — the tree is already
    // created, so a missing manager / lockfile only changes the reported line
    // (never the outcome). The line reaches the model through `ctx.report`
    // (the create-worktree tool supplies it); absence of the seam — the gate,
    // the hub, every other caller — changes nothing.
    await reportProjectDeps(ctx.report, worktreePath);

    // 2. Preserve the historical standalone persistence hook when supplied.
    // SessionHub omits it so the host can observe this returned root and
    // persist it together with the turn through conditionalSave.
    await persistWorkspaceRoot(conversationId, worktreePath, "rebind");

    bound.set(conversationId, worktreePath);
    taskRoots.add(worktreePath);
    return worktreePath;
  }

  /**
   * ADR-0070 — pure functional helper for enter's pre-claim occupancy check.
   * Strictly READ-ONLY: never calls store.save / mkdir / writeFile or any
   * other disk write. Design choices:
   *   - path comparison normalizes once via `resolve()` on both sides
   *     (absorbing trailing separators / long absolute paths) before `===`;
   *   - self-claims (`entry.conversation_id === conversationId`) are
   *     skipped — a session pointing at its own tree is not a conflict
   *     (especially when a fresh process has an empty bound Map);
   *   - missing / empty `workspaceRoot` → treated as unclaimed (pass);
   *   - listSessions throwing → typed `rebind_failed` (host-side
   *     rerun_after_change; never silently treated as unclaimed).
   */
  async function assertNotClaimed(
    target: string,
    selfConversationId: string,
    list: () => Promise<ReadonlyArray<SessionListEntry>>
  ): Promise<void> {
    const normalizedTarget = resolve(target);
    let entries: ReadonlyArray<SessionListEntry>;
    try {
      entries = await list();
    } catch (err) {
      // Exception arm — typed fail-closed. The original error object is not
      // rethrown (that would leak SessionStoreError's shape into
      // WorktreeIsolationError.message); errorMessage extracts a plain-string
      // context, keeping the typed fail-closed path consistent.
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: cannot enumerate sessions for occupancy check: ${errorMessage(err)}`
      );
    }
    for (const entry of entries) {
      if (
        entry.workspaceRoot === undefined ||
        entry.workspaceRoot.length === 0
      ) {
        continue; // empty arm — missing field / empty string = unclaimed
      }
      if (entry.conversation_id === selfConversationId) {
        continue; // a self-claim is not a conflict (fresh process has an empty bound Map)
      }
      if (resolve(entry.workspaceRoot) === normalizedTarget) {
        // The receipt names the claimer and the release path.
        // Weak-mode disclosure: occupancy is visible only within this
        // process; claims held by other CLI processes are invisible to this
        // check — this is the mandatory disclosure point in the receipt.
        throw new WorktreeIsolationError(
          "worktree_claimed",
          `worktree isolation: task worktree ${target} is already claimed by session '${entry.conversation_id}'; release it by resuming that session and calling exit-worktree, or by deleting the session record. Note: occupancy is visible only within the current process — other CLI processes' claims on the same tree are not visible to this check`
        );
      }
    }
  }

  async function enter(
    req: WorktreeEnterRequest
  ): Promise<WorktreeEnterResult> {
    const conversationId = req.conversationId;
    if (conversationId === undefined || conversationId.length === 0) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        "worktree isolation: the enter call carried no conversation id; cannot rebind a session root without one"
      );
    }
    // Segment-safety gate BEFORE path construction — both ids are joined
    // into the target path verbatim.
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: conversation id ${JSON.stringify(conversationId)} is not a safe path/branch segment (expected ^[A-Za-z0-9][A-Za-z0-9_-]*$); refusing to rebind with it`
      );
    }
    if (!SAFE_CONVERSATION_ID_RE.test(req.targetConversationId)) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: target conversation id ${JSON.stringify(req.targetConversationId)} is not a safe path/branch segment (expected ^[A-Za-z0-9][A-Za-z0-9_-]*$); refusing to resolve a task worktree with it`
      );
    }

    // Enter only from the main repo: a caller already inside a linked
    // worktree must exit first — this structurally prevents nested task
    // trees (`<tree>/.iknow/worktrees/<id>`) and chained rebinds.
    if (isLinkedWorktreeRoot(req.root)) {
      throw new WorktreeIsolationError(
        "foreign_worktree",
        `worktree isolation: session ${conversationId} is currently inside a git worktree (${req.root}); return to the main repo root (exit-worktree) before entering another task worktree`
      );
    }

    // Resolve an exact conversation id first, then a unique decorative label.
    // The list is the source of truth for labeled leaves; the legacy
    // UUID-only path fallback keeps old trees enterable even when a host uses
    // a minimal git runner.
    const listed = await list({ root: req.root });
    const selected = selectTaskWorktree(listed, req.targetConversationId);
    const target =
      selected?.path ??
      taskWorktreePath(req.root, req.targetConversationId, undefined);
    const current = bound.get(conversationId);
    if (current === target) {
      return enterResultOf(target); // idempotent re-enter (zero writes)
    }

    // ADR-0070 — ON-mode pre-enter occupancy check. Placed after the
    // idempotent re-enter and before the four target validations:
    //   - already claimed in this process's bound Map (self) → the early
    //     return above costs zero listing overhead;
    //   - another persisted session claims the tree → typed
    //     worktree_claimed (fail-closed; the receipt carries the stop
    //     instruction and the release path).
    //
    // Input classes:
    //   - empty      listSessions empty / record missing workspaceRoot /
    //                empty field → treated as unclaimed (no throw);
    //   - negative   OFF mode skips this check entirely;
    //   - overflow   paths compared after `resolve()` normalization
    //                (trailing separators / long absolute paths);
    //   - exception  listSessions throws → typed `rebind_failed`, never
    //                silently passed;
    //   - concurrent two enters in the same window can both pass
    //                (check-then-act is not atomic here).
    if (worktreeExclusive && listSessions !== undefined) {
      await assertNotClaimed(target, conversationId, listSessions);
    }

    // Target validation, cheapest checks first:
    //   1. exists on disk → `worktree_not_found`
    //   2. is a LINKED checkout (`.git` is a file) → `foreign_worktree`
    //   3. belongs to the SAME repository as the caller's root (common-dir
    //      comparison) → `foreign_worktree` on mismatch
    if (!existsSync(target)) {
      throw new WorktreeIsolationError(
        "worktree_not_found",
        `worktree isolation: no task worktree matches '${req.targetConversationId}' at ${target}; check the conversation id or label, or create the tree first with the create-worktree tool`
      );
    }
    if (!isLinkedWorktreeRoot(target)) {
      throw new WorktreeIsolationError(
        "foreign_worktree",
        `worktree isolation: ${target} exists but is not a linked git worktree checkout; refusing to rebind a session root onto it`
      );
    }
    const repoCommon = await gitCommonDir(req.root, "not_a_git_repo");
    const targetCommon = await gitCommonDir(target, "foreign_worktree");
    if (targetCommon !== repoCommon) {
      throw new WorktreeIsolationError(
        "foreign_worktree",
        `worktree isolation: task worktree ${target} belongs to a different repository (${targetCommon}) than the session root (${repoCommon}); a foreign tree is never entered or rebound`
      );
    }

    // Legacy standalone persistence hook (mirrors `provision`): callers
    // outside SessionHub rebind the session file here; SessionHub omits the
    // store and persists the returned root through conditionalSave.
    await persistWorkspaceRoot(conversationId, target, "enter rebind");

    // Register the boundary BEFORE the (bounded but slow) install. `enter`
    // has no in-flight map of its own (unlike `provision`'s `pending`), so the
    // re-enter guard above is the only coalescing point: with the ensure still
    // ahead of `bound.set`, two concurrent enters of the same tree both missed
    // that guard and raced two installers into one `node_modules`. Moving the
    // registration up makes the second call take the idempotent early return.
    //
    // Tradeoff, stated rather than hidden: the second (racing) call returns the
    // same path with the plain receipt, WITHOUT a dep line — the install is
    // still in flight for the first call, and the outcome belongs to that
    // call's receipt. Duplicate installs are the failure that matters; a
    // receipt line is not worth a second writer.
    bound.set(conversationId, target);
    taskRoots.add(target);

    // Idempotent project-deps ensure: entering a tree created before this
    // feature (or created by a session whose install failed) still ends with
    // resolvable
    // project deps. Same fail-open contract as `provision` — the enter itself
    // has already succeeded and no outcome depends on this. The receipt carries
    // the line because enter's model-facing text comes from this seam.
    return enterResultOf(target, await projectDepsLine(target));
  }

  async function exit(req: WorktreeExitRequest): Promise<string> {
    const conversationId = req.conversationId;
    if (conversationId === undefined || conversationId.length === 0) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        "worktree isolation: the exit call carried no conversation id; cannot rebind a session root without one"
      );
    }
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: conversation id ${JSON.stringify(conversationId)} is not a safe path/branch segment (expected ^[A-Za-z0-9][A-Za-z0-9_-]*$); refusing to rebind with it`
      );
    }

    // Rebound detection (fail-closed): a session that never rebound has no
    // in-process entry, no durable anchor, and no shaped engine root.
    const boundRoot = bound.get(conversationId);
    const shapedCurrent = isTaskWorktreePath(req.root) ? req.root : undefined;
    const shapedAnchor =
      req.sessionWorkspaceRoot !== undefined &&
      isTaskWorktreePath(req.sessionWorkspaceRoot)
        ? req.sessionWorkspaceRoot
        : undefined;
    if (
      boundRoot === undefined &&
      shapedCurrent === undefined &&
      shapedAnchor === undefined
    ) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: session ${conversationId} is not currently rebound to a task worktree; there is nothing to exit`
      );
    }
    const tree = shapedCurrent ?? boundRoot ?? shapedAnchor!;

    // Main repo root SSOT: the git common dir of the tree is
    // `<repoRoot>/.git` (worktree-safe, restart-safe) — one level up is the
    // main repo checkout. No recorded origin state, no orphan deletion.
    const commonDir = await gitCommonDir(tree, "rebind_failed");
    const repoRoot = dirname(commonDir);

    bound.delete(conversationId);

    // Legacy standalone persistence hook (mirrors `provision` / `enter`).
    await persistWorkspaceRoot(conversationId, repoRoot, "exit rebind");

    return repoRoot;
  }

  async function list(
    ctx: WorktreeListContext
  ): Promise<ReadonlyArray<TaskWorktreeInfo>> {
    const repoRoot = mainCheckoutOf(ctx.root);
    const porcelain = await runGitForLifecycle(
      runGit,
      ["worktree", "list", "--porcelain"],
      repoRoot,
      "worktree_list_failed",
      "cannot list git worktrees"
    );
    const records = parseWorktreePorcelain(porcelain.stdout);
    const activeBranches = new Set<string>();
    const entries: TaskWorktreeInfo[] = [];

    for (const record of records) {
      if (!isTaskWorktreePath(record.path)) continue;
      const owner = taskWorktreeOwnerOf(record.path);
      if (owner === undefined) continue;
      const dirty = await readWorktreeDirty(runGit, record.path);
      const branch = record.branch ?? "";
      if (branch.length > 0) activeBranches.add(branch);
      entries.push({
        label: taskWorktreeLabelOf(record.path),
        conversationId: owner,
        path: record.path,
        branch,
        head: record.head ?? "",
        dirty,
      });
    }

    if (ctx.includeStale !== true) {
      return Object.freeze(entries);
    }

    const branches = await runGitForLifecycle(
      runGit,
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/iknow/task*"],
      repoRoot,
      "worktree_list_failed",
      "cannot list task branches"
    );
    for (const branch of splitGitLines(branches.stdout)) {
      if (activeBranches.has(branch)) continue;
      const parsed = parseTaskBranch(branch);
      if (parsed === undefined) continue;
      const head = await runGitForLifecycle(
        runGit,
        ["rev-parse", branch],
        repoRoot,
        "worktree_list_failed",
        `cannot inspect task branch ${branch}`
      );
      entries.push({
        label: parsed.label,
        conversationId: parsed.conversationId,
        path: "",
        branch,
        head: head.stdout.trim(),
        dirty: false,
        stale: true,
      });
    }
    return Object.freeze(entries);
  }

  async function remove(ctx: WorktreeRemoveContext): Promise<WorktreeRemoval> {
    const entries = await list({ root: ctx.root });
    const selected = selectTaskWorktree(entries, ctx.targetConversationId);
    if (selected === undefined || selected.path.length === 0) {
      throw new WorktreeIsolationError(
        "worktree_not_found",
        `worktree isolation: no active task worktree matches '${ctx.targetConversationId}'`
      );
    }

    if (resolve(ctx.root) === resolve(selected.path)) {
      throw new WorktreeIsolationError(
        "current_worktree",
        `worktree isolation: cannot remove the caller's current task worktree ${selected.path}; exit-worktree first`
      );
    }
    if (selected.dirty) {
      throw new WorktreeIsolationError(
        "worktree_dirty",
        `worktree isolation: task worktree ${selected.path} has uncommitted changes; clean or commit it before removal`
      );
    }

    const repoRoot = mainCheckoutOf(ctx.root);
    const unpublished = await exclusiveUnpushedCommitCount(
      runGit,
      repoRoot,
      selected.branch
    );
    if (unpublished > 0) {
      throw new WorktreeIsolationError(
        "unpublished_commits",
        `worktree isolation: task branch ${selected.branch} has ${unpublished} exclusive commit(s) not confirmed pushed; push or merge them before removal`
      );
    }

    await runGitForLifecycle(
      runGit,
      ["worktree", "remove", selected.path],
      repoRoot,
      "worktree_remove_failed",
      `cannot remove task worktree ${selected.path}`
    );

    let branchDeleted = false;
    if (ctx.deleteBranch === true && selected.branch.length > 0) {
      await runGitForLifecycle(
        runGit,
        ["branch", "-D", selected.branch],
        repoRoot,
        "branch_delete_failed",
        `cannot delete task branch ${selected.branch}`
      );
      branchDeleted = true;
    }

    if (bound.get(selected.conversationId) === selected.path) {
      bound.delete(selected.conversationId);
    }
    taskRoots.delete(selected.path);
    return {
      label: selected.label,
      conversationId: selected.conversationId,
      path: selected.path,
      branch: selected.branch,
      head: selected.head,
      branchDeleted,
    };
  }

  return Object.freeze({
    provision,
    enter,
    exit,
    list,
    remove,
    isTaskWorktreeRoot: (root: string) => taskRoots.has(root),
  });
}
