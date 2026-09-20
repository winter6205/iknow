/**
 * Trace read-side scan-root resolution (ADR-0071): flag > `IKNOW_TRACE_OUT` env >
 * caller's write-side dataDir.
 *
 * Trace anchors live inside the session folder; main-session writes derive
 * the path via hub / store (`resolveConversationTraceFilePath`). This root
 * serves as the scan root for the ACI read-side tools (list_sessions /
 * query_trace / get_record) and the trace panel directory. The write-side
 * session pool is explicit `--data-dir` or `~/.iknow` (ADR-0087: no more
 * per-cwd / workspaceRoot sharding), so the fallback must reuse the
 * caller's own write-side dataDir.
 *
 * Separate module because cli.ts has module-level `main()` side effects and
 * cannot be imported by tui/run.tsx or tests; this module is side-effect free.
 *
 * `resolve` normalizes any relative input to an absolute path so downstream
 * mkdirSync / appendFileSync never re-anchor on the launch-time CWD when a
 * caller passes a cwd-relative path.
 */
import { resolve } from "node:path";
import { resolveServeDataDir } from "../session-api/serve.js";

export function resolveTraceRoot(
  flag: string | undefined,
  writeSideDataDir: string | undefined
): string {
  return resolve(
    flag ??
      process.env.IKNOW_TRACE_OUT ??
      writeSideDataDir ??
      // Last-resort fallback: caller passed no write-side pool root (legacy
      // caller / test seam) -> default `~/.iknow`. All three entry points
      // (chat / serve / tui) pass `resolveServeDataDir(parsed.dataDir)`
      // explicitly, so this branch only fires where no `--data-dir` can be
      // forwarded (ADR-0087 default pool root).
      resolveServeDataDir()
  );
}
