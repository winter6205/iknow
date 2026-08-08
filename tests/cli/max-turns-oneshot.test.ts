/**
 * tests/cli/max-turns-oneshot.test.ts
 *
 * plan T6: ask oneshot 的 maxTurns 纯函数呈现层。
 *
 * runOneShot 在 cli.ts 内(main() side-effect 不可 import),故纯函数
 * maxTurnsNotice / maxTurnsEnvelope 下沉到 src/cli/max-turns.ts,这里直接测。
 *
 * 断言:
 *   - maxTurnsNotice:stderr 通知行 + output 摘要;摘要缺席 → output 空;
 *   - maxTurnsEnvelope:JSON envelope(error / turnsRan / reason / message /
 *     stopSummary);stopSummary 缺席 → 字段缺席(byte-stable)。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { MaxTurnsExceeded } from "../../src/harness/errors.ts";
import {
  maxTurnsNotice,
  maxTurnsEnvelope,
} from "../../src/cli/max-turns.ts";

describe("maxTurnsNotice (chat REPL 呈现)", () => {
  it("含摘要 → stderr 通知 + output 摘要头 + 摘要文本", () => {
    const err = new MaxTurnsExceeded(1, "maxTurns");
    const { stderr, output } = maxTurnsNotice(err, "bounded work done");
    assert.match(stderr, /已达 maxTurns=1 轮上限（maxTurns），终止/);
    assert.equal(output, "收尾摘要：\nbounded work done");
  });

  it("摘要缺席 → output 空串(无空头)", () => {
    const err = new MaxTurnsExceeded(3, "maxTurns");
    const { stderr, output } = maxTurnsNotice(err, undefined);
    assert.match(stderr, /已达 maxTurns=3 轮上限/);
    assert.equal(output, "");
  });

  it("空串摘要等价缺席", () => {
    const err = new MaxTurnsExceeded(2, "maxTurns");
    assert.equal(maxTurnsNotice(err, "").output, "");
  });
});

describe("maxTurnsEnvelope (ask oneshot JSON)", () => {
  it("含摘要 → JSON envelope 带 stopSummary", () => {
    const err = new MaxTurnsExceeded(1, "maxTurns");
    const env = JSON.parse(maxTurnsEnvelope(err, "done summarizing")) as Record<
      string,
      unknown
    >;
    assert.equal(env.error, "max_turns_exceeded");
    assert.equal(env.turnsRan, 1);
    assert.equal(env.reason, "maxTurns");
    assert.match(env.message as string, /已达 maxTurns=1 轮上限/);
    assert.equal(env.stopSummary, "done summarizing");
  });

  it("摘要缺席 → stopSummary 字段缺席(byte-stable)", () => {
    const err = new MaxTurnsExceeded(4, "maxTurns");
    const parsed = JSON.parse(maxTurnsEnvelope(err, undefined)) as Record<
      string,
      unknown
    >;
    assert.equal("stopSummary" in parsed, false);
    assert.deepEqual(Object.keys(parsed).sort(), [
      "error",
      "message",
      "reason",
      "turnsRan",
    ]);
  });
});
