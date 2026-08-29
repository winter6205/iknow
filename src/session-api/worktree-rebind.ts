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
 *   - worktree path `<repoRoot>/.iknow/worktrees/<conversationId>` (`.iknow`
 *     is the per-root state anchor and gitignored, so the nested checkout
 *     never pollutes the main repo's status);
 *   - branch `iknow/task-<conversationId>`.
 *   The naming makes ownership unambiguous, but a pre-existing branch /
 *   worktree path is still fail-closed (`branch_exists` / `worktree_exists`
 *   from the git layer) — no silent overwrite, no reuse of unknown trees,
 *   no checkout of other sessions' HEADs (hard req ①③).
 *
 * Failure semantics (hard req ⑥): every failure exits typed
 * (`WorktreeIsolationError`) and the session file is left untouched — the
 * rebind happens only after the tree was created successfully.
 */
import { join } from "node:path";

import {
  createTaskWorktree,
  WorktreeIsolationError,
  defaultGitRunner,
} from "../harness/isolation/worktree-gate.js";
import type { GitRunner } from "../harness/isolation/worktree-gate.js";
import { errorMessage } from "../harness/errors.js";
import type { SessionFileV1 } from "./store/index.js";

/** Minimal store surface the provisioner needs (SessionStore satisfies it). */
export interface WorktreeRebindStore {
  load(conversationId: string): Promise<SessionFileV1>;
  save(opts: { id: string; file: SessionFileV1 }): Promise<void>;
}

export interface TaskWorktreeProvisionerOpts {
  readonly store: WorktreeRebindStore;
  readonly runGit?: GitRunner;
  readonly now?: () => string;
}

export interface TaskWorktreeProvisioner {
  /**
   * Create (or no-op-return) the conversation's task worktree and rebind the
   * session root. Resolves with the worktree path. Idempotent per
   * conversation: once provisioned, subsequent calls return the same root
   * without running `git worktree add` again (same-process concurrency latch
   * lives in the harness gate; this covers engine rebuilds).
   */
  provision(ctx: {
    readonly conversationId?: string;
    readonly root: string;
  }): Promise<string>;
  /** True when `root` is a task worktree this provisioner created. */
  isTaskWorktreeRoot(root: string): boolean;
}

export function taskWorktreePath(repoRoot: string, conversationId: string): string {
  return join(repoRoot, ".iknow", "worktrees", conversationId);
}

export function taskWorktreeBranch(conversationId: string): string {
  return `iknow/task-${conversationId}`;
}

export function createTaskWorktreeProvisioner(
  opts: TaskWorktreeProvisionerOpts
): TaskWorktreeProvisioner {
  const runGit = opts.runGit ?? defaultGitRunner;
  const now = opts.now ?? (() => new Date().toISOString());
  /** conversationId → worktree path (provisioned set). */
  const bound = new Map<string, string>();
  /** All task worktree roots created here (per-root engine flag source). */
  const taskRoots = new Set<string>();

  async function provision(ctx: {
    conversationId?: string;
    root: string;
  }): Promise<string> {
    const conversationId = ctx.conversationId;
    if (conversationId === undefined || conversationId.length === 0) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        "worktree isolation: the mutate call carried no conversation id; cannot rebind a session root without one"
      );
    }

    const existing = bound.get(conversationId);
    if (existing !== undefined) {
      return existing; // idempotent rebind (no second `worktree add`)
    }

    // 1. create the tree (typed fail-closed: not_a_git_repo / git_unavailable /
    //    branch_exists / worktree_exists / worktree_add_failed)
    const worktreePath = taskWorktreePath(ctx.root, conversationId);
    const branch = taskWorktreeBranch(conversationId);
    try {
      await createTaskWorktree({
        repoRoot: ctx.root,
        worktreePath,
        branch,
        runGit,
      });
    } catch (err) {
      if (err instanceof WorktreeIsolationError) throw err;
      throw new WorktreeIsolationError(
        "worktree_add_failed",
        errorMessage(err)
      );
    }

    // 2. rebind ONLY this session's root (session file update after the tree
    //    exists; store failures leave the tree in place — operator-visible,
    //    main repo untouched, next attempt reports branch_exists per ADR §3)
    let file: SessionFileV1;
    try {
      file = await opts.store.load(conversationId);
    } catch (err) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: cannot load session ${conversationId} for rebind: ${errorMessage(err)}`
      );
    }
    const updated: SessionFileV1 = {
      ...file,
      workspaceRoot: worktreePath,
      updatedAt: now(),
    };
    try {
      await opts.store.save({ id: conversationId, file: updated });
    } catch (err) {
      throw new WorktreeIsolationError(
        "rebind_failed",
        `worktree isolation: cannot persist rebind for session ${conversationId}: ${errorMessage(err)}`
      );
    }

    bound.set(conversationId, worktreePath);
    taskRoots.add(worktreePath);
    return worktreePath;
  }

  return Object.freeze({
    provision,
    isTaskWorktreeRoot: (root: string) => taskRoots.has(root),
  });
}
