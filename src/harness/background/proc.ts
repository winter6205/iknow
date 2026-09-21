/**
 * /proc process-metric reads (pure, stateless, no IO side effects).
 *
 * Single source: manager.spawn's starttime read, stale-reap's pgid-reuse
 * check, and the test helper all share one implementation (converged from
 * byte-identical duplication during code review). Pure functions: no process-
 * governance decisions, no caching, no throwing (unreadable -> undefined; the
 * caller applies the conservative policy).
 */
import { readFileSync } from "node:fs";

/**
 * Read field 22 of /proc/<pid>/stat (starttime): whitespace-split index 19
 * of the suffix (verified: node suffix[19] === awk $22). Unreadable dir /
 * file -> undefined. Caller semantics:
 *   - manager spawn: record the process-group leader's starttime so reap can
 *     avoid killing a recycled pgid by mistake;
 *   - stale-reap: compare the current pgid-leader's starttime with the one
 *     stored in the registry record; mismatch -> mark dead only, never kill a
 *     recycled group.
 */
export function readProcStartTime(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const suffix = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    const v = Number(suffix[19]);
    return Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
