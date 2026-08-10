/** @jsxImportSource @opentui/react */
/**
 * tests/tui/context-bar.test.tsx
 *
 * #343 T4：ContextBar（OpenTUI 版）——只读展示 RunResult.lastUsage
 * （ADR-0008 D5：数据路径不变，只换渲染组件；本组件不写 token 账本）。
 *  - 数值语义：used = input + cacheRead + cacheCreation（cache null → 0）；
 *    pct = round(used / contextWindow * 100)；tokens 数字 `X.Xk/Y.Yk` 渲染；
 *  - 三档色阈值 <50% CTX_BLUE / 50-80% running / >80% error（captureSpans）；
 *  - lastUsage null（首轮前）→ 完整 0% 框；窄列 cols<40 降级仅 `ctx NN%`；
 *  - activeToolName 尾缀指示器（[tool] name，不新增 chrome 行）；
 *  - 组件本身按 flex-start 左对齐渲染（父容器 justifyContent 由 app.tsx
 *    控制，组件内不右对齐）。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { CapturedFrame } from "@opentui/core";
import {
  CTX_BLUE,
  ContextBar,
  ctxUsed,
  contextColor,
  toolIndicator,
  valueBand,
} from "../../src/tui/context-bar.js";
import { tuiPalette } from "../../src/tui/theme.js";
import { TuiHarness } from "./_fixtures.js";
import type { TokenUsage } from "../../src/harness/model-adapter/types.js";
import stringWidth from "string-width";

function makeUsage(input: number): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
}

function hex01(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/** 帧中是否存在含 needle 的 span 且 fg = hex（±1/255）。 */
function hasFg(frame: CapturedFrame, needle: string, hex: string): boolean {
  const [r, g, b] = hex01(hex);
  const eps = 1.5 / 255;
  return frame.lines.some((line) =>
    line.spans.some(
      (span) =>
        span.text.includes(needle) &&
        Math.abs(span.fg.r - r) < eps &&
        Math.abs(span.fg.g - g) < eps &&
        Math.abs(span.fg.b - b) < eps
    )
  );
}

async function renderBar(props: {
  lastUsage: TokenUsage | null;
  contextWindow: number;
  running: boolean;
  cols: number;
  activeToolName?: string;
}) {
  const setup = await testRender(<ContextBar {...props} />, {
    width: props.cols,
    height: 5,
  });
  await setup.renderOnce();
  return setup;
}

describe("纯函数（数值语义 SSOT）", () => {
  test("valueBand：pct 0/50/100 → 全空/半填/全填；越界截断", () => {
    expect(valueBand(0, 10)).toBe("░░░░░░░░░░");
    expect(valueBand(50, 10)).toBe("█████░░░░░");
    expect(valueBand(100, 10)).toBe("██████████");
    expect(valueBand(-20, 10)).toBe("░░░░░░░░░░");
    expect(valueBand(150, 10)).toBe("██████████");
  });

  test("ctxUsed：cache null 按 0；非 null 合计", () => {
    expect(ctxUsed(makeUsage(100))).toBe(100);
    expect(
      ctxUsed({
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 300,
      })
    ).toBe(600);
  });

  test("contextColor：阈值边界 <50/=50/>80", () => {
    expect(contextColor(0)).toBe(CTX_BLUE);
    expect(contextColor(49)).toBe(CTX_BLUE);
    expect(contextColor(50)).toBe(tuiPalette.running);
    expect(contextColor(80)).toBe(tuiPalette.running);
    expect(contextColor(81)).toBe(tuiPalette.error);
  });

  test("toolIndicator：放得下原样；放不下前缀 → 空串；超宽 CJK 尾截断补 …", () => {
    // "[tool] " 前缀 7 列；name budget = cols - 7。
    expect(toolIndicator("Bash", 11)).toBe("[tool] Bash");
    expect(toolIndicator("Bash", stringWidth("[tool] Bash"))).toBe(
      "[tool] Bash"
    );
    expect(toolIndicator("Bash", 0)).toBe("");
    expect(toolIndicator("Bash", stringWidth("[tool] "))).toBe("");
    const out = toolIndicator("读写文件工具名很长", 13);
    expect(out.startsWith("[tool] ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(13);
  });
});

describe("渲染（只读 lastUsage）", () => {
  test("null lastUsage → 完整 0% 框（band + ok + 0.0k/window）", async () => {
    const setup = await renderBar({
      lastUsage: null,
      contextWindow: 10000,
      running: false,
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("│ ctx ░░░░░░░░░░ 0% ok 0.0k/10.0k");
    await setup.renderer.destroy();
  });

  test("tokens 数字渲染：pct=50 warn → `5.0k/10.0k`", async () => {
    const setup = await renderBar({
      lastUsage: makeUsage(5000),
      contextWindow: 10000,
      running: false,
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("│ ctx █████░░░░░ 50% warn 5.0k/10.0k");
    await setup.renderer.destroy();
  });

  test("cache 字段计入 used（只读投影，不改写）", async () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 10,
      cacheCreationInputTokens: 2000,
      cacheReadInputTokens: 2000,
    };
    const setup = await renderBar({
      lastUsage: usage,
      contextWindow: 10000,
      running: false,
      cols: 80,
    });
    expect(setup.captureCharFrame()).toContain("50% warn 5.0k/10.0k");
    // 只读契约：组件不修改传入的 usage 对象。
    expect(usage.inputTokens).toBe(1000);
    expect(usage.cacheReadInputTokens).toBe(2000);
    await setup.renderer.destroy();
  });

  test("contextWindow ≤ 0 → 按 0% 兜底（不 NaN）", async () => {
    const setup = await renderBar({
      lastUsage: makeUsage(5000),
      contextWindow: 0,
      running: false,
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("0% ok");
    expect(frame).not.toContain("NaN");
    await setup.renderer.destroy();
  });

  test("三档色（captureSpans）：ok 淡蓝 / warn running / alert error", async () => {
    const cases: Array<{ used: number; hex: string }> = [
      { used: 4900, hex: CTX_BLUE },
      { used: 5000, hex: tuiPalette.running },
      { used: 8100, hex: tuiPalette.error },
    ];
    for (const c of cases) {
      const setup = await renderBar({
        lastUsage: makeUsage(c.used),
        contextWindow: 10000,
        running: false,
        cols: 80,
      });
      const spans = setup.captureSpans();
      // band 字符（█/░）与 pct 数字同档色，取 band 首字符断言。
      const bandChar = c.used >= 5000 ? "█" : "░";
      expect(
        hasFg(spans, bandChar, c.hex),
        `used=${c.used} band 色 ${c.hex}`
      ).toBe(true);
      await setup.renderer.destroy();
    }
  });

  test("窄列 cols<40：仅 `ctx NN%`，省略状态词 / k/k / band", async () => {
    const setup = await renderBar({
      lastUsage: makeUsage(8100),
      contextWindow: 10000,
      running: true,
      cols: 30,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("│");
    expect(frame).toContain("ctx");
    expect(frame).toContain("81%");
    expect(frame).not.toContain("alert");
    expect(frame).not.toContain("warn");
    expect(frame).not.toContain("k/");
    expect(frame).not.toContain("█");
    expect(frame).not.toContain("░");
    await setup.renderer.destroy();
  });

  test("宽度 40 / 80 / 120 单行不溢出（视觉宽 ≤ cols）", async () => {
    for (const cols of [40, 80, 120]) {
      const setup = await renderBar({
        lastUsage: makeUsage(9900),
        contextWindow: 10000,
        running: false,
        cols,
      });
      const lines = setup
        .captureCharFrame()
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(lines.length, `cols=${cols} 应单行`).toBe(1);
      expect(stringWidth((lines[0] ?? "").trimEnd())).toBeLessThanOrEqual(cols);
      await setup.renderer.destroy();
    }
  });

  test("activeToolName → 行尾 `⚙ name`（单行）；undefined → 不渲染 ⚙", async () => {
    const withTool = await renderBar({
      lastUsage: makeUsage(5000),
      contextWindow: 10000,
      running: true,
      cols: 80,
      activeToolName: "Bash",
    });
    const frame = withTool.captureCharFrame();
    expect(frame).toContain("[tool] Bash");
    expect(frame.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(
      1
    );
    await withTool.renderer.destroy();

    const noTool = await renderBar({
      lastUsage: makeUsage(5000),
      contextWindow: 10000,
      running: true,
      cols: 80,
    });
    expect(noTool.captureCharFrame()).not.toContain("[tool]");
    await noTool.renderer.destroy();
  });

  test("窄列超宽工具名：截断补 …，单行 ≤ cols", async () => {
    const cols = 30;
    const setup = await renderBar({
      lastUsage: makeUsage(8100),
      contextWindow: 10000,
      running: true,
      cols,
      activeToolName: "读写文件工具名字特别特别特别长",
    });
    const lines = setup
      .captureCharFrame()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(stringWidth((lines[0] ?? "").trimEnd())).toBeLessThanOrEqual(cols);
    expect(lines[0] ?? "").toContain("[tool]");
    expect(lines[0] ?? "").toContain("…");
    await setup.renderer.destroy();
  });

  test("组件自身左对齐：首行以 │ 开头，无 leading 空格", async () => {
    const setup = await renderBar({
      lastUsage: makeUsage(5000),
      contextWindow: 10000,
      running: false,
      cols: 80,
    });
    const firstNonEmpty = setup
      .captureCharFrame()
      .split("\n")
      .find((l) => l.trim().length > 0);
    expect(firstNonEmpty).toBeDefined();
    expect(firstNonEmpty?.startsWith("│")).toBe(true);
    await setup.renderer.destroy();
  });

  test("app 级左对齐：TuiHarness 父容器 justify-content=flex-start 下 ContextBar 首列于 frame 首列", async () => {
    // 集成视角（app.tsx 的 `<box flexDirection="row" justifyContent="flex-start">`
    // 包裹 ContextBar）：用 TuiHarness 全装配渲染，ContextBar 行贴左——
    // 该行首字符（左 border │）落在 frame 首列（无 leading 空格）。
    const setup = await testRender(<TuiHarness />, {
      width: 80,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
    });
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    const ctxLine = frame.split("\n").find((l) => l.includes("ctx"));
    expect(ctxLine).toBeDefined();
    expect(ctxLine?.startsWith("│")).toBe(true);
    await setup.renderer.destroy();
  });
});
