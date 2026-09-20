/**
 * Session list reader (read side of the trace inspection panel).
 *
 * ADR-0071: two-level tree walk.
 *   - `traceDir` is now the **baseDir** — the parent of `<baseDir>/projects/`.
 *     Same path the cli passes via `IKNOW_TRACE_OUT`; the read side used to
 *     treat it as a flat `<traceDir>/<convId>.jsonl` directory, but writes
 *     already moved under the projects tree, and the read side has to
 *     follow.
 *   - Walk: `<baseDir>/projects/<project-slug>/<convId>/trace.jsonl`.
 *     Each conversation folder is a leaf, the `subagents/` sibling is
 *     excluded (subagent exclusion), and the `blobs/` subfolder is
 *     ignored (it sits under `<convId>/`, not a project root).
 *   - `mtime` / `size` = stat `trace.jsonl` (the file the reader reads),
 *     not the conversation folder or the project root. Pinned by tests
 *     under `t6-two-level-tree.test.ts`.
 *
 * Read + derived agent_version (prefix 64 KiB root-record scan) + total
 * order comparison stay in this file; only "where is each session" changed
 * from a flat directory file to a leaf under the two-level tree. The
 * existing bounded prefix scan is kept; its window cost is independent of
 * the tree move.
 *
 * Failure paths (unchanged contract):
 *   - readdir ENOENT (no baseDir / no projects/ level) -> empty list, not
 *     500 / not a throw.
 *   - single-file stat ENOENT (session deleted mid-read) -> skip that file.
 *   - root record absent / bad line / non-string agent_version -> field
 *     absent (optional, no whole-list failure).
 *   - any other read-side IO error -> TraceReadError (mapped to 500 by
 *     serve.ts, no fs detail leak).
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { isEnoent, wrapIoError } from "./io.js";
import {
  PROJECTS_DIR_NAME,
  SUBAGENT_TRACE_DIR_NAME,
} from "../shared/session-tree-names.js";

/** Read-side metadata for a session-list entry (wire shape, snake_case). */
export interface SessionSummary {
  conversation_id: string; // file name minus `.jsonl` = UUID
  mtime: number; // last activity (stat.mtimeMs)
  size: number; // bytes (the list never reads content; line count ≈ size)
  agent_version?: string; // read from the session root record; absent on missing / bad line
}

/**
 * ADR-0071: the trace file sits at the conversation folder root. The list
 * only walks folders whose `trace.jsonl` exists — that's the session
 * criterion. Folder-without-trace.jsonl is ignored (a freshly-mkdir'd
 * session that hasn't recorded yet).
 */
const TRACE_FILE_NAME_FOR_LIST = "trace.jsonl";

// -- bounded reads (no whole-file readFileSync) --------------------------------

/**
 * Read up to `cap` bytes of a file (bounded pread).
 *
 * The read side promises "never read file content" for the session list;
 * the sole exception is agent_version, which needs the session root record.
 * The cap keeps even huge files bounded; when the file is larger, only the
 * prefix is scanned — but the root record is written at run end, so the
 * prefix scan only reaches it when the whole file fits in the window; a
 * miss leaves the field absent.
 */
function readBounded(filePath: string, cap = 65536): string | undefined {
  const buf = Buffer.alloc(cap);
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const n = readSync(fd, buf, 0, cap, 0);
    return buf.toString("utf8", 0, n);
  } catch (err) {
    if (isEnoent(err)) return undefined; // deleted between stat and read → agent_version absent
    throw wrapIoError(err);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// -- agent_version extraction --------------------------------------------------

/**
 * Scan file text for the session root record and return its agent_version.
 *
 * Parse line by line, accepting only `record_type === "session"` rows (the
 * real writer appends it at run end = last line; the first line is usually
 * llm_call/turn, so never give up just because line 1 isn't session).
 * Root record absent / bad line / non-string -> undefined (field optional,
 * no whole-list failure).
 */
function agentVersionFromText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // bad line: skip, keep looking for the session root; all lines bad → absent
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      continue;
    }
    const row = parsed as Record<string, unknown>;
    if (row["record_type"] !== "session") continue; // not the session root row → skip
    const v = row["agent_version"];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  }
  return undefined; // no session root record / all lines bad → absent
}

// -- directory scan ------------------------------------------------------------

/**
 * List every session in `traceDir` by two-level readdir + stat.
 *
 * Walk: `<traceDir>/projects/<project-slug>/<convId>/trace.jsonl`.
 * The `subagents/` subfolder under each project is a per-agent sibling,
 * not a session — it never carries a `trace.jsonl` (per-agent trace lives
 * deeper at `<project-slug>/<convId>/subagents/agent-<taskId>.jsonl`),
 * but excluding it by name is the contract and protects the listing
 * if the per-agent file ever takes a `trace.jsonl` name.
 *
 * No directory (readdir ENOENT) -> empty list (not 500); single-file stat
 * ENOENT -> skip; other IO errors -> TraceReadError. conversation_id =
 * conversation folder name (locked by the writer: sanitized UUID shape).
 */
export function listSessions(traceDir: string): SessionSummary[] {
  const projectsRoot = join(traceDir, PROJECTS_DIR_NAME);
  let projectDirNames: string[];
  try {
    projectDirNames = readdirSync(projectsRoot);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw wrapIoError(err);
  }

  const sessions: SessionSummary[] = [];
  for (const projectName of projectDirNames) {
    const projectDir = join(projectsRoot, projectName);
    let convDirNames: string[];
    try {
      convDirNames = readdirSync(projectDir);
    } catch (err) {
      if (isEnoent(err)) continue; // project dir deleted mid-listing → skip
      throw wrapIoError(err);
    }
    for (const convDirName of convDirNames) {
      // Exclude the subagents/ folder — it hangs under <project-slug>/ and is not a session.
      if (convDirName === SUBAGENT_TRACE_DIR_NAME) continue;
      const convDir = join(projectDir, convDirName);
      const filePath = join(convDir, TRACE_FILE_NAME_FOR_LIST);
      let stats;
      try {
        stats = statSync(filePath);
      } catch (err) {
        if (isEnoent(err)) continue; // this session has no trace.jsonl → skip
        throw wrapIoError(err);
      }
      if (!stats.isFile()) continue;
      const agentVersion = agentVersionFromText(readBounded(filePath));
      sessions.push({
        conversation_id: convDirName,
        mtime: stats.mtimeMs,
        size: stats.size,
        ...(agentVersion !== undefined ? { agent_version: agentVersion } : {}),
      });
    }
  }
  return sessions;
}

// -- default (newest) session --------------------------------------------------

/** The max-mtime entry; on ties the earlier-listed one wins (only the maximum is needed, not a sort). */
function newestSession(
  sessions: ReadonlyArray<SessionSummary>
): SessionSummary | undefined {
  return sessions.reduce<SessionSummary | undefined>((latest, session) => {
    if (latest === undefined) return session;
    return session.mtime > latest.mtime ? session : latest;
  }, undefined);
}

/**
 * The single derivation of the "most recently active session"; both the
 * panel (`http.ts`) and the tool (`query-trace-core.ts`) implicit defaults
 * go through it.
 *
 * Re-reads the index on every call, no caching: new sessions can land
 * between polls (panel) or between consecutive tool calls, and a cached
 * default would go silently stale. No session / missing directory ->
 * undefined; each caller decides its own empty-result expression.
 *
 * This function deliberately does **not** build on `sessionsByRecency`:
 * its tie rule is "strictly newer wins, otherwise keep the earlier-listed
 * one", which is the existing default-session semantics (the panel's
 * default session comes from it; the tie level is pinned by
 * `tests/traceserver/sessions.test.ts`, while `http.test.ts` only covers
 * the default routing where mtime differs), whereas pagination needs a
 * deterministic total order. Two different needs, two separate comparators.
 */
export function newestConversationId(traceDir: string): string | undefined {
  return newestSession(listSessions(traceDir))?.conversation_id;
}

/**
 * **Deterministic page order** over the same session index: `mtime`
 * descending (most recently active first), ties broken by `conversation_id`
 * ascending. The `list_sessions` tool face slices it by the caller's
 * `limit` / `offset`.
 *
 * Why the `conversation_id` level is required: `listSessions` returns
 * readdir order, and readdir order is filesystem-decided — the same page
 * can swap members between two calls. Without breaking mtime ties you get
 * a random page, not "the page at the position the caller specified".
 *
 * Why a new function instead of sorting inside `listSessions`: the panel
 * (`http.ts`) wants the readdir-semantics index directly, and each face
 * manages its own wire shape.
 */
export function sessionsByRecency(traceDir: string): SessionSummary[] {
  return listSessions(traceDir).sort(compareByRecency);
}

/** `mtime` descending → on ties `conversation_id` ascending (total order, independent of readdir order). */
function compareByRecency(a: SessionSummary, b: SessionSummary): number {
  if (a.mtime !== b.mtime) return b.mtime - a.mtime;
  if (a.conversation_id === b.conversation_id) return 0;
  // Plain codepoint compare, not localeCompare: page order must not shift with the ICU locale.
  return a.conversation_id < b.conversation_id ? -1 : 1;
}
