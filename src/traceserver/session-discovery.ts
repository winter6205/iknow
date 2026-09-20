/**
 * ADR-0071: read-side two-level tree discovery.
 *
 * Layout: `<baseDir>/projects/<project-slug>/<conversationId>/trace.jsonl`.
 * The read side has no `projectIdentityRoot` at hand (the writer-side store
 * does, but it's the writer), so conversationId lookup is a walk under
 * `<baseDir>/projects/<project-slug>/<convId>/`. Multiple projects may have folders
 * named the same way — the read side picks the **latest mtime** and treats
 * any other matches as shadow copies of the same conversation.
 *
 * The writer-side SSOT (`src/session-api/store/session-store.ts:resolveProjectSessionDir`
 * + `resolveConversationTraceFilePath`) is **not** imported here on purpose:
 * this file is a read-side helper, and the read side must not import the
 * writer-side path keys — coupling would mean a writer-side change could
 * silently flip read-side file lookups. Two layouts agree on the directory
 * shape, not on the same parse function.
 *
 * Consumers: `findConversationTraceFile` in `get-record-core.ts`,
 * `query-trace-core.ts`, and `http.ts`. The formerly exported
 * `listConversations` / `agentVersionFromTracePath` / `ConversationHit` had
 * zero consumers and were deleted; this header no longer claims coverage by
 * `t6-two-level-tree.test.ts` — that test only covers
 * `dereferenceTraceMessages`, not this file.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROJECTS_DIR_NAME } from "../shared/session-tree-names.js";

const TRACE_FILE_NAME = "trace.jsonl";

/**
 * Walk `<baseDir>/projects/<project-slug>/<convId>/trace.jsonl` and return
 * the trace file path for `conversationId`. If multiple project folders
 * hold a folder named `<convId>` (e.g. the same conversation spawned from
 * two worktrees of the same project under one base), the one with the
 * latest mtime wins — the older ones are shadow copies of the same
 * session.
 *
 * Returns `undefined` on absent or path-hostile `conversationId` — the
 * caller decides whether that becomes a `TraceSessionNotFoundError` (it
 * does, in all three cores).
 */
export function findConversationTraceFile(
  baseDir: string,
  conversationId: string
): string | undefined {
  if (
    typeof conversationId !== "string" ||
    conversationId.length === 0 ||
    conversationId.includes("/") ||
    conversationId.includes("\\")
  ) {
    return undefined;
  }
  const projectsRoot = join(baseDir, PROJECTS_DIR_NAME);
  let projectDirNames: string[];
  try {
    projectDirNames = readdirSync(projectsRoot);
  } catch {
    return undefined;
  }
  let latest: { mtime: number; traceFilePath: string } | undefined;
  for (const name of projectDirNames) {
    const projectDir = join(projectsRoot, name);
    const convDir = join(projectDir, conversationId);
    const traceFilePath = join(convDir, TRACE_FILE_NAME);
    let stats;
    try {
      stats = statSync(traceFilePath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    if (latest === undefined || stats.mtimeMs > latest.mtime) {
      latest = { mtime: stats.mtimeMs, traceFilePath };
    }
  }
  return latest?.traceFilePath;
}
