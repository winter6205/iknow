/**
 * VerificationRecord / recordVerification (T6, #128 自动修正闭环).
 *
 * 契约（对齐既有 jsonl.test.ts 装配方式：captureWriter + always-throw writer）:
 * 1. jsonl sink 写入 VerificationRecord: 行形状 (record_type / verification_id /
 *    snake_case 顶层 key / conversation_id / 单 id 载体)
 * 2. 可选字段缺席 (failedCount / signature / finalOutcome) → 不写 key (Postel)
 * 3. noop 实现返回 undefined (零副作用, 编译覆盖由 typecheck 承担)
 * 4. always-throw writer → 返回 undefined, 不抛 (@throws never)
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import type { VerificationRecord } from "../../../src/harness/trace/types.ts";

const SAMPLE_VERIFICATION: VerificationRecord = {
  // id / sessionId / ts 由调用方提供 (plan §Decisions 定稿字段)。
  id: "ver-1",
  sessionId: "sess-1",
  round: 2,
  verdict: "true-failure",
  exitCode: 1,
  failedCount: 3,
  signature: "sig-abc123",
  action: "continue",
  finalOutcome: "fixed in round 3",
  ts: "2026-08-13T00:00:00.000Z",
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

describe("createJsonlTraceService — recordVerification", () => {
  it("行形状: record_type=verification, verification_id 取调用方 id, 顶层 snake_case, conversation_id 存在, 无重复 id 载体", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-ver.jsonl",
      conversationId: "conv-ver",
      writer,
    });
    const returned = await svc.recordVerification(SAMPLE_VERIFICATION);
    assert.equal(returned, SAMPLE_VERIFICATION.id);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.record_type, "verification");
    assert.equal(parsed.verification_id, "ver-1");
    assert.equal(parsed.conversation_id, "conv-ver");
    // snake_case 顶层 key
    assert.equal(parsed.session_id, "sess-1");
    assert.equal(parsed.round, 2);
    assert.equal(parsed.verdict, "true-failure");
    assert.equal(parsed.exit_code, 1);
    assert.equal(parsed.failed_count, 3);
    assert.equal(parsed.signature, "sig-abc123");
    assert.equal(parsed.action, "continue");
    assert.equal(parsed.final_outcome, "fixed in round 3");
    assert.equal(parsed.ts, SAMPLE_VERIFICATION.ts);
    // 单 id 载体: 顶层不重复落 id (id 已由 verification_id 承载)
    assert.equal(parsed.id, undefined);
  });

  it("可选字段缺席 (failedCount / signature / finalOutcome) → 不写对应 key (Postel)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-ver.jsonl",
      conversationId: "conv-ver-min",
      writer,
    });
    const minimal: VerificationRecord = {
      id: "ver-2",
      sessionId: "sess-2",
      round: 1,
      verdict: "pass",
      exitCode: 0,
      action: "stop",
      ts: "2026-08-13T00:00:01.000Z",
    };
    await svc.recordVerification(minimal);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(parsed.failed_count, undefined);
    assert.equal(parsed.signature, undefined);
    assert.equal(parsed.final_outcome, undefined);
    assert.ok(!("failed_count" in parsed), "failed_count must be absent");
    assert.ok(!("signature" in parsed), "signature must be absent");
    assert.ok(!("final_outcome" in parsed), "final_outcome must be absent");
  });

  it("@throws never: always-throw writer → 返回 undefined, 不抛", async () => {
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-ver.jsonl",
      conversationId: "conv-ver-fail",
      writer: (): void => {
        throw new Error("simulated disk failure");
      },
    });
    const result = await svc.recordVerification(SAMPLE_VERIFICATION);
    assert.equal(result, undefined);
  });
});

describe("recordVerification — 分类器分支字段 (T5, #128)", () => {
  it("reason/evidence/missing 完整 round-trip: 写入 → 解析 → snake_case key + 值保留", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-ver.jsonl",
      conversationId: "conv-ver-classifier",
      writer,
    });
    const classifierRecord: VerificationRecord = {
      id: "ver-class-1",
      sessionId: "sess-1",
      round: 1,
      verdict: "true-failure",
      exitCode: 1,
      action: "continue",
      ts: "2026-08-14T00:00:00.000Z",
      // 分类器分支 (spec A4): fail 态带 reason + evidence + missing。
      reason: "任务未完成: 迁移脚本缺失",
      evidence: [
        {
          command: "node scripts/check-migration.ts",
          result: "fail",
          output: "migration file not found",
        },
        { command: "test -f deploy.md", result: "fail" },
      ],
      missing: ["部署到 staging", "迁移脚本"],
    };
    const returned = await svc.recordVerification(classifierRecord);
    assert.equal(returned, classifierRecord.id);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.reason, "任务未完成: 迁移脚本缺失");
    // evidence 是嵌套 payload, 顶层 key 走 snake_case, 内部字段保持原样
    // (ADR-0003 Decision 8: camelToSnake 不递归)。
    assert.deepEqual(parsed.evidence, [
      {
        command: "node scripts/check-migration.ts",
        result: "fail",
        output: "migration file not found",
      },
      { command: "test -f deploy.md", result: "fail" },
    ]);
    assert.deepEqual(parsed.missing, ["部署到 staging", "迁移脚本"]);
    // 既有字段不受影响。
    assert.equal(parsed.verdict, "true-failure");
    assert.equal(parsed.record_type, "verification");
  });

  it("Postel: 显式 undefined 字段被 JSON.stringify 丢弃 (不写 key)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-ver.jsonl",
      conversationId: "conv-ver-postel",
      writer,
    });
    const recordWithUndefined: VerificationRecord = {
      id: "ver-postel-1",
      sessionId: "sess-1",
      round: 1,
      verdict: "pass",
      exitCode: 0,
      action: "stop",
      ts: "2026-08-14T00:00:00.000Z",
      reason: undefined,
      evidence: undefined,
      missing: undefined,
    };
    await svc.recordVerification(recordWithUndefined);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.ok(
      !("reason" in parsed),
      "reason must be absent (undefined dropped)"
    );
    assert.ok(
      !("evidence" in parsed),
      "evidence must be absent (undefined dropped)"
    );
    assert.ok(
      !("missing" in parsed),
      "missing must be absent (undefined dropped)"
    );
  });

  it("命令路径记录 (9 字段, 无分类器字段) → 序列化无新增 key (无回归)", async () => {
    const { lines, writer } = captureWriter();
    const svc = createJsonlTraceService({
      filePath: "/tmp/unused-ver.jsonl",
      conversationId: "conv-ver-cmd-path",
      writer,
    });
    await svc.recordVerification(SAMPLE_VERIFICATION);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.ok(!("reason" in parsed), "reason must be absent");
    assert.ok(!("evidence" in parsed), "evidence must be absent");
    assert.ok(!("missing" in parsed), "missing must be absent");
  });

  it("真实 FS: 写 <dir>/<convId>.jsonl → re-read → 分类器字段保留", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "iknow-trace-ver-cls-"));
    try {
      const svc = createJsonlTraceService({
        filePath: scratch,
        conversationId: "conv-ver-fs",
      });
      const classifierRecord: VerificationRecord = {
        id: "ver-fs-1",
        sessionId: "sess-1",
        round: 1,
        verdict: "unstable",
        exitCode: 127,
        action: "stop",
        ts: "2026-08-14T00:00:01.000Z",
        reason: "判官判不了: transport 错",
        evidence: undefined,
        missing: undefined,
      };
      const returned = await svc.recordVerification(classifierRecord);
      assert.equal(returned, classifierRecord.id);
      const filePath = join(scratch, "conv-ver-fs.jsonl");
      assert.equal(existsSync(filePath), true);
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(parsed["record_type"], "verification");
      assert.equal(parsed["verification_id"], "ver-fs-1");
      assert.equal(parsed["reason"], "判官判不了: transport 错");
      // abort 态无 evidence/missing: undefined 不落 key。
      assert.ok(!("evidence" in parsed), "evidence must be absent");
      assert.ok(!("missing" in parsed), "missing must be absent");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("createNoopTraceService — recordVerification", () => {
  it("返回 undefined (零副作用)", async () => {
    const svc = createNoopTraceService();
    const result = await svc.recordVerification(SAMPLE_VERIFICATION);
    assert.equal(result, undefined);
  });
});
