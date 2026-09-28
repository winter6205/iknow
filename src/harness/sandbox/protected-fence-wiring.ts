import {
  isWorkspaceRootError,
  renderWorkspaceRootError,
  resolveWorkspaceRoot,
} from "../../config/workspace-root.js";
import { ToolExecutionError } from "../errors.js";
import { VIOLATION_PREFIXES } from "../permission/prefixes.js";
import {
  createProtectedTargetInventory,
  type ProtectedTargetInventory,
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
