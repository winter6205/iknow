/**
 * VerificationRecord 扩展 (B3, #449b evidence-first loop).
 *
 * 契约:
 * 1. verify 域 VerificationRecord 增 evidenceVerdict / gamingSignals 两个可选字段 +
 *    reason 字段保留 string 但新增 REASON_UNVERIFIED / REASON_ABORT_TYPED 字面常量 +
 *    VerifyReasonKind 判别类型 (判别用, reason 字段本身仍是 string)。
 * 2. trace 域 VerificationRecord 镜像同三字段; evidenceVerdict 在 trace 侧 = 同名字面
 *    字符串联合 (EVIDENCE_SUFFICIENT / EVIDENCE_CONTRADICTED / EVIDENCE_INSUFFICIENT) —
 *    trace bounded context 不 import verify 域类型 (文件头先例 + plan §Decisions)。
 * 3. 双轨 assert: createJsonlTraceService + createNoopTraceService
 *    - jsonl 行含 evidence_verdict / gaming_signals / reason 键 (snake_case 自动转)
 *    - 可选字段缺省 (无 evidenceVerdict / gamingSignals) → 行不含这两个键 (Postel)
 *    - noop 返回 undefined (零副作用)
 * 4. 真实 FS round-trip: 写 → re-read → 字段保留。
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

// 双轨 fixture (verify 域 + trace 域镜像同形态)
const SAMPLE_VERIFY_FULL: VerifyVerificationRecord = {
  id: "ver-b3-1",
  sessionId: "sess-b3-1",
  round: 1,
  verdict: "true-failure",
  exitCode: 1,
  action: "continue",
  ts: "2026-08-16T00:00:00.000Z",
  evidenceVerdict: "EVIDENCE_INSUFFICIENT",
  gamingSignals: ["assertion count dropped", "new skip added"],
  reason: REASON_UNVERIFIED,
};

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
// verify 域 — 类型形状
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
// trace 域 — jsonl 落盘 snake_case 转换 + 真实 FS round-trip
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
    // snake_case 转换不影响其他字段
    assert.equal(parsed.verdict, "true-failure");
    assert.equal(parsed.record_type, "verification");
    // 反向: camelCase key 不出现 (单 id 载体纪律保持)
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
    // reason 在 minimal 里也没填, 也不应出现
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
// trace 域 — noop 零副作用
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
