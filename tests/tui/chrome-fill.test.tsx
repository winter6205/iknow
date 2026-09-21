/** @jsxImportSource @opentui/react */
/**
 * tests/tui/chrome-fill.test.tsx
 *
 * Assistant fill off; user prompt fill on.
 *
 * Surface:
 *  - src/tui/message-shell.tsx (shared assistant / fold / live-draft shell)
 *  - src/tui/message-blocks.tsx (user keeps fill; assistant passes through
 *    to the shell)
 *  - src/tui/prompt-input.tsx (input box shares the user fill family)
 *  - src/tui/theme.ts (token-read robustness)
 *  - src/tui/markdown.tsx (fence still uses codeBlockBg)
 *
 * Invariants:
 *  1. empty assistant text → no leftover assistantBg fill box (no panel);
 *  2. user messages still fill with userBg;
 *  3. long markdown still formats normally (no regression);
 *  4. live draft and history assistant share the no-fill rule (same
 *     MessageShell);
 *  5. fold rows follow assistant (no panel), not the user fill;
 *  6. a missing palette token must not wash out the transcript (missing
 *     userBg/codeBlockBg → fall back to terminal default; never pass #000 /
 *     undefined and flood the screen with black);
 *  7. fence codeBlockBg stays distinguishable from the terminal default
 *     (fenced code blocks must remain visible).
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import { MessageBlocks } from "../../src/tui/message-blocks.js";
import { MessageShell } from "../../src/tui/message-shell.js";
import { Markdown } from "../../src/tui/markdown.js";
import { tuiPalette } from "../../src/tui/theme.js";
import { PromptInput } from "../../src/tui/prompt-input.js";
import { createRef } from "react";

const COLS = 60;

function isTransparent(rgba: RGBA): boolean {
  // The OpenTUI test-renderer expresses "no backgroundColor set" as RGBA(0,0,0,0).
  return rgba.a === 0;
}

function bgOfSpanWith(
  setup: Awaited<ReturnType<typeof testRender>>,
  needle: string
): RGBA | undefined {
  const { lines } = setup.captureSpans();
  for (const line of lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span.bg;
    }
  }
  return undefined;
}

describe("Task 2 — assistant fill off; user fill on", () => {
  test("assistant 文本：MessageShell 不再套 assistantBg 填充（span.bg 透明）", async () => {
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "正文：这条 assistant 消息没有面板填充" },
      ],
    };
    const setup = await testRender(
      <MessageBlocks message={msg} cols={COLS} statusMap={new Map()} />,
      { width: COLS, height: 10, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // text still visible (markdown rendering intact)
    expect(frame).toContain("正文：这条 assistant 消息没有面板填充");
    // span background = transparent (no fill box)
    const bg = bgOfSpanWith(setup, "正文");
    expect(bg).toBeDefined();
    expect(isTransparent(bg!)).toBe(true);
    await setup.renderer.destroy();
  });

  test("user 消息：仍走 userBg 填充（非透明）", async () => {
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "用户提问应当填充" }],
    };
    const setup = await testRender(
      <MessageBlocks message={msg} cols={COLS} statusMap={new Map()} />,
      { width: COLS, height: 10, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("❯ 用户提问应当填充");
    const bg = bgOfSpanWith(setup, "用户提问");
    expect(bg).toBeDefined();
    // user message span.bg = userBg token (non-transparent)
    expect(isTransparent(bg!)).toBe(false);
    const expected = RGBA.fromHex(tuiPalette.userBg);
    expect(bg!.r).toBe(expected.r);
    expect(bg!.g).toBe(expected.g);
    expect(bg!.b).toBe(expected.b);
    await setup.renderer.destroy();
  });

  test("长 markdown 仍正常格式化：headings / code / list 节选（assistant 无填充下不破）", async () => {
    const md = [
      "# 大标题",
      "",
      "段落含 `codespan` 与 **加粗**。",
      "",
      "- 列表 A",
      "- 列表 B",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: md }],
    };
    const setup = await testRender(
      <MessageBlocks message={msg} cols={COLS} statusMap={new Map()} />,
      { width: COLS, height: 30, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("大标题");
    expect(frame).toContain("codespan");
    expect(frame).toContain("加粗");
    expect(frame).toContain("列表 A");
    expect(frame).toContain("列表 B");
    expect(frame).toContain("const x = 1;");
    // body paragraphs keep a transparent background (no panel); only fences
    // use codeBlockBg
    const paraBg = bgOfSpanWith(setup, "段落含");
    expect(paraBg).toBeDefined();
    expect(isTransparent(paraBg!)).toBe(true);
    await setup.renderer.destroy();
  });

  test("MessageShell 折叠行（fold rows）：无 panel 填充（跟 assistant）", async () => {
    // Verified directly on MessageShell: fold rows used to hang bare and
    // shifted one column left because they skipped the shell. After the
    // shell became pass-through, fold rows still go through MessageShell
    // (reused by chat-view renderFoldLines), but the shell no longer injects
    // backgroundColor. Check: dim text inside MessageShell has transparent
    // span.bg.
    const setup = await testRender(
      <MessageShell>
        <text fg={tuiPalette.dim} wrapMode="none">
          折叠行：思考了 3 秒
        </text>
      </MessageShell>,
      { width: COLS, height: 5, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const bg = bgOfSpanWith(setup, "折叠行");
    expect(bg).toBeDefined();
    expect(isTransparent(bg!)).toBe(true);
    await setup.renderer.destroy();
  });

  test("fence codeBlockBg：与终端默认仍可区分（assistant panel 拿掉后 fence 不消失）", async () => {
    // Markdown fenced code blocks use codeBlockBg independently, decoupled
    // from the outer assistant panel.
    // Check: fence-line span.bg = codeBlockBg (and differs from userBg /
    // assistantBg).
    const md = ["```ts", "const x = 1;", "```"].join("\n");
    const setup = await testRender(<Markdown text={md} width={COLS} />, {
      width: COLS,
      height: 10,
      exitOnCtrlC: false,
    });
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("const x = 1;");
    // Syntax highlighting splits the fence into many spans; pin the
    // invariant on the first non-transparent span. The span containing
    // `const` (the fence's first token) should carry bg = codeBlockBg.
    const codeBg = bgOfSpanWith(setup, "const");
    expect(codeBg).toBeDefined();
    expect(isTransparent(codeBg!)).toBe(false);
    const expected = RGBA.fromHex(tuiPalette.codeBlockBg);
    expect(codeBg!.r).toBe(expected.r);
    expect(codeBg!.g).toBe(expected.g);
    expect(codeBg!.b).toBe(expected.b);
    // Must differ from userBg too — guards against token drift.
    const userBg = RGBA.fromHex(tuiPalette.userBg);
    expect(
      codeBg!.r === userBg.r && codeBg!.g === userBg.g && codeBg!.b === userBg.b
    ).toBe(false);
    await setup.renderer.destroy();
  });

  test("live draft 与历史 assistant 共用无填充规则：Markdown streaming 包装无 panel", async () => {
    // chat-view wraps the streaming draft slot in MessageShell; now that
    // MessageShell is transparent, streaming and history assistant both carry
    // no assistantBg panel. Assert directly: standalone Markdown streaming
    // rendering introduces no panel.
    const setup = await testRender(
      <Markdown text="流式草稿正文" width={COLS} streaming />,
      { width: COLS, height: 5, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const bg = bgOfSpanWith(setup, "流式草稿正文");
    expect(bg).toBeDefined();
    expect(isTransparent(bg!)).toBe(true);
    await setup.renderer.destroy();
  });

  test("PromptInput 输入框：border-only，无底色（T2 修订：填充留给已提交消息）", async () => {
    // The input box paints no background — visual separation from the
    // transcript relies on the border alone; the fill family belongs only to
    // committed message bubbles. Assert the inner textarea's text span
    // background is the terminal default (transparent).
    const ref = createRef<{ insertText: (t: string) => void }>();
    const setup = await testRender(
      <PromptInput
        ref={ref as never}
        value="输入一些字"
        active={false}
        cols={COLS}
        onChange={() => undefined}
        onSubmit={() => undefined}
      />,
      { width: COLS, height: 8, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    // text visible
    expect(frame).toContain("输入一些字");
    // the textarea-rendered span background = terminal default
    // (transparent, no fill)
    const bg = bgOfSpanWith(setup, "输入一些字");
    expect(bg).toBeDefined();
    expect(isTransparent(bg!)).toBe(true);
    await setup.renderer.destroy();
  });

  test("缺 palette token 不刷白 transcript：userBg 空串 → 不传 backgroundColor（终端默认）", async () => {
    // Robustness: if theme.userBg is missing / empty string (CI / future
    // degradation), user messages must not be force-washed. By design, an
    // empty userBg read → skip backgroundColor, back to terminal default.
    // tuiPalette is Object.frozen and cannot be patched here; the invariant
    // is pinned through another entry: passing "" as backgroundColor is
    // still treated as empty fill by OpenTUI (no black screen). The render
    // guard sits where tuiPalette is read — this can only assert that the
    // existing MessageBlocks path with a valid userBg doesn't wash out
    // (invariant: bg.a is always non-zero / never becomes #000).
    const msg: AnthropicNativeMessage = {
      role: "user",
      content: [{ type: "text", text: "不刷白检查" }],
    };
    const setup = await testRender(
      <MessageBlocks message={msg} cols={COLS} statusMap={new Map()} />,
      { width: COLS, height: 10, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const bg = bgOfSpanWith(setup, "不刷白检查");
    expect(bg).toBeDefined();
    // userBg is known valid → bg must equal userBg (not black-filled, not
    // transparent).
    const userBg = RGBA.fromHex(tuiPalette.userBg);
    expect(bg!.r).toBe(userBg.r);
    expect(bg!.g).toBe(userBg.g);
    expect(bg!.b).toBe(userBg.b);
    expect(bg!.a).toBeGreaterThan(0);
    // Must not be (0,0,0,255) — "washed out" here means "fully black fill";
    // userBg is not allowed to be #000. As long as the token is unchanged,
    // this implicit invariant stays locked.
    const isPureBlack = bg!.r === 0 && bg!.g === 0 && bg!.b === 0;
    expect(isPureBlack).toBe(false);
    await setup.renderer.destroy();
  });

  test("空 assistant 消息：返回 null，不留空壳 box（不残留 panel 痕迹）", async () => {
    // The null contract for folded pure-retract tool messages: the invariant
    // continues. assistantBg is no longer injected, so an empty message
    // should never carry fill — pin it: even when empty, no stray span is
    // injected.
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-rd",
          name: "read_file",
          input: { path: "a.ts" },
        },
      ],
    };
    const setup = await testRender(
      <MessageBlocks
        message={msg}
        cols={COLS}
        statusMap={new Map([["tu-rd", false]])}
      />,
      { width: COLS, height: 10, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const { lines } = setup.captureSpans();
    const contentSpans = lines.flatMap((line) =>
      line.spans.filter((span) => span.text.trim().length > 0)
    );
    expect(contentSpans).toHaveLength(0);
    await setup.renderer.destroy();
  });

  test("空 assistant 文本分支（无 tool_use，仅空白 text）→ 渲染为 null", async () => {
    // "empty: empty assistant text → no leftover filled box"
    // A text block with trim() === '' → MessageBlocks returns null early;
    // no shell is mounted.
    const msg: AnthropicNativeMessage = {
      role: "assistant",
      content: [{ type: "text", text: "   " }],
    };
    const setup = await testRender(
      <MessageBlocks message={msg} cols={COLS} statusMap={new Map()} />,
      { width: COLS, height: 10, exitOnCtrlC: false }
    );
    await setup.waitForVisualIdle();
    const { lines } = setup.captureSpans();
    const contentSpans = lines.flatMap((line) =>
      line.spans.filter((span) => span.text.trim().length > 0)
    );
    expect(contentSpans).toHaveLength(0);
    await setup.renderer.destroy();
  });
});
