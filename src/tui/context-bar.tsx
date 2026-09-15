/** @jsxImportSource @opentui/react */
/**
 * src/tui/context-bar.tsx
 *
 * #343 T4（自 archive/tui-ink/src/context-bar.tsx 迁移 ink → OpenTUI）：
 * 上下文用量条 —— 三档色容量条（`│ ctx █░ band NN% 状态 X.Xk/Y.Yk`）。
 *
 * 数据契约（ADR-0008 D5，specs/321 Always 项）：本组件**只读**消费
 * `RunResult.lastUsage`（TokenUsage wire 形状原样），不引入第二份 token
 * 账本、不写回 usage —— 迁移只换渲染组件，数据路径不变。
 *
 * 数值语义（与 web/src/components/UsageChip.tsx 镜像同值）：
 * used = inputTokens + cacheReadInputTokens + cacheCreationInputTokens
 * （cache null → 0）；pct = round(used / contextWindow × 100)。
 *
 * 三档色阈值：<50% CTX_BLUE 淡蓝；50-80% running（琥珀）；>80% error。
 * running 且已有用量时左 border 600ms 脉动。
 *
 * 始终显示框：lastUsage === null（首轮前）也渲染完整 band + `0% ok` +
 * `0.0k/window`。窄列（cols < 40）降级仅 `ctx NN%`。activeToolName 尾缀
 * `⚙ name`（不新增 chrome 行，行账不变）。
 *
 * model 来源：前缀里的模型名**不经 props 传递**，而是直接订阅 envDisplay
 * store —— env 变化不进 React 树（不靠 host 重渲染传导 props），本组件
 * 自行重投影模型名，其余 chrome / 消息区不随之重算。effortLabel 仍由 host
 * 预计算（thinking 不在此 store 的订阅面内）。模型路由串 → 显示名的投影
 * `modelDisplayName` 在 model-picker.tsx（与注册表展平同宿主，见该处）。
 */
import { useSyncExternalStore, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { TokenUsage } from "../harness/model-adapter/types.js";
import type { IknowSettingsLlmProvider } from "../config/settings.js";
import { modelDisplayName } from "./model-picker.js";
import {
  EMPTY_ENV_DISPLAY_STORE,
  type EnvDisplayStore,
} from "./env-display-store.js";
import { visualWidth } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

export interface ContextBarProps {
  /** 只读投影（ADR-0008 D5）：host 传 RunResult.lastUsage，本组件不改写。 */
  readonly lastUsage: TokenUsage | null;
  readonly contextWindow: number;
  readonly running: boolean;
  readonly cols: number;
  /** 当前运行中工具名（app 从 liveToolRuns 派生）。undefined = 无工具运行
   *  → 不渲染指示器。渲染在本行尾缀（不新增 chrome 行）。 */
  readonly activeToolName?: string;
  /**
   * env 显示 store：model 前段的**唯一**来源，组件内部订阅 —— env publish
   * 后本组件自行重渲染，不需要 host 换 props，故不触发 TuiApp 全树 repaint。
   * 缺省（未接线 / 无 env）→ EMPTY_ENV_DISPLAY_STORE：快照 model 恒
   * undefined，与「不传 model」同一条渲染路径（model 段退场）。
   */
  readonly envDisplay?: EnvDisplayStore;
  /** 模型注册表（provider × models，路由串 → 显示名投影用）。
   *  缺省 → 无 name 可查，显示名回退路由串本身。 */
  readonly providers?: ReadonlyArray<IknowSettingsLlmProvider>;
  /** 思考档位标签（"off"/"auto"/"low"/... 已由 host 预计算）。缺省 "" → 不渲染档位段。 */
  readonly effortLabel?: string;
}

/** envDisplay 缺省解析（挪出组件体：组件体不加分支，S5 复杂度门保持基线）。 */
function resolveEnvDisplayStore(
  store: EnvDisplayStore | undefined
): EnvDisplayStore {
  return store ?? EMPTY_ENV_DISPLAY_STORE;
}

/** 淡蓝安全档；与 Web UsageChip COLOR_SAFE 镜像同值。
 *  导出供测试引用（保持与 Web 测试同模式）。 */
export const CTX_BLUE = "#7ab8ff";

// 数值语义 SSOT：下述纯函数与 web/src/components/UsageChip.tsx
// 镜像保持一致 —— 修改任一侧必须同步另一侧（公式 / 三档色阈值双改）。
/** 容量条：█ 填充 + ░ 空余。 */
export function valueBand(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** 三档色阈值：<50% CTX_BLUE 淡蓝 / 50-80% running / >80% error。 */
export function contextColor(pct: number): string {
  if (pct > 80) return tuiPalette.error;
  if (pct >= 50) return tuiPalette.running;
  return CTX_BLUE;
}

/** 上下文 token 用量合计：cache 空字段按 0 处理。 */
export function ctxUsed(lastUsage: TokenUsage): number {
  return (
    lastUsage.inputTokens +
    (lastUsage.cacheReadInputTokens ?? 0) +
    (lastUsage.cacheCreationInputTokens ?? 0)
  );
}

/** 600ms 布尔脉动（frozen 冻结时不启动定时器）。 */
function usePulse(frozen: boolean, periodMs = 600): boolean {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (frozen) return;
    const t = setInterval(() => setN((x) => x + 1), periodMs);
    return () => clearInterval(t);
  }, [frozen, periodMs]);
  return n % 2 === 0;
}

/** 活动工具指示器：`[tool] name` 截断到 budgetCols 视觉列宽内（CJK 安全）；
 *  放不下前缀 → 空串。超宽名字尾部截断补 `…`。纯函数，供单测直驱。
 *  无 emoji UI 字形（spec #146:86 无 emoji UI 字形约束）。 */
export function toolIndicator(name: string, budgetCols: number): string {
  const PREFIX = "[tool] ";
  const prefixW = visualWidth(PREFIX);
  if (budgetCols <= prefixW) return "";
  const nameBudget = budgetCols - prefixW;
  // 折叠空白：内嵌换行/多空格会让一行渲染变形（首行剩余 + 溢出），
  // 折叠为单空格后再截断（正常工具名无空白，零影响）。
  const folded = name.replace(/\s+/g, " ");
  if (visualWidth(folded) <= nameBudget) return PREFIX + folded;
  // 尾部截断：对折叠后文本逐码点累加（折叠过 name 才走到这），
  // 直到再放一个字符就超过（预留 `…` 位）。
  const ellW = visualWidth("…");
  let acc = "";
  for (const ch of folded) {
    if (visualWidth(acc + ch) > nameBudget - ellW) break;
    acc += ch;
  }
  return PREFIX + acc + "…";
}

/** 模型名前缀段（`{model} · {effort}` 的 model 部分）：按视觉列宽截断（CJK
 *  安全，尾部补 `…`）。budgetCols ≤ 1（连 `…` 都放不下）→ 空串。纯函数，供
 *  单测直驱。折叠内嵌空白（防换行/多空格变形，与 toolIndicator 同纪律）。 */
export function modelPrefix(model: string, budgetCols: number): string {
  const folded = model.replace(/\s+/g, " ").trim();
  if (budgetCols <= 1 || folded.length === 0) return "";
  if (visualWidth(folded) <= budgetCols) return folded;
  const ellW = visualWidth("…");
  let acc = "";
  for (const ch of folded) {
    if (visualWidth(acc + ch) > budgetCols - ellW) break;
    acc += ch;
  }
  return acc + "…";
}

export function ContextBar(props: ContextBarProps): ReactNode {
  const pal = tuiPalette;
  const { lastUsage, contextWindow, running, cols } = props;
  // 无条件下发 hook（React 规则）：envDisplay 缺省改用模块级 inert store，
  // 未接线时 getSnapshot 返回恒定的空快照，永不触发重渲染。
  const envDisplay = resolveEnvDisplayStore(props.envDisplay);
  const envSnapshot = useSyncExternalStore(
    envDisplay.subscribe,
    envDisplay.get
  );
  // 分母 ≤ 0（envInt 返回 0 / 负数）→ 视为无效，used/pct 按 0 兜底，防 NaN。
  const denomOk = contextWindow > 0;
  const used = lastUsage === null || !denomOk ? 0 : ctxUsed(lastUsage);
  const pct =
    lastUsage === null || !denomOk
      ? 0
      : Math.round((used / contextWindow) * 100);
  // 首轮前（lastUsage null）不脉动——没有用量「可读」，静置 0% 框；
  // 运行中且已检测出用量才脉动左 border。
  const warm = lastUsage !== null && running && pct > 0 && denomOk;
  const leftBorder = usePulse(!warm) ? pal.border : pal.running;
  const color = contextColor(pct);
  const activeToolName = props.activeToolName;
  // 前缀段 `{model} · {effort}`：model / effort 分别非空才渲染各自段与 ` · `
  // 分隔；两者皆空 → 不渲染前缀（兼容不传的既有直渲染用例）。effort 由 host
  // 预计算（enabled ? formatEffortLabel : "off"），标签至多 5 列不截断。model
  // 名按视觉宽截断（modelPrefix，CJK 安全补 …）。不新增 chrome 行，行账不变。
  //
  // 行宽账目（visualWidth 口径，防溢行，SSOT）：
  //   行 = `│` + ` {prefix} · ` + bodyContent + [` ` + tool]
  // 各段列数：border 1 + 前导空格 1 + prefixCols + SEP(` · `) 3
  //          + bodyContentW + [工具前导空格 1 + toolW]
  // model 截断预算 = cols − border(1) − 前导空格(1) − SEP(3) − bodyW − 安全
  // 边际(1) − [effort 段 ` · `(3) + effortW]。预算 ≤1 → model 段退场。
  const SEP = 3; // ` · `
  // 快照里的路由串经注册表投影成显示名，再 trim 归一（同 effortLabel 口径）。
  const model = (
    modelDisplayName(envSnapshot.model, props.providers) ?? ""
  ).trim();
  const effortLabel = (props.effortLabel ?? "").trim();
  const effW = visualWidth(effortLabel);
  const statusWord = pct > 80 ? "alert" : pct >= 50 ? "warn" : "ok";
  const tokensText = `${(used / 1000).toFixed(1)}k/${(
    contextWindow / 1000
  ).toFixed(1)}k`;
  const wideBodyContent = `ctx ${valueBand(pct, 10)} ${pct}% ${statusWord} ${tokensText}`;
  const narrowBodyContent = `ctx ${pct}%`;
  const wideBodyW = visualWidth(wideBodyContent);
  const narrowBodyW = visualWidth(narrowBodyContent);
  const modelBudgetWide = Math.max(
    0,
    cols -
      1 -
      1 -
      SEP -
      wideBodyW -
      1 -
      (effortLabel.length > 0 ? SEP : 0) -
      effW
  );
  const modelBudgetNarrow = Math.max(0, cols - 1 - 1 - SEP - narrowBodyW - 1);
  const clippedModel =
    model.length > 0 ? modelPrefix(model, modelBudgetWide) : "";
  const clippedModelNarrow =
    model.length > 0 ? modelPrefix(model, modelBudgetNarrow) : "";
  // 宽列前缀：model（截断后）+ effort；窄列前缀：effort 优先（≤5 列最稳定，
  // 满足「窄列 effort 尽量保留」），仅 model-only（无 effort）时退用窄预算截断
  // model。两者皆空 → 空串（不渲染前缀）。
  const widePrefix =
    model.length === 0 && effortLabel.length === 0
      ? ""
      : clippedModel.length === 0
        ? effortLabel
        : effortLabel.length === 0
          ? clippedModel
          : `${clippedModel} · ${effortLabel}`;
  const narrowPrefix =
    effortLabel.length > 0 ? effortLabel : clippedModelNarrow;
  const widePrefixCols = visualWidth(widePrefix);
  const narrowPrefixCols = visualWidth(narrowPrefix);
  // fit 守卫：前缀整段（含前导空格 + SEP + body）放得下才渲染。预算推导保证
  // model 情形必然 fit；守卫兜底 effort-only 意外超长（host 传坏值的防御）。
  const wideFits =
    widePrefix.length === 0 || 1 + widePrefixCols + SEP + 1 + wideBodyW <= cols;
  const narrowFits =
    narrowPrefix.length === 0 ||
    1 + narrowPrefixCols + SEP + 1 + narrowBodyW <= cols;
  // 工具尾缀预算 = cols − border − 前导空格 − [prefix + SEP] − body − 工具前导
  // 空格 − 安全边际(1)。尾缀预算必须扣掉前缀占列，否则前缀挤压尾缀溢出。
  const wideToolBudget = Math.max(
    0,
    cols - 1 - 1 - (wideFits ? widePrefixCols + SEP : 0) - wideBodyW - 1 - 1
  );
  const narrowToolBudget = Math.max(
    0,
    cols -
      1 -
      1 -
      (narrowFits ? narrowPrefixCols + SEP : 0) -
      narrowBodyW -
      1 -
      1
  );
  const wideTool =
    activeToolName === undefined
      ? ""
      : toolIndicator(activeToolName, wideToolBudget);
  const narrowTool =
    activeToolName === undefined
      ? ""
      : toolIndicator(activeToolName, narrowToolBudget);
  // 窄列（cols < 40）：仅 `ctx NN%`（省略状态词与 k/k 数字）。前缀只保 effort
  // （model 让位），放不下整体降级。
  if (cols < 40) {
    return (
      <box flexDirection="row">
        <text fg={leftBorder}>│</text>
        {narrowFits && narrowPrefix.length > 0 && (
          <text fg={pal.dim}> {narrowPrefix} ·</text>
        )}
        <text fg={color}> ctx {pct}%</text>
        {narrowTool !== "" && <text fg={pal.dim}> {narrowTool}</text>}
      </box>
    );
  }
  return (
    <box flexDirection="row">
      <text fg={leftBorder}>│</text>
      {wideFits && widePrefix.length > 0 && (
        <text fg={pal.dim}> {widePrefix} ·</text>
      )}
      <text>
        <span> ctx </span>
        <span fg={color}>{valueBand(pct, 10)}</span>
        <span fg={color}> {pct}%</span>
        <span fg={color}> {statusWord}</span>
        <span fg={pal.dim}> {tokensText}</span>
        {wideTool !== "" && <span fg={pal.dim}> {wideTool}</span>}
      </text>
    </box>
  );
}
