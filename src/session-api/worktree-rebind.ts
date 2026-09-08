/**
 * src/session-api/worktree-rebind.ts
 *
 * ADR-0037 / plans/worktree-isolation-on-mutate.md T3 — the session-api host
 * seam of the worktree isolation pipeline: create a per-conversation task
 * worktree (via the harness git layer) and rebind the CURRENT session's
 * workspaceRoot to it, so the next turn's per-root engine cache resolves an
 * engine rooted at the task worktree.
 *
 * Module boundary (ACR bounded-context-guardian):
 *   - owns ONLY the host-side rebind: per-conversation naming, the session
 *     file update, and the bound-root registry. No LLM/session-runtime
 *     imports; the git worktree creation is delegated to
 *     `harness/isolation/worktree-gate.ts` (single git-layer SSOT).
 *
 * Deterministic naming (ADR-0037 §3):
 *   - worktree path `<repoRoot>/.iknow/worktrees/<label>--<conversationId>` or
 *     the historical `<conversationId>` leaf (`.iknow` is the per-root state
 *     anchor and gitignored, so the nested checkout never pollutes the main
 *     repo's status);
 *   - branch `iknow/task/<label>-<uuid8>` when labeled, otherwise
 *     `iknow/task-<conversationId>`.
 *   The naming makes ownership unambiguous, but a pre-existing branch /
 *   worktree path is still fail-closed (`branch_exists` / `worktree_exists`
 *   from the git layer) — no silent overwrite, no reuse of unknown trees,
 *   no checkout of other sessions' HEADs (hard req ①③).
 *
 * Failure semantics (hard req ⑥): every failure exits typed
 * (`WorktreeIsolationError`) and the session file is left untouched — the
 * rebind happens only after the tree was created successfully.
 *
 * T4 (passthrough): the per-conversation passthrough decision lives HERE —
 * a mutate arriving while the session is already on its own task worktree
 * (deterministic naming, restart-safe) is a zero-side-effect no-op; a root
 * belonging to another conversation or an unrelated linked worktree fails
 * closed with `foreign_worktree`.
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
   * T3 / plans/worktree-exclusive-lock.md / ADR-0070 — enter-task-worktree
   * 占用锁档。boolean-only；缺失 / 非 `true` 一律按 OFF（fail-closed，
   * 与 `worktreeOnMutate` 同款值域纪律）。OFF 时 `enter()` 行为与今日
   * 逐字节一致——四道检查不变、不新增任何拒绝路径（SC2）。
   *
   * 该字段**只**在装配期读取一次：缺失语义与 `isolation.worktreeExclusive`
   * 设置项缺席等价 → OFF；后续 `enter()` 调用沿用本闭包冻结的值，**绝不**
   * 在每次 enter 时重新判定（ADR-0037 §5 硬要求 9）。
   */
  readonly worktreeExclusive?: boolean;
  /**
   * T3 / ADR-0070 — 占用检查的会话枚举入口。`worktreeExclusive === true`
   * 时必须提供；返回 `SessionStore.list()` 的同形态（`workspaceRoot` 缺席
   * 即视为「该会话未占用任何 worktree」——empty 臂按无占用放行）。
   *
   * I/O 故障语义（exception 臂，spec 输入五类表）：
   *   - 抛非 ENOENT I/O → typed `rebind_failed`（host-side rerun_after_change）。
   *     **绝不**静默放行——那会让锁在管理员最需要它时自动解除。
   *
   * L1 弱档披露：当前实现只扫**本进程 dataDir 单一项目命名空间**
   * （`SessionStore` 单进程单 cwd）；跨进程 / 跨 CLI 实例的占用看不见。
   * 这是 SC3 / L1 的已决弱档语义，**不**是 bug——披露在设置项文档 + 回执文案 +
   * spec 三处同时在场（spec Changes 段）。
   */
  readonly listSessions?: () => Promise<ReadonlyArray<SessionListEntry>>;
}

export interface TaskWorktreeProvisioner {
  /**
   * Create (or no-op-return) the conversation's task worktree and rebind the
   * session root. Resolves with the worktree path. Idempotent per
   * conversation: once provisioned, subsequent calls return the same root
   * without running `git worktree add` again (same-process concurrency latch
   * lives in the harness gate; this covers engine rebuilds).
   *
   * T4 passthrough anchoring: when `ctx.root` IS this conversation's own task
   * worktree (deterministic naming, restart-safe), `provision` is a no-op
   * that returns the same root — zero git calls, zero rebind writes. When
   * `ctx.root` is another conversation's task worktree or an unrelated
   * linked worktree, it rejects with a typed `foreign_worktree`
   * (fail-closed; ADR-0037 defines only the main repo and the own task tree).
   *
   * T7 adoption anchor: `anchor.sessionWorkspaceRoot` (the caller's PERSISTED
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
   * T7 explicit enter: move a session anchored at the MAIN repo onto an
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
   * T8 symmetric exit: return the conversation to its MAIN repo root. No
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
   * recognized as a conversation's own tree — T4 passthrough registration).
   * Ownership-AGNOSTIC introspection: it does NOT answer "is this root
   * conversation X's own tree" — the per-conversation passthrough anchor is
   * `provision` itself, never this predicate.
   */
  isTaskWorktreeRoot(root: string): boolean;
}

/**
 * T7 adoption input: the caller's persisted workspace root (loaded from the
 * session file by the hub before invoking `provision`). Undefined / absent
 * = no durable record → the T4 fail-closed contract stands unchanged.
 */
export interface WorktreeProvisionAnchor {
  readonly sessionWorkspaceRoot?: string;
}

/**
 * T7 enter request — the harness `WorktreeEnterContext` SSOT (no local copy).
 */
export type WorktreeEnterRequest = WorktreeEnterContext;

/**
 * T8 exit request: the harness `WorktreeExitContext` SSOT (engine root is
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
 * T4 ownership anchor: decompose a root against the deterministic naming.
 * The implementation is kept in the harness isolation module so the gate,
 * provisioner, and read-only display consumers cannot disagree.
 *
 * Single SSOT lives in `harness/isolation/worktree-gate.ts` (the mutate gate
 * routes on the same predicate — T3 model-provision contract); re-exported
 * here for the provisioner and read-only display consumers (TUI environment
 * pane, review Medium-2): "workspaceRoot looks like a task worktree" is the
 * display condition, NOT "workspaceRoot is any non-empty string" — serve's
 * `bindWorkspace` legitimately persists the MAIN root as workspaceRoot, and
 * that must never render as a worktree binding.
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
 * Review Medium-1 (2026-08-29): the conversationId is concatenated verbatim
 * into the worktree path (`<repoRoot>/.iknow/worktrees/<id>`) and the branch
 * name (`iknow/task-<id>`). The store layer has no id-shape contract (ids are
 * host-generated UUIDs joined into file paths as-is), so the provisioner owns
 * the segment-safety gate: fail closed on anything that is not a single safe
 * path/branch segment, BEFORE any git call or store write.
 *
 * Contract: first char alphanumeric; remainder alphanumeric / `_` / `-`.
 * This rejects path traversal (`..`, `a/b`), leading dashes/dots (option or
 * glob ambiguity in `git worktree add -b`), whitespace / shell metacharacters,
 * and empty strings. The regex SSOT lives in
 * `harness/isolation/worktree-gate.ts` (the T7 enter-task-worktree tool
 * validates its model-supplied id against the same contract); re-exported
 * here for existing importers.
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
 * write-situation-disclosure T9 (SC10): compose the enter success receipt.
 * The tree's owner sidecar (via `taskWorktreeOwnerOf`) discloses WHO created
 * the tree being entered — disclosure, never authorization (ADR-0069). The
 * read is a single best-effort fs access: `taskWorktreeOwnerOf` already
 * degrades missing / empty / unreadable sidecars to `undefined` (typed catch:
 * an absent owner record is a legal legacy state, not an I/O fault), so the
 * ownership sentence is simply omitted — no throw, no placeholder.
 *
 * Constant-on: this path reads no setting (specs/worktree-exclusive-lock.md
 * SC10 — the exclusive-lock gate is a separate PR and must not gate this).
 */
function enterResultOf(path: string): WorktreeEnterResult {
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
      disclosure,
  };
}

export function createTaskWorktreeProvisioner(
  opts: TaskWorktreeProvisionerOpts
): TaskWorktreeProvisioner {
  const runGit = opts.runGit ?? defaultGitRunner;
  const now = opts.now ?? (() => new Date().toISOString());
  const projectIdentityRoot = opts.projectIdentityRoot;
  /**
   * T3 / ADR-0070 — enter-task-worktree 占用锁档。装配期一次性读取
   * （ADR-0037 §5 硬要求 9 / `resolveWorktreeExclusive` 单读点同款形状）：
   * 闭包冻结值贯穿本 provisioner 寿命，`enter()` 不重读 opts。缺失 /
   * 非 `true` 一律 OFF（fail-closed）。
   */
  const worktreeExclusive = opts.worktreeExclusive === true;
  /**
   * T3 / ADR-0070 — 占用枚举入口。`worktreeExclusive === false` 时**绝不**
   * 调用（OFF 档零回归 SC2）。`true` 时必须提供；缺席 → 装配期抛错（fail-
   * closed：开锁却没装锁孔 = 锁无效，直接报错不让它跑起来）。
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
    // Review Medium-1: segment-safety gate BEFORE path/branch construction —
    // an unsafe id must never reach `git worktree add`, the worktree path, or
    // a session-file write (typed rebind_failed, zero side effects).
    if (!SAFE_CONVERSATION_ID_RE.test(conversationId)) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: conversation id ${JSON.stringify(conversationId)} is not a safe path/branch segment (expected ^[A-Za-z0-9][A-Za-z0-9_-]*$); refusing to build a task worktree or rebind with it`
      );
    }

    const existing = bound.get(conversationId);
    if (existing !== undefined) {
      return existing; // idempotent rebind (no second `worktree add`)
    }

    // T7 — adoption via the durable enter record: a session whose PERSISTED
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

    // T4 — passthrough anchored to THIS conversation's own task worktree
    // (deterministic naming is the ownership anchor, valid across restarts):
    //   - own tree → no-op passthrough: return the same root with zero git
    //     calls and zero rebind writes (no second tree, hard req ⑦ idempotency);
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

    // 2. Preserve the historical standalone persistence hook when supplied.
    // SessionHub omits it so the host can observe this returned root and
    // persist it together with the turn through conditionalSave.
    await persistWorkspaceRoot(conversationId, worktreePath, "rebind");

    bound.set(conversationId, worktreePath);
    taskRoots.add(worktreePath);
    return worktreePath;
  }

  /**
   * T3 / ADR-0070 — enter 前置占用检查纯函数式 helper。**只读**——
   * 绝不调 store.save / mkdir / writeFile 等任何写盘动作（SC7 审查项）。
   * 设计选择：
   *   - 路径比较走 `resolve()` 单次归一化（化解尾随分隔符 / 长绝对路径），
   *     两侧解析到绝对路径后再 `===` 裁决（overflow 臂）；
   *   - 自占用（`entry.conversation_id === conversationId`）跳过——同一
   *     会话自己点过自己不算占用（fresh 进程 bound Map 为空时尤其重要）；
   *   - 缺 `workspaceRoot` / 空串 → 视为无占用放行（empty 臂，spec 显式要求）；
   *   - listSessions 抛 → typed `rebind_failed`（exception 臂；host-side
   *     rerun_after_change，绝不静默当成无占用）。
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
      // exception 臂 — typed fail-closed. 不重新 throw 原始错误对象（避免
      // 把 SessionStoreError 形状泄漏进 WorktreeIsolationError.message）；
      // errorMessage 抽 plain string 上下文（spec 输入五类表「原样 rethrow
      // 或 typed fail-closed」二选一——这里选 typed fail-closed 一致性）。
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
        continue; // empty 臂 — 缺字段 / 空串视为无占用放行
      }
      if (entry.conversation_id === selfConversationId) {
        continue; // 自占用不算占用（fresh 进程 bound Map 为空时尤其重要）
      }
      if (resolve(entry.workspaceRoot) === normalizedTarget) {
        // 回执点名占用者 + 释放路径（spec SC3 / SC9）。
        // L1 披露：占用枚举仅本进程可见，跨进程 / 跨 CLI 实例的占用看不见
        // （spec L1「弱档」已决；该披露在设置项文档 + 回执文案 + spec 三处
        // 同时在场，本句为回执处的强制披露点）。
        throw new WorktreeIsolationError(
          "worktree_claimed",
          `worktree isolation: task worktree ${target} is already claimed by session '${entry.conversation_id}'; release it by resuming that session and calling exit-task-worktree, or by deleting the session record. Note: occupancy is visible only within the current process — other CLI processes' claims on the same tree are not visible to this check`
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
    // Segment-safety gate BEFORE path construction — both ids are joined into
    // the target path verbatim (Review Medium-1 discipline).
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
        `worktree isolation: session ${conversationId} is currently inside a git worktree (${req.root}); return to the main repo root (exit-task-worktree) before entering another task worktree`
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

    // T3 / ADR-0070 — ON 档 enter 前置占用检查（spec SC3 / SC4 / SC5）。
    // 位置在幂等 re-enter 之后、四道目标校验之前：
    //   - 同进程 bound Map 已认领（同会话自占用）→ 上面已早返回，零 list 开销；
    //   - 别的现存会话记录占用 → typed worktree_claimed（fail-closed，归
    //     operator_required，回执自带停止指令 + 释放路径，spec SC3 / SC6）。
    //
    // 输入五类表（spec 输入五类 + SC7 零新写盘）：
    //   - empty          listSessions 空 / 记录缺 workspaceRoot / 字段空串 → 视为无占用放行（不 throw）；
    //   - negative       OFF 档 → 完全跳过本检查（早返回前已断 worktreeExclusive；SC2）；
    //   - overflow       路径比较走 `resolve()` 归一化（尾随分隔符 / 长绝对路径均正确裁决）；
    //   - exception      listSessions 抛 → typed `rebind_failed`（**绝不**静默放行）；
    //   - concurrent     双 enter 同窗双双成功（spec L2，本 ticket 不测，T4 留测试钉住）。
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
        `worktree isolation: no task worktree matches '${req.targetConversationId}' at ${target}; check the conversation id or label, or create the tree first with the create-task-worktree tool`
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

    bound.set(conversationId, target);
    taskRoots.add(target);
    return enterResultOf(target);
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
        `worktree isolation: cannot remove the caller's current task worktree ${selected.path}; exit-task-worktree first`
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
