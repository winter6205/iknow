/**
 * Write-situation tri-state decision.
 *
 * "Can we write right now?" is decided by one function; the tri-state
 * enum (`writable_main` / `writable_tree` / `no_writable_root`) lives in
 * `session-roots.ts`, and the rendering surface plus the worker prior all
 * consume this enum instead of judging on their own.
 *
 * Boundary contract:
 *   - Deterministic and synchronous. Boundness (the ON arm's tree decision)
 *     is delegated to `isBound` — which defaults to `isBoundWorktreeRoot`
 *     (issue 1231): a stamp-aware predicate that reads the target root's
 *     gitdir entered-stamp sidecar. So the DEFAULT arm is NOT disk-free. A
 *     caller that wants a pure decision (unit tests, already-decided roots)
 *     injects its own `isBound`; the function itself does no other I/O, runs
 *     no git, and reads no settings (the isolation tier is passed in).
 *   - Boundness detection **reuses** `isBoundWorktreeRoot` (the SSOT for
 *     "is this root writable?"); no second parallel shape / stamp logic here.
 *   - empty / blank root -> typed result (`no_writable_root`), never throws,
 *     never silently allows. "The main repo is read-only for file edits" is
 *     semantically equivalent to "no writable root" — telling the model "do
 *     not write" is safer than treating an empty string as the main repo.
 *   - overflow: extremely long / deeply nested / trailing separators — still
 *     adjudicated by the injected `isBound` predicate.
 */
import type { WriteSituation } from "../session-roots.js";
import { isBoundWorktreeRoot } from "./worktree-gate.js";

/**
 * Decide "can we write now, and where" — tri-state.
 *
 * @param isolationOn  isolation tier (injected by the caller from settings;
 *                     this function does **not** read settings)
 * @param root         current live root (taskRoot snapshot, not the main-repo string)
 * @param isBound      boundness predicate; defaults to the stamp-aware
 *                     `isBoundWorktreeRoot` (reads the root's gitdir entered
 *                     stamp). Inject a pure predicate to keep the caller's own
 *                     decision / avoid disk.
 * @returns            write-situation enum (typed, never throws)
 */
export function writeSituation(
  isolationOn: boolean,
  root: string,
  isBound: (root: string) => boolean = isBoundWorktreeRoot
): WriteSituation {
  // Empty arm: root absent / blank-only -> fail-closed to `no_writable_root`.
  // This path is taken even with isolation OFF — a blank root is not "write
  // the main repo", it is "no root to write".
  if (root.trim().length === 0) {
    return "no_writable_root";
  }

  // Isolation OFF: write root = main repo (the live-root string is
  // meaningless here). Boundness **does not participate** — even if a
  // tree-shaped path is passed in, the answer stays "write the main repo"
  // (pinned by the negative arm).
  if (!isolationOn) {
    return "writable_main";
  }

  // Isolation ON: bound root (task worktree, or an explicitly-entered
  // external linked worktree) -> write this session's tree; otherwise refuse.
  return isBound(root) ? "writable_tree" : "no_writable_root";
}
