/**
 * Trace panel entry helpers (ADR-0020, plan T5) — pure-function coverage.
 * web 包无渲染测试框架（spec A8/A10），入口语义抽到 web/src/lib/trace-entry.ts
 * 后在 root vitest（node env）单测。
 *
 * 5 boundary classes (plan §T5 列):
 *   - empty: 会话列表空 → null（deep-link 也救不了空列表）；param 缺省 → mtime 最新
 *   - negative: deep-link 会话不存在 → 静默 fallback 最近会话（不报错）
 *   - overflow: 超长 conversationId → deep-link 构造不崩（encodeURIComponent 兜底）
 *   - exception: URL-unsafe 字符 id → round-trip 可解码还原
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  traceDeepLink,
  pickInitialTraceSession,
  type TraceSessionPick,
} from "../../web/src/lib/trace-entry.ts";

function s(conversation_id: string, mtime: number): TraceSessionPick {
  return { conversation_id, mtime };
}

describe("traceDeepLink", () => {
  it("plain id → /trace?session=<id>", () => {
    assert.equal(traceDeepLink("a1b2c3"), "/trace?session=a1b2c3");
  });

  it("overflow: 4096 字符 id 构造不崩", () => {
    const long = "x".repeat(4096);
    const url = traceDeepLink(long);
    assert.ok(url.startsWith("/trace?session="));
    assert.ok(url.length > 4096);
  });

  it("exception: URL-unsafe 字符 round-trip 可还原", () => {
    const weird = "id with space&query=?#";
    const url = traceDeepLink(weird);
    const param = new URL(url, "http://localhost").searchParams.get("session");
    assert.equal(param, weird);
  });
});

describe("pickInitialTraceSession", () => {
  const sessions = [s("older", 100), s("newest", 300), s("mid", 200)];

  it("无 param → mtime 最新（SC-V 23）", () => {
    assert.equal(pickInitialTraceSession(sessions, null), "newest");
  });

  it("param 命中列表 → 优先 deep-link 会话", () => {
    assert.equal(pickInitialTraceSession(sessions, "older"), "older");
  });

  it("negative: param 未命中 → 静默 fallback 最近会话", () => {
    assert.equal(pickInitialTraceSession(sessions, "ghost-id"), "newest");
  });

  it("empty: 空列表 → null（无论 param 与否）", () => {
    assert.equal(pickInitialTraceSession([], null), null);
    assert.equal(pickInitialTraceSession([], "whatever"), null);
  });

  it("不 mutate 输入列表", () => {
    const before = sessions.map((x) => x.mtime).join(",");
    pickInitialTraceSession(sessions, null);
    assert.equal(sessions.map((x) => x.mtime).join(","), before);
  });
});
