/**
 * src/tui/components.tsx
 *
 * #146 TUI 共享渲染原子（V7 定案，原型 components.tsx 搬入收口）：
 *  - Spinner：ASCII 轮转 `| / - \` 100ms/帧（Q4a：前台动态指示，无 emoji）；
 *  - PromptInput：圆角线框内单行输入（running 转亮色即分隔，V7 操作员定稿
 *    否决输入框下方全宽分隔线）；行内编辑 = 追加 / 退格 / Enter 提交；
 *  - useTick：动画心跳 hook（100ms）。
 */
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useInput } from "ink";
import { tuiPalette } from "./theme.js";

export const SPINNER_FRAMES: ReadonlyArray<string> = ["|", "/", "-", "\\"];

/** 100ms 心跳：返回自增帧号，驱动 spinner / 动效重渲染。
 *  periodMs <= 0 = 禁用档（不挂定时器，避免 0ms 忙轮询；hooks 顺序不变，
 *  调用方可按条件在 0 / 正常周期间切换）。 */
export function useTick(periodMs = 100): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (periodMs <= 0) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return tick;
}

export function Spinner(props: { readonly label?: string }): ReactElement {
  const tick = useTick();
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "|";
  return (
    <Text color={tuiPalette.running}>
      {frame} {props.label ?? "运行中…"}
    </Text>
  );
}

/**
 * 剥除非可打印字符：ink 对同一 chunk 的多字符输入按整串回调（快速打字 /
 * 粘贴 / pty 突发都产生多字符 chunk）；只查首字符会让 chunk 尾部的 \r
 * 等控制字符混入输入缓冲（Enter 语义丢失）。逐字符过滤后追加。
 */
function stripNonPrintable(input: string): string {
  return [...input]
    .filter((c) => c.charCodeAt(0) >= 32 && c !== "\x7f")
    .join("");
}

export interface PromptInputProps {
  readonly value: string;
  readonly placeholder?: string;
  /** running 态：线框转亮色（V7 定稿）。 */
  readonly active: boolean;
  /** 禁用输入（turn 运行中仍接受导航命令 → 由上层决定，不禁用）。 */
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
}

export function PromptInput(props: PromptInputProps): ReactElement {
  useInput(
    (input, key) => {
      if (key.return) {
        props.onSubmit(props.value);
        return;
      }
      if (key.backspace || key.delete) {
        props.onChange(props.value.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta || key.escape) return;
      const printable = stripNonPrintable(input);
      if (printable.length > 0) props.onChange(props.value + printable);
    },
    { isActive: !props.disabled }
  );
  const pal = tuiPalette;
  return (
    <Box
      borderStyle="round"
      borderColor={props.active ? pal.running : pal.border}
      paddingX={1}
    >
      <Text>
        <Text color={props.active ? pal.running : pal.dim}>❯ </Text>
        {props.value.length > 0 ? (
          <Text color={pal.text}>{props.value}</Text>
        ) : (
          <Text color={pal.dim}>{props.placeholder ?? ""}</Text>
        )}
      </Text>
    </Box>
  );
}
