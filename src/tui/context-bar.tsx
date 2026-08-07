/**
 * src/tui/context-bar.tsx
 *
 * T4 (#TBD): 上下文用量条 — 三档色容量条（原型 f3afc37 variant3-single.tsx
 * 视觉 `│ 上下文 █░ band NN% 状态 X.Xk/Y.Yk`）。
 *
 * 数值语义（本计划裁决 1）：used = inputTokens + cacheReadInputTokens +
 * cacheCreationInputTokens（cache null → 0，Anthropic 三类 token 互不相交，
 * 合计 = 本回合模型看到的完整上下文）；pct = round(used / contextWindow × 100)。
 * 分母 = contextWindow 真值（非原型 mock 8000）。
 *
 * 三档色阈值 <50% bgRunning / 50-80% running / >80% error（theme.ts:61-62，
 * 与原型的 bgRunning/running/danger 数值一致）。running 时左 border 600ms
 * 脉动（pal.border ↔ pal.running，原型 usePulse 钩子形态）。
 * 窄列（cols < 40）降级仅 `上下文 NN%`；NO_COLOR 由 ink chalk 自动去色，
 * `█░` 形状 + 数字兜底可读（原型 theme.ts:19-21 同约定）。
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

/** 容量条：█ 填充 + ░ 空余（原型 variant3-single.tsx:91-95 同签名同输出）。 */
export function valueBand(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** 三档色阈值（theme.ts:61-62）：<50% bgRunning / 50-80% running / >80% error。 */
export function contextColor(pct: number): string {
  if (pct > 80) return tuiPalette.error;
  if (pct >= 50) return tuiPalette.running;
  return tuiPalette.bgRunning;
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
  // 钩子无条件前置调用（Rules of Hooks）：lastUsage null 与非 null 的两
  // 条渲染分支 hook 顺序必须一致，否则 React 19 dev 会报 static flag 警告。
  const used = lastUsage === null ? 0 : ctxUsed(lastUsage);
  const pct = lastUsage === null ? 0 : Math.round((used / contextWindow) * 100);
  const warm = lastUsage !== null && running && pct > 0;
  const leftBorder = usePulse(!warm) ? pal.border : pal.running;
  if (lastUsage === null) {
    return (
      <Box>
        <Text color={pal.dim}>│ 上下文 — 待首轮</Text>
      </Box>
    );
  }
  const color = contextColor(pct);
  // 窄列（cols < 40）：仅 `上下文 NN%`（省略状态词与 k/k 数字）。
  if (cols < 40) {
    return (
      <Box>
        <Text color={leftBorder}>│</Text>
        <Text color={color}> 上下文 {pct}%</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color={leftBorder}>│</Text>
      <Text>
        <Text> 上下文 </Text>
        <Text color={color}>{valueBand(pct, 10)}</Text>
        <Text color={color}> {pct}%</Text>
        <Text color={color}>
          {" "}
          {pct > 80 ? "告警" : pct >= 50 ? "注意" : "安全"}
        </Text>
        <Text color={pal.dim}>
          {" "}
          {(used / 1000).toFixed(1)}k/{(contextWindow / 1000).toFixed(1)}k
        </Text>
      </Text>
    </Box>
  );
}
