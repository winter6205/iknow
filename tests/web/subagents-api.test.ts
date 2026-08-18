/**
 * #358 T8: Subagent endpoint client wiring — pure-helper + fetch-stub tests.
 *
 * `resolveSubagentsPath` is a pure URL builder exported alongside
 * `getSubagents` so the URL contract is testable without a fetch mock (mirrors
 * `tests/web/trace-api-base.test.ts` convention). The full fetch + JSON-parse
 * chain is verified below by stubbing `global.fetch` and asserting both the
 * outgoing path and the unwrapped `SubagentsResponse` shape — the same
 * `request<T>` wrapper is exercised across all client helpers, so this
 * asserts the T7 endpoint contract: `GET /sessions/:id/subagents` →
 * `{ subagents: SubagentStatus[] }`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSubagents,
  resolveSubagentsPath,
} from "../../web/src/api/client.ts";

describe("resolveSubagentsPath (#358 T8)", () => {
  it("builds the GET /sessions/:id/subagents path under the chat sessions API", () => {
    expect(resolveSubagentsPath("c1")).toBe("/api/v1/sessions/c1/subagents");
  });

  it("URL-encodes conversationId special characters (mirror listPendingAsks)", () => {
    expect(resolveSubagentsPath("a/b c?x=1")).toBe(
      "/api/v1/sessions/a%2Fb%20c%3Fx%3D1/subagents"
    );
  });
});

describe("getSubagents (#358 T8)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /api/v1/sessions/<id>/subagents and unwraps { subagents: [...] }", async () => {
    const items = [
      {
        taskId: "t1",
        state: "running",
        taskPreview: "fix flaky test",
        startedAt: "2026-08-18T03:00:00.000Z",
      },
      {
        taskId: "t2",
        state: "completed",
        taskPreview: "build summary",
        startedAt: "2026-08-18T02:00:00.000Z",
        endedAt: "2026-08-18T02:01:00.000Z",
        summary: "done in 60s",
      },
    ];
    const calls: Array<{ input: RequestInfo; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ subagents: items }),
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const res = await getSubagents("c1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/api/v1/sessions/c1/subagents");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(res.subagents).toHaveLength(2);
    expect(res.subagents[0]?.state).toBe("running");
    expect(res.subagents[0]?.taskId).toBe("t1");
    expect(res.subagents[1]?.state).toBe("completed");
    expect(res.subagents[1]?.summary).toBe("done in 60s");
  });

  it("rejects with SessionApiError on non-2xx (typed-error propagation)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () =>
          JSON.stringify({
            error: { kind: "internal", message: "boom" },
          }),
      })) as unknown as typeof fetch
    );
    await expect(getSubagents("c1")).rejects.toThrow(/boom/);
  });
});
