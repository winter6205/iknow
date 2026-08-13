/**
 * src/tui/thinking-gate.ts
 *
 * thinking override gate 纯函数（无 React 依赖，可独立单测）。
 *
 * 背景：TuiApp.runTurnOnce 的 thinking override 透传决策（stateChanged /
 * override 计算）原本内联在组件闭包里，难以单测。reviewer Spec Low#3 要求抽出。
 *
 * 语义：仅当用户实际改了 thinking 状态（相对 env defaultThinking 基线）才透传
 * per-turn override；否则返回 undefined → 走 cached deps（行为不变）。
 */

import type {
  ThinkingEffortWire,
  WireThinkingOverride,
} from "../session-api/contract.js";

/** env `thinking` + `thinkingEffort` 形状（TuiAppProps.defaultThinking 的最小投影）。 */
export interface DefaultThinkingShape {
  readonly mode: "off" | "adaptive";
  readonly effort: ThinkingEffortWire;
}

/** gate 纯函数：当前 thinking 状态 vs env 默认 → wire override（undefined = 走
 *  cached deps）。注意 enabled=false 时 effort 维度已由 enabled 覆盖，无需再比
 *  effort（defaultEffort 可能为 ""）。 */
export function computeThinkingOverride(
  defaultThinking: DefaultThinkingShape | undefined,
  enabled: boolean,
  effort: ThinkingEffortWire
): WireThinkingOverride | undefined {
  const defaultMode = defaultThinking?.mode ?? "off";
  const defaultEffort = defaultThinking?.effort ?? "";
  const stateChanged =
    enabled !== (defaultMode === "adaptive") ||
    (enabled && effort !== defaultEffort);
  if (!stateChanged) return undefined;
  return enabled ? { mode: "adaptive", effort } : { mode: "off" };
}

/** thinking 档位展示标签：""（未显式指定）→ "auto"，其余原样。
 *  reviewer Medium#2：消除 `effort || "auto"` 重复（/effort 无效提示 + infoLines）。 */
export function formatEffortLabel(effort: ThinkingEffortWire): string {
  return effort === "" ? "auto" : effort;
}
