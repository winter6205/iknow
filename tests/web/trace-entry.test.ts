/**
 * Trace panel entry helpers (ADR-0020) — pure-function coverage.
 * The web package has no render-test framework, so the entry semantics are
 * extracted into web/src/lib/trace-entry.ts and unit-tested under root vitest
 * (node env).
 *
 * Boundary classes:
 *   - empty: no sessions → null (deep-link cannot save an empty list); no param → latest mtime
 *   - negative: deep-linked session absent → silent fallback to the newest one (no error)
 *   - overflow: very long conversationId → deep-link construction survives (encodeURIComponent fallback)
 *   - exception: URL-unsafe chars in id → round-trip decodes back intact
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
