import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createQueryTraceCore,
  QUERY_TRACE_MAX_RECORD_ID_SCAN,
} from "../../src/traceserver/query-trace-core.ts";
import { TraceQueryRecordScanError } from "../../src/traceserver/query-trace-errors.ts";

/**
 * Characterization baseline for the record_id scan cap (plan
 * `trace-mcp-read-side-split` T2, spec SC14). Kept in its own file because the
 * fixture needs more matching rows than the cap, which makes this by far the
 * slowest test under `tests/traceserver/`: roughly 2.4-4.6 s depending on
 * parallel load (re-measured 3.6 s inside a full 13-file run, 2.4 s standalone),
 * against <=770 ms for every other file. Exact milliseconds are deliberately not
 * pinned — they do not reproduce across machines. The cost is the cap's, not the
 * fixture's: findRecord walks the scan cap in QUERY_TRACE_MAX_LIMIT pages
 * (findRecord's paging loop in query-trace-core.ts) and the synchronous reader
 * re-reads, re-parses and re-sorts the whole file on every query() call
 * (reader.ts:266-272), so this is 50 full parses of 10,001 rows.
 */

const traceDirs: string[] = [];

afterEach(() => {
  for (const traceDir of traceDirs.splice(0)) {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

function jsonLine(row: Record<string, unknown>): string {
  return `${JSON.stringify(row)}\n`;
}

describe("query_trace core record_id scan cap", () => {
  it("raises TraceQueryRecordScanError once the scan cap is exhausted without a match", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "iknow-query-trace-scan-"));
    traceDirs.push(traceDir);
    // One row more than the cap: the scan stops at the cap with `total` still
    // larger, which is exactly the condition that turns "not found" into a
    // raise instead of the silent empty result a small session returns.
    const rowCount = QUERY_TRACE_MAX_RECORD_ID_SCAN + 1;
    let content = "";
    for (let i = 0; i < rowCount; i++) {
      content += jsonLine({
        record_type: "llm_call",
        conversation_id: "big",
        llm_call_id: `llm-${i}`,
        turn_id: `turn-${i}`,
        started_at: "2026-01-01T00:00:00.000Z",
      });
    }
    writeFileSync(join(traceDir, "big.jsonl"), content);

    let caught: unknown;
    try {
      await createQueryTraceCore({ traceDir })({
        conversation_id: "big",
        record_id: "llm-missing",
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(
      caught instanceof TraceQueryRecordScanError,
      `expected a TraceQueryRecordScanError, got ${String(caught)}`
    );
    assert.equal(caught.kind, "record_scan");
    assert.equal(caught.recordId, "llm-missing");
    assert.equal(caught.scanned, QUERY_TRACE_MAX_RECORD_ID_SCAN);
    assert.equal(
      caught.message,
      `record_id scan exhausted after ${QUERY_TRACE_MAX_RECORD_ID_SCAN} records before finding 'llm-missing'`
    );
  }, 120_000 /* see the header: the scan cap, not this fixture, sets the cost */);
});
