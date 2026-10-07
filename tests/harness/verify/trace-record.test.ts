/**
 * VerificationRecord extension for the evidence-first loop.
 *
 * Contract:
 * 1. verify-domain VerificationRecord gains optional evidenceVerdict /
 *    gamingSignals; reason stays a string but adds the REASON_UNVERIFIED /
 *    REASON_ABORT_TYPED literals plus the VerifyReasonKind discriminated type
 *    (for discrimination only — the field itself remains string).
 * 2. trace-domain VerificationRecord mirrors the same three fields; on the
 *    trace side evidenceVerdict is the same-name string union (EVIDENCE_SUFFICIENT
 *    / EVIDENCE_CONTRADICTED / EVIDENCE_INSUFFICIENT) — the trace bounded
 *    context must not import verify-domain types.
 * 3. Double-track assert: createJsonlTraceService + createNoopTraceService
 *    - jsonl lines carry evidence_verdict / gaming_signals / reason keys (auto snake_case)
 *    - absent optional fields (no evidenceVerdict / gamingSignals) → those keys
 *      are not emitted (Postel)
 *    - noop returns undefined (zero side effects)
 * 4. Real-FS round-trip: write → re-read → fields preserved.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import type { VerificationRecord as TraceVerificationRecord } from "../../../src/harness/trace/types.ts";
import type { VerificationRecord as VerifyVerificationRecord } from "../../../src/harness/verify/types.ts";
import {
  REASON_ABORT_TYPED,
  REASON_UNVERIFIED,
} from "../../../src/harness/verify/types.ts";

// Dual-track fixtures (verify domain + mirrored trace-domain shape)
const SAMPLE_VERIFY_MINIMAL: VerifyVerificationRecord = {
  id: "ver-b3-min",
  sessionId: "sess-b3-min",
  round: 1,
  verdict: "pass",
  exitCode: 0,
  action: "stop",
  ts: "2026-08-16T00:00:01.000Z",
};

const SAMPLE_TRACE_FULL: TraceVerificationRecord = {
  id: "ver-b3-trace-1",
  sessionId: "sess-b3-1",
  round: 1,
  verdict: "true-failure",
  exitCode: 1,
  action: "continue",
  ts: "2026-08-16T00:00:00.000Z",
  evidenceVerdict: "EVIDENCE_INSUFFICIENT",
  gamingSignals: ["assertion count dropped"],
  reason: REASON_ABORT_TYPED,
};

const SAMPLE_TRACE_MINIMAL: TraceVerificationRecord = {
  id: "ver-b3-trace-min",
  sessionId: "sess-b3-trace-min",
  round: 1,
  verdict: "pass",
  exitCode: 0,
  action: "stop",
  ts: "2026-08-16T00:00:02.000Z",
};

function captureWriter(): {
  lines: string[];
  writer: (line: string) => void;
} {
  const lines: string[] = [];
  return {
    lines,
    writer: (line: string): void => {
      lines.push(line);
    },
  };
}

// -----------------------------------------------------------------------------
// verify domain — type shape
// -----------------------------------------------------------------------------
describe("verify/types — VerificationRecord 扩展 (B3)", () => {
  it("字面常量 REASON_UNVERIFIED === 'unverified'", () => {
    assert.equal(REASON_UNVERIFIED, "unverified");
  });

  it("字面常量 REASON_ABORT_TYPED === 'abort'", () => {
    assert.equal(REASON_ABORT_TYPED, "abort");
  });

  it("可选字段 evidenceVerdict 接受 EVIDENCE_* 三态值", () => {
    const r1: VerifyVerificationRecord = {
      ...SAMPLE_VERIFY_MINIMAL,
      evidenceVerdict: "EVIDENCE_SUFFICIENT",
    };
    const r2: VerifyVerificationRecord = {
      ...SAMPLE_VERIFY_MINIMAL,
      evidenceVerdict: "EVIDENCE_CONTRADICTED",
    };
    const r3: VerifyVerificationRecord = {
      ...SAMPLE_VERIFY_MINIMAL,
      evidenceVerdict: "EVIDENCE_INSUFFICIENT",
    };
    assert.equal(r1.evidenceVerdict, "EVIDENCE_SUFFICIENT");
    assert.equal(r2.evidenceVerdict, "EVIDENCE_CONTRADICTED");
    assert.equal(r3.evidenceVerdict, "EVIDENCE_INSUFFICIENT");
  });

  it("可选字段 gamingSignals 接受 ReadonlyArray<string>", () => {
    const r: VerifyVerificationRecord = {
      ...SAMPLE_VERIFY_MINIMAL,
      gamingSignals: ["sig-a", "sig-b"],
    };
    assert.deepEqual(r.gamingSignals, ["sig-a", "sig-b"]);
  });
});

// -----------------------------------------------------------------------------
// trace domain — jsonl snake_case conversion + real-FS round-trip
// -----------------------------------------------------------------------------
describe("createJsonlTraceService — recordVerification B3 新字段", () => {
  it("evidenceVerdict / gamingSignals / reason 完整 round-trip: snake_case key 落盘 + 值保留", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-b3.jsonl",
      conversationId: "conv-b3-full",
      writer,
    });
    const returned = await svc.recordVerification(SAMPLE_TRACE_FULL);
    assert.equal(returned, SAMPLE_TRACE_FULL.id);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.evidence_verdict, "EVIDENCE_INSUFFICIENT");
    assert.deepEqual(parsed.gaming_signals, ["assertion count dropped"]);
    assert.equal(parsed.reason, "abort");
    // snake_case conversion must not affect other fields
    assert.equal(parsed.verdict, "true-failure");
    assert.equal(parsed.record_type, "verification");
    // Conversely: no camelCase keys appear (single id-carrier discipline holds)
    assert.equal(parsed.evidenceVerdict, undefined);
    assert.equal(parsed.gamingSignals, undefined);
  });

  it("Postel: 可选字段缺省 (无 evidenceVerdict / gamingSignals) → 行不含对应 key", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-b3.jsonl",
      conversationId: "conv-b3-min",
      writer,
    });
    await svc.recordVerification(SAMPLE_TRACE_MINIMAL);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.ok(
      !("evidence_verdict" in parsed),
      "evidence_verdict must be absent"
    );
    assert.ok(!("gaming_signals" in parsed), "gaming_signals must be absent");
    // reason is also unset in the minimal record and must not appear
    assert.ok(!("reason" in parsed), "reason must be absent when undefined");
  });

  it("真实 FS: 写 <dir>/<convId>.jsonl → re-read → B3 新字段保留", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "iknow-b3-trace-"));
    try {
      const svc = createJsonlTraceService({
        filePath: scratch,
        conversationId: "conv-b3-fs",
      });
      const returned = await svc.recordVerification(SAMPLE_TRACE_FULL);
      assert.equal(returned, SAMPLE_TRACE_FULL.id);
      const filePath = join(scratch, "conv-b3-fs.jsonl");
      assert.equal(existsSync(filePath), true);
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(parsed["record_type"], "verification");
      assert.equal(parsed["verification_id"], "ver-b3-trace-1");
      assert.equal(parsed["evidence_verdict"], "EVIDENCE_INSUFFICIENT");
      assert.deepEqual(parsed["gaming_signals"], ["assertion count dropped"]);
      assert.equal(parsed["reason"], "abort");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// trace domain — noop, zero side effects
// -----------------------------------------------------------------------------
describe("createNoopTraceService — recordVerification B3 新字段", () => {
  it("B3 全字段 record → 返回 undefined (零副作用, 无 IO)", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordVerification(SAMPLE_TRACE_FULL);
    assert.equal(result, undefined);
  });

  it("缺省字段 record → 返回 undefined", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordVerification(SAMPLE_TRACE_MINIMAL);
    assert.equal(result, undefined);
  });
});
