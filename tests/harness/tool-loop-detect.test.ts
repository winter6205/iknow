/**
 * #672 T3: 工具环检测纯函数 — empty / negative / overflow / concurrent 窗口 / fail-open。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  isStalledToolLoop,
  toolLoopEventFromCall,
  type ToolLoopEvent,
} from "../../src/harness/tool-loop-detect.ts";
import type { AnthropicContentBlock } from "../../src/harness/model-adapter/types.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";

const fail = (msg: string): ToolExecutionResult => ({
  kind: "execution_failed",
  toolUseId: "x",
  message: msg,
});

const okText = (text: string): ToolExecutionResult => ({
  kind: "ok",
  toolUseId: "x",
  payload: [{ type: "text", text }],
});

/**
 * read_image 成功臂的 payload 是 executor 下转型（as AnthropicContentBlock[]）
 * 后携带的 image block —— image 不在该联合内，构造测试数据同样需要下转型。
 */
const okImage = (
  mediaType: string,
  data: string
): ToolExecutionResult => ({
  kind: "ok",
  toolUseId: "x",
  payload: [
    {
      type: "image",
      source: { type: "base64", media_type: mediaType, data },
    } as unknown as AnthropicContentBlock,
  ],
});

function ev(
  name: string,
  input: unknown,
  result: ToolExecutionResult,
  phaseId: number
): ToolLoopEvent {
  return toolLoopEventFromCall(name, input, result, phaseId);
}

describe("isStalledToolLoop", () => {
  it("empty: no events → not stalled", () => {
    assert.equal(isStalledToolLoop([]), false);
  });

  it("negative: 4 identical execution_failed is below R=5", () => {
    const events = [0, 1, 2, 3].map((p) =>
      ev("bash", { command: "x" }, fail("boom"), p)
    );
    assert.equal(isStalledToolLoop(events), false);
  });

  it("R=5 identical execution_failed across 5 phases → stalled", () => {
    const events = [0, 1, 2, 3, 4].map((p) =>
      ev("bash", { command: "x" }, fail("boom"), p)
    );
    assert.equal(isStalledToolLoop(events), true);
  });

  it("overflow: 100 identical still stalled (closed trip)", () => {
    const events = Array.from({ length: 100 }, (_, p) =>
      ev("bash", { command: "x" }, fail("boom"), p)
    );
    assert.equal(isStalledToolLoop(events), true);
  });

  it("k=2 fail/read/fail… R=5 with stagnant result keys → stalled", () => {
    const events: ToolLoopEvent[] = [];
    for (let r = 0; r < 5; r += 1) {
      events.push(ev("edit", { path: "a.ts" }, fail("nope"), r));
      events.push(ev("read", { path: "a.ts" }, okText("same"), r));
    }
    assert.equal(isStalledToolLoop(events), true);
  });

  it("negative: same bash command but changing exit code is progress", () => {
    const events = [1, 1, 1, 1, 2].map((code, p) =>
      ev(
        "bash",
        { command: "test" },
        okText(JSON.stringify({ code, stdout: "" })),
        p
      )
    );
    assert.equal(isStalledToolLoop(events), false);
  });

  it("bash ok + nonzero is in (counts toward fuse)", () => {
    const events = [0, 1, 2, 3, 4].map((p) =>
      ev(
        "bash",
        { command: "false" },
        okText(JSON.stringify({ code: 1, stdout: "", stderr: "x" })),
        p
      )
    );
    assert.equal(isStalledToolLoop(events), true);
  });

  it("exception: unnormalizable MCP in the window → fail-open", () => {
    const bad = (phaseId: number): ToolLoopEvent => ({
      callKey: "mcp",
      resultKey: "x",
      normalizable: false,
      phaseId,
    });
    assert.equal(isStalledToolLoop([0, 1, 2, 3, 4].map(bad)), false);
  });

  it("concurrent: one wave of 8 identical calls shares phaseId → not stalled", () => {
    const wave = Array.from({ length: 8 }, () =>
      ev("echo", { n: 1 }, fail("e"), 0)
    );
    assert.equal(isStalledToolLoop(wave), false);
  });
});

/**
 * path-image-vision 修复 R2：read_image 成功臂的 payload 携带 ≤1.4MB base64
 * image block（executor 下转型塞进 AnthropicContentBlock[]）。resultKey 必须
 * 仍对「相同图像重复出现」判等（loop 语义不变），但不得携带像素本体。
 */
describe("image block resultKey fingerprint", () => {
  // 256KiB 伪随机像素 → base64 约 341K 字符，模拟 read_image 真实 payload 量级。
  const bigData = Buffer.alloc(256 * 1024, 0xab).toString("base64");
  const otherData = Buffer.alloc(256 * 1024, 0xcd).toString("base64");

  it("resultKey 不收像素：data 原文不出现在 resultKey 与 events 序列化中", () => {
    const e = ev("read_image", { path: "a.png" }, okImage("image/png", bigData), 0);
    assert.equal(e.normalizable, true);
    assert.ok(!e.resultKey.includes(bigData));
    assert.ok(!JSON.stringify(e).includes(bigData));
    // 指纹仍保留媒体类型信息供判等
    assert.ok(e.resultKey.includes("image/png"));
  });

  it("字节相同的图像 → resultKey 相等（loop 判等语义不变）", () => {
    const a = ev("read_image", { path: "a.png" }, okImage("image/png", bigData), 0);
    const b = ev("read_image", { path: "a.png" }, okImage("image/png", bigData), 1);
    assert.equal(a.resultKey, b.resultKey);
  });

  it("像素不同的图像 → resultKey 不等（内容哈希判等不误伤进展）", () => {
    const a = ev("read_image", { path: "a.png" }, okImage("image/png", bigData), 0);
    const b = ev("read_image", { path: "a.png" }, okImage("image/png", otherData), 1);
    assert.notEqual(a.resultKey, b.resultKey);
  });

  it("同像素不同 media_type → resultKey 不等（指纹含 media_type）", () => {
    const a = ev("read_image", { path: "a" }, okImage("image/png", bigData), 0);
    const b = ev("read_image", { path: "a" }, okImage("image/jpeg", bigData), 1);
    assert.notEqual(a.resultKey, b.resultKey);
  });

  it("同一图像重复 R=5 跨 phase → 仍判 stalled（大 payload 不再撑爆 events）", () => {
    const events = [0, 1, 2, 3, 4].map((p) =>
      ev("read_image", { path: "a.png" }, okImage("image/png", bigData), p)
    );
    assert.equal(isStalledToolLoop(events), true);
    // events 整体序列化必须远小于 5 份像素本体（不吞 base64 的可观测代理）
    assert.ok(JSON.stringify(events).length < bigData.length);
  });

  it("同一图像但像素每轮变化 → 不 stalled（判等基于内容哈希）", () => {
    const events = [0, 1, 2, 3, 4].map((p) =>
      ev(
        "read_image",
        { path: "a.png" },
        okImage("image/png", Buffer.alloc(256 * 1024, p).toString("base64")),
        p
      )
    );
    assert.equal(isStalledToolLoop(events), false);
  });
});
