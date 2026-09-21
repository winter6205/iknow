/** @jsxImportSource @opentui/react */
/**
 * tests/tui/context-bar.test.tsx
 *
 * ContextBar (OpenTUI version) — read-only display of RunResult.lastUsage
 * (ADR-0008 D5: the data path is unchanged, only the rendering component is
 * swapped; this component never writes the token ledger).
 *  - Numeric semantics = context occupancy (ADR-0118): pre_call shape (both
 *    cache null) → used = inputTokens (cache never added onto a total that
 *    already includes it); post_call → input + cacheRead + cacheCreation
 *    (null cache → 0); pct = round(used / contextWindow * 100); token
 *    figures render as `X.Xk/Y.Yk`;
 *  - three color thresholds: <50% CTX_BLUE / 50-80% running / >80% error
 *    (captureSpans);
 *  - lastUsage null (before the first turn) → full 0% frame; narrow cols
 *    (<40) degrade to just `ctx NN%`;
 *  - activeToolName suffix indicator ([tool] name, no extra chrome row);
 *  - the component renders left-aligned with flex-start (parent
 *    justifyContent is controlled by app.tsx; no right-align inside);
 *  - the model prefix comes from an envDisplay store subscription: host
 *    publish refreshes it without prop changes (regression pin — /model
 *    switching touches this line only, no full-tree repaint).
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { CapturedFrame } from "@opentui/core";
import {
  contextColor,
  CTX_BLUE,
  ContextBar,
  modelPrefix,
  toolIndicator,
  valueBand,
} from "../../src/tui/context-bar.js";
import { occupancyFromUsage } from "../../src/harness/compress/occupancy.js";
import { modelDisplayName } from "../../src/tui/model-picker.js";
import {
  activeToolNameOf,
  shortenMcpToolName,
} from "../../src/tui/live-tool-state.js";
import {
  createEnvDisplayStore,
  type EnvDisplayStore,
} from "../../src/tui/env-display-store.js";
import { tuiPalette } from "../../src/tui/theme.js";
import { TuiHarness } from "./_fixtures.js";
import type { TokenUsage } from "../../src/harness/model-adapter/types.js";
import type { IknowSettingsLlmProvider } from "../../src/config/settings.js";
import stringWidth from "string-width";

function makeUsage(input: number): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
}

/**
 * Context occupancy numerator contract (ADR-0118) — SHARED TABLE with
 * tests/web/usage-chip.test.tsx: the same TokenUsage input pairs must yield
 * the same occupancy on the harness SSOT (occupancyFromUsage, used by TUI
 * and the gate) and the web contextOccupancy mirror. Changing a row here
 * must change the mirrored row there.
 */
const OCCUPANCY_CASES: ReadonlyArray<{
  readonly name: string;
  readonly usage: TokenUsage;
  readonly used: number;
}> = [
  {
    name: "pre_call 形态（cache 全 null）→ inputTokens",
    usage: makeUsage(12800),
    used: 12800,
  },
  {
    name: "pre_call 形态非零 input 同样不加 cache",
    usage: makeUsage(1),
    used: 1,
  },
  {
    name: "post_call 三类相加（一 cache null 当 0）",
    usage: {
      inputTokens: 20,
      outputTokens: 5,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 30,
    },
    used: 50,
  },
  {
    name: "post_call 三 cache 齐全",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    },
    used: 600,
  },
  {
    name: "post_call cache 全 0 → inputTokens",
    usage: {
      inputTokens: 42,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    used: 42,
  },
  {
    name: "超预算占用原样返回（clamp 属渲染侧）",
    usage: makeUsage(15000),
    used: 15000,
  },
];

function hex01(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/** Whether the frame contains a span holding needle with fg = hex (±1/255). */
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
  envDisplay?: EnvDisplayStore;
  providers?: ReadonlyArray<IknowSettingsLlmProvider>;
  effortLabel?: string;
}) {
  const setup = await testRender(<ContextBar {...props} />, {
    width: props.cols,
    height: 5,
  });
  await setup.renderOnce();
  return setup;
}

/** Single-model env store: `model` is the routing string; the display name
 *  is projected by the providers registry. */
function storeWithModel(model: string | undefined): EnvDisplayStore {
  return createEnvDisplayStore({ model, defaultThinking: undefined });
}

/** Model registry (SSOT for routing-string → display-name projection; same
 *  shape as the /model picker source). */
const PROVIDERS: ReadonlyArray<IknowSettingsLlmProvider> = [
  {
    id: "minimax-cn",
    baseUrl: "https://api.minimax.chat/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    models: [{ id: "MiniMax-M3", name: "MiniMax M3" }, { id: "MiniMax-M2" }],
  },
  {
    id: "volcengine-ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "ARK_API_KEY",
    models: [{ id: "deepseek-v3-250324", name: "DeepSeek V3" }],
  },
];

describe("纯函数（数值语义 SSOT）", () => {
  test("valueBand：pct 0/50/100 → 全空/半填/全填；越界截断", () => {
    expect(valueBand(0, 10)).toBe("░░░░░░░░░░");
    expect(valueBand(50, 10)).toBe("█████░░░░░");
    expect(valueBand(100, 10)).toBe("██████████");
    expect(valueBand(-20, 10)).toBe("░░░░░░░░░░");
    expect(valueBand(150, 10)).toBe("██████████");
  });

  test("occupancyFromUsage：ADR-0118 共享分子表（pre_call 不加 cache；post_call 三类相加）", () => {
    for (const c of OCCUPANCY_CASES) {
      expect(occupancyFromUsage(c.usage), c.name).toBe(c.used);
    }
    // 结构不可能「总量再加 cacheRead 2×」：pre_call 形态（两 cache 字段均
    // null）走 inputTokens-only 分支，cache 字段不参与任何加法。
    for (const input of [0, 1, 12800, 15000]) {
      expect(occupancyFromUsage(makeUsage(input))).toBe(input);
    }
  });

  test("contextColor：阈值边界 <50/=50/>80", () => {
    expect(contextColor(0)).toBe(CTX_BLUE);
    expect(contextColor(49)).toBe(CTX_BLUE);
    expect(contextColor(50)).toBe(tuiPalette.running);
    expect(contextColor(80)).toBe(tuiPalette.running);
    expect(contextColor(81)).toBe(tuiPalette.error);
  });

  test("toolIndicator：放得下原样；放不下前缀 → 空串；超宽 CJK 尾截断补 …", () => {
    // "[tool] " prefix = 7 columns; name budget = cols - 7.
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

  test("modelPrefix：短名原样 / 超宽 CJK 尾截断补 … / 预算过小回退空串", () => {
    expect(modelPrefix("m3-combo", 20)).toBe("m3-combo");
    expect(modelPrefix("Qwen3.8-Max Model", 40)).toBe("Qwen3.8-Max Model");
    // Over budget: CJK counts as 2 columns (visualWidth metric); result
    // width ≤ budget with a trailing ….
    const long = "Qwen3.8-Max-Exp-1234567890-abcde";
    const out = modelPrefix(long, 20);
    expect(out.endsWith("…")).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(20);
    expect(out).not.toContain("\n");
    // Budget too small (can't even fit …) → empty string.
    expect(modelPrefix(long, 0)).toBe("");
    expect(modelPrefix(long, 1)).toBe("");
    // Still truncated when the budget fits only one character.
    const tiny = modelPrefix(long, 2);
    expect(stringWidth(tiny)).toBeLessThanOrEqual(2);
  });

  test("modelDisplayName：命中注册表且有 name → name；未命中 / 无 name / 注册表缺席 → 回退路由串", () => {
    expect(modelDisplayName("minimax-cn/MiniMax-M3", PROVIDERS)).toBe(
      "MiniMax M3"
    );
    // Entry exists but has no name → fall back to the routing string; never
    // fabricate an empty string.
    expect(modelDisplayName("minimax-cn/MiniMax-M2", PROVIDERS)).toBe(
      "minimax-cn/MiniMax-M2"
    );
    expect(modelDisplayName("unknown/model", PROVIDERS)).toBe("unknown/model");
    // Registry missing / empty → nothing to project, fall back to the routing
    // string itself.
    expect(modelDisplayName("minimax-cn/MiniMax-M3", undefined)).toBe(
      "minimax-cn/MiniMax-M3"
    );
    expect(modelDisplayName("minimax-cn/MiniMax-M3", [])).toBe(
      "minimax-cn/MiniMax-M3"
    );
    // model not wired → undefined (the render side skips the model segment).
    expect(modelDisplayName(undefined, PROVIDERS)).toBeUndefined();
  });

  test("toolIndicator：内嵌空白折叠为单空格（防止换行/多空格导致底栏变形）", () => {
    // Newlines + runs of spaces → collapse to single spaces; returned as-is
    // within budget.
    // "[tool] a b c" is 12 columns wide, exact budget 12 → returned collapsed
    // as-is.
    const inBudget = toolIndicator("a\nb  c", stringWidth("[tool] a b c"));
    expect(inBudget).toBe("[tool] a b c");
    // Over-budget truncation: iterate over the collapsed text; output
    // contains no original newline.
    const truncated = toolIndicator("alpha\nbeta  gamma", 14);
    expect(truncated.startsWith("[tool] ")).toBe(true);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated).not.toContain("\n");
    expect(stringWidth(truncated)).toBeLessThanOrEqual(14);
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
    // Read-only contract: the component never mutates the passed usage object.
    expect(usage.inputTokens).toBe(1000);
    expect(usage.cacheReadInputTokens).toBe(2000);
    await setup.renderer.destroy();
  });

  test("pre_call 形态读数（cache 全 null）→ 分子 = inputTokens 原样上条", async () => {
    const setup = await renderBar({
      lastUsage: makeUsage(12800),
      contextWindow: 256000,
      running: false,
      cols: 80,
    });
    expect(setup.captureCharFrame()).toContain("5% ok 12.8k/256.0k");
    await setup.renderer.destroy();
  });

  test("超预算（used > window）：band 封顶全填、数字不 clamp（现行兜底钉住）", async () => {
    const setup = await renderBar({
      lastUsage: makeUsage(15000),
      contextWindow: 10000,
      running: false,
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    // pct 数字与 k/k 原样显示 150% / 15.0k/10.0k（不截断读数）；
    // 仅容量 band 通过 valueBand 的 0..100 clamp 封顶为全填。
    expect(frame).toContain("ctx ██████████ 150% alert 15.0k/10.0k");
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
      // The band characters (█/░) share the pct number's band color; assert
      // on the band's first character.
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

  test("缺省不传 model/effortLabel → 前缀不渲染（现有帧断言保持通过）", async () => {
    const setup = await renderBar({
      lastUsage: null,
      contextWindow: 10000,
      running: false,
      cols: 80,
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("│ ctx ░░░░░░░░░░ 0% ok 0.0k/10.0k");
    expect(frame).not.toContain("·");
    await setup.renderer.destroy();
  });

  test("model + effortLabel → `model · effort · ctx ...` 前缀渲染在 ctx 之前", async () => {
    const setup = await renderBar({
      lastUsage: makeUsage(5000),
      contextWindow: 10000,
      running: false,
      cols: 80,
      // No providers passed → no registry to consult, display name falls
      // back to the routing string (this case pins prefix concatenation and
      // budget, not display-name projection).
      envDisplay: storeWithModel("Qwen3.8-Max Model"),
      effortLabel: "medium",
    });
    const frame = setup.captureCharFrame();
    const ctxIdx = frame.indexOf("ctx");
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(frame.slice(0, ctxIdx)).toContain("Qwen3.8-Max Model · medium ·");
    expect(frame).toContain("medium");
    expect(frame).toContain("█████░░░░░");
    const lines = frame.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    await setup.renderer.destroy();
  });

  test("超长 model 名截断：前缀被截且整行视觉宽 ≤ cols（不换行）", async () => {
    const cols = 60;
    const setup = await renderBar({
      lastUsage: makeUsage(5000),
      contextWindow: 10000,
      running: false,
      cols,
      envDisplay: storeWithModel("Qwen3.8-Max-Exp-1234567890-abcdefghijklmnop"),
      effortLabel: "high",
    });
    const lines = setup
      .captureCharFrame()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line).toContain("…");
    expect(line).toContain("high");
    expect(line).toContain("ctx");
    expect(stringWidth(line.trimEnd())).toBeLessThanOrEqual(cols);
    await setup.renderer.destroy();
  });

  test("宽列前缀预算占用：activeToolName 尾缀不溢出", async () => {
    const cols = 90;
    const setup = await renderBar({
      lastUsage: makeUsage(8100),
      contextWindow: 10000,
      running: true,
      cols,
      envDisplay: storeWithModel("Qwen3.8-Max Model"),
      effortLabel: "high",
      activeToolName: "读写文件工具名字特别特别长",
    });
    const lines = setup
      .captureCharFrame()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(stringWidth((lines[0] ?? "").trimEnd())).toBeLessThanOrEqual(cols);
    expect(lines[0] ?? "").toContain("[tool]");
    await setup.renderer.destroy();
  });

  test("窄列 cols<40 + 前缀：保留 effort 段，单行 ≤ cols 且 ctx 仍可见", async () => {
    const cols = 30;
    const setup = await renderBar({
      lastUsage: makeUsage(8100),
      contextWindow: 10000,
      running: true,
      cols,
      envDisplay: storeWithModel("Qwen3.8-Max Model"),
      effortLabel: "medium",
    });
    const lines = setup
      .captureCharFrame()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(stringWidth((lines[0] ?? "").trimEnd())).toBeLessThanOrEqual(cols);
    expect(lines[0] ?? "").toContain("medium");
    expect(lines[0] ?? "").toContain("ctx");
    await setup.renderer.destroy();
  });

  test("model 显示名：路由串经 providers 命中 name → 渲染 name 而非路由串", async () => {
    const setup = await renderBar({
      lastUsage: makeUsage(5000),
      contextWindow: 10000,
      running: false,
      cols: 80,
      envDisplay: storeWithModel("minimax-cn/MiniMax-M3"),
      providers: PROVIDERS,
      effortLabel: "medium",
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("MiniMax M3 · medium ·");
    expect(frame).not.toContain("minimax-cn/MiniMax-M3");
    await setup.renderer.destroy();
  });

  test("model 切换只经 store.publish：props 不变，本行自行重渲染到新显示名", async () => {
    // Regression pin: after /model rewrites the routing string, the host
    // only publishes (no TuiApp re-render, no prop swap). If model went back
    // to prop passing, this case would not update under unchanged props.
    const store = storeWithModel("minimax-cn/MiniMax-M3");
    const setup = await renderBar({
      lastUsage: makeUsage(5000),
      contextWindow: 10000,
      running: false,
      cols: 80,
      envDisplay: store,
      providers: PROVIDERS,
      effortLabel: "medium",
    });
    expect(setup.captureCharFrame()).toContain("MiniMax M3 · medium ·");

    store.publish({
      model: "volcengine-ark/deepseek-v3-250324",
      defaultThinking: undefined,
    });
    // store.publish is an event source outside the React tree: one manual
    // flush simulates the host render loop (same store-push discipline as
    // the stream-draft integration tests).
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("DeepSeek V3 · medium ·");
    expect(frame).not.toContain("MiniMax M3");
    // Still one line (renaming the model segment adds no line).
    expect(frame.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(
      1
    );
    await setup.renderer.destroy();
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
    // Integration view (app.tsx wraps ContextBar in
    // `<box flexDirection="row" justifyContent="flex-start">`): rendered with
    // the full TuiHarness assembly, the ContextBar line hugs the left edge —
    // its first character (left border │) lands in column 0 (no leading
    // space).
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

// activeToolNameOf strips MCP tool names to the <server>/<tool> short form
// (ContextBar's only suffix consumer); non-MCP names pass through unchanged.
describe("activeToolNameOf / shortenMcpToolName", () => {
  test("activeToolNameOf 取最后一个 running；无 running → undefined", () => {
    const runs = [
      { id: "a", name: "read_file", status: "ok" as const, input: undefined },
      {
        id: "b",
        name: "mcp__alpha__search",
        status: "running" as const,
        input: undefined,
      },
    ];
    expect(activeToolNameOf(runs)).toBe("alpha/search");
    expect(activeToolNameOf([])).toBeUndefined();
    expect(
      activeToolNameOf([
        {
          id: "c",
          name: "write_file",
          status: "ok" as const,
          input: undefined,
        },
      ])
    ).toBeUndefined();
  });

  test("shortenMcpToolName：mcp__<server>__<tool> → <server>/<tool>；非 MCP 原样", () => {
    expect(shortenMcpToolName("mcp__codebase-memory__search_code")).toBe(
      "codebase-memory/search_code"
    );
    // server / tool segments may themselves contain __ (manager sanitize only
    // replaces non-[A-Za-z0-9_]): strip only the first __ after the first
    // __; the rest stays in the tool segment.
    expect(shortenMcpToolName("mcp__a__b__c")).toBe("a/b__c");
    expect(shortenMcpToolName("read_file")).toBe("read_file");
    // Malformed mcp__ shapes (no separator) are returned as-is.
    expect(shortenMcpToolName("mcp__nosep")).toBe("mcp__nosep");
  });
});
