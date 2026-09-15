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
 *    控制，组件内不右对齐）；
 *  - model 前段来自 envDisplay store 订阅（#1021）：host publish 即刷新，
 *    不需要换 props（回归钉——/model 切换只动本行，不触发全树 repaint）。
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { CapturedFrame } from "@opentui/core";
import {
  CTX_BLUE,
  ContextBar,
  ctxUsed,
  contextColor,
  modelPrefix,
  toolIndicator,
  valueBand,
} from "../../src/tui/context-bar.js";
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

/** 单 model 的 env store：`model` 为路由串，显示名由 providers 注册表投影。 */
function storeWithModel(model: string | undefined): EnvDisplayStore {
  return createEnvDisplayStore({ model, defaultThinking: undefined });
}

/** 模型注册表（路由串 → 显示名投影的 SSOT；与 /model picker 同源形状）。 */
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

  test("modelPrefix：短名原样 / 超宽 CJK 尾截断补 … / 预算过小回退空串", () => {
    expect(modelPrefix("m3-combo", 20)).toBe("m3-combo");
    expect(modelPrefix("Qwen3.8-Max Model", 40)).toBe("Qwen3.8-Max Model");
    // 超预算：CJK 按 2 列计（visualWidth 口径），结果宽 ≤ 预算且尾部补 …。
    const long = "Qwen3.8-Max-Exp-1234567890-abcde";
    const out = modelPrefix(long, 20);
    expect(out.endsWith("…")).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(20);
    expect(out).not.toContain("\n");
    // 预算过小（连 … 都放不下）→ 空串。
    expect(modelPrefix(long, 0)).toBe("");
    expect(modelPrefix(long, 1)).toBe("");
    // 预算能放单字符时仍截断。
    const tiny = modelPrefix(long, 2);
    expect(stringWidth(tiny)).toBeLessThanOrEqual(2);
  });

  test("modelDisplayName：命中注册表且有 name → name；未命中 / 无 name / 注册表缺席 → 回退路由串", () => {
    expect(modelDisplayName("minimax-cn/MiniMax-M3", PROVIDERS)).toBe(
      "MiniMax M3"
    );
    // 条目存在但未配 name → 回退路由串，不伪造空串。
    expect(modelDisplayName("minimax-cn/MiniMax-M2", PROVIDERS)).toBe(
      "minimax-cn/MiniMax-M2"
    );
    expect(modelDisplayName("unknown/model", PROVIDERS)).toBe("unknown/model");
    // 注册表缺席 / 空 → 无从投影，回退路由串本身。
    expect(modelDisplayName("minimax-cn/MiniMax-M3", undefined)).toBe(
      "minimax-cn/MiniMax-M3"
    );
    expect(modelDisplayName("minimax-cn/MiniMax-M3", [])).toBe(
      "minimax-cn/MiniMax-M3"
    );
    // model 未接线 → undefined（渲染侧据此不渲染 model 段）。
    expect(modelDisplayName(undefined, PROVIDERS)).toBeUndefined();
  });

  test("toolIndicator：内嵌空白折叠为单空格（防止换行/多空格导致底栏变形）", () => {
    // 换行 + 多空格 → 折叠后单空格；预算内原样返回。
    // "[tool] a b c" 宽 12 列,精确预算 12 → 折叠后原样返回。
    const inBudget = toolIndicator("a\nb  c", stringWidth("[tool] a b c"));
    expect(inBudget).toBe("[tool] a b c");
    // 超预算截断：迭代折叠后文本，输出不含原换行。
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
      // 未传 providers → 无注册表可查，显示名回退路由串本身（本用例钉的是
      // 前缀拼接与预算，与显示名投影无关）。
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
    // #1021 回归钉：/model 改写路由后 host 只 publish（不重渲染 TuiApp、不换
    // 组件 props）。若 model 退回 props 传递，本用例在 props 不变时不会更新。
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
    // store.publish 是 React 树外的事件源：手动 flush 一次即模拟宿主渲染循环
    // （同 stream-draft 集成测试的 store 推送口径）。
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("DeepSeek V3 · medium ·");
    expect(frame).not.toContain("MiniMax M3");
    // 单行不变（model 段换名不新增行）。
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

// #377 项 B 相关：activeToolNameOf 把 MCP 工具名剥为 <server>/<tool> 短形态
// （ContextBar 尾缀单一消费方），非 MCP 名原样。
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
    // server / tool 段本身含 __（manager sanitize 只把非 [A-Za-z0-9_] 替换）：
    // 只剥第一个 __ 之后的第一个 __，其余保留在 tool 段。
    expect(shortenMcpToolName("mcp__a__b__c")).toBe("a/b__c");
    expect(shortenMcpToolName("read_file")).toBe("read_file");
    // 畸形 mcp__ 形态（无分隔）原样返回
    expect(shortenMcpToolName("mcp__nosep")).toBe("mcp__nosep");
  });
});
