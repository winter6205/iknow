/**
 * src/harness/isolation/worktree-gate.ts
 *
 * ADR-0037 / plans/worktree-isolation-on-mutate.md T3 — mutate gate at the
 * harness executor seam: when the isolation switch is ON and the session is
 * still on the main checkout, the first workspace-mutating tool call is
 * intercepted, the host provisions a per-session task worktree (git layer
 * below) and rebinds the session root (host seam), and subsequent turns run
 * on the worktree-rooted engine where mutates pass through.
 *
 * Module boundary (ACR bounded-context-guardian):
 *   - this module owns ONLY the gate + git layer; it holds no session state
 *     beyond the per-conversation provisioning latch, reads no settings and
 *     imports no session-api code. The host (session-api) supplies the
 *     `provision` callback that creates the tree and rebinds the session.
 *
 * Failure semantics (ADR-0037 §6, fail-closed):
 *   - every failure exits as a typed `WorktreeIsolationError` (non-empty,
 *     visible message) and the intercepted call NEVER reaches the tool
 *     handler — the main repo gets zero writes;
 *   - a successful rebind on a stale-root engine still blocks the in-flight
 *     call (the tools below this executor still target the old root); the
 *     model is told the session moved and the next turn runs on the new
 *     worktree-rooted engine where mutates pass through (hard req: create
 *     without effective rebind = invalid).
 *
 * Switch OFF → `createWorktreeIsolationExecutor` is not wired by the
 * assembly (build-engine), i.e. byte-identical to today's behavior.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { errorMessage } from "../errors.js";
import { validateReadonlyCommand } from "../aci/tools/bash-readonly.js";
import type { Executor, ToolCall, ToolExecutionResult } from "../tools/types.js";

/** Visible message prefix for every gate-produced block (SSOT for tests). */
export const WORKTREE_ISOLATION_PREFIX = "[worktree_isolation]";

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
  | "foreign_worktree";

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

// -- gate executor ----------------------------------------------------------------

export interface WorktreeProvisionContext {
  /** Owning conversation (from the executor call chain); undefined = anonymous. */
  readonly conversationId?: string;
  /** This engine's root (the session's current root when the turn started). */
  readonly root: string;
}

/**
 * Host-facing options the assembly (build-engine) threads through: the
 * switch itself is read once at the startup load point
 * (`resolveWorktreeOnMutate(settings)`), the host supplies only the provision
 * seam. Passthrough for a session already on its task worktree is anchored
 * PER CONVERSATION inside `provision` (T4) — the host must not blanket-mark
 * an engine "bound" when several conversations can share a root.
 */
export interface WorktreeIsolationHostOpts {
  readonly provision: (ctx: WorktreeProvisionContext) => Promise<string>;
}

export interface WorktreeIsolationGateOpts {
  /** Startup read (hard req 9): assembly passes `resolveWorktreeOnMutate(settings)`. */
  readonly enabled: boolean;
  /** This engine's root — the bound-tree comparison anchor. */
  readonly root: string;
  /**
   * Host seam (session-api): create the task worktree AND rebind the current
   * session root; resolves with the new root (or the current root when the
   * session is already bound there). MUST be idempotent per conversation —
   * the gate coalesces concurrent callers onto one invocation.
   */
  readonly provision: (ctx: WorktreeProvisionContext) => Promise<string>;
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
 * Wrap an executor with the mutate gate. Read calls and switch-OFF traffic
 * pass through untouched; mutates on an unbound session are coalesced onto a
 * single `provision()` per conversation (boundary c idempotency), then:
 *
 *   - provision resolved to this engine's root → passthrough (mutates land
 *     in the worktree the engine is rooted at);
 *   - provision resolved elsewhere → the call is blocked with a visible
 *     rebind notice (stale-root tools must not write the old root);
 *   - provision failed → blocked with the typed `kind=<kind>` message;
 *     state resets so the next mutate retries (still fail-closed).
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
