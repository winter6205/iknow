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
 *
 * T4 (passthrough): the per-conversation passthrough decision lives HERE —
 * a mutate arriving while the session is already on its own task worktree
 * (deterministic naming, restart-safe) is a zero-side-effect no-op; a root
 * belonging to another conversation or an unrelated linked worktree fails
 * closed with `foreign_worktree`.
 */
import { basename, dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";

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
   *
   * T4 passthrough anchoring: when `ctx.root` IS this conversation's own task
   * worktree (deterministic naming, restart-safe), `provision` is a no-op
   * that returns the same root — zero git calls, zero rebind writes. When
   * `ctx.root` is another conversation's task worktree or an unrelated
   * linked worktree, it rejects with a typed `foreign_worktree`
   * (fail-closed; ADR-0037 defines only the main repo and the own task tree).
   */
  provision(ctx: {
    readonly conversationId?: string;
    readonly root: string;
  }): Promise<string>;
  /**
   * True when `root` is a task worktree this provisioner created (or
   * recognized as a conversation's own tree — T4 passthrough registration).
   * Ownership-AGNOSTIC introspection: it does NOT answer "is this root
   * conversation X's own tree" — the per-conversation passthrough anchor is
   * `provision` itself, never this predicate.
   */
  isTaskWorktreeRoot(root: string): boolean;
}

export function taskWorktreePath(repoRoot: string, conversationId: string): string {
  return join(repoRoot, ".iknow", "worktrees", conversationId);
}

export function taskWorktreeBranch(conversationId: string): string {
  return `iknow/task-${conversationId}`;
}

/**
 * T4 ownership anchor: decompose a root against the deterministic naming.
 * Returns the owning conversationId when `root` IS a task worktree path
 * (`<any>/.iknow/worktrees/<conversationId>`), undefined otherwise. Because
 * the leaf name is the conversation id, "the path decomposes to X" is
 * equivalent to "the tree belongs to conversation X" — no registry needed,
 * works across server restarts.
 *
 * Exported for read-only display consumers (TUI environment pane, review
 * Medium-2): "workspaceRoot looks like a task worktree" is the display
 * condition, NOT "workspaceRoot is any non-empty string" — serve's
 * `bindWorkspace` legitimately persists the MAIN root as workspaceRoot, and
 * that must never render as a worktree binding.
 */
export function taskWorktreeOwnerOf(root: string): string | undefined {
  if (basename(dirname(root)) !== "worktrees") return undefined;
  if (basename(dirname(dirname(root))) !== ".iknow") return undefined;
  return basename(root);
}

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
 * and empty strings.
 */
const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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
