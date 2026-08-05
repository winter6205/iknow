/**
 * src/tui/components.tsx
 *
 * #146 TUI 共享渲染原子（V7 定案，原型 components.tsx 搬入收口）：
 *  - Spinner：ASCII 轮转 `| / - \` 100ms/帧（Q4a：前台动态指示，无 emoji）；
 *  - PromptInput：圆角线框内单行输入（running 转亮色即分隔，V7 操作员定稿
 *    否决输入框下方全宽分隔线）；行内编辑 = 追加 / 退格 / Enter 提交 / Tab 补全；
 *  - useTick：动画心跳 hook（100ms）。
 *
 * 任务 B：PromptInput 维护内部 hintCursor（候选选中索引），↑/↓ 在 hint
 * 可见且有候选时调整 cursor；Enter 时若 hint 有候选则触发 onSelectHint 而
 * 非 onSubmit（路由切换由调用方决定）；Tab 按 cursor 指向的候选补全
 * （onTabComplete 接受 hintCursor 参数）。
 */
import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { tuiPalette } from "./theme.js";
import { SLASH_HINT_DESCRIPTIONS, type TuiSlashCommand } from "./slash.js";

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
 *
 * 保留 `\t`（Tab）：ink 在 kittyKeyboard disabled 模式下会把 Tab 作为
 * key.tab 单独触发，但 pty/raw 路径偶发把 Tab 当 chunk 字符塞进来；
 * 保留它让 hint 路径的 useInput 拿到原始字符（filter 在 useInput 内部
 * 用 key.tab 拦截，不依赖 chunk 内的 `\t`）。
 */
function stripNonPrintable(input: string): string {
  return [...input]
    .filter((c) => c.charCodeAt(0) >= 32 || c === "\t")
    .filter((c) => c !== "\x7f")
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
  /**
   * 任务 B：候选 hint 选中项 Enter 触发。若 hint 可见且 suggestions 非空，
   * Enter 走 onSelectHint(command) 而非 onSubmit(value)；否则仍走
   * onSubmit(value)。调用方负责把 command 路由到实际命令。
   */
  readonly onSelectHint?: (command: TuiSlashCommand) => void;
  /**
   * Tab 补全（任务 B 新签名）：(value, hintCursor) → 补全字符串 / null。
   * 旧单参形式 (value) → null 仍可工作（cursor 默认 0）。
   */
  readonly onTabComplete?: (value: string, hintCursor: number) => string | null;
  /**
   * 候选列表（任务 B）。PromptInput 内部维护 hintCursor；↑/↓ 在 hint 可见
   * 且有候选时调整 cursor，cursor 越界自 clamp。空数组 → 隐藏 hint，cursor
   * 不动；输入变化（值非 "/" 开头）也重置 cursor。
   */
  readonly hintSuggestions?: ReadonlyArray<TuiSlashCommand>;
  /** 输入框下方的轻量提示（不抢输入焦点）。 */
  readonly hint?: ReactNode;
}

export function PromptInput(props: PromptInputProps): ReactElement {
  const suggestions = props.hintSuggestions ?? [];
  const hasHint = suggestions.length > 0;
  const [hintCursor, setHintCursor] = useState(0);
  // 输入框内容变化（非候选时）→ cursor 重置为 0
  useEffect(() => {
    if (!hasHint) {
      setHintCursor(0);
      return;
    }
    if (hintCursor >= suggestions.length) setHintCursor(suggestions.length - 1);
  }, [props.value, hasHint, suggestions.length, hintCursor]);
  useInput(
    (input, key) => {
      if (key.return) {
        if (hasHint && props.onSelectHint) {
          const idx = Math.max(0, Math.min(hintCursor, suggestions.length - 1));
          props.onSelectHint(suggestions[idx]!);
        } else {
          props.onSubmit(props.value);
        }
        return;
      }
      if (key.tab) {
        if (props.onTabComplete) {
          const completed = props.onTabComplete(props.value, hintCursor);
          if (completed !== null) props.onChange(completed);
        }
        return;
      }
      // ↑/↓ 仅在 hint 有候选时调整 cursor（无候选时让 keystroke 落入
      // stripNonPrintable → 走默认追加路径，避免空 inputValue 也能滚）
      if (hasHint) {
        if (key.upArrow) {
          setHintCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (key.downArrow) {
          setHintCursor((c) => Math.min(suggestions.length - 1, c + 1));
          return;
        }
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
  // 任务 B：hintSuggestions 提供时由 PromptInput 内部渲染（带 cursor
  // 高亮）；外部 hint prop 仍可单独用（兼容旧用法）。
  const renderInternalHint =
    props.hintSuggestions !== undefined && suggestions.length > 0;
  return (
    <Box flexDirection="column">
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
      {renderInternalHint ? (
        <Box flexDirection="column" marginTop={0}>
          {suggestions.map((cmd, i) => {
            const selected = i === hintCursor;
            const desc = SLASH_HINT_DESCRIPTIONS[cmd];
            return (
              <Text
                key={cmd}
                color={selected ? pal.selected : pal.dim}
                inverse={selected}
              >
                {`/${cmd}  ${desc}`}
              </Text>
            );
          })}
        </Box>
      ) : (
        props.hint !== undefined &&
        props.hint !== null && <Box marginTop={0}>{props.hint}</Box>
      )}
    </Box>
  );
}
