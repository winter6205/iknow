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
import type { Executor, ToolCall, ToolExecutionResult } from "../tools/types.js";

/** Visible message prefix for every gate-produced block (SSOT for tests). */
export const WORKTREE_ISOLATION_PREFIX = "[worktree_isolation]";

/**
 * Hint the gate emits on unbound mutates (T3 model-provision contract): the
 * model must call the create-task-worktree ACI tool (T4) — the gate never
 * auto-creates. T4's tool name/registration must align with this wording.
 */
export const CREATE_TASK_WORKTREE_TOOL_HINT = "create-task-worktree ACI tool";

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
        if (err && (err as NodeJS.ErrnoException).code !== undefined && typeof (err as NodeJS.ErrnoException).code === "number") {
          // git exited non-zero — a normal result, not a spawn failure
          resolve({ code: err.code as number, stdout: String(stdout), stderr: String(stderr) });
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

export type MutateClass = "mutate" | "read";

const ALWAYS_MUTATE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * Deterministic workspace-mutation classifier (SSOT reuse): write_file /
 * edit_file are mutates; bash is a mutate unless its command passes the
 * readonly command validator (the same SSOT the readonly bash mode uses);
 * non-string bash commands fail closed to mutate; everything else is a read
 * path and stays on the main repo (reads may remain per contract).
 */
export function classifyCall(call: ToolCall): MutateClass {
  if (ALWAYS_MUTATE_TOOLS.has(call.name)) return "mutate";
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
export type WorktreeProvisionFn = (ctx: WorktreeProvisionContext) => Promise<string>;

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
}

export interface WorktreeIsolationGateOpts {
  /** Startup read (hard req 9): assembly passes `resolveWorktreeOnMutate(settings)`. */
  readonly enabled: boolean;
  /** This engine's root — the bound-tree comparison anchor. */
  readonly root: string;
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
  const { enabled, root, provision, initiallyBound, inner } = opts;
  const classify = opts.classify ?? classifyCall;
  const states = new Map<string, GateSessionState>();

  const stateFor = (conversationId: string | undefined): GateSessionState => {
    const key = conversationId ?? "";
    const hit = states.get(key);
    if (hit) return hit;
    const fresh: GateSessionState = initiallyBound
      ? { status: "bound", boundRoot: root }
      : { status: "open" };
    states.set(key, fresh);
    return fresh;
  };

  const setState = (conversationId: string | undefined, next: GateSessionState): void => {
    states.set(conversationId ?? "", next);
  };

  const block = (toolUseId: string, message: string): ToolExecutionResult => ({
    kind: "execution_failed",
    toolUseId,
    message,
  });

  const reboundMessage = (boundRoot: string): string =>
    `${WORKTREE_ISOLATION_PREFIX} session workspace rebound to task worktree ${boundRoot}; this call was not executed and the previous root stays read-only — end the turn and retry the write in the new root.`;

  async function gateMutate(
    call: ToolCall,
    conversationId: string | undefined
  ): Promise<ToolExecutionResult | undefined> {
    let state = stateFor(conversationId);
    if (state.status === "bound" && state.boundRoot === root) {
      return undefined; // passthrough
    }
    // T3 model-provision contract: a session on a non-task-worktree root
    // (main repo) can never be bound — block with the ACI-tool notice and
    // NEVER provision (no `git worktree add` on the execution path). The
    // block is side-effect free; state stays open so later mutates re-block.
    if (state.status === "open" && taskWorktreeOwnerOf(root) === undefined) {
      return block(call.id, unboundMutateNotice());
    }
    if (state.status === "open") {
      const pending = provision({ conversationId, root });
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
      if (boundRoot === root) return undefined; // already home
      return block(call.id, reboundMessage(boundRoot));
    }
    // bound elsewhere (defensive: host rebound the session away from this root)
    return block(call.id, reboundMessage(state.boundRoot ?? root));
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
      return inner.executeAll(calls, signal, timeoutMs, conversationId, onSettled, turnId, onStream);
    }
    let anyMutate = false;
    for (const call of calls) {
      if (classify(call) === "mutate") {
        anyMutate = true;
        break;
      }
    }
    if (!anyMutate) {
      return inner.executeAll(calls, signal, timeoutMs, conversationId, onSettled, turnId, onStream);
    }
    // mixed / mutating batch: per-call gating (read calls still batched one
    // by one so onSettled keeps the input index alignment)
    const out: ToolExecutionResult[] = [];
    for (const [index, call] of calls.entries()) {
      let result: ToolExecutionResult;
      if (classify(call) === "read") {
        [result] = await inner.executeAll([call], signal, timeoutMs, conversationId, undefined, turnId, onStream);
      } else {
        const blocked = await gateMutate(call, conversationId);
        result = blocked ?? (await inner.executeAll([call], signal, timeoutMs, conversationId, undefined, turnId, onStream))[0]!;
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
