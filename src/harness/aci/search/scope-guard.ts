/**
 * Search-scope gate: when `path` points at an oversized tree and the caller
 * did not narrow with a **positive `glob`**, return a short typed error before
 * the tier clock burns out, instead of spinning to the 30s default-tier
 * timeout.
 *
 * Why the gate counts **files**, not wall clock: measured (rg 15.1.0), the
 * same 54,318-file tree takes `rg -l --max-filesize=1MiB` 17.8s (60% of the
 * default tier), while 1,200 files take 0.021s; wall-clock thresholds
 * misjudge on both fast and slow hosts (17.8s is already close to 30s — a
 * slightly slower machine crosses the tier). File count is approximately
 * linear in matching cost at this tool's scale (~0.33ms/file), so the gate
 * uses file count: deterministic, testable, decoupled from host speed; the
 * tier clock remains the backstop.
 *
 * `GREP_SCOPE_FILE_LIMIT` = 10,000: extrapolating from the measurement above,
 * `17.8s × 10,000 / 54,318 ≈ 3.3s`, about 11% of the default tier, leaving
 * ~9x headroom for host speed; counting itself early-stops at cap+1, and the
 * Node walk of 10,000 files measured < 1s.
 *
 * Exempt / not exempt (both engines share this module — the same `path` must
 * get the same verdict):
 *   - **explicit single-file `path`** is exempt: same source as `node-scan.ts`'s
 *     size-gate exemption — a named file yields one candidate and can never
 *     overflow.
 *   - **positive `glob`** is exempt: a narrowing `glob` is the only admitted
 *     narrowing dimension.
 *   - **negated `glob` (e.g. `!node_modules`) is not exempt**: it does not
 *     shrink the included set (in `glob-match`'s set semantics only positives
 *     narrow), so it does not reduce traversal / matching cost.
 *   - **`type` is not exempt**: filtering by filename narrows the **match**
 *     set, not the traversal scope (rg's `--type` still readdirs the whole
 *     tree), and only `glob` is admitted as narrowing.
 *   - **`head_limit` / `offset` / `output` are not exempt**: they slice output
 *     or change mode without reducing search cost.
 *   - **A permissive positive `glob` (`**`-like)** passes as the caller's
 *     explicit choice; the tier clock stays the backstop. Distinguishing
 *     "permissive" from "narrowing" needs regex-semantics heuristics whose
 *     value does not cover the complexity.
 *
 * Cost (call-time): the gate runs `walkFiles` once (early stop at cap+1) as a
 * pre-engine check, **paid by every directory `grep`**, even when the bundled
 * rg is present — sharing this module across engines is required for the same
 * `path` verdict and cannot be skipped per engine. A bare `path` also cannot
 * rely on the gate alone: it counts files, not bytes, so trees with many
 * directories and few files can still pass the gate and burn the tier clock.
 * The tier clock remains a real backstop; the gate just fires a beat earlier.
 */

import { ToolExecutionError } from "../../errors.js";
import { isNegation } from "./glob-match.js";
import { toWorkspaceRelative, walkFiles } from "./node-scan.js";
import { isPathRepresentable } from "./path-representable.js";

/**
 * File-count cap for the search scope (SSOT: the error text and tests both
 * reference it; never hardcoded elsewhere). Rationale in the file header
 * (extrapolated from the 17.8s / 54,318-file rg measurement).
 */
export const GREP_SCOPE_FILE_LIMIT = 10_000;

export interface ScopeGuardInput {
  readonly workspaceRoot: string;
  readonly searchRoot: string;
  /** Search root is an explicitly named single file (same test as `node-scan`'s size-gate exemption). */
  readonly explicitFile: boolean;
  /** Caller-supplied `glob`; positive means narrowing (exempt), negated does not. */
  readonly glob: string | undefined;
  /** Test seam; absent → `GREP_SCOPE_FILE_LIMIT`. */
  readonly limit?: number;
}

/**
 * Count candidate files; throw a typed error once the cap is exceeded.
 *
 * "Candidate file" follows `node-scan.walkFiles`: skip `node_modules` / `.git`,
 * skip paths unrepresentable in the line protocol (with `\n` / `\0`; the rg
 * side removes them identically via `NEWLINE_PATH_EXCLUDES`). No `glob` /
 * `type` filtering — traversal cost is paid before filtering, and what is
 * counted is the **scope** size, not the hit-set size.
 */
export async function assertScopeWithinLimit(
  input: ScopeGuardInput
): Promise<void> {
  if (input.explicitFile) return;
  if (input.glob !== undefined && !isNegation(input.glob)) return;
  const limit = input.limit ?? GREP_SCOPE_FILE_LIMIT;
  let count = 0;
  // Early stop: throw as soon as the cap is crossed instead of walking the
  // whole tree before deciding.
  for await (const absPath of walkFiles(input.searchRoot)) {
    const relPath = toWorkspaceRelative(input.workspaceRoot, absPath);
    if (!isPathRepresentable(relPath)) continue;
    count += 1;
    if (count > limit) throw tooLarge(limit);
  }
}

function tooLarge(limit: number): ToolExecutionError {
  return new ToolExecutionError(
    `grep: search scope is too large (more than ${String(limit)} files under the given path); add a narrowing glob (for example glob: "**/*.ts") or search a subdirectory`
  );
}
