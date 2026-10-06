import { resolve } from "node:path";
import type { FsIsolationMode } from "./fs-mode.js";
import {
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
  type FsPolicy,
} from "./fs-policy.js";

/**
 * The fence's reachable set for one fs-isolation tier (ADR-0092), declared
 * ONCE so the mount layer and the permission layer cannot each hold their own
 * copy. ADR-0092's rejected-option record rules out a second implementation of
 * this boundary ("two implementations that can each drift"); ADR-0140 §2 reason
 * 3 is the amendment: one boundary decision, the fence still what physically
 * enforces it. This module is the single derivation both read —
 * `fs-boundary-parity.test.ts` pins the declaration to the argv bwrap emits, so
 * a later edit to one side turns that test red.
 *
 * TWO GEOMETRIES, NOT ONE — and the difference is load-bearing.
 * `reachableRoots` is the tier's write WHITELIST OVERLAY: the workspace tier
 * emits `--bind / /` and then ro-binds over it, so a path outside the whitelist
 * is still written successfully. "Outside the declaration" therefore does NOT
 * mean "the fence refuses". `isRefusedByFsBoundary` is the refusal geometry —
 * the read-only bindings — and it is what the ADR-0140 ask is built on.
 */
export interface FsBoundarySnapshot {
  readonly mode: FsIsolationMode;
  /** null means UNBOUNDED reach: the global tier stacks no workspace layer, so
   *  there is no edge for a call to cross. An array is the exact set of roots
   *  the fence binds writable under this tier. */
  readonly reachableRoots: readonly string[] | null;
}

/**
 * The mount inputs a fence assembly hands over. `homeRoot` is accepted so a call
 * site can pass its own fence options through unchanged, but it is
 * deliberately NOT part of the reachable set: home is `--ro-bind`, so no write
 * can land there. Smuggling it in would make the declaration claim a writable
 * home the argv does not grant — the exact drift this module exists to prevent.
 */
export interface FsBoundaryMounts {
  readonly homeRoot?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly tmpRoot?: string | undefined;
}

/**
 * The workspace tier's write whitelists, in bwrap's last-mount-wins order
 * (taskRoot then session tmp) so the declared order is the mounted order. An
 * absent or empty root is omitted rather than becoming a `""` entry that would
 * resolve against the caller's cwd and declare the cwd writable.
 */
function reachableWriteRoots(mounts: FsBoundaryMounts): readonly string[] {
  return [mounts.workspaceRoot, mounts.tmpRoot].filter(
    (root): root is string => root !== undefined && root.length > 0
  );
}

/**
 * The one place the fence's reachable set is derived. `fsPolicy.mode` is the
 * only tier input; the mounts are the workspace tier's whitelists.
 *
 * `global` → `reachableRoots: null` (unbounded, matching `workspaceMountArgs`'s
 * empty segment today). `workspace` → the two writable roots, verbatim as the
 * fence binds them (no `resolve` here: this value is compared against emitted
 * argv, and resolution belongs to the containment check below).
 */
export function fsBoundarySnapshot(
  fsPolicy: FsPolicy,
  mounts: FsBoundaryMounts
): FsBoundarySnapshot {
  if (fsPolicy.mode !== "workspace") {
    return Object.freeze({ mode: fsPolicy.mode, reachableRoots: null });
  }
  return Object.freeze({
    mode: fsPolicy.mode,
    reachableRoots: Object.freeze(reachableWriteRoots(mounts)),
  });
}

/** True when a boundary exists at all (a call can cross an edge). */
export function fsBoundaryIsActive(snapshot: FsBoundarySnapshot): boolean {
  return snapshot.reachableRoots !== null;
}

/**
 * Containment with a separator boundary on resolved paths. A bare `startsWith`
 * would report `/a/bc` as inside `/a/b` — a real escape, and the reason this
 * resolves both sides before comparing. Always true under unbounded reach: with
 * no declared roots there is no edge, so a caller must not have to special-case
 * the global tier to ask the question.
 */
export function isWithinFsBoundary(
  target: string,
  snapshot: FsBoundarySnapshot
): boolean {
  const roots = snapshot.reachableRoots;
  if (roots === null) return true;
  const resolved = resolve(target);
  return roots.some((root) => contains(resolved, resolve(root)));
}

/** `resolved` sits at or under `resolvedRoot`, on a separator boundary. */
function contains(resolved: string, resolvedRoot: string): boolean {
  // A root of "/" already ends in the separator; appending another would build a
  // prefix ("//") no absolute path starts with, turning the widest boundary into
  // one that contains nothing.
  const prefix = resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`;
  return resolved === resolvedRoot || resolved.startsWith(prefix);
}

/**
 * Would the FENCE actually refuse a write to `target`? This is the honest
 * question for ADR-0140's boundary ask, and it is NOT the same as
 * `!isWithinFsBoundary`.
 *
 * Measured on the real fence (`--bind / /` then ro-binds over it): the declared
 * writable set is a WHITELIST OVERLAY on a writable `/` substrate, so a path
 * outside the whitelist — `/tmp`, `/var/tmp`, `/dev/shm` — is still written
 * successfully. Asking about those would prompt the operator for crossings that
 * never happen. Conversely the fence refuses inside a declared root when
 * `cwdReadonly` re-binds it read-only.
 *
 * So the refusal set is the fence's read-only bindings: the system prefixes every
 * tier ro-binds, plus `home` when the workspace tier ro-binds it. That matches
 * what `[fs_denied]`'s mode-boundary arm classifies against, so the question and
 * the refusal now agree on one geometry.
 *
 * `cwdReadonly` is deliberately NOT modelled here: it is a per-call fence option
 * the permission layer cannot see, so this answers the static tier. ADR-0140
 * records the exception.
 */
export function isRefusedByFsBoundary(
  target: string,
  snapshot: FsBoundarySnapshot,
  mounts: FsBoundaryMounts
): boolean {
  if (snapshot.reachableRoots === null) return false;
  const resolved = resolve(target);
  const writable = snapshot.reachableRoots.map((root) => resolve(root));
  if (writable.some((root) => contains(resolved, root))) return false;
  const readOnly = [...READ_ONLY_SYSTEM_PATHS, ...OPTIONAL_HOST_RO_PREFIXES];
  if (snapshot.mode === "workspace" && mounts.homeRoot) {
    readOnly.push(mounts.homeRoot);
  }
  return readOnly.some((root) => contains(resolved, resolve(root)));
}
