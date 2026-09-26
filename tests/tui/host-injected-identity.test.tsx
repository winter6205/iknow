/** @jsxImportSource @opentui/react */
/**
 * tests/tui/host-injected-identity.test.tsx — host-injected 消息的 UI 身份
 * (plans/host-injected-ui-identity.md T2, form per T1 decision).
 *
 * Contract under test (marker-keyed, never envelope-text-keyed):
 *  - `role:"user"` + `hostInjected:true` and not in the hidden list →
 *    annotated prefix `[系统注入]` + warning colour, body visible, no ❯
 *    bubble; any future stamped envelope (validation-loop fuse) rides the
 *    same branch;
 *  - plain user messages keep the ❯ bubble byte-for-byte;
 *  - hidden-list kinds (agent_status bar / drain / verify / graph_mode /
 *    skill-index) stay suppressed even though they carry the stamp
 *    (decision (b): 现状分治不动).
 */
import { describe, expect, test } from "bun:test";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import { MessageBlocks } from "../../src/tui/message-blocks.js";
import { tuiPalette } from "../../src/tui/theme.js";
import { LOOP_DETECTED_TEXT } from "../../src/harness/tool-loop-detect.js";

const COLS = 60;

async function renderBlocks(
  message: AnthropicNativeMessage
): Promise<Awaited<ReturnType<typeof testRender>>> {
  const setup = await testRender(
    <MessageBlocks message={message} cols={COLS} statusMap={new Map()} />,
    { width: COLS, height: 20, exitOnCtrlC: false }
  );
  await setup.waitForVisualIdle();
  return setup;
}

function stampedUser(text: string): AnthropicNativeMessage {
  return Object.freeze({
    role: "user" as const,
    content: Object.freeze([Object.freeze({ type: "text" as const, text })]),
    hostInjected: true as const,
  });
}

function fgOfSpanWith(
  setup: Awaited<ReturnType<typeof testRender>>,
  needle: string
): RGBA | undefined {
  const { lines } = setup.captureSpans();
  for (const line of lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span.fg;
    }
  }
  return undefined;
}

describe("hostInjected user 消息：标注前缀 + 区分样式（T1 决策形态）", () => {
  test("LOOP_DETECTED envelope：[系统注入] 前缀 + 正文可见，不再是 ❯ 气泡", async () => {
    const setup = await renderBlocks(stampedUser(LOOP_DETECTED_TEXT));
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[系统注入]");
    expect(frame).toContain("LOOP_DETECTED: tool-call loop stalled");
    expect(frame.includes("❯")).toBe(false);
    // T1 形态 = 警示色（running token），区别于 ❯ 气泡的 accent + userBg。
    const fg = fgOfSpanWith(setup, "[系统注入]");
    expect(fg).toBeDefined();
    const expected = RGBA.fromHex(tuiPalette.running);
    expect(
      fg!.r === expected.r && fg!.g === expected.g && fg!.b === expected.b
    ).toBe(true);
    await setup.renderer.destroy();
  });

  test("分支按标记泛化：任意新 stampenvelope（如 validation 熔断文本）同形态", async () => {
    const setup = await renderBlocks(
      stampedUser("VALIDATION_LOOP_DETECTED: 未来窄谱熔断 envelope 示例。")
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[系统注入]");
    expect(frame).toContain("VALIDATION_LOOP_DETECTED");
    expect(frame.includes("❯")).toBe(false);
    await setup.renderer.destroy();
  });

  test("普通用户消息不受影响：仍是 ❯ 气泡，无标注前缀", async () => {
    const setup = await renderBlocks({
      role: "user",
      content: [{ type: "text", text: "真实的用户问题" }],
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("❯ 真实的用户问题");
    expect(frame.includes("[系统注入]")).toBe(false);
    await setup.renderer.destroy();
  });

  test("决策(b)：agent_status 栏注入虽带戳仍走既有隐藏路径（不渲染）", async () => {
    const setup = await renderBlocks(
      stampedUser("<agent_status>\nactive_tasks: 0\n</agent_status>")
    );
    const frame = setup.captureCharFrame();
    expect(frame.includes("❯")).toBe(false);
    expect(frame.includes("[系统注入]")).toBe(false);
    await setup.renderer.destroy();
  });
});
