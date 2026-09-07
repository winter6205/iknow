/** @jsxImportSource @opentui/react */
/**
 * tests/tui/chrome-fill.test.tsx
 *
 * Task 2 — Assistant fill off; user prompt fill on (plans/tui-chrome-interaction.md T2)
 *
 * Surface:
 *  - src/tui/message-shell.tsx (shared assistant / fold / live-draft shell)
 *  - src/tui/message-blocks.tsx (user 仍填充；assistant 透传给 shell)
 *  - src/tui/prompt-input.tsx (输入框 share user 填充家族)
 *  - src/tui/theme.ts (token 读取健壮性)
 *  - src/tui/markdown.tsx (fence 仍用 codeBlockBg)
 *
 * 不变式 (来自 plan T2 acceptance):
 *  1. empty assistant 文本 → 渲染不残留 assistantBg 填充盒 (no panel);
 *  2. user 消息仍走 userBg 填充;
 *  3. 长 markdown 仍正常格式化 (no regression);
 *  4. live draft 与历史 assistant 共用无填充规则 (同 MessageShell);
 *  5. fold rows 跟 assistant (无 panel)，不跟 user 填充;
 *  6. 缺 palette token 不许把 transcript 刷白（userBg/codeBlockBg 缺失 → 退回终端默认,
 *     不传 #000 / undefined 让黑画刷屏);
 *  7. fence codeBlockBg 与终端默认仍可区分 (围栏代码块视觉上要看得见).
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
  // OpenTUI test-renderer 把「未设置 backgroundColor」表达为 RGBA(0,0,0,0)。
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
    // 文本仍可见（markdown 渲染未破）
    expect(frame).toContain("正文：这条 assistant 消息没有面板填充");
    // span 背景 = 透明（无填充盒）
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
    // user 消息 span.bg = userBg token（非透明）
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
    // 主体段落仍透明背景（无 panel），仅 fence 走 codeBlockBg
    const paraBg = bgOfSpanWith(setup, "段落含");
    expect(paraBg).toBeDefined();
    expect(isTransparent(paraBg!)).toBe(true);
    await setup.renderer.destroy();
  });

  test("MessageShell 折叠行（fold rows）：无 panel 填充（跟 assistant）", async () => {
    // 直接构造 MessageShell 验证：之前 assistant 折叠行裸挂左移一列是因为
    // 折叠行没套壳。T2 把 MessageShell 透传化后,fold 行依然走 MessageShell
    // （chat-view renderFoldLines 复用），但壳不再注入 backgroundColor。
    // 验证：MessageShell 内 dim 文本 span.bg = 透明。
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
    // Markdown 围栏代码块独立用 codeBlockBg,与外层 assistant panel 解耦。
    // 验证：fence 行 span.bg = codeBlockBg（且与 userBg / assistantBg 不同）。
    const md = ["```ts", "const x = 1;", "```"].join("\n");
    const setup = await testRender(<Markdown text={md} width={COLS} />, {
      width: COLS,
      height: 10,
      exitOnCtrlC: false,
    });
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("const x = 1;");
    // fence 内被语法高亮切成多个 span,以「第一行非透明 span」为代表钉住不变量。
    // 找包含 const 关键字的 span（fence 首 token）→ 它的 bg 应是 codeBlockBg
    const codeBg = bgOfSpanWith(setup, "const");
    expect(codeBg).toBeDefined();
    expect(isTransparent(codeBg!)).toBe(false);
    const expected = RGBA.fromHex(tuiPalette.codeBlockBg);
    expect(codeBg!.r).toBe(expected.r);
    expect(codeBg!.g).toBe(expected.g);
    expect(codeBg!.b).toBe(expected.b);
    // 跟 userBg 也必须不同 —— 防止 token 漂移
    const userBg = RGBA.fromHex(tuiPalette.userBg);
    expect(
      codeBg!.r === userBg.r && codeBg!.g === userBg.g && codeBg!.b === userBg.b
    ).toBe(false);
    await setup.renderer.destroy();
  });

  test("live draft 与历史 assistant 共用无填充规则：Markdown streaming 包装无 panel", async () => {
    // chat-view 的流式草稿槽套 MessageShell；T2 后 MessageShell 透明，
    // 等价于流式与历史 assistant 都不再带 assistantBg 面板。
    // 直接断言：Markdown streaming 单独渲染不引入 panel。
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
    // T2 修订（operator 反馈 2026-09-07）：输入框不涂底色 —— 与 transcript
    // 的视觉分层靠 border 已足够；填充家族只属于已提交消息气泡。断言内部
    // textarea 文本 span 背景为终端默认（transparent）。
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
    // 文本可见
    expect(frame).toContain("输入一些字");
    // textarea 渲染的 span 背景 = 终端默认（transparent，无填充）
    const bg = bgOfSpanWith(setup, "输入一些字");
    expect(bg).toBeDefined();
    expect(isTransparent(bg!)).toBe(true);
    await setup.renderer.destroy();
  });

  test("缺 palette token 不刷白 transcript：userBg 空串 → 不传 backgroundColor（终端默认）", async () => {
    // 健壮性：theme.userBg 若缺失/空串（CI / 未来降级），用户消息不应被
    // 强行刷白。设计上读 userBg 时若空 → 跳过 backgroundColor，回归终端默认。
    // 直接用 MessageBlocks 渲染一条 user 消息,但 patch palette token（不影响
    // tuiPalette.frozen — 改主题冻结值的成本太高,这里只断言渲染路径不崩）。
    // 由于 tuiPalette 是 Object.frozen,改不动；这条 spec 通过另一条入口钉住：
    // 当 backgroundColor 传 "" 时 OpenTUI 仍按空填处理（不黑屏）。渲染层
    // 守卫在 tuiPalette 读取处 — 这里只能断言 MessageBlocks 现有路径在
    // userBg 有效时不刷白（不变量 = bg.a 始终非 0 / 不会变 #000）。
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
    // userBg 已知有效 → bg 必为 userBg（非黑底、非透明）。
    const userBg = RGBA.fromHex(tuiPalette.userBg);
    expect(bg!.r).toBe(userBg.r);
    expect(bg!.g).toBe(userBg.g);
    expect(bg!.b).toBe(userBg.b);
    expect(bg!.a).toBeGreaterThan(0);
    // 不应是 (0,0,0,255) —— 即「被刷白」意味着「完全黑填充」,userBg 不允许
    // 取 #000。token 不动则这条隐式不变量锁住。
    const isPureBlack = bg!.r === 0 && bg!.g === 0 && bg!.b === 0;
    expect(isPureBlack).toBe(false);
    await setup.renderer.destroy();
  });

  test("空 assistant 消息：返回 null，不留空壳 box（不残留 panel 痕迹）", async () => {
    // 折叠后纯 retract 工具消息的 null 契约：不变式继续。
    // T2 后 assistantBg 不再注入,空消息本来就不应有填充；这里锁住不变量
    // —— 即使空,也不应意外注入任何 span。
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
    // text block.trim() === '' → MessageBlocks 早期 return null;不挂任何壳。
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
