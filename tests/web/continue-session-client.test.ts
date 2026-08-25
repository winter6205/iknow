/**
 * T5 (#691): web client POST /sessions/:id/continue — mirrors compactSession.
 *
 * Empty JSON body; response is PostMessageResponse { session, turn }.
 * No GET /pending. Fetch-stub pattern from tests/web/subagents-api.test.ts.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { continueSession } from "../../web/src/api/client.ts";
import { SessionApiError } from "../../web/src/api/types.ts";

const CONTINUE_OK = {
  session: {
    conversation_id: "c1",
    json_mode: false,
    turn_count: 1,
    prior_count: 0,
  },
  turn: {
    query: "",
    answer: {
      finalText: "resumed",
      stopReason: "completed",
      turnCount: 1,
    },
  },
};

describe("continueSession client — POST /continue", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs /api/v1/sessions/:id/continue with empty JSON body", async () => {
    const calls: Array<{ input: RequestInfo; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({ input, init });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(CONTINUE_OK),
        };
      }) as unknown as typeof fetch
    );

    const res = await continueSession("c1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input, "/api/v1/sessions/c1/continue");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(calls[0]?.init?.body, JSON.stringify({}));
    assert.equal(res.session.conversation_id, "c1");
    assert.equal(res.turn.answer.finalText, "resumed");
    assert.equal(res.turn.query, "");
  });

  it("URL-encodes conversation id", async () => {
    const calls: Array<{ input: RequestInfo }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        calls.push({ input });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(CONTINUE_OK),
        };
      }) as unknown as typeof fetch
    );
    await continueSession("a/b c");
    assert.equal(calls[0]?.input, "/api/v1/sessions/a%2Fb%20c/continue");
  });

  it("400 ValidationError (nothing_pending) → SessionApiError, not swallowed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              kind: "validation",
              message: "nothing_pending: cannot continue this session",
              field: "continue",
            },
          }),
      })) as unknown as typeof fetch
    );
    await assert.rejects(
      () => continueSession("c1"),
      (err: unknown) => {
        assert.ok(err instanceof SessionApiError);
        assert.equal(err.status, 400);
        assert.match(err.message, /nothing_pending/);
        return true;
      }
    );
  });
});
