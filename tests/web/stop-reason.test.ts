/**
 * stop-reason.ts pure-helper tests (T6).
 *
 * Mirrors tests/web/thinking-settings.test.ts style: vitest describe/it +
 * node:assert/strict, root vitest (node env). The web package has no test
 * framework (spec A8/A10 forbid adding one).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  STOP_REASON_LABELS,
  stopReasonLabel,
} from "../../web/src/lib/stop-reason.ts";

describe("stopReasonLabel", () => {
  it("maps every non-completed stop reason to a Chinese notice", () => {
    assert.equal(stopReasonLabel("maxTurns"), "已达轮次上限，回答可能不完整");
    assert.equal(stopReasonLabel("nonSuccessStop"), "模型未正常完成回答");
    assert.equal(stopReasonLabel("protocolError"), "回答协议异常");
    assert.equal(stopReasonLabel("emptyFinalResponse"), "模型返回了空回答");
    assert.equal(stopReasonLabel("cancelled"), "请求已取消");
    assert.equal(stopReasonLabel("timeout"), "请求超时");
  });

  it("returns null for the completed stop reason", () => {
    assert.equal(stopReasonLabel("completed"), null);
  });

  it("returns null when reason is missing", () => {
    assert.equal(stopReasonLabel(undefined), null);
    assert.equal(stopReasonLabel(null), null);
    assert.equal(stopReasonLabel(""), null);
  });

  it("returns null for unknown values (forward compat with backend drift)", () => {
    assert.equal(stopReasonLabel("brandNewReason"), null);
    assert.equal(stopReasonLabel("Completed"), null); // case-sensitive
    assert.equal(stopReasonLabel(" unknown "), null); // no whitespace trim
  });

  it("does not render for completed even when paired with other args", () => {
    // Verifies the function is purely a mapping, not a UI concern.
    assert.equal(stopReasonLabel("completed"), null);
  });
});

describe("STOP_REASON_LABELS", () => {
  it("covers the six non-completed harness stop reasons", () => {
    assert.deepEqual(STOP_REASON_LABELS, {
      maxTurns: "已达轮次上限，回答可能不完整",
      nonSuccessStop: "模型未正常完成回答",
      protocolError: "回答协议异常",
      emptyFinalResponse: "模型返回了空回答",
      cancelled: "请求已取消",
      timeout: "请求超时",
    });
  });

  it("does not include the completed reason (it never renders)", () => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(STOP_REASON_LABELS, "completed"),
      false
    );
  });
});
