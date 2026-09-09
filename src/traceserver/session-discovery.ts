/**
 * T6 (plans/session-folder-consolidation.md / SC16): read-side two-level tree
 * discovery.
 *
 * Layout: `<baseDir>/projects/<project-slug>/<conversationId>/trace.jsonl`.
 * The read side has no `projectIdentityRoot` at hand (T1's store does, but
 * it's the writer), so conversationId lookup is a walk under
 * `<baseDir>/projects/<project-slug>/<convId>/`. Multiple projects may have folders
 * named the same way — the read side picks the **latest mtime** and treats
 * any other matches as shadow copies of the same conversation.
 *
 * 写侧的 SSOT (`src/session-api/store/session-store.ts:resolveProjectSessionDir`
 * + `resolveConversationTraceFilePath`) is **not** imported here on purpose:
 * this file is a read-side helper, and the read side must not import the
 * writer-side path keys — coupling would mean a writer-side change could
 * silently flip read-side file lookups. Two layouts agree on the directory
 * shape, not on the same parse function.
 *
 * Behavior pinned by tests (`t6-two-level-tree.test.ts`):
 *   - `findConversationTraceFile(baseDir, conversationId)`: returns the
 *     trace.jsonl path, or undefined when no conversation folder matches.
 *   - `listConversations(baseDir)`: enumerate every `<baseDir>/projects/<project-slug>/<convId>`
 *     folder that has a `trace.jsonl`, newest-mtime first.
 *   - The `subagents/` subfolder is NEVER enumerated (SC16 subagent
 *     exclusion: per-agent files don't qualify as sessions).
 *   - Blob and meta files (`blobs/`, `*.meta.json`) are NEVER enumerated.
 *   - The session criterion is **the presence of `trace.jsonl`** (the
 *     conversation has begun recording); folder-without-trace.jsonl is
 *     ignored (still warming up, or only carries session.jsonl).
 *   - mtime/size semantics: stat `trace.jsonl` (the conversation file the
 *     reader reads), not the conversation folder; that is what callers see
 *     in their `list_sessions` response and what the L1 cap is measured
 *     against.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const PROJECTS_DIR_NAME = "projects";
const TRACE_FILE_NAME = "trace.jsonl";
const SUBAGENTS_DIR_NAME = "subagents";
const AGENT_VERSION_READ_WINDOW_BYTES = 65536;

export interface ConversationHit {
  readonly conversationId: string;
  readonly projectDir: string;
  readonly traceFilePath: string;
  readonly mtime: number;
  readonly size: number;
}

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

/**
 * Newest-first enumeration of every conversation under `baseDir` whose
 * folder carries a `trace.jsonl`. Each entry pins the trace file path so
 * the core can pass it straight to the JSONL reader.
 *
 * Sort order = mtime desc, with `conversationId` ascending as a total-order
 * tie-break (matches the existing `sessionsByRecency` contract so a
 * list_sessions page is stable across calls).
 */
export function listConversations(baseDir: string): ConversationHit[] {
  const projectsRoot = join(baseDir, PROJECTS_DIR_NAME);
  let projectDirNames: string[];
  try {
    projectDirNames = readdirSync(projectsRoot);
  } catch {
    return [];
  }
  const hits: ConversationHit[] = [];
  for (const name of projectDirNames) {
    const projectDir = join(projectsRoot, name);
    let convDirNames: string[];
    try {
      convDirNames = readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const convDirName of convDirNames) {
      // SC16: 排除 subagents/ 文件夹 —— 子代理落点不是会话,本枚举
      // 不应被它污染(`subagents/` 是 sibling of `<convId>`)。
      if (convDirName === SUBAGENTS_DIR_NAME) continue;
      const convDir = join(projectDir, convDirName);
      const traceFilePath = join(convDir, TRACE_FILE_NAME);
      let stats;
      try {
        stats = statSync(traceFilePath);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      hits.push({
        conversationId: convDirName,
        projectDir,
        traceFilePath,
        mtime: stats.mtimeMs,
        size: stats.size,
      });
    }
  }
  hits.sort(compareByRecency);
  return hits;
}

/** Total order: mtime desc, then conversationId asc (matches sessions.ts). */
function compareByRecency(a: ConversationHit, b: ConversationHit): number {
  if (a.mtime !== b.mtime) return b.mtime - a.mtime;
  if (a.conversationId === b.conversationId) return 0;
  return a.conversationId < b.conversationId ? -1 : 1;
}

/**
 * Read `agent_version` from the bounded-prefix window of one trace file.
 * Mirrors `sessions.ts:readBounded` + `agentVersionFromText` so the read
 * side and the writer-side file reader agree on the absence semantics
 * (absent = "no session root record in the read window", not "session is
 * unfinished"). Kept as a reimplementation (not a re-import) so the
 * read-side shape is testable without booting the writer.
 */
export function agentVersionFromTracePath(
  traceFilePath: string
): string | undefined {
  if (!existsSync(traceFilePath)) return undefined;
  const buf = Buffer.alloc(AGENT_VERSION_READ_WINDOW_BYTES);
  let fd: number | undefined;
  try {
    fd = openSync(traceFilePath, "r");
    const n = readSync(fd, buf, 0, AGENT_VERSION_READ_WINDOW_BYTES, 0);
    const text = buf.toString("utf8", 0, n);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        continue;
      }
      const row = parsed as Record<string, unknown>;
      if (row["record_type"] !== "session") continue;
      const v = row["agent_version"];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // close errors are not actionable here; the file may have been
        // unlinked between open and close (concurrent delete).
      }
    }
  }
}
