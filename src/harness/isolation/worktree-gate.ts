/**
 * src/harness/isolation/worktree-gate.ts
 *
 * ADR-0037 (amended 2026-08-30) / plans/worktree-isolation-model-provision.md
 * T3 — mutate gate at the harness executor seam. Model-provision contract:
 * when the isolation switch is ON and the session is still on the main
 * checkout, the first workspace-mutating tool call is BLOCKED — the gate
 * NEVER provisions. Creating the per-conversation task worktree and rebinding
 * the session root is the model's job via the create-task-worktree ACI tool
 * (T4); the block message says exactly that. Once the session root moved to
 * its task worktree (host rebuilds the engine at that root), mutates are
 * adjudicated per conversation by the host `provision` seam: the session's
 * own tree is a same-root no-op passthrough, a foreign root fails closed.
 *
 * Module boundary (ACR bounded-context-guardian):
 *   - this module owns ONLY the gate + git layer; it holds no session state
 *     beyond the per-conversation adjudication latch, reads no settings and
 *     imports no session-api code. The host (session-api) supplies the
 *     `provision` callback; the deterministic task-worktree path shape
 *     (`isTaskWorktreePath`) and identity (`taskWorktreeOwnerOf`) live here
 *     because the gate routes on them — session-api re-exports them as the
 *     single SSOT.
 *
 * Failure semantics (ADR-0037 §6, fail-closed):
 *   - every failure exits as a typed `WorktreeIsolationError` (non-empty,
 *     visible message) and the intercepted call NEVER reaches the tool
 *     handler — the main repo gets zero writes;
 *   - the unbound block is side-effect free and idempotent: every mutate
 *     re-blocks with the ACI-tool notice until the model provisions and the
 *     host rebinds.
 *
 * Switch OFF → `createWorktreeIsolationExecutor` is not wired by the
 * assembly (build-engine), i.e. byte-identical to today's behavior.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "../errors.js";
import { validateSegmentPolicy } from "../aci/tools/bash-readonly.js";
import { splitShellSegments } from "../permission/hard-walls.js";
import { FILE_WRITE_TOOL_NAMES } from "../aci/tools/symbol-mutate.js";
import type { LiveTaskRoot } from "../session-roots.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../tools/types.js";

/** Visible message prefix for every gate-produced block (SSOT for tests). */
export const WORKTREE_ISOLATION_PREFIX = "[worktree_isolation]";

/**
 * Hint the gate emits on unbound mutates (T3 model-provision contract): the
 * model must call the create-task-worktree ACI tool (T4) — the gate never
 * auto-creates. T4's tool name/registration must align with this wording.
 */
export const CREATE_TASK_WORKTREE_TOOL_HINT = "create-task-worktree ACI tool";

/**
 * Root-flip lifecycle block notice (D11 / review fix): a mutate arriving
 * after an enter/exit-task-worktree call in the SAME wave would be adjudicated
 * on the wave-entry snapshot while its handler would consume the flipped
 * cell — the admit-but-write-other-root window D11 forbids. Fail-closed: the
 * call is not executed; the model re-issues it in the next wave.
 */
export function rootFlipMutateNotice(toolName: string): string {
  return (
    `${WORKTREE_ISOLATION_PREFIX} workspace mutation blocked: ${toolName} in this ` +
    `wave of tool calls changed the session's active root, and this call was ` +
    `adjudicated against the root from before that change. The call was not ` +
    `executed — re-issue it in the next wave of tool calls in this run, which ` +
    `will adjudicate against the new root.`
  );
}

/**
 * Unbound-mutate block notice: states facts only — isolation is ON and the
 * session is unbound, this call would write the main repo, it was NOT
 * executed, and the tool for a writable root exists (the gate never
 * auto-provisions). Deliberately no imperative "create this conversation's
 * task worktree" framing (spec casual-ask-context-hygiene SC7): the notice
 * must not steer the model's next move into building a tree.
 */
export function unboundMutateNotice(): string {
  return (
    `${WORKTREE_ISOLATION_PREFIX} This call would write the workspace, and it was not executed: ` +
    `worktree isolation is ON and this session is not yet bound to a task worktree. ` +
    `The main repo stays read-only. The ${CREATE_TASK_WORKTREE_TOOL_HINT} exists for ` +
    `sessions that need a writable root (no auto-provisioning).`
  );
}

/** Typed failure kinds (ADR-0037 §6 / plan hard req 6–8). */
export type WorktreeIsolationErrorKind =
  | "not_a_git_repo"
  | "git_unavailable"
  | "branch_exists"
  | "worktree_exists"
  | "worktree_add_failed"
  | "rebind_failed"
  /**
   * Session root is a git worktree that is NOT this conversation's own task
   * worktree (another session's task tree, or an unrelated manual worktree).
   * T4 fail-closed choice: the isolation contract (ADR-0037) only defines the
   * main repo and the session's own task tree, so a foreign root never gets a
   * nested tree and never sees a write.
   */
  | "foreign_worktree"
  /**
   * T7 enter-task-worktree: the requested target task worktree does not
   * exist (no directory at `<repoRoot>/.iknow/worktrees/<conversationId>`).
   * Distinct from `foreign_worktree` so the model can tell "wrong id / tree
   * never created" apart from "tree exists but belongs elsewhere".
   */
  | "worktree_not_found"
  | "ambiguous_worktree"
  | "worktree_list_failed"
  | "worktree_status_failed"
  | "worktree_dirty"
  | "unpublished_commits"
  | "current_worktree"
  | "worktree_remove_failed"
  | "branch_delete_failed";

/**
 * Typed, non-empty, visible error for every gate failure. Mirrors the
 * `SubAgentSandboxRootError` convention (readonly name + typed context) and
 * the plain-object discriminant discipline of `WorkspaceRootError` — callers
 * branch on `kind`, never on message parsing.
 */
export class WorktreeIsolationError extends Error {
  override readonly name = "WorktreeIsolationError";
  readonly kind: WorktreeIsolationErrorKind;
  /** Message without the typed prefix — reused verbatim in gate blocks. */
  readonly detail: string;

  constructor(kind: WorktreeIsolationErrorKind, detail: string) {
    super(`WorktreeIsolationError: ${kind} — ${detail}`);
    this.kind = kind;
    this.detail = detail;
  }
}

// -- git layer -----------------------------------------------------------------

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Git runner seam. Implementations return the process result for normal
 * exits; a spawn failure (git binary missing) must THROW so the gate can
 * map it to `git_unavailable` distinctly from "not a repository".
 */
export type GitRunner = (
  args: readonly string[],
  cwd: string
) => Promise<GitResult>;

/**
 * Production runner: `git <args>` in `cwd`. Spawn errors propagate as throws.
 *
 * cwd 语义的 runner 必须剥离父 git 进程注入的 GIT_DIR / GIT_WORK_TREE 等 env
 * （如 hook 子进程里启动 iknow 时）：这些变量会把 `rev-parse` 等按 cwd 探测
 * 的调用钉到父仓库上，探测的不再是 opts.cwd 指向的 repo。
 */
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_COMMON_DIR",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_PREFIX",
      "GIT_SUPER_PREFIX",
      "GIT_CEILING_DIRECTORIES",
    ]) {
      delete env[key];
    }
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", env },
      (err, stdout, stderr) => {
        if (
          err &&
          (err as NodeJS.ErrnoException).code !== undefined &&
          typeof (err as NodeJS.ErrnoException).code === "number"
        ) {
          // git exited non-zero — a normal result, not a spawn failure
          resolve({
            code: err.code as number,
            stdout: String(stdout),
            stderr: String(stderr),
          });
          return;
        }
        if (err) {
          reject(err);
          return;
        }
        resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });

export interface CreateTaskWorktreeOpts {
  /** Repository (or linked worktree) the task worktree branches from. */
  readonly repoRoot: string;
  /** Absolute target path for the new worktree; must not exist. */
  readonly worktreePath: string;
  /** New branch name; must not exist (fail-closed, ADR-0037 §3). */
  readonly branch: string;
  /**
   * Owning conversation. When set, written to the linked worktree gitdir
   * sidecar so labeled name-only leaves can invert identity without encoding
   * the id in the folder name.
   */
  readonly conversationId?: string;
  readonly runGit?: GitRunner;
}

export interface TaskWorktree {
  readonly worktreePath: string;
  readonly branch: string;
}

/**
 * Create a task worktree on a NEW branch, deterministically and fail-closed:
 *
 *   1. `rev-parse --git-common-dir` (usable-gitdir probe, ADR-0037 §6
 *      amendment 2026-09-07) — no usable gitdir → `not_a_git_repo`; git
 *      binary missing → `git_unavailable`. A bare gitdir or a
 *      `core.bare=true` checkout with working files IS a usable repo (the
 *      criterion is the ability to `worktree add`, not working files on the
 *      root); only directories without a gitdir fail here.
 *   2. branch already exists → `branch_exists` (never repointed/overwritten;
 *      never checked out into another worktree's place — hard req ①/②).
 *   3. worktree path exists → `worktree_exists`.
 *   4. `worktree add -b <branch> <path>` — failure → `worktree_add_failed`
 *      with git's stderr in the message (e.g. a bare gitdir with no commits
 *      has no HEAD to branch from).
 *
 * The source repo's HEAD and current branch are never moved: `-b` creates the
 * branch at HEAD and checks it out only in the new worktree. Every failure
 * happens before any path is created (zero side effects on the main root).
 */
export async function createTaskWorktree(
  opts: CreateTaskWorktreeOpts
): Promise<TaskWorktree> {
  const runGit = opts.runGit ?? defaultGitRunner;
  const { repoRoot, worktreePath, branch } = opts;

  let probe: GitResult;
  try {
    probe = await runGit(["rev-parse", "--git-common-dir"], repoRoot);
  } catch (err) {
    throw new WorktreeIsolationError(
      "git_unavailable",
      `git is not available (spawn failed): ${errorMessage(err)}`
    );
  }
  if (probe.code !== 0 || probe.stdout.trim().length === 0) {
    throw new WorktreeIsolationError(
      "not_a_git_repo",
      `not a usable git repository (no gitdir found; worktree isolation requires one): ${repoRoot}${
        probe.stderr.trim().length > 0 ? ` — ${probe.stderr.trim()}` : ""
      }`
    );
  }

  let branchProbe: GitResult;
  try {
    branchProbe = await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      repoRoot
    );
  } catch (err) {
    throw new WorktreeIsolationError(
      "git_unavailable",
      `git is not available (spawn failed): ${errorMessage(err)}`
    );
  }
  if (branchProbe.code === 0) {
    throw new WorktreeIsolationError(
      "branch_exists",
      `task branch '${branch}' already exists; resolve the leftover tree/branch manually before retrying (no silent overwrite)`
    );
  }

  if (existsSync(worktreePath)) {
    throw new WorktreeIsolationError(
      "worktree_exists",
      `task worktree path already exists: ${worktreePath}; resolve the leftover tree manually before retrying (no silent overwrite)`
    );
  }

  let add: GitResult;
  try {
    add = await runGit(
      ["worktree", "add", "-b", branch, worktreePath],
      repoRoot
    );
  } catch (err) {
    throw new WorktreeIsolationError(
      "git_unavailable",
      `git is not available (spawn failed): ${errorMessage(err)}`
    );
  }
  if (add.code !== 0) {
    throw new WorktreeIsolationError(
      "worktree_add_failed",
      `git worktree add failed for ${worktreePath} (branch ${branch}): ${
        add.stderr.trim().length > 0 ? add.stderr.trim() : `exit ${add.code}`
      }`
    );
  }
  const conversationId = opts.conversationId;
  if (conversationId !== undefined && conversationId.length > 0) {
    writeOwnerSidecar(worktreePath, conversationId);
  }
  return { worktreePath, branch };
}

// -- mutate classification -------------------------------------------------------

export type MutateClass = "mutate" | "read" | "root_flip";

/**
 * Root-flip lifecycle tools (T7 enter / T8 exit). They do not write workspace
 * files, but their handlers resolve the withLiveTaskRootWrite-wrapped host
 * enter/exit seams, which FLIP the live `taskRoot` cell mid-wave. A mutate
 * later in the same wave would otherwise be adjudicated on the wave-entry
 * snapshot (D2) while its handler consumes the flipped cell — the
 * admit-but-write-other-root window D11 forbids. The gate therefore tracks
 * these calls and fail-closes every subsequent mutate in the wave.
 */
const ROOT_FLIP_TOOLS: ReadonlySet<string> = new Set([
  "enter-task-worktree",
  "exit-task-worktree",
]);

/**
 * Classify one bash command by whether it writes the workspace. A command is
 * `read` only if EVERY top-level segment (split on `;`, `&&`, `||`, `|` by
 * `splitShellSegments`) passes the readonly command policy AND its redirects
 * write nothing to the filesystem AND it spawns no bare-`&` background job.
 * Fail-closed: unknown commands, mutating commands, any `>` / `>>` redirect
 * to a real file, and any bare `&` classify `mutate`.
 *
 * Redirect rules (the delta vs the readonly bash-mode table, which rejects
 * ALL `>`): stderr→stdout merges and /dev/null sinks are pure stream plumbing
 * — `2>&1`, `2>/dev/null`, `1>&2`, `> /dev/null`, `&> /dev/null` keep the
 * segment `read`; any other `>` / `>>` target means the command's output
 * lands in a workspace file → `mutate` (e.g. `echo x > f.txt`).
 *
 * Bare-`&` rule: `splitShellSegments` splits only on `;` `&&` `||` `|`, so in
 * `ls & touch new.txt` the mutating second command rides inside one segment
 * that the policy check would pass on its first token alone. Any `&` that is
 * not part of a redirect token is therefore a background compound → mutate.
 *
 * Deliberately NOT `validateReadonlyCommand`: that validator is the SSOT for
 * `bashMode === "readonly"` (bash.ts) and fail-closes against `2>&1` / pipes
 * composition — a much stricter question ("is this provably side-effect-free
 * in readonly mode") than the gate's ("does this call write the workspace").
 * Complexity guard (ACR): the two semantics stay in separate functions; the
 * gate only borrows the segment splitter and the readonly command policy via
 * `validateSegmentPolicy` so the command whitelist cannot drift.
 */
export function classifyBashWorkspaceWrite(command: string): "read" | "mutate" {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return "mutate";
  return segments.every(
    (segment) =>
      segmentIsPolicyReadonly(segment) &&
      segmentRedirectsNowhere(segment) &&
      segmentHasNoBareBackground(segment)
  )
    ? "read"
    : "mutate";
}

/**
 * Reuse the readonly-mode command policy (allowlist + find/sort/git flag
 * tables) for a single segment: true when the segment's command would be
 * accepted by `validateSegmentPolicy`, false when it throws (execution
 * agents, non-allowlisted commands, mutating git subcommands / flags).
 * Unknown commands → false → fail-closed mutate upstream.
 */
function segmentIsPolicyReadonly(segment: string): boolean {
  try {
    validateSegmentPolicy(segment, segment);
    return true;
  } catch {
    return false;
  }
}

/**
 * Redirect analysis for one policy-passing segment: false when the segment
 * redirects output into a workspace file. `/dev/null` targets and fd merges
 * (`2>&1`, `1>&2`) write nothing to the workspace and stay true. Quoted `>`
 * characters inside the command text are treated as redirects (rare
 * false-positive cost; deny-by-default direction).
 */
function segmentRedirectsNowhere(segment: string): boolean {
  const matches = [...segment.matchAll(/&>>?|\d?>>&?|\d?>&?\d?/g)];
  if (matches.length === 0) return true;
  return matches.every((match) => {
    const redirect = match[0];
    const target = segment
      .slice((match.index ?? 0) + redirect.length)
      .trim()
      .split(/\s+/)[0]!;
    // fd merge (`2>&1`, `1>&2`) or /dev/null sink — pure stream plumbing,
    // no workspace file is created or appended
    return /^\d*>&\d+$/.test(redirect) || target === "/dev/null";
  });
}

/**
 * Bare-`&` background detection for one segment: false when the segment
 * contains an `&` that is NOT part of a redirect token (`2>&1`, `>&2`,
 * `&>`, `&>>`). `splitShellSegments` consumes `&&` but passes bare `&`
 * through, so a background compound (`ls & touch new.txt`) would otherwise
 * hide its second command inside one policy-passing segment — fail-closed
 * to mutate instead (mirror of the readonly table's Strictening 1, minus
 * the redirect forms the gate legitimately allows).
 */
function segmentHasNoBareBackground(segment: string): boolean {
  const withoutRedirects = segment.replace(/&>>?|\d?>&/g, "");
  return !withoutRedirects.includes("&");
}

/**
 * T1 (plans/worktree-live-task-root.md §6 T1) — workspace-mutation classifier
 * SSOT. Single source of truth for "does this tool write to the workspace":
 *
 *   - the canonical list of workspace-writing tool names comes from
 *     `FILE_WRITE_TOOL_NAMES` (symbol-mutate.ts), which is the SAME frozen
 *     list the worker deny-list (catalog.ts) uses and the same set the
 *     registry's Gate-3 append-only check enforces — one name → one
 *     classification, no shadow copies;
 *   - bash is adjudicated by `classifyBashWorkspaceWrite` — the gate's own
 *     workspace-write question ("will any segment or redirect write the
 *     workspace"), NOT the readonly bash-mode table: `validateReadonlyCommand`
 *     remains the SSOT only for `bashMode === "readonly"` (bash.ts). Non-
 *     string bash commands fail closed to mutate;
 *   - read-only tools (read_file / grep / glob / web_fetch / memory_recall /
 *     etc.) and control / lifecycle tools (create-task-worktree /
 *     spawn_subagent / todo_write / …) do not write workspace files and
 *     default to `read`;
 *   - the enter/exit lifecycle tools (enter-task-worktree / exit-task-worktree)
 *     are classified `root_flip`: they do not write workspace files, but their
 *     handlers flip the live `taskRoot` cell mid-wave (via the wrapped host
 *     seams), so the gate latches the flip and fail-closes later mutates in
 *     the same wave (D11). create-task-worktree is NOT in that set: its
 *     wrapped-provision flip only happens on a wave that started at the main
 *     repo, where every mutate is already blocked by the unbound branch.
 *
 * Before T1 the gate used a hardcoded 2-name set (`ALWAYS_MUTATE_TOOLS`),
 * which left the 5 symbol-mutate tools (`rename_symbol` etc.) unclassified
 * → they passed the gate and edited the main repo directly (fail-open).
 * T1 closes that hole by routing on `FILE_WRITE_TOOL_NAMES`, the same SSOT
 * already used by the worker deny-list (catalog.ts) — one name → one
 * classification, no shadow copies.
 *
 * Note on `spawn_subagent`: this default treats it as `read`, but the gate
 * installed by `build-engine.ts:849-872` (`classifyWithSubagentIsolation`)
 * overrides that with a role-aware decision (ADR-0040). That override
 * belongs to the build-engine seam, not the SSOT classifier — it composes
 * with this function via the `classify` opt.
 */
export function classifyCall(call: ToolCall): MutateClass {
  if (ROOT_FLIP_TOOLS.has(call.name)) return "root_flip";
  if ((FILE_WRITE_TOOL_NAMES as ReadonlyArray<string>).includes(call.name)) {
    return "mutate";
  }
  if (call.name === "bash") {
    const command = (call.input as { command?: unknown } | null)?.command;
    if (typeof command !== "string") return "mutate";
    return classifyBashWorkspaceWrite(command);
  }
  return "read";
}

// -- task worktree naming and path shape -----------------------------------------

/**
 * Human-facing task-worktree labels are deliberately narrower than
 * conversation ids. The `--` separator is banned in new labels so it can
 * still invert historical `<slug>--<conversationId>` leaves; new labeled
 * leaves do not encode identity in the folder name.
 */
export const SAFE_WORKTREE_SLUG_RE =
  /^(?=.{2,40}$)(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface TaskWorktreeLabelResolution {
  readonly label: string | undefined;
  readonly reason?: string;
}

/**
 * Resolve a model-supplied label once for all path/branch consumers.
 * Invalid values intentionally fall back to the historical UUID-only shape.
 */
export function resolveTaskWorktreeLabel(
  name: unknown
): TaskWorktreeLabelResolution {
  if (name === undefined) return { label: undefined };
  if (typeof name !== "string") {
    return {
      label: undefined,
      reason: "name must be a string",
    };
  }
  if (name.length > 40) {
    return {
      label: undefined,
      reason: "name exceeds the maximum length of 40 characters",
    };
  }
  if (!SAFE_WORKTREE_SLUG_RE.test(name)) {
    return {
      label: undefined,
      reason:
        "name must be lowercase kebab-case, 2-40 characters, with alphanumeric edges and no consecutive hyphens",
    };
  }
  return { label: name };
}

/**
 * Build the task-worktree path. This is the naming SSOT shared by the
 * provisioner, enter/list/remove consumers, and the isolation gate's
 * ownership inversion.
 *
 * A valid label is the leaf (`<slug>`). conversationId is not encoded in
 * the folder name; identity is the gitdir sidecar (and the historical
 * `<slug>--<conversationId>` / UUID-only leaves still invert from the path).
 * Duplicate labels collide on this path and fail closed at `worktree_exists`.
 */
export function taskWorktreePath(
  repoRoot: string,
  conversationId: string,
  label?: string
): string {
  const resolved = resolveTaskWorktreeLabel(label);
  const leaf = resolved.label === undefined ? conversationId : resolved.label;
  return join(repoRoot, ".iknow", "worktrees", leaf);
}

/** Build the task branch name from the same validated label decision. */
export function taskWorktreeBranch(
  conversationId: string,
  label?: string
): string {
  const resolved = resolveTaskWorktreeLabel(label);
  return resolved.label === undefined
    ? `iknow/task-${conversationId}`
    : `iknow/task/${resolved.label}-${conversationId.slice(0, 8)}`;
}

const OWNER_SIDECAR_NAME = "iknow-conversation-id";

/**
 * True when `root` is shaped as `<any>/.iknow/worktrees/<leaf>`.
 * Shape only — not identity. Labeled name-only leaves still match.
 */
export function isTaskWorktreePath(root: string): boolean {
  if (root.length === 0) return false;
  return (
    basename(dirname(root)) === "worktrees" &&
    basename(dirname(dirname(root))) === ".iknow"
  );
}

function parseGitdirPointer(gitMeta: string): string | undefined {
  const match = /^gitdir:\s*(.+)$/m.exec(gitMeta);
  const gitdir = match?.[1]?.trim();
  return gitdir !== undefined && gitdir.length > 0 ? gitdir : undefined;
}

function writeOwnerSidecar(worktreePath: string, conversationId: string): void {
  const gitFile = join(worktreePath, ".git");
  let gitMeta: string;
  try {
    gitMeta = readFileSync(gitFile, "utf8");
  } catch (err) {
    throw new WorktreeIsolationError(
      "worktree_add_failed",
      `task worktree ${worktreePath} has no readable .git pointer after add: ${errorMessage(err)}`
    );
  }
  const gitdir = parseGitdirPointer(gitMeta);
  if (gitdir === undefined) {
    throw new WorktreeIsolationError(
      "worktree_add_failed",
      `task worktree ${worktreePath} .git pointer is not a gitdir file; cannot record conversation ownership`
    );
  }
  try {
    writeFileSync(join(gitdir, OWNER_SIDECAR_NAME), `${conversationId}\n`, {
      encoding: "utf8",
    });
  } catch (err) {
    throw new WorktreeIsolationError(
      "worktree_add_failed",
      `cannot write ownership sidecar for ${worktreePath}: ${errorMessage(err)}`
    );
  }
}

function ownerFromGitdirSidecar(root: string): string | undefined {
  const gitFile = join(root, ".git");
  if (!existsSync(gitFile)) return undefined;
  let gitMeta: string;
  try {
    gitMeta = readFileSync(gitFile, "utf8");
  } catch {
    // EXIT: .git pointer unreadable — fall through to path inversion
    return undefined;
  }
  const gitdir = parseGitdirPointer(gitMeta);
  if (gitdir === undefined) return undefined;
  const sidecar = join(gitdir, OWNER_SIDECAR_NAME);
  if (!existsSync(sidecar)) return undefined;
  try {
    const id = readFileSync(sidecar, "utf8").trim();
    return SAFE_CONVERSATION_ID_RE.test(id) ? id : undefined;
  } catch {
    // EXIT: sidecar unreadable — fall through to path inversion
    return undefined;
  }
}

/** Return the decorative label from a task-worktree leaf, if present. */
export function taskWorktreeLabelOf(root: string): string | undefined {
  if (!isTaskWorktreePath(root)) return undefined;
  const leaf = basename(root);
  const separator = leaf.lastIndexOf("--");
  if (separator > 0) {
    const label = leaf.slice(0, separator);
    const owner = leaf.slice(separator + 2);
    return SAFE_CONVERSATION_ID_RE.test(owner) &&
      resolveTaskWorktreeLabel(label).label === label
      ? label
      : undefined;
  }
  const sidecarOwner = ownerFromGitdirSidecar(root);
  if (
    sidecarOwner !== undefined &&
    sidecarOwner !== leaf &&
    resolveTaskWorktreeLabel(leaf).label === leaf
  ) {
    return leaf;
  }
  return undefined;
}

/**
 * Ownership anchor for task-worktree naming.
 *
 * Identity sources, first match wins:
 *   1. gitdir sidecar `iknow-conversation-id` (name-only labeled leaves);
 *   2. historical `<slug>--<conversationId>` suffix;
 *   3. UUID-only / unlabeled leaf (the whole basename).
 */
export function taskWorktreeOwnerOf(root: string): string | undefined {
  if (!isTaskWorktreePath(root)) return undefined;
  const sidecar = ownerFromGitdirSidecar(root);
  if (sidecar !== undefined) return sidecar;
  const leaf = basename(root);
  const separator = leaf.lastIndexOf("--");
  const owner = separator === -1 ? leaf : leaf.slice(separator + 2);
  return SAFE_CONVERSATION_ID_RE.test(owner) ? owner : undefined;
}

/**
 * T6 (plans/worktree-session-roots.md / ADR-0037 §4): the stable main checkout
 * that owns `root` — `root` itself when it is not task-worktree-shaped,
 * otherwise the repo three levels up (`<main>/.iknow/worktrees/<leaf>`).
 *
 * This is the `productRoot` derivation hosts need when they hold **only** a
 * session root: after a rebind (and after a restart that resumes a session
 * already anchored on a tree) the session root is the tree, and identity /
 * per-root state must still resolve to the main checkout. Same naming SSOT as
 * `isTaskWorktreePath`, so it is a pure path derivation — no git call, no
 * `process.cwd()` fallback.
 */
export function mainCheckoutOf(root: string): string {
  return isTaskWorktreePath(root) ? dirname(dirname(dirname(root))) : root;
}

// -- gate executor ----------------------------------------------------------------

/**
 * Segment-safety gate for conversation ids that reach a worktree path or
 * branch name (SSOT; session-api worktree-rebind re-exports it). Contract:
 * first char alphanumeric; remainder alphanumeric / `_` / `-` — rejects path
 * traversal (`..`, `a/b`), leading dashes/dots, whitespace / shell
 * metacharacters, and empty strings. The T7 enter-task-worktree tool runs
 * this against its model-supplied `conversationId` BEFORE any host call.
 */
export const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface WorktreeProvisionContext {
  /** Owning conversation (from the executor call chain); undefined = anonymous. */
  readonly conversationId?: string;
  /** This engine's root (the session's current root when the turn started). */
  readonly root: string;
  /**
   * Optional model-supplied task label. The provisioner validates it against
   * `SAFE_WORKTREE_SLUG_RE`; invalid labels are deliberately discarded rather
   * than turning a recoverable tool call into a protocol failure.
   */
  readonly name?: unknown;
}

/**
 * Host provision seam shape (SSOT): resolves with the rebound session root
 * (the task worktree path); rejects with typed `WorktreeIsolationError`.
 * Shared by the gate's host opts, the `create-task-worktree` ACI tool deps,
 * and the session-api provisioner — no per-module structural copies.
 */
export type WorktreeProvisionFn = (
  ctx: WorktreeProvisionContext
) => Promise<string>;

/**
 * T7 explicit-enter seam context: a session (conversationId) anchored at the
 * main repo (root) adopts the EXISTING task worktree owned by
 * `targetConversationId`. The target path is resolved from the repository's
 * task-worktree listing, using either the owner's id or a unique label; the
 * tool takes a selector, never a free-form path.
 */
export interface WorktreeEnterContext {
  /** Calling conversation (the session that moves onto the target tree). */
  readonly conversationId?: string;
  /** The caller's current engine root — the main repo (path SSOT base). */
  readonly root: string;
  /** Owner conversation id whose task worktree to enter. */
  readonly targetConversationId: string;
}

/**
 * T7 host enter seam shape (SSOT): resolves with the entered task worktree
 * path; rejects with typed `WorktreeIsolationError`
 * (worktree_not_found / foreign_worktree / rebind_failed / git_unavailable).
 * Shared by the host opts, the `enter-task-worktree` ACI tool deps, and the
 * session-api provisioner — no per-module structural copies.
 */
export type WorktreeEnterFn = (ctx: WorktreeEnterContext) => Promise<string>;

/**
 * T8 symmetric-exit seam context: the session (conversationId) currently
 * executing on `root` returns to the main repo root. No target input — the
 * tree is identified by the engine root / the session's durable rebind
 * record; the main repo root is derived from the tree itself.
 */
export interface WorktreeExitContext {
  /** Calling conversation (the session that leaves the task worktree). */
  readonly conversationId?: string;
  /** The caller's current engine root (the task worktree being exited). */
  readonly root: string;
}

/**
 * T8 host exit seam shape (SSOT): resolves with the session's main repo
 * root; rejects with typed `WorktreeIsolationError` (rebind_failed /
 * git_unavailable). The tree is preserved (orphan cleanup is a plan
 * non-goal). Shared by the host opts, the `exit-task-worktree` ACI tool
 * deps, and the session-api provisioner — no per-module structural copies.
 */
export type WorktreeExitFn = (ctx: WorktreeExitContext) => Promise<string>;

/** A read-only projection of one task worktree or stale task branch. */
export interface TaskWorktreeInfo {
  /** Human-facing label; absent for legacy UUID-only leaves. */
  readonly label: string | undefined;
  /** Conversation identity recovered from the leaf or branch name. */
  readonly conversationId: string;
  /** Linked checkout path; empty for a branch with no active worktree. */
  readonly path: string;
  /** Local task branch name. */
  readonly branch: string;
  /** HEAD commit at inspection time. */
  readonly head: string;
  /** Whether the linked checkout has visible working-tree changes. */
  readonly dirty: boolean;
  /** Present only when the entry came from an orphaned task branch. */
  readonly stale?: true;
}

export interface WorktreeListContext {
  /** Current engine root; task roots are mapped back to their main checkout. */
  readonly root: string;
  readonly includeStale?: boolean;
}

/** Host seam for the read-only task-worktree listing tool. */
export type WorktreeListFn = (
  ctx: WorktreeListContext
) => Promise<ReadonlyArray<TaskWorktreeInfo>>;

export interface WorktreeRemoval {
  readonly label: string | undefined;
  readonly conversationId: string;
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  readonly branchDeleted: boolean;
}

export interface WorktreeRemoveContext {
  /** Current session root, used to reject removing the caller's active tree. */
  readonly root: string;
  /** Caller conversation id, for audit/context only. */
  readonly conversationId?: string;
  /** A conversation id or a task-worktree label. */
  readonly targetConversationId: string;
  readonly deleteBranch?: boolean;
}

/** Host seam for explicit task-worktree removal. */
export type WorktreeRemoveFn = (
  ctx: WorktreeRemoveContext
) => Promise<WorktreeRemoval>;

/**
 * Host-facing options the assembly (build-engine) threads through: the
 * switch itself is read once at the startup load point
 * (`resolveWorktreeOnMutate(settings)`), the host supplies only the provision
 * seam. Passthrough for a session already on its task worktree is anchored
 * PER CONVERSATION inside `provision` (T4) — the host must not blanket-mark
 * an engine "bound" when several conversations can share a root.
 */
export interface WorktreeIsolationHostOpts {
  readonly provision: WorktreeProvisionFn;
  /**
   * T7 explicit-enter seam (session-api hub / CLI provisioner). Present → the
   * `enter-task-worktree` ACI tool enters the registry (alongside
   * `create-task-worktree`); absent (worker assembly, hub-less inlets) →
   * excluded via the Gate 3 mirror filter. The gate itself never calls it —
   * enter is a model-invoked tool, and its durable rebind record is what the
   * `provision` adjudication later adopts.
   */
  readonly worktreeEnter?: WorktreeEnterFn;
  /**
   * T8 symmetric-exit seam (session-api hub / CLI provisioner). Present →
   * the `exit-task-worktree` ACI tool enters the registry; absent (worker
   * assembly, hub-less inlets) → excluded via the Gate 3 mirror filter. The
   * gate itself never calls it — exit is a model-invoked tool whose durable
   * rebind record puts the session back under the unbound gate on the main
   * repo.
   */
  readonly worktreeExit?: WorktreeExitFn;
  /**
   * Read-only task-tree discovery. It is intentionally independent from the
   * mutate gate and is registered only when this host supplies the seam.
   */
  readonly worktreeList?: WorktreeListFn;
  /**
   * Explicit task-tree removal. The host performs dirty/unpublished/current
   * root checks before invoking git worktree remove.
   */
  readonly worktreeRemove?: WorktreeRemoveFn;
}

export interface WorktreeIsolationGateOpts {
  /** Startup read (hard req 9): assembly passes `resolveWorktreeOnMutate(settings)`. */
  readonly enabled: boolean;
  /**
   * T10 (plans/worktree-live-task-root.md §6 T10 / D1/D2) — live `taskRoot`
   * cell (T4 SSOT). The gate snapshots `cell.read()` ONCE at `executeAll`
   * entry; the whole wave shares that snapshot. Why snapshot, not per-call:
   *
   *   - D2 (batch 快照): 一波 tool calls 只能有一个根 — 否则 create-task-worktree
   *     在同波翻转时把一次逻辑改动劈进两棵树,违 least astonishment。rebind
   *     因此对**下一波** tool calls 生效,不是同波。
   *   - D11 (排序不变量): 门禁裁决用的根必须等于消费者用的根。单波内 cell
   *     会被生命周期工具翻转 — create-task-worktree 在 gate 之前的 unbound
   *     分支就被拦（main-repo 波内后续 mutate 本来就 block），而 enter/exit
   *     以 `root_flip` 分类直达 inner 并经 `withLiveTaskRootWrite` 缝翻
   *     cell；对这两者之后的 mutate，gate 以 `rootFlipped` latch fail-closed
   *     拦下（`rootFlipMutateNotice`），保证被放行的每条 mutate 的
   *     handler 读到的 cell 值就是门禁裁决用的快照值 — 不出现
   *     admit-but-write-other-root 窗口。
   *
   * 写仍然由 `withLiveTaskRootWrite` 缝包裹 host `provision` / `enter` /
   * `exit` 单点写入(T4 SSOT) — 本字段是**读取面**入口。
   */
  readonly liveTaskRoot: LiveTaskRoot;
  /**
   * Host seam (session-api). T3 model-provision contract: the gate calls this
   * ONLY for engines rooted at a task-worktree-shaped path (post-rebind), as
   * the per-conversation passthrough adjudicator — the session's own tree
   * resolves to the same root (zero-side-effect no-op), a foreign root
   * rejects with typed `foreign_worktree`. The creation path of the
   * underlying host provisioner is reserved for the create-task-worktree ACI
   * tool (T4): the gate NEVER routes main-repo traffic here, so no
   * `git worktree add` is ever triggered by a blocked mutate. MUST be
   * idempotent per conversation — the gate coalesces concurrent callers onto
   * one invocation.
   */
  readonly provision: WorktreeProvisionFn;
  /**
   * Engine built on a root that already is a task worktree (rebound engine).
   * Harness-level prior for embeddings that serve EXACTLY the conversation
   * owning this root (e.g. a single-session CLI engine). Multi-conversation
   * hosts (session-api hub) must NOT set it — per-conversation passthrough is
   * adjudicated by `provision` (T4: own task tree → same-root no-op; foreign
   * root → typed `foreign_worktree`).
   *
   * The bound-root is initialised to the wave-entry snapshot of
   * `liveTaskRoot`, so a pre-rebound CLI engine whose cell starts at the
   * task worktree path goes straight to passthrough.
   */
  readonly initiallyBound?: boolean;
  readonly classify?: (call: ToolCall) => MutateClass;
  /** Failure observability (typed error instance; the model still gets the block). */
  readonly onError?: (err: WorktreeIsolationError) => void;
}

interface GateSessionState {
  readonly status: "open" | "pending" | "bound";
  readonly pending?: Promise<string>;
  readonly boundRoot?: string;
}

/**
 * Wrap an executor with the mutate gate (model-provision contract, ADR-0037
 * amendment). Read calls and switch-OFF traffic pass through untouched. For
 * mutates:
 *
 *   - unbound session on a NON-task-worktree root (main repo) → blocked with
 *     the create-task-worktree ACI-tool notice; `provision` is never called,
 *     so no `git worktree add` runs and the main repo sees zero writes. The
 *     block is side-effect free and idempotent — every mutate re-blocks until
 *     the model provisions (T4 tool) and the host rebinds the session root;
 *   - engine rooted at a task-worktree-shaped path → per-conversation
 *     adjudication via `provision`, coalesced onto a single invocation per
 *     conversation (boundary c idempotency):
 *
 *       - provision resolved to this engine's root → passthrough (mutates
 *         land in the worktree the engine is rooted at);
 *       - provision resolved elsewhere → the call is blocked with a visible
 *         rebind notice (stale-root tools must not write the old root);
 *       - provision failed → blocked with the typed `kind=<kind>` message;
 *         state resets so the next mutate retries (still fail-closed).
 */
export function createWorktreeIsolationExecutor(
  opts: WorktreeIsolationGateOpts & { readonly inner: Executor }
): Executor {
  const { enabled, liveTaskRoot, provision, initiallyBound, inner } = opts;
  const classify = opts.classify ?? classifyCall;
  const states = new Map<string, GateSessionState>();

  const stateFor = (
    conversationId: string | undefined,
    snapshotRoot: string
  ): GateSessionState => {
    const key = conversationId ?? "";
    const hit = states.get(key);
    if (hit) return hit;
    const fresh: GateSessionState = initiallyBound
      ? { status: "bound", boundRoot: snapshotRoot }
      : { status: "open" };
    states.set(key, fresh);
    return fresh;
  };

  const setState = (
    conversationId: string | undefined,
    next: GateSessionState
  ): void => {
    states.set(conversationId ?? "", next);
  };

  const block = (toolUseId: string, message: string): ToolExecutionResult => ({
    kind: "execution_failed",
    toolUseId,
    message,
  });

  const reboundMessage = (boundRoot: string): string =>
    `${WORKTREE_ISOLATION_PREFIX} session workspace rebound to task worktree ${boundRoot}; ` +
    `this call was not executed — the previous root stays read-only. The next wave of tool calls ` +
    `in this run will land in the new root, re-issue the write then.`;

  async function gateMutate(
    call: ToolCall,
    conversationId: string | undefined,
    snapshotRoot: string
  ): Promise<ToolExecutionResult | undefined> {
    let state = stateFor(conversationId, snapshotRoot);
    if (state.status === "bound" && state.boundRoot === snapshotRoot) {
      return undefined; // passthrough
    }
    // T3 model-provision contract: a session on a non-task-worktree root
    // (main repo) can never be bound — block with the ACI-tool notice and
    // NEVER provision (no `git worktree add` on the execution path). The
    // block is side-effect free; state stays open so later mutates re-block.
    //
    // T10: `root` here is the **wave snapshot** of `liveTaskRoot` taken at
    // executeAll entry (D2). mid-wave flips (create-task-worktree) do not
    // change this snapshot — rebind takes effect on the NEXT wave.
    if (state.status === "open" && !isTaskWorktreePath(snapshotRoot)) {
      return block(call.id, unboundMutateNotice());
    }
    if (state.status === "open") {
      const pending = provision({ conversationId, root: snapshotRoot });
      setState(conversationId, { status: "pending", pending });
      state = { status: "pending", pending };
    }
    if (state.status === "pending") {
      let boundRoot: string;
      try {
        boundRoot = await state.pending!;
      } catch (err) {
        const typed =
          err instanceof WorktreeIsolationError
            ? err
            : new WorktreeIsolationError("rebind_failed", errorMessage(err));
        opts.onError?.(typed);
        setState(conversationId, { status: "open" }); // retry allowed, still fail-closed
        return block(
          call.id,
          `${WORKTREE_ISOLATION_PREFIX} kind=${typed.kind} ${typed.detail}`
        );
      }
      setState(conversationId, { status: "bound", boundRoot });
      if (boundRoot === snapshotRoot) return undefined; // already home
      return block(call.id, reboundMessage(boundRoot));
    }
    // bound elsewhere (defensive: host rebound the session away from this root)
    return block(call.id, reboundMessage(state.boundRoot ?? snapshotRoot));
  }

  const runAll = async (
    calls: ReadonlyArray<ToolCall>,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string,
    onSettled?: (
      result: ToolExecutionResult,
      index: number
    ) => void | Promise<void>,
    turnId?: string,
    onStream?: (event: import("../stream.js").HarnessStreamEvent) => void
  ): Promise<ReadonlyArray<ToolExecutionResult>> => {
    if (!enabled) {
      return inner.executeAll(
        calls,
        signal,
        timeoutMs,
        conversationId,
        onSettled,
        turnId,
        onStream
      );
    }
    // T10 D2: snapshot live taskRoot ONCE at executeAll entry. The whole wave
    // shares this value so:
    //   (a) mid-wave flips (create-task-worktree) cannot split the wave
    //     between two roots — one wave = one root (least astonishment);
    //   (b) gate adjudication root == consumer handler root (D11 invariant:
    //     gate admits → consumer writes to the same root). Within a single
    //     wave the cell can be flipped by the lifecycle tools (create- /
    //     enter- / exit-task-worktree) whose handlers resolve the wrapped
    //     host seams. Those calls go through inner directly (classified
    //     "read" / "root_flip", not "mutate"), and mutates AFTER a
    //     enter/exit flip are fail-closed blocked below (rootFlipped latch),
    //     so a handler's `cell.read()` at call time observes the same root
    //     the gate adjudicated for that call.
    const snapshotRoot = liveTaskRoot.read();
    let anyMutate = false;
    for (const call of calls) {
      if (classify(call) === "mutate") {
        anyMutate = true;
        break;
      }
    }
    if (!anyMutate) {
      return inner.executeAll(
        calls,
        signal,
        timeoutMs,
        conversationId,
        onSettled,
        turnId,
        onStream
      );
    }
    // mixed / mutating batch: per-call gating (read calls still batched one
    // by one so onSettled keeps the input index alignment)
    const out: ToolExecutionResult[] = [];
    // D11 (review fix): enter/exit-task-worktree are classified `root_flip`
    // — they pass through to inner but their handlers flip the live cell
    // mid-wave via the withLiveTaskRootWrite-wrapped host seams. A mutate
    // AFTER such a call would be adjudicated on the wave-entry snapshot
    // while its handler consumes the flipped cell (admit-but-write-other-
    // root window). Fail-closed: the mutate is blocked and re-issued in the
    // next wave. Mutates BEFORE the flip keep the snapshot==cell match.
    let rootFlipped = false;
    let rootFlipTool: string | undefined;
    for (const [index, call] of calls.entries()) {
      let result: ToolExecutionResult;
      const cls = classify(call);
      if (cls === "root_flip") {
        [result] = await inner.executeAll(
          [call],
          signal,
          timeoutMs,
          conversationId,
          undefined,
          turnId,
          onStream
        );
        rootFlipped = true;
        rootFlipTool = call.name;
      } else if (cls === "read") {
        [result] = await inner.executeAll(
          [call],
          signal,
          timeoutMs,
          conversationId,
          undefined,
          turnId,
          onStream
        );
      } else if (rootFlipped) {
        result = block(
          call.id,
          rootFlipMutateNotice(rootFlipTool ?? "a root-flip lifecycle tool")
        );
      } else {
        const blocked = await gateMutate(call, conversationId, snapshotRoot);
        result =
          blocked ??
          (
            await inner.executeAll(
              [call],
              signal,
              timeoutMs,
              conversationId,
              undefined,
              turnId,
              onStream
            )
          )[0]!;
      }
      await onSettled?.(result, index);
      out.push(result);
    }
    return out;
  };

  return Object.freeze({
    executeAll: runAll,
  });
}
