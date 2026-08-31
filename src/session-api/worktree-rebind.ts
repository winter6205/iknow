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
import { dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";

import {
  createTaskWorktree,
  mainCheckoutOf,
  taskWorktreeOwnerOf,
  WorktreeIsolationError,
  defaultGitRunner,
  SAFE_CONVERSATION_ID_RE,
} from "../harness/isolation/worktree-gate.js";
import type {
  GitRunner,
  GitResult,
  WorktreeProvisionContext,
  WorktreeEnterContext,
  WorktreeExitContext,
} from "../harness/isolation/worktree-gate.js";
import { errorMessage } from "../harness/errors.js";
import type { SessionFileV1 } from "./store/index.js";

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
   * EXISTING task worktree of THIS repository (deterministic path SSOT,
   * owner = `targetConversationId`). Creates no tree and touches no foreign
   * HEAD — the only effect is the caller's own rebind (store-mode persists
   * workspaceRoot; hub-mode returns the root for the dirty-root
   * conditional-save protocol). Idempotent per conversation.
   *
   * Fail-closed: missing target → `worktree_not_found`; target that is not a
   * linked checkout or belongs to another repository → `foreign_worktree`;
   * caller already inside a worktree → `foreign_worktree` (exit first);
   * unsafe ids → `rebind_failed` before any fs/git access.
   */
  enter(req: WorktreeEnterRequest): Promise<string>;
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
 * Single SSOT lives in `harness/isolation/worktree-gate.ts` (the mutate gate
 * routes on the same predicate — T3 model-provision contract); re-exported
 * here for the provisioner and read-only display consumers (TUI environment
 * pane, review Medium-2): "workspaceRoot looks like a task worktree" is the
 * display condition, NOT "workspaceRoot is any non-empty string" — serve's
 * `bindWorkspace` legitimately persists the MAIN root as workspaceRoot, and
 * that must never render as a worktree binding.
 */
export { taskWorktreeOwnerOf, mainCheckoutOf };

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

export function createTaskWorktreeProvisioner(
  opts: TaskWorktreeProvisionerOpts
): TaskWorktreeProvisioner {
  const runGit = opts.runGit ?? defaultGitRunner;
  const now = opts.now ?? (() => new Date().toISOString());
  /** conversationId → worktree path (provisioned / entered set). */
  const bound = new Map<string, string>();
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
      taskWorktreeOwnerOf(ctx.root) !== undefined
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

    // 2. Preserve the historical standalone persistence hook when supplied.
    // SessionHub omits it so the host can observe this returned root and
    // persist it together with the turn through conditionalSave.
    await persistWorkspaceRoot(conversationId, worktreePath, "rebind");

    bound.set(conversationId, worktreePath);
    taskRoots.add(worktreePath);
    return worktreePath;
  }

  async function enter(req: WorktreeEnterRequest): Promise<string> {
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

    // Path SSOT: the tool takes the owner's conversation id, never a
    // free-form path — the target is always `<root>/.iknow/worktrees/<id>`.
    const target = taskWorktreePath(req.root, req.targetConversationId);
    const current = bound.get(conversationId);
    if (current === target) {
      return target; // idempotent re-enter (zero writes)
    }

    // Target validation, cheapest checks first:
    //   1. exists on disk → `worktree_not_found`
    //   2. is a LINKED checkout (`.git` is a file) → `foreign_worktree`
    //   3. belongs to the SAME repository as the caller's root (common-dir
    //      comparison) → `foreign_worktree` on mismatch
    if (!existsSync(target)) {
      throw new WorktreeIsolationError(
        "worktree_not_found",
        `worktree isolation: no task worktree at ${target} (conversation '${req.targetConversationId}' owns no tree here); check the conversation id, or create the tree first with the create-task-worktree tool`
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
    return target;
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
    const shapedCurrent =
      taskWorktreeOwnerOf(req.root) !== undefined ? req.root : undefined;
    const shapedAnchor =
      req.sessionWorkspaceRoot !== undefined &&
      taskWorktreeOwnerOf(req.sessionWorkspaceRoot) !== undefined
        ? req.sessionWorkspaceRoot
        : undefined;
    if (boundRoot === undefined && shapedCurrent === undefined && shapedAnchor === undefined) {
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

  return Object.freeze({
    provision,
    enter,
    exit,
    isTaskWorktreeRoot: (root: string) => taskRoots.has(root),
  });
}
