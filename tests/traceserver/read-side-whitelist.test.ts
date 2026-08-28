import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  createJsonlTraceReader,
  TRACE_FIELD_DEFS,
  TRACE_RECORD_TYPES,
} from "../../src/traceserver/index.ts";
import { startTraceServe, type TraceListeningServer } from "../../src/traceserver/serve.ts";

const rows = [
  {
    conversation_id: "c1",
    record_type: "verification",
    verification_id: "v-1",
    session_id: "s-1",
    round: 1,
    verdict: "pass",
    exit_code: 0,
    action: "stop",
    ts: "2026-08-28T00:00:01.000Z",
    turn_id: "turn-1",
  },
  {
    conversation_id: "c1",
    record_type: "goal",
    goal_id: "g-1",
    session_id: "s-1",
    action: "pin",
    status: "active",
    text_len: 4,
    ts: "2026-08-28T00:00:02.000Z",
    turn_id: "turn-2",
  },
  {
    conversation_id: "c1",
    record_type: "verification",
    verification_id: "v-2",
    session_id: "s-1",
    round: 2,
    verdict: "true-failure",
    exit_code: 1,
    action: "continue",
    ts: "2026-08-28T00:00:03.000Z",
    turn_id: "turn-10",
  },
];

describe("T7 traceserver read-side contract", () => {
  let tmpDir: string;
  let tracePath: string;
  let server: TraceListeningServer | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "iknow-traceserver-t7-"));
    tracePath = join(tmpDir, "c1.jsonl");
    writeFileSync(tracePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  });

  afterEach(async () => {
    if (server) await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends verification and goal to the record-type whitelist", () => {
    assert.deepEqual(
      TRACE_RECORD_TYPES.slice(-2),
      ["verification", "goal"]
    );
  });

  it("declares scalar verification and goal columns", () => {
    const declared = new Set(
      TRACE_FIELD_DEFS.flatMap((field) => [field.jsonlKey])
    );
    for (const key of [
      "verification_id",
      "goal_id",
      "session_id",
      "round",
      "verdict",
      "action",
      "text_len",
    ]) {
      assert.ok(declared.has(key), `missing field ${key}`);
    }
  });

  it("filters turn_id exactly at reader level", () => {
    const reader = createJsonlTraceReader({ filePath: tracePath });
    const result = reader.query({ turnId: "turn-1" });
    assert.equal(result.total, 1);
    assert.equal(result.records[0]?.["verification_id"], "v-1");
  });

  it("accepts verification and goal filters and turn_id over HTTP", async () => {
    server = await startTraceServe({
      host: "127.0.0.1",
      port: 0,
      traceOut: tmpDir,
    });
    const origin = `http://${server.host}:${server.port}`;

    for (const recordType of ["verification", "goal"]) {
      const response = await fetch(
        `${origin}/api/v1/traces?conversation_id=c1&record_type=${recordType}`
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        records: Array<Record<string, unknown>>;
      };
      assert.ok(body.records.every((record) => record.record_type === recordType));
    }

    const turnResponse = await fetch(
      `${origin}/api/v1/traces?conversation_id=c1&turn_id=turn-10`
    );
    assert.equal(turnResponse.status, 200);
    const turnBody = (await turnResponse.json()) as {
      records: Array<Record<string, unknown>>;
    };
    assert.deepEqual(turnBody.records.map((record) => record.verification_id), ["v-2"]);
  });

  it("rejects an empty turn_id with a typed validation response", async () => {
    server = await startTraceServe({
      host: "127.0.0.1",
      port: 0,
      traceOut: tmpDir,
    });
    const response = await fetch(
      `http://${server.host}:${server.port}/api/v1/traces?turn_id=`
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as {
      error?: { kind?: string; field?: string };
    };
    assert.equal(body.error?.kind, "validation");
    assert.equal(body.error?.field, "turn_id");
  });
});
