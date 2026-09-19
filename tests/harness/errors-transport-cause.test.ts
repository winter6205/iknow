/**
 * ADR-0094 / SC4-SC5 (viewport API error): summarizeTransportCause helper.
 *
 * 钉住 SDK-agnostic 形态:任何 unknown → 安全 `{ status?, message }` 或
 * `undefined`。SDK APIError 形态 = `{ status:number, message:string, name:"APIError" }`,
 * 但本 helper 不耦合该类型,只做结构化读取。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { AnthropicError } from "@anthropic-ai/sdk";
import {
  ModelStreamIncompleteError,
  ProtocolError,
  TransportRetryExhaustedError,
  summarizeTransportCause,
  transportApiErrorOf,
} from "../../src/harness/errors.ts";

describe("summarizeTransportCause (ADR-0094 SC4)", () => {
  it("APIError-like object → { status, message }", () => {
    const cause = {
      name: "APIError",
      status: 404,
      message:
        '{"error":{"message":"No active credentials for provider: 9router"}}',
    };
    const summary = summarizeTransportCause(cause);
    assert.deepEqual(summary, {
      status: 404,
      message:
        '{"error":{"message":"No active credentials for provider: 9router"}}',
    });
  });

  it("object without status → message-only", () => {
    const cause = { name: "Error", message: "network down" };
    const summary = summarizeTransportCause(cause);
    assert.deepEqual(summary, { message: "network down" });
  });

  it("object with empty message → non-empty String(cause) fallback", () => {
    const cause = { name: "APIError", status: 500, message: "" };
    const summary = summarizeTransportCause(cause);
    assert.notEqual(summary, undefined);
    assert.equal(summary?.status, 500);
    // 非空,因为 message="" 会回退到 String(cause)
    assert.ok((summary?.message ?? "").length > 0);
  });

  it("non-numeric status → no status field", () => {
    const cause = { status: "404", message: "x" };
    const summary = summarizeTransportCause(cause);
    assert.deepEqual(summary, { message: "x" });
  });

  it("Error instance → status=undefined, message=err.message", () => {
    const err = new Error("boom");
    const summary = summarizeTransportCause(err);
    assert.deepEqual(summary, { message: "boom" });
  });

  it("string cause → { message }", () => {
    const summary = summarizeTransportCause("plain text cause");
    assert.deepEqual(summary, { message: "plain text cause" });
  });

  it("null cause → undefined", () => {
    assert.equal(summarizeTransportCause(null), undefined);
  });

  it("undefined cause → undefined", () => {
    assert.equal(summarizeTransportCause(undefined), undefined);
  });

  it("number cause → { message: String(n) }", () => {
    const summary = summarizeTransportCause(404);
    assert.deepEqual(summary, { message: "404" });
  });

  it("empty object cause → { message: String({}) }", () => {
    const summary = summarizeTransportCause({});
    assert.notEqual(summary, undefined);
    assert.equal(summary?.status, undefined);
    // String({}) = "[object Object]" — message non-empty.
    assert.ok((summary?.message ?? "").length > 0);
  });

  // 真实 4xx throw 路径（ADR-0094 实测补刀）:SDK APIError 把网关 JSON 错误
  // 体挂在 `error` 字段;裸 APIError（非瞬态 HTTP 不包 TransportRetryExhausted）
  // 直达 TUI catch,服务商原文必须从嵌套体提取,而不是 SDK 的 HTTP 描述。
  it("SDK APIError shape with nested error body → provider message wins", () => {
    const cause = {
      name: "APIError",
      status: 404,
      message: "404 Not Found",
      error: {
        type: "error",
        error: {
          type: "not_found_error",
          message: "No active credentials for provider: fakeprov",
        },
      },
    };
    const summary = summarizeTransportCause(cause);
    assert.deepEqual(summary, {
      status: 404,
      message: "No active credentials for provider: fakeprov",
    });
  });

  it("nested error body one level (official API shape) → message wins", () => {
    const cause = {
      name: "APIError",
      status: 400,
      message: "400 Bad Request",
      error: {
        type: "invalid_request_error",
        message: "invalid params (2013)",
      },
    };
    const summary = summarizeTransportCause(cause);
    assert.deepEqual(summary, {
      status: 400,
      message: "invalid params (2013)",
    });
  });

  it("nested error body present but empty message → SDK message fallback", () => {
    const cause = {
      name: "APIError",
      status: 500,
      message: "500 Internal Server Error",
      error: { error: { message: "" } },
    };
    const summary = summarizeTransportCause(cause);
    assert.deepEqual(summary, {
      status: 500,
      message: "500 Internal Server Error",
    });
  });
});

/**
 * ADR-0111 Decision 2(c): `transportApiErrorOf` 覆盖面扩到
 * ModelStreamIncompleteError —— 兑现不变式「apiError 在场 ⇔ 带 cause 的
 * 瞬时模型流/传输失败」。cause 摘要复用 summarizeTransportCause（同一提取面）。
 */
describe("transportApiErrorOf (ADR-0111 D2c)", () => {
  it("ModelStreamIncompleteError with Error cause → { message } 摘要（cause 原文）", () => {
    const sdkErr = new AnthropicError(
      "stream ended without producing a Message with role=assistant"
    );
    const err = new ModelStreamIncompleteError(true, sdkErr);
    assert.deepEqual(transportApiErrorOf(err), { message: sdkErr.message });
  });

  it("ModelStreamIncompleteError with status-bearing cause → { status, message }", () => {
    const cause = { name: "APIError", status: 529, message: "Overloaded" };
    const err = new ModelStreamIncompleteError(false, cause);
    assert.deepEqual(transportApiErrorOf(err), {
      status: 529,
      message: "Overloaded",
    });
  });

  it("null / undefined cause → undefined（无 cause 不挂 apiError，通用文案保留）", () => {
    assert.equal(
      transportApiErrorOf(new ModelStreamIncompleteError(false, null)),
      undefined
    );
    assert.equal(
      transportApiErrorOf(new ModelStreamIncompleteError(false, undefined)),
      undefined
    );
  });

  it("无 cause 的其它 throwable（裸 ProtocolError 等）→ undefined（不变式反方向）", () => {
    assert.equal(transportApiErrorOf(new ProtocolError("broken")), undefined);
    assert.equal(transportApiErrorOf(new Error("boom")), undefined);
    assert.equal(transportApiErrorOf(null), undefined);
    assert.equal(transportApiErrorOf(undefined), undefined);
  });

  it("TransportRetryExhaustedError 既有行为不变：cause → 摘要", () => {
    const err = new TransportRetryExhaustedError(3, {
      status: 503,
      message: "unavailable",
    });
    assert.deepEqual(transportApiErrorOf(err), {
      status: 503,
      message: "unavailable",
    });
  });
});
