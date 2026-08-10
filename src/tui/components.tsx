/** @jsxImportSource @opentui/react */
/**
 * src/tui/components.tsx
 *
 * #343 T1 基础原语最小集 + T6-B 增量（不提前抽象）：
 *  - Separator：全宽水平分隔线；
 *  - StatusLine：单行状态 / 提示文字（默认 dim 次级色）；
 *  - Spinner：T6-B 增量 — 80ms/帧 braille-dot 轮转，`useTick` 驱动。
 *    PromptInput 仍归 T6-C 写（本文件不引入输入框逻辑）。
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { tuiPalette } from "./theme.js";

/** 全宽分隔线：1 行高 box 以 border 色背景充当横线。 */
export function Separator(): ReactNode {
  return <box height={1} width="100%" backgroundColor={tuiPalette.border} />;
}

export interface StatusLineProps {
  readonly text: string;
  /** 语义色覆盖（默认 dim；错误提示传 tuiPalette.error 等）。 */
  readonly fg?: string;
}

/** 单行状态行：状态栏 / 错误提示 / slash 反馈共用。 */
export function StatusLine(props: StatusLineProps): ReactNode {
  return <text fg={props.fg ?? tuiPalette.dim}>{props.text}</text>;
}

/** opencode 同款 braille-dot 轮转（80ms/帧，Q4a：前台动态指示，无 emoji）。
 *  帧序来自 archive/tui-ink/src/components.tsx SPINNER_FRAMES —— 单一来源。 */
export const SPINNER_FRAMES: ReadonlyArray<string> = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** 100ms 心跳：返回自增帧号，驱动 spinner / 动效重渲染。
 *  periodMs <= 0 = 禁用档（不挂定时器，避免 0ms 忙轮询；hooks 顺序不变）。
 *  T6-B 简易版（去 archive 冗余 useRef 路径），opencode 周期 80ms。 */
export function useTick(periodMs = 100): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (periodMs <= 0) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return tick;
}

/** 旋转指示器 — T6-B 简易版（运行态不传 label 默认「运行中…」）。 */
export function Spinner(props: { readonly label?: string }): ReactNode {
  const tick = useTick(80);
  const idx = tick % SPINNER_FRAMES.length;
  const frame = SPINNER_FRAMES[idx] ?? "⠋";
  return (
    <text fg={tuiPalette.running} wrapMode="none">
      {`${frame} ${props.label ?? "运行中…"}`}
    </text>
  );
}
