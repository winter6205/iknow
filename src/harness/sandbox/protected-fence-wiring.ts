import {
  isWorkspaceRootError,
  renderWorkspaceRootError,
  resolveWorkspaceRoot,
} from "../../config/workspace-root.js";
import { ToolExecutionError } from "../errors.js";
import { VIOLATION_PREFIXES } from "../permission/prefixes.js";
import {
  createProtectedTargetInventory,
  prewalkProtectedTargets,
  type ProtectedTargetInventory,
  type ProtectedTargetSnapshotCache,
} from "./protected-targets.js";

// The session-scoped protected-target snapshot holder is re-exported here so
// the fence-wiring surface stays ONE module for the wiring's own inputs (the
// `sandbox/index.js` barrel's re-export list is owned elsewhere).
export {
  createProtectedTargetSnapshotCache,
  type ProtectedTargetSnapshotCache,
} from "./protected-targets.js";

/**
 * The name-pattern scan scope for a route that was NOT given a DI'd workspace
 * root (unwired assembly / direct factory tests). Falls back to the shared
 * resolver's cwd arm — deliberately NOT to a raw `process.env` read: the env
 * SSOT (`.env` / `.env.local` merged by `loadIknowEnv`) is invisible to
 * `process.env`, so a `.env`-configured session would scan a different tree
 * here than read_file / trace / workers anchor on — two protection surfaces in
 * one session. Production routes thread their already-resolved root instead.
 */
export function fenceScanScope(cwd: string): string {
  try {
    return resolveWorkspaceRoot({ cwd });
  } catch (err) {
    // `resolveWorkspaceRoot` throws PLAIN discriminated objects, not Errors.
    // Unguarded, `sanitizeFailure` flattens one to the generic "tool execution
    // failed" — a security-boundary refusal with zero diagnostic. Re-render it
    // through the shared guard / renderer (the shape cli.ts / tui/run.tsx /
    // session-api/http.ts use); anything else propagates untouched.
    if (isWorkspaceRootError(err)) {
      throw new ToolExecutionError(
        `${VIOLATION_PREFIXES.fsDenied} fence scan scope could not be resolved: ${renderWorkspaceRootError(err)}`
      );
    }
    throw err;
  }
}

/**
 * Single wiring point for the PROTECTED-FENCE option pair
 * (specs/effect-boundary-protection.md SC1/SC4) — the exact subset of
 * `BwrapFenceOptions` every production route must carry identically:
 *   - `protectedTargets` — the inventory, resolved against the CALLER's
 *     frozen home root (one source of truth per route; no per-site
 *     `homedir()` re-reads, no drifted defaults) with the name-pattern scan
 *     scope set to the route's workspace root;
 *   - `protectCredentialReads: true` — the credential read mask always rides
 *     with the inventory (one coordinated mount plan; a route that forgot it
 *     would hand back readable credentials).
 *
 * Before this helper the pair was hand-assembled at four sites with three
 * different home defaults (and inconsistent mask flags) — exactly the drift
 * class it removes. The value itself (home fallback) STAYs the caller's:
 * the helper wires the pair, it does not re-decide each route's frozen
 * inputs; routes pass the same value they already resolved for the
 * workspace tier.
 *
 * `workspaceRoot` is REQUIRED, not defaulted: the scan scope is the one input
 * this helper must never invent. A route that has none resolves one itself
 * through `fenceScanScope` and passes the result, so "absent" can never mean
 * "silently scanned something else".
 */
export function protectedFenceWiring(input: {
  /** Frozen home root of this route (caller resolves any homedir() default). */
  readonly homeRoot: string;
  /**
   * Frozen workspace root of this route — the name-pattern scan scope
   * (specs/effect-boundary-protection.md "Scan scope"), the SAME root the
   * other fence routes scan. Unwired callers pass `fenceScanScope(<their cwd>)`.
   */
  readonly workspaceRoot: string;
}): {
  /** Always present: the pair's whole purpose is carrying the inventory. */
  readonly protectedTargets: ProtectedTargetInventory;
  readonly protectCredentialReads: true;
} {
  return {
    protectedTargets: createProtectedTargetInventory({
      home: input.homeRoot,
      scanRoot: input.workspaceRoot,
    }),
    protectCredentialReads: true,
  };
}

/**
 * The PROTECTED_TARGETS pair for ONE fence-assembling call, resolving the arm
 * choice at the single wiring point instead of at each route:
 *
 *  - `fenceRetired` — the synchronous arm. A retired-fence route materializes
 *    no bundle at all, so the awaited arm would pay for a walk no one reads.
 *  - otherwise — the same pair, but the name-pattern walk happens HERE with one
 *    `await` per directory (`prewalkProtectedTargets`) instead of synchronously
 *    inside `createBwrapFence`.
 *
 * The awaited half is a scheduling change, not a change to what is protected:
 * the walk covers the same tree under the same bounds with the same typed
 * refusals and merely hands the thread back between directories. It matters
 * because the product runs the renderer, the keystroke echo and the agent engine
 * on ONE thread — on a ~5,070-directory / ~56,800-entry checkout the synchronous
 * walk measured 2.4 s cold (a single uninterrupted 2,409 ms block) and 100-240 ms
 * warm, repeated on every call because the fence re-materializes per assembly
 * (the walk itself is no longer repeated: the session's snapshot holder caches
 * it and re-validates it per assembly — see the holder paragraph below).
 * The assembly that follows consumes the pre-walk once, then synchronously
 * validates the recorded directory identities and timestamps before trusting
 * its matches. Only a directory whose listing changed is reread; that pass
 * allows proven removals to reach the absent-target warning, and refuses new
 * matches, unscanned subdirectories, and replaced objects.
 *
 * The awaited arm is NOT cheaper in wall-clock — the same warm walk measured
 * 150 ms synchronous (one uninterrupted 131 ms block) against 383 ms awaited,
 * which held the thread for no 20 ms heartbeat overrun at all. Call latency is
 * spent to buy frame and echo latency back; restoring the synchronous walk to
 * save those milliseconds puts the freeze back.
 *
 * CALL THIS AS THE LAST AWAIT BEFORE THE FENCE IS BUILT. Each directory's
 * identity and change timestamps are captured immediately before its awaited
 * read, then checked synchronously during materialization. Changed listings
 * are reread within the original enumeration bound, and matched bind-source
 * identities are checked before use. Any `await` after that validation and
 * before bind composition would reopen a window in which a credential could
 * appear without a corresponding bind.
 *
 * The bound is the spec's class-6 refusal: it stays VISIBLE — the refusal names
 * the bound and the root that hit it, never a silent exclusion — but this build
 * has no configuration surface for it, so "what the operator can widen" means
 * editing the `MAX_MATERIALIZE_ENTRIES` source constant in
 * `protected-targets.ts` (`DEFAULT_LIMITS` is not wired to any setting).
 *
 * The session's snapshot holder (perf) is consulted here and nowhere else: with
 * a holder, the walked snapshot of the previous call is re-parked for this
 * assembly instead of re-walking the whole scan scope. The snapshot is checked
 * for FRESHNESS, not trusted: the stat-only identity pass re-reads no listing
 * and refuses nothing — every walked directory's fs identity unchanged means
 * the tree is provably the tree the snapshot was walked from, so the match set
 * still holds; any difference makes the snapshot STALE, and the assembly then
 * takes the ordinary fresh-walk path (the awaited pre-walk, the last await
 * before the fence is built) exactly as it does without a holder, so a
 * credential that appeared under the scan scope is masked by that very call.
 * The retired arm never enters the holder.
 */
export async function prepareProtectedFenceWiring(input: {
  readonly homeRoot: string;
  readonly workspaceRoot: string;
  /** This call retires the fence wholesale; then the walk is pure cost. */
  readonly fenceRetired: boolean;
  /**
   * The session-scoped snapshot holder (optional). Absent → the fence walks
   * per call, exactly as before.
   */
  readonly snapshotCache?: ProtectedTargetSnapshotCache;
}): Promise<ReturnType<typeof protectedFenceWiring>> {
  if (input.fenceRetired) {
    // EXIT: the retired arm materializes no bundle, so it neither consults nor
    // populates the session's snapshot holder.
    return protectedFenceWiring(input);
  }
  const cache = input.snapshotCache;
  if (cache !== undefined) {
    const reused = cache.take({
      homeRoot: input.homeRoot,
      workspaceRoot: input.workspaceRoot,
    });
    if (reused !== undefined) {
      // The reused snapshot is checked for freshness, not trusted: the holder
      // only serves a snapshot whose walked directories are all unchanged, and
      // the assembly checks that again before it trusts a single match. A
      // credential that appeared under the scan scope since the walk is found
      // by the fresh walk this path falls back to, and masked by that call.
      return { protectedTargets: reused, protectCredentialReads: true };
    }
  }
  const wiring = protectedFenceWiring(input);
  await prewalkProtectedTargets(wiring.protectedTargets, cache?.limits);
  cache?.put({
    homeRoot: input.homeRoot,
    workspaceRoot: input.workspaceRoot,
    inventory: wiring.protectedTargets,
  });
  return wiring;
}
