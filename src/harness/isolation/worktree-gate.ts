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
 *     (`taskWorktreeOwnerOf`) lives here because the gate routes on it —
 *     session-api re-exports it as the single SSOT.
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
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { errorMessage } from "../errors.js";
import { validateReadonlyCommand } from "../aci/tools/bash-readonly.js";
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
 * Unbound-mutate block notice: visible, actionable, and free of the old
 * auto-provision protocol wording ("end the turn and retry").
 */
export function unboundMutateNotice(): string {
  return (
    `${WORKTREE_ISOLATION_PREFIX} workspace mutation blocked: worktree isolation is ON and this session is not yet bound to a task worktree. ` +
    `Call the ${CREATE_TASK_WORKTREE_TOOL_HINT} to create this conversation's task worktree and rebind the session root, ` +
    `then re-issue this write in the new root. The main repo stays read-only until the rebind lands (no auto-provisioning).`
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
  | "worktree_not_found";

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

/** Production runner: `git <args>` in `cwd`. Spawn errors propagate as throws. */
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8" },
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
  readonly runGit?: GitRunner;
}

export interface TaskWorktree {
  readonly worktreePath: string;
  readonly branch: string;
}

/**
 * Create a task worktree on a NEW branch, deterministically and fail-closed:
 *
 *   1. `rev-parse --is-inside-work-tree` — not a repo (or bare) →
 *      `not_a_git_repo`; git binary missing → `git_unavailable`.
 *   2. branch already exists → `branch_exists` (never repointed/overwritten;
 *      never checked out into another worktree's place — hard req ①/②).
 *   3. worktree path exists → `worktree_exists`.
 *   4. `worktree add -b <branch> <path>` — failure → `worktree_add_failed`
 *      with git's stderr in the message.
 *
 * The main repo's HEAD and current branch are never moved: `-b` creates the
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
    probe = await runGit(["rev-parse", "--is-inside-work-tree"], repoRoot);
  } catch (err) {
    throw new WorktreeIsolationError(
      "git_unavailable",
      `git is not available (spawn failed): ${errorMessage(err)}`
    );
  }
  if (probe.code !== 0 || probe.stdout.trim() !== "true") {
    throw new WorktreeIsolationError(
      "not_a_git_repo",
      `not a git repository (worktree isolation requires one): ${repoRoot}${
        probe.stderr.trim().length > 0 ? ` — ${probe.stderr.trim()}` : ""
      }`
    );
  }

  const branchProbe = await runGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    repoRoot
  );
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

  const add = await runGit(
    ["worktree", "add", "-b", branch, worktreePath],
    repoRoot
  );
  if (add.code !== 0) {
    throw new WorktreeIsolationError(
      "worktree_add_failed",
      `git worktree add failed for ${worktreePath} (branch ${branch}): ${
        add.stderr.trim().length > 0 ? add.stderr.trim() : `exit ${add.code}`
      }`
    );
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
 * T1 (plans/worktree-live-task-root.md §6 T1) — workspace-mutation classifier
 * SSOT. Single source of truth for "does this tool write to the workspace":
 *
 *   - the canonical list of workspace-writing tool names comes from
 *     `FILE_WRITE_TOOL_NAMES` (symbol-mutate.ts), which is the SAME frozen
 *     list the worker deny-list (catalog.ts) uses and the same set the
 *     registry's Gate-3 append-only check enforces — one name → one
 *     classification, no shadow copies;
 *   - bash is a mutate unless its command passes the readonly command
 *     validator (the same SSOT the readonly bash mode uses); non-string
 *     bash commands fail closed to mutate;
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
    try {
      validateReadonlyCommand(command);
      return "read";
    } catch {
      return "mutate";
    }
  }
  return "read";
}

// -- task worktree path shape -----------------------------------------------------

/**
 * Ownership anchor for the deterministic task-worktree naming
 * (`<any>/.iknow/worktrees/<conversationId>`, session-api provisioner SSOT):
 * returns the owning conversationId when `root` IS a task-worktree path,
 * undefined otherwise.
 *
 * The GATE routes on this predicate (T3 model-provision contract): a mutate
 * arriving at an engine whose root is NOT task-worktree-shaped can never be a
 * bound session (bound roots are always shaped), so it is blocked with the
 * ACI-tool notice and `provision` is never invoked — structurally impossible
 * for the gate to auto-run `git worktree add`. A shaped root goes through the
 * per-conversation `provision` adjudication (own tree → same-root no-op
 * passthrough; foreign → typed `foreign_worktree`). session-api re-exports
 * this function for its provisioner and read-only display consumers.
 */
export function taskWorktreeOwnerOf(root: string): string | undefined {
  if (basename(dirname(root)) !== "worktrees") return undefined;
  if (basename(dirname(dirname(root))) !== ".iknow") return undefined;
  return basename(root);
}

/**
 * T6 (plans/worktree-session-roots.md / ADR-0037 §4): the stable main checkout
 * that owns `root` — `root` itself when it is not task-worktree-shaped,
 * otherwise the repo three levels up (`<main>/.iknow/worktrees/<conv>`).
 *
 * This is the `productRoot` derivation hosts need when they hold **only** a
 * session root: after a rebind (and after a restart that resumes a session
 * already anchored on a tree) the session root is the tree, and identity /
 * per-root state must still resolve to the main checkout. Same naming SSOT as
 * `taskWorktreeOwnerOf`, so it is a pure path derivation — no git call, no
 * `process.cwd()` fallback.
 */
export function mainCheckoutOf(root: string): string {
  return taskWorktreeOwnerOf(root) === undefined
    ? root
    : dirname(dirname(dirname(root)));
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
 * `targetConversationId`. The target path is SSOT-derived
 * (`taskWorktreePath(root, targetConversationId)`) — the tool takes the
 * owner's id, never a free-form path.
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
    if (
      state.status === "open" &&
      taskWorktreeOwnerOf(snapshotRoot) === undefined
    ) {
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
        result = block(call.id, rootFlipMutateNotice(rootFlipTool ?? "a root-flip lifecycle tool"));
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
