/**
 * `list_sessions` — the shared read-side core behind both thin tool faces
 * (ACI in-process + stdio MCP), mirroring `createQueryTraceCore`'s contract:
 * `options` in, one serialized JSON string out. The faces add their own schema,
 * their own tool-name prefix, and their own error mapping; they do not re-do the
 * reading, the ordering, or the paging.
 *
 * Why this axis needs its own tool (`query_trace` cannot cover it):
 *   - `query_trace` reads **one** file (`conversation_id ??
 *     newestConversationId`, see query-trace-core.ts), so it is structurally
 *     blind to the other sessions in the directory;
 *   - the session root record only lands at run end (src/harness/trace/jsonl.ts,
 *     sole caller src/harness/loop-engine.ts) and is always the file's last
 *     line — crashed or in-progress sessions simply have no root record;
 *   - `listSessions` (sessions.ts) builds its index from readdir + stat and
 *     scans for one root record only inside the first 64 KiB window (never
 *     reading whole files, never carrying record content into the response),
 *     so it finds both kinds.
 * Hence this tool answers the "what sessions exist" catalog axis, orthogonal
 * to the row axis (`query_trace`) and the byte-window axis (`get_record`).
 */
import { sessionsByRecency, type SessionSummary } from "./sessions.js";
import { parseInteger } from "./parse-integer.js";
import { TraceQueryValidationError } from "./query-trace-errors.js";

/**
 * The read unit of this axis = one page of session summaries. Default 100 is
 * the same magnitude as `query_trace`, but the names are **deliberately
 * separate**: the two axes count different units (a summary vs a record row).
 *
 * The 128 cap is derived from `TRACE_OUTPUT_BACKSTOP`, not a rounding
 * preference. A full page must serialize to parseable JSON under the cap, or
 * the truncation marker lands mid-array and the caller gets a fragment
 * instead of an index — and both backstop / executor caps count
 * `text.length`, so the budget unit here is **characters**, not bytes.
 * Measured (one-off probe over the main repo's 81 real sessions): one
 * summary's JSON body is 71–124 characters (UUID `conversation_id` +
 * `agent_version` present = 124; no `agent_version` = 71), and in-page
 * joining adds 1 inter-entry comma ⇒ 72–125 (test comments use the latter
 * caliber). At the in-page caliber: 128 × 125 = 16 000 < 20 000, while
 * 200 × 125 = 25 000 already breaks the cap; the printable ceiling for the
 * four fields is ≈126. (An older plan noted "~141 B per entry"; that could
 * not be reproduced on the same real directory — widest was 124 chars with
 * `agent_version` uniformly `0.1.0` — so this re-measurement stands.)
 * "A full page stays under the cap" is pinned by an empirical assertion in
 * tests/traceserver/list-sessions-core.test.ts — summary size drifts with
 * fields like `agent_version`, so the raw number alone is not enough.
 */
export const LIST_SESSIONS_DEFAULT_LIMIT = 100;
export const LIST_SESSIONS_MAX_LIMIT = 128;

/**
 * The one description text for both faces (one source, and it claims no
 * character cap — how much you read is `limit`, never a byte budget).
 * Positive-trigger phrasing, enforced by
 * tests/harness/aci/tools/d9-description-guard.test.ts.
 */
export const LIST_SESSIONS_DESCRIPTION =
  "List the trace sessions in this trace directory, most recently active first. " +
  "Read this to discover which conversation_id values exist before querying one. " +
  "Each entry carries conversation_id, mtime (epoch milliseconds), size (bytes), " +
  "and agent_version taken from that session's root record. The writer appends " +
  "the root record when a run ends, while this tool reads only the first 64 KiB " +
  "of each file, so the field is absent in two cases: the run has not ended, or " +
  "the file is larger than that read window and the root record sits past it. " +
  "Absence therefore reports that no root record was found in the window, and " +
  "says nothing about whether the session finished. Page the index with limit " +
  "(default 100, up to 128) and offset; the response echoes the effective limit " +
  "and offset, so a page shorter than the echoed limit means the index is " +
  "exhausted and offset + entries returned continues it. Pair a returned " +
  "conversation_id with query_trace to read that session's records.";

interface ListSessionsInput {
  readonly limit?: unknown;
  readonly offset?: unknown;
}

/**
 * The tool face's wire shape: `sessions` + **echo of the coordinates
 * actually used**.
 *
 * Echoing coordinates is not truncation metadata: contract X only forbids
 * `truncated` / `total` / `response_truncated` (ADR-0004), while `limit` /
 * `offset` are the read unit the caller itself supplied. The tool-face
 * output is defined as "array + echo of caller-supplied coordinates"; the
 * overflow cell of the boundary table says "drop only the tail + a resume
 * coordinate", and the row axis likewise keeps `offset` — one shape across
 * all three texts. What is echoed is the **effective value** (defaults when
 * not passed), so "did this page reach the end" is decided in place by
 * `sessions.length < limit`, and the resume coordinate = `offset +
 * sessions.length`; the caller need not remember what it passed.
 */
export interface ListSessionsPage {
  readonly sessions: ReadonlyArray<SessionSummary>;
  readonly limit: number;
  readonly offset: number;
}

export interface ListSessionsCoreOptions {
  readonly traceDir: string;
}

export type ListSessionsCoreHandler = (input: unknown) => Promise<string>;

export function createListSessionsCore(
  options: string | ListSessionsCoreOptions
): ListSessionsCoreHandler {
  const traceDir = typeof options === "string" ? options : options.traceDir;

  return async (input: unknown): Promise<string> => {
    const { limit, offset } = parseInput(input);
    // Re-read the index on every call: sessions are live and a cache would
    // hide new ones (same rationale as newestConversationId). Page order
    // comes from sessions.ts's comparator; this spot only slices a position.
    const page: ListSessionsPage = {
      sessions: sessionsByRecency(traceDir).slice(offset, offset + limit),
      limit,
      offset,
    };
    return JSON.stringify(page);
  };
}

function parseInput(input: unknown): { limit: number; offset: number } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TraceQueryValidationError("input", "input must be an object");
  }
  const raw = input as ListSessionsInput;
  // Both faces declare the same bounds on their own schema (ACI ajv
  // compiles and enforces, MCP zod enforces); re-checking here is the
  // second authority for the same rule, not a third semantics. The upper
  // bound is this file's const; the lower bounds (`limit` 1 / `offset` 0)
  // are literals in three places, and whether they drift across faces is
  // pinned unconditionally by the minimum-diff test in
  // tests/trace-mcp/server.test.ts.
  const limit =
    parseInteger(raw.limit, "limit", 1, LIST_SESSIONS_MAX_LIMIT) ??
    LIST_SESSIONS_DEFAULT_LIMIT;
  const offset = parseInteger(raw.offset, "offset", 0) ?? 0;
  return { limit, offset };
}
