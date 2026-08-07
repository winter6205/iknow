/**
 * src/tui/context-bar.tsx
 *
 * T4 (#TBD): 上下文用量条 — 三档色容量条（原型 f3afc37 variant3-single.tsx
 * 视觉 `│ ctx █░ band NN% 状态 X.Xk/Y.Yk`）。标签用 `ctx`（用户 2026-08-07
 * 反馈：不用中文），状态词 ok / warn / alert 对应三档色。
 *
 * 数值语义（本计划裁决 1）：used = inputTokens + cacheReadInputTokens +
 * cacheCreationInputTokens（cache null → 0，Anthropic 三类 token 互不相交，
 * 合计 = 本回合模型看到的完整上下文）；pct = round(used / contextWindow × 100)。
 * 分母 = contextWindow 真值（非原型 mock 8000）。
 *
 * 三档色阈值（用户 2026-08-07 反馈：颜色调淡蓝）：
 *  - <50% CTX_BLUE 淡蓝（新增，取代原 bgRunning 灰绿）；
 *  - 50-80% running（琥珀，theme.ts:60，保留警示）；
 *  - >80% error（theme.ts:62，保留告警）。
 * running 时左 border 600ms 脉动（pal.border ↔ pal.running，原型 usePulse 钩子形态）。
 *
 * 始终显示框（用户 2026-08-07 反馈：一开始就 0% 框，不是横线等文本）：
 * lastUsage === null（首轮前）也渲染完整 band + `0% ok` + `0.0k/window`，
 * 用量是真实检测（首轮后）后才刷新。窄列（cols < 40）降级仅 `ctx NN%`；
 * NO_COLOR 由 ink chalk 自动去色，`█░` 形状 + 数字兜底可读。
 */
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text } from "ink";
import type { TokenUsage } from "../harness/model-adapter/types.js";
import { tuiPalette } from "./theme.js";

export interface ContextBarProps {
  readonly lastUsage: TokenUsage | null;
  readonly contextWindow: number;
  readonly running: boolean;
  readonly cols: number;
}

/** 淡蓝（用户 2026-08-07 反馈）；与 Web ContextUsageStrip COLOR_SAFE 镜像同值。
 *  导出供 tests/tui/context-bar.test.tsx 引用（保持与 Web 测试同模式）。 */
export const CTX_BLUE = "#7ab8ff";

// 数值语义 SSOT（本计划裁决 1）：下述纯函数与
// web/src/components/ContextUsageStrip.tsx 镜像保持逐字一致 —— 修改任一侧
// 必须同步另一侧（裁决 1 公式 / 三档色阈值变更需双改）。
/** 容量条：█ 填充 + ░ 空余（原型 variant3-single.tsx:91-95 同签名同输出）。 */
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

/** 上下文 token 用量合计（裁决 1）：cache 空字段按 0 处理。 */
export function ctxUsed(lastUsage: TokenUsage): number {
  return (
    lastUsage.inputTokens +
    (lastUsage.cacheReadInputTokens ?? 0) +
    (lastUsage.cacheCreationInputTokens ?? 0)
  );
}

/** 600ms 布尔脉动（原型 variant3-single.tsx:151-165 usePulse，frozen 冻结）。 */
function usePulse(frozen: boolean, periodMs = 600): boolean {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (frozen) return;
    const t = setInterval(() => setN((x) => x + 1), periodMs);
    return () => clearInterval(t);
  }, [frozen, periodMs]);
  return n % 2 === 0;
}

export function ContextBar(props: ContextBarProps): ReactElement {
  const pal = tuiPalette;
  const { lastUsage, contextWindow, running, cols } = props;
  // 分母 ≤ 0（envInt 返回 0 / 负数）→ 视为无效，used/pct 按 0 兜底，防 NaN/Infinity。
  const denomOk = contextWindow > 0;
  const used = lastUsage === null || !denomOk ? 0 : ctxUsed(lastUsage);
  const pct =
    lastUsage === null || !denomOk
      ? 0
      : Math.round((used / contextWindow) * 100);
  // 首轮前（lastUsage null）不脉动——没有用量「可读」，静置 0% 框；
  // 运行中且已检测出用量才脉动左 border（用户反馈「等有文本之后再检测」）。
  const warm = lastUsage !== null && running && pct > 0 && denomOk;
  const leftBorder = usePulse(!warm) ? pal.border : pal.running;
  const color = contextColor(pct);
  // 窄列（cols < 40）：仅 `ctx NN%`（省略状态词与 k/k 数字）。
  if (cols < 40) {
    return (
      <Box>
        <Text color={leftBorder}>│</Text>
        <Text color={color}> ctx {pct}%</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color={leftBorder}>│</Text>
      <Text>
        <Text> ctx </Text>
        <Text color={color}>{valueBand(pct, 10)}</Text>
        <Text color={color}> {pct}%</Text>
        <Text color={color}>
          {" "}
          {pct > 80 ? "alert" : pct >= 50 ? "warn" : "ok"}
        </Text>
        <Text color={pal.dim}>
          {" "}
          {(used / 1000).toFixed(1)}k/{(contextWindow / 1000).toFixed(1)}k
        </Text>
      </Text>
    </Box>
  );
}
