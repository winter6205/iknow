/** @jsxImportSource @opentui/react */
/**
 * tests/tui/host-injected-identity.test.tsx — render identity of host-injected
 * user messages.
 *
 * Contract under test (marker-keyed, never envelope-text-keyed): the ADR-0112
 * `hostInjected` provenance stamp is the only render key.
 *  - `role:"user"` + `hostInjected:true` and not in the hidden list →
 *    annotated prefix + warning colour, body visible, no ❯ bubble; because
 *    nothing but the stamp is matched, any future stamped envelope (a second
 *    host fuse, e.g.) rides the same branch untouched;
 *  - plain user messages keep the ❯ bubble byte-for-byte;
 *  - `isTuiHiddenUserMessage` runs before the stamp branch, so the hidden
 *    kinds (agent_status bar / drain / verify / graph_mode / skill-index) stay
 *    suppressed even though they carry the stamp.
 */
import { describe, expect, test } from "bun:test";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import {
  HOST_INJECTED_MARK,
  MessageBlocks,
} from "../../src/tui/message-blocks.js";
import { tuiPalette } from "../../src/tui/theme.js";
import { LOOP_DETECTED_TEXT } from "../../src/harness/tool-loop-detect.js";

const COLS = 60;

/** The notice text block word-wraps at COLS, so only the leading fragment of a
 *  long envelope can land on one frame line. Derived from the producer's SSOT
 *  constant instead of a hand-copied literal. */
const LOOP_DETECTED_HEAD = LOOP_DETECTED_TEXT.split(" (")[0];

/** Placeholder body for a stamped envelope that has no producer yet: the point
 *  under test is that the stamp — not the text — selects the branch. */
const UNPRODUCED_STAMPED_BODY = "任意未注册的 host 注入正文占位。";

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

describe("hostInjected user 消息：标注前缀 + 警示色（只按标记二分）", () => {
  test("LOOP_DETECTED envelope：标注前缀 + 正文可见，不再是 ❯ 气泡", async () => {
    const setup = await renderBlocks(stampedUser(LOOP_DETECTED_TEXT));
    const frame = setup.captureCharFrame();
    expect(frame).toContain(HOST_INJECTED_MARK);
    expect(frame).toContain(LOOP_DETECTED_HEAD);
    expect(frame.includes("❯")).toBe(false);
    // Warning form = running token as foreground, distinct from the ❯ bubble's
    // accent + userBg fill.
    const fg = fgOfSpanWith(setup, HOST_INJECTED_MARK);
    expect(fg).toBeDefined();
    const expected = RGBA.fromHex(tuiPalette.running);
    expect(
      fg!.r === expected.r && fg!.g === expected.g && fg!.b === expected.b
    ).toBe(true);
    await setup.renderer.destroy();
  });

  test("分支按标记泛化：任意新 stamped envelope 同形态", async () => {
    const setup = await renderBlocks(stampedUser(UNPRODUCED_STAMPED_BODY));
    const frame = setup.captureCharFrame();
    expect(frame).toContain(HOST_INJECTED_MARK);
    expect(frame).toContain(UNPRODUCED_STAMPED_BODY);
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
    expect(frame.includes(HOST_INJECTED_MARK)).toBe(false);
    await setup.renderer.destroy();
  });

  test("agent_status 栏注入虽带戳仍走既有隐藏路径（不渲染）", async () => {
    const setup = await renderBlocks(
      stampedUser("<agent_status>\nactive_tasks: 0\n</agent_status>")
    );
    const frame = setup.captureCharFrame();
    expect(frame.includes("❯")).toBe(false);
    expect(frame.includes(HOST_INJECTED_MARK)).toBe(false);
    await setup.renderer.destroy();
  });
});
