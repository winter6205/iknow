/**
 * spec session-list-title — GET /api/v1/sessions 消费面：
 *  - `SessionListItem.title` 是主行字段（渲染逻辑测试见 SessionSidebar.test.ts
 *    的 sidebarLineText——web 包无 DOM 测试框架，spec A8/A10）。
 *  - listSessions 的空会话过滤继续按 lastFinalText 命中，不因主行改读
 *    title 而放宽（Does not「中途反复改题、列表双行」；过滤行为不变）。
 *
 * Fetch-stub pattern from tests/web/subagents-api.test.ts /
 * continue-session-client.test.ts.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { listSessions } from "../../web/src/api/client.ts";

function stubListFetch(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    })) as unknown as typeof fetch
  );
}

describe("listSessions — title 透传 + lastFinalText 过滤不变", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("服务端返回的 title 原样透传给调用方", async () => {
    stubListFetch({
      sessions: [
        {
          conversation_id: "c1",
          updatedAt: "2026-07-30T12:00:00.000Z",
          lastFinalText: "answer",
          title: "会话主题标签",
        },
      ],
    });
    const { sessions } = await listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.title, "会话主题标签");
  });

  it("过滤仍按 lastFinalText：title 非空但 lastFinalText 为空的 bootstrap 会话仍被丢弃", async () => {
    stubListFetch({
      sessions: [
        {
          conversation_id: "empty-bootstrap",
          updatedAt: "2026-07-30T12:00:00.000Z",
          lastFinalText: "",
          title: "占位标题",
        },
        {
          conversation_id: "active",
          updatedAt: "2026-07-30T11:00:00.000Z",
          lastFinalText: "有回复",
          title: "活跃会话",
        },
      ],
    });
    const { sessions } = await listSessions();
    assert.deepEqual(
      sessions.map((s) => s.conversation_id),
      ["active"]
    );
  });

  it("lastFinalText 全空 → 空列表（既有行为，不因 title 存在而保留）", async () => {
    stubListFetch({
      sessions: [
        {
          conversation_id: "c1",
          updatedAt: "2026-07-30T12:00:00.000Z",
          lastFinalText: "   ",
          title: "有标题",
        },
      ],
    });
    const { sessions } = await listSessions();
    assert.equal(sessions.length, 0);
  });
});
