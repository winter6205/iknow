/**
 * Write-situation tri-state decision (expanded early; no consumers yet).
 *
 * "Can we write right now?" is decided by one pure function; the tri-state
 * enum (`writable_main` / `writable_tree` / `no_writable_root`) lives in
 * `session-roots.ts`, and the rendering surface plus the worker prior all
 * consume this enum instead of judging on their own. This stage has **no
 * consumers** — `skill/body.ts` / `subagent/worker.ts` wire in later.
 *
 * Boundary contract:
 *   - Pure synchronous function; touches no disk, runs no git, reads no
 *     settings (the isolation tier is passed in by the caller).
 *   - Shape detection **reuses** `isTaskWorktreePath`; no second parallel
 *     shape logic.
 *   - empty / blank root -> typed result (`no_writable_root`), never throws,
 *     never silently allows. "The main repo is read-only for file edits" is
 *     semantically equivalent to "no writable root" — telling the model "do
 *     not write" is safer than treating an empty string as the main repo.
 *   - overflow: extremely long / deeply nested / trailing separators — still
 *     adjudicated by `isTaskWorktreePath`.
 */
import type { WriteSituation } from "../session-roots.js";
import { isTaskWorktreePath } from "./worktree-gate.js";

/**
 * Decide "can we write now, and where" — tri-state.
 *
 * @param isolationOn  isolation tier (injected by the caller from settings;
 *                     this function does **not** read settings)
 * @param root         current live root (taskRoot snapshot, not the main-repo string)
 * @returns            write-situation enum (typed, never throws)
 */
export function writeSituation(
  isolationOn: boolean,
  root: string
): WriteSituation {
  // Empty arm: root absent / blank-only -> fail-closed to `no_writable_root`.
  // This path is taken even with isolation OFF — a blank root is not "write
  // the main repo", it is "no root to write".
  if (root.trim().length === 0) {
    return "no_writable_root";
  }

  // Isolation OFF: write root = main repo (the live-root string is
  // meaningless here). Shape detection **does not participate** — even if a
  // tree-shaped path is passed in, the answer stays "write the main repo"
  // (pinned by the negative arm).
  if (!isolationOn) {
    return "writable_main";
  }

  // Isolation ON: tree-shaped -> write this session's task worktree; non-tree -> refuse the write.
  return isTaskWorktreePath(root) ? "writable_tree" : "no_writable_root";
}
