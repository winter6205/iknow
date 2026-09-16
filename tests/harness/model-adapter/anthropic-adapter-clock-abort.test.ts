/**
 * transport-continue-persist T1 / spec inv 2（SC2）:**时钟 abort 不得翻成
 * `user_cancel`**；宿主 Ctrl+C 仍必须是 `user_cancel`。
 *
 * 这两件事在 thrown error 上完全同形：SDK 的 `APIUserAbortError` 不转发
 * `signal.reason`（fetch 不转发），且不设 `.name`（恒为 `"Error"`）。判据只能
 * 是 `signal.reason` 上的 `clock_abort` 标记，本文件把它钉死在翻译层。
 *
 * 分流：
 *   - 时钟标记 + 不可见 → `clock_timeout`（retry 类 → 可重发，spec inv 1）
 *   - 时钟标记 + 可见   → `timeout`（none 类 → 不重发）
 *   - 无标记的 abort    → `user_cancel`（宿主意图，绝不重发）
 *   - 429 / 5xx         → `llm_http` + `retry-after` 毫秒化（spec inv 4）
 *   - 连接故障          → `llm_network`（retry 类，spec inv 4）
 *   - cert / TLS 失败   → 非重试类（spec inv 4 的 cert 格）
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { translateAnthropicTransportFault } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import {
  classifyFault,
  clockAbortReasonOf,
  parseRetryAfterMs,
} from "../../../src/harness/fault-class.ts";

/** 复刻 loop-engine 到点时的做法：abort 一个带 clock_abort 标记的 reason。 */
function clockSignal(
  source: "idle" | "hardCap",
  visible: boolean
): AbortSignal {
  const controller = new AbortController();
  controller.abort(clockAbortReasonOf(source, visible));
  return controller.signal;
}

function hostAbortSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new DOMException("Aborted", "AbortError"));
  return controller.signal;
}

/** SDK 形态的 abort:这就是时钟到点时 adapter 里被 catch 到的那个 error。 */
function sdkAbortError(): APIUserAbortError {
  return new APIUserAbortError();
}

describe("translateAnthropicTransportFault: 时钟 abort ≠ user_cancel", () => {
  it("不可见 idle 到点 → clock_timeout(不是 user_cancel),且归 retry 类", () => {
    const event = translateAnthropicTransportFault(
      sdkAbortError(),
      clockSignal("idle", false)
    );
    assert.equal(event.kind, "clock_timeout");
    assert.notEqual(event.kind, "user_cancel");
    assert.equal(classifyFault(event), "retry");
  });

  it("不可见 hardCap 到点 → clock_timeout,source 透传为 hardCap", () => {
    const event = translateAnthropicTransportFault(
      sdkAbortError(),
      clockSignal("hardCap", false)
    );
    assert.deepEqual(event, {
      kind: "clock_timeout",
      source: "hardCap",
      visible: false,
    });
    assert.equal(classifyFault(event), "retry");
  });

  it("可见增量之后 idle 到点 → timeout(none 类),不重发", () => {
    const event = translateAnthropicTransportFault(
      sdkAbortError(),
      clockSignal("idle", true)
    );
    assert.equal(event.kind, "timeout");
    assert.equal(classifyFault(event), "none");
  });

  it("可见增量之后 hardCap 到点 → timeout(none 类)", () => {
    const event = translateAnthropicTransportFault(
      sdkAbortError(),
      clockSignal("hardCap", true)
    );
    assert.equal(event.kind, "timeout");
    assert.equal(classifyFault(event), "none");
  });

  it("宿主 abort(无时钟标记)→ user_cancel,不许被重试", () => {
    const event = translateAnthropicTransportFault(
      sdkAbortError(),
      hostAbortSignal()
    );
    assert.equal(event.kind, "user_cancel");
    assert.equal(classifyFault(event), "none");
  });

  it("signal 缺席(既有调用面)→ 仍是 user_cancel,不回退成时钟误标", () => {
    const event = translateAnthropicTransportFault(sdkAbortError());
    assert.equal(event.kind, "user_cancel");
  });

  it("时钟标记优先于裸 AbortError 形态(离线替身同型)", () => {
    const bare = new DOMException("This operation was aborted", "AbortError");
    assert.deepEqual(
      translateAnthropicTransportFault(bare, clockSignal("idle", false)),
      { kind: "clock_timeout", source: "idle", visible: false }
    );
  });

  it("标记缺席的裸 AbortError 形态 → user_cancel", () => {
    const bare = new DOMException("This operation was aborted", "AbortError");
    assert.equal(
      translateAnthropicTransportFault(bare, hostAbortSignal()).kind,
      "user_cancel"
    );
  });
});

describe("translateAnthropicTransportFault: retry-after 毫秒化", () => {
  it("retry-after 秒数在场 → llm_http.retryAfterMs", () => {
    const err = new APIError(
      429,
      { error: { message: "rate limited" } },
      undefined,
      new Headers({ "retry-after": "3" })
    );
    const event = translateAnthropicTransportFault(err);
    assert.equal(event.kind, "llm_http");
    assert.deepEqual(event, {
      kind: "llm_http",
      status: 429,
      retryAfterMs: 3_000,
    });
    assert.equal(classifyFault(event), "retry");
  });

  it("retry-after 畸形 / 缺席 → 字段不挂(退避回落表值)", () => {
    const malformed = new APIError(
      503,
      { error: { message: "unavailable" } },
      undefined,
      new Headers({ "retry-after": "not-a-number" })
    );
    assert.deepEqual(translateAnthropicTransportFault(malformed), {
      kind: "llm_http",
      status: 503,
    });
    const absent = new APIError(
      503,
      { error: { message: "unavailable" } },
      undefined,
      new Headers()
    );
    assert.deepEqual(translateAnthropicTransportFault(absent), {
      kind: "llm_http",
      status: 503,
    });
  });
});

/**
 * transport-continue-persist T1 / spec inv 4:显式网络故障必须可重试,且
 * 不得被翻成 `llm_http` 假状态码 —— SDK 的 `APIConnectionError` /
 * `APIConnectionTimeoutError` 都 extends `APIError` 而 `status === undefined`,
 * 落到泛化 HTTP 支就会变成 `llm_http: 0`(classifyFault → none),让 spec 的
 * 「explicit network faults」重试格永远不可达。
 */
describe("translateAnthropicTransportFault: 连接故障 ≠ 假 HTTP 状态", () => {
  it("SDK APIConnectionError(cause 为 fetch failed)→ llm_network,归 retry 类", () => {
    const err = new APIConnectionError({
      message: "Connection error.",
      cause: new TypeError("fetch failed"),
    });
    const event = translateAnthropicTransportFault(err);
    assert.deepEqual(event, { kind: "llm_network" });
    assert.equal(classifyFault(event), "retry");
  });

  it("连接被重置的 socket 错误同样落 llm_network(不依赖具体 message)", () => {
    const err = new APIConnectionError({
      cause: Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      }),
    });
    assert.equal(translateAnthropicTransportFault(err).kind, "llm_network");
  });

  it("SDK APIConnectionTimeoutError 是连接子类 → llm_network,归 retry 类", () => {
    const err = new APIConnectionTimeoutError();
    const event = translateAnthropicTransportFault(err);
    assert.deepEqual(event, { kind: "llm_network" });
    assert.equal(classifyFault(event), "retry");
  });

  it("裸 fetch failed(未包成 SDK 类)→ llm_network", () => {
    const event = translateAnthropicTransportFault(
      new TypeError("fetch failed")
    );
    assert.equal(event.kind, "llm_network");
    assert.equal(classifyFault(event), "retry");
  });

  it("时钟 abort 优先于连接故障翻译(连接错误 + 时钟标记 → clock_timeout)", () => {
    const err = new APIConnectionError({
      cause: new TypeError("fetch failed"),
    });
    assert.equal(
      translateAnthropicTransportFault(err, clockSignal("idle", false)).kind,
      "clock_timeout"
    );
  });
});

/**
 * spec inv 4 的 cert 格:证书 / TLS 校验失败是确定性失败,重发同一请求
 * 只会再失败一次 —— 必须落非重试类,且不得冒充可重试的 `llm_network`。
 * 这里显式钉住,而不是依赖「正则恰好没命中」的偶然。
 */
describe("translateAnthropicTransportFault: cert 失败不可重试", () => {
  it("unable to verify the first certificate → protocol_error(none 类)", () => {
    const event = translateAnthropicTransportFault(
      new Error("unable to verify the first certificate")
    );
    assert.equal(event.kind, "protocol_error");
    assert.notEqual(event.kind, "llm_network");
    assert.equal(classifyFault(event), "none");
  });

  it("SELF_SIGNED_CERT_IN_CHAIN 形态同样不可重试", () => {
    const event = translateAnthropicTransportFault(
      Object.assign(new Error("self signed certificate in certificate chain"), {
        code: "SELF_SIGNED_CERT_IN_CHAIN",
      })
    );
    assert.notEqual(event.kind, "llm_network");
    assert.equal(classifyFault(event), "none");
  });

  // cert 支只在「无 HTTP status」时才可判：真 HTTP 语义优先,否则一个碰巧
  // 提到证书字样的 5xx 会被降级成不可重试,丢掉本该有的重试。
  it("带数值 status 的 500 即使文案提到证书 → 仍 llm_http 可重试", () => {
    const err = new APIError(
      500,
      { error: { message: "upstream certificate renewal failed" } },
      undefined,
      new Headers()
    );
    const event = translateAnthropicTransportFault(err);
    assert.deepEqual(event, { kind: "llm_http", status: 500 });
    assert.equal(classifyFault(event), "retry");
  });

  it("带数值 status 的 400 不因 cause 挂着连接错误而变成可重试", () => {
    const err = new APIError(
      400,
      { error: { message: "bad request" } },
      undefined,
      new Headers(),
      undefined
    );
    Object.assign(err, { cause: new TypeError("fetch failed") });
    const event = translateAnthropicTransportFault(err);
    assert.deepEqual(event, { kind: "llm_http", status: 400 });
    assert.equal(classifyFault(event), "none");
  });
});

describe("parseRetryAfterMs 边界", () => {
  it("秒数(整数 / 小数)按秒解", () => {
    assert.equal(parseRetryAfterMs("3"), 3_000);
    assert.equal(parseRetryAfterMs("0"), 0);
    assert.equal(parseRetryAfterMs("1.5"), 1_500);
  });

  it("HTTP-date 形态按当前时刻折算", () => {
    const now = Date.parse("2026-09-15T00:00:00Z");
    assert.equal(
      parseRetryAfterMs("Tue, 15 Sep 2026 00:00:05 GMT", now),
      5_000
    );
  });

  it("恰好等于当前时刻的 HTTP-date → 0(不早于现在,合法)", () => {
    const now = Date.parse("2026-09-15T00:00:00Z");
    assert.equal(parseRetryAfterMs("Tue, 15 Sep 2026 00:00:00 GMT", now), 0);
  });

  it("过去时刻 / 负数 / 畸形 / 缺席 → undefined(不得给负退避)", () => {
    const now = Date.parse("2026-09-15T00:00:00Z");
    assert.equal(
      parseRetryAfterMs("Tue, 15 Sep 2026 00:00:00 GMT", now + 5_000),
      undefined
    );
    assert.equal(parseRetryAfterMs("-5"), undefined);
    assert.equal(parseRetryAfterMs("garbage"), undefined);
    assert.equal(parseRetryAfterMs(null), undefined);
    assert.equal(parseRetryAfterMs(undefined), undefined);
    assert.equal(parseRetryAfterMs(""), undefined);
  });
});
