/**
 * Search-scope gate: when `path` points at an oversized tree and the caller
 * did not narrow with a **positive `glob`**, return a short typed error before
 * the tier clock burns out, instead of spinning to the 30s default-tier
 * timeout.
 *
 * Why the gate counts **files**, not wall clock: measured on the engine that
 * actually ships (rg 15.0.0, best of 3 on this host), 1,200 / 5,400 / 10,000 /
 * 20,000 / 40,000 files take 0.012 / 0.030 / 0.050 / 0.093 / 0.168s — about
 * 0.004ms/file, linear in file count. Wall-clock thresholds misjudge on both
 * fast and slow hosts, so the gate uses file count: deterministic, testable,
 * decoupled from host speed; the tier clock remains the backstop.
 *
 * An earlier note here attributed 17.8s to a 54,318-file tree on rg 15.1.0.
 * **That figure does not reproduce** — the same shape extrapolates to well
 * under a second here, and the command it quoted (`--max-filesize=1MiB`) is
 * an rc=2 parse error on both binaries that exits in ~8ms without scanning
 * anything, so it cannot have produced that number either. It is kept above
 * only as a record of what was believed; **nothing derives the limit from it.**
 * (The tool's real spelling is a raw byte count — `argv.ts` pushes
 * `--max-filesize=${MAX_TEXT_FILE_BYTES}`, i.e. `1048576` — not a `1M` suffix.)
 *
 * `GREP_SCOPE_FILE_LIMIT` = 10,000: at the measured ~0.004ms/file that is
 * ~50ms of scanning, far under the 30s default tier, so host-speed variance
 * does not threaten it — which is the whole reason the gate counts files
 * rather than seconds. Counting itself early-stops at cap+1, and the Node walk
 * of 10,000 files measured < 1s.
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
