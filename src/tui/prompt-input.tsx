/** @jsxImportSource @opentui/react */
/**
 * src/tui/prompt-input.tsx
 *
 * #343 T6-C 修复项 B：TUI 输入框原生化（OpenTUI `<input>`）。
 * 用原生 input 的受控 value + onInput（全量字符串）替代旧版手动拼串，
 * 从根上消除「首字被吃」竞态；onKeyDown 拦截功能键做历史/补全/hint 路由，
 * 字符与 Backspace 交给 input 原生处理。
 *
 * 职责（与归档 PromptInput 一一对应）：
 *  - 完整受控输入：字符插入 / Backspace 删除 / Enter 提交（onSubmit） /
 *    ↑↓ 历史召回 / Tab 补全（onTabComplete + onSelectHint）；
 *  - 输入框下方候选提示（slash 词表）由本组件内部渲染，↑/↓ 在候选可见时
 *    调 hint cursor（hint 优先），无候选时调历史游标；
 *  - active 色边框（running 转亮色，V7 定稿）；
 *  - 不吞 Ctrl+C / Ctrl+O / Shift+Tab（让出给 app 层 useKeyboard）。
 *
 * 不产：行级滚动 / 行计数 / 镜像渲染树（spec SC3 删除清单）。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { KeyEvent } from "@opentui/core";
import { SLASH_HINT_DESCRIPTIONS, type TuiSlashCommand } from "./slash.js";
import { tuiPalette } from "./theme.js";

export interface PromptInputProps {
  readonly value: string;
  readonly placeholder?: string;
  /** running 态：线框转亮色（V7 定稿）。 */
  readonly active: boolean;
  /** 禁用输入（modal 活跃 / Esc 收起兜底）。原生 input `disabled` 无效；
   *  disabled 态：focused={false} 触发 blur 摘 keypressHandler；此 onKeyDown
   *  兜底（仅在 re-render 竞态窗口可达）。 */
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  /** 候选 hint 选中项 Enter 触发（不走 raw 文本解析）。 */
  readonly onSelectHint?: (command: TuiSlashCommand) => void;
  /** Tab 补全：调用方返回 null = 不动作；返补全串则覆盖 value。 */
  readonly onTabComplete?: (value: string, hintCursor: number) => string | null;
  /** 候选列表（任务 B）；PromptInput 内部维护 hintCursor + 渲染。 */
  readonly hintSuggestions?: ReadonlyArray<TuiSlashCommand>;
  /** 命令历史（内存态，会话内有效不落盘）。仅在 hint 不可见时生效。 */
  readonly history?: ReadonlyArray<string>;
}

export function PromptInput(props: PromptInputProps): ReactNode {
  const pal = tuiPalette;
  const suggestions = props.hintSuggestions ?? [];
  const hasHint = suggestions.length > 0;
  const history = props.history ?? [];

  const [hintCursor, setHintCursor] = useState(0);
  // 历史召回游标：-1 = 未在浏览历史；0..length-1 = 当前指向历史条目。
  const [historyCursor, setHistoryCursor] = useState(-1);
  // 草稿：↑ 离开输入现场时存；↓ 越过最新条时恢复（替代旧的覆盖式丢失）。
  const draftRef = useRef("");
  // 最近一次 ↑↓/Tab 导航写入的值。原生 input 的 value setter 在 commit 时
  // 同步回放一次 onInput（值相同），navValueRef 用来识别并跳过这次回放；
  // 由下方 useEffect 在下次值变化不一致时清除（handleInput 不主动清，否则
  // 回放会抢在 useEffect 前把守卫吃掉，导致 historyCursor 被误归位）。
  const navValueRef = useRef<string | null>(null);

  useEffect(() => {
    if (navValueRef.current === props.value) return;
    navValueRef.current = null;
    if (historyCursor !== -1) setHistoryCursor(-1);
  }, [props.value, historyCursor]);

  // 输入值变化 / 候选列表长度变化 → cursor 越界时 clamp。
  useEffect(() => {
    if (!hasHint) {
      if (hintCursor !== 0) setHintCursor(0);
      return;
    }
    if (hintCursor >= suggestions.length) {
      setHintCursor(suggestions.length - 1);
    }
  }, [props.value, hasHint, suggestions.length, hintCursor]);

  function handleInput(v: string): void {
    // 防回环：程序写入值（history/tab）在 commit 时被 input 回放一次 —
    // 值与 navValueRef 相同即跳过，不改写 state。navValueRef 的清除交给
    // 上方 useEffect（值变化且不匹配时）。
    if (navValueRef.current === v) return;
    if (v === props.value) return;
    props.onChange(v);
  }

  function handleKeyDown(e: KeyEvent): void {
    // disabled 态由 focused={false} 触发 blur 摘 keypressHandler 阻断事件，
    // 此分支仅 re-render 竞态窗口可达（防御性保留）。
    if (props.disabled) {
      e.preventDefault();
      return;
    }

    // 让出全局键（Ctrl+C / Ctrl+O / Shift+Tab 由 app 层处理）。
    if (e.ctrl || e.meta) return;
    if (e.shift && e.name === "tab") return;

    if (e.name === "return") {
      if (hasHint && props.onSelectHint) {
        const idx = Math.max(0, Math.min(hintCursor, suggestions.length - 1));
        const cmd = suggestions[idx];
        if (cmd !== undefined) props.onSelectHint(cmd);
      } else {
        props.onSubmit(props.value);
      }
      e.preventDefault();
      return;
    }

    if (e.name === "tab") {
      if (props.onTabComplete) {
        const completed = props.onTabComplete(props.value, hintCursor);
        if (completed !== null) {
          navValueRef.current = completed;
          props.onChange(completed);
        }
      }
      e.preventDefault();
      return;
    }

    // ↑/↓：hint 可见时调 hint cursor；否则走历史召回。
    if (e.name === "up") {
      if (hasHint) {
        setHintCursor((c) => Math.max(0, c - 1));
      } else if (history.length > 0) {
        if (historyCursor === -1) draftRef.current = props.value;
        const next =
          historyCursor === -1
            ? history.length - 1
            : Math.max(0, historyCursor - 1);
        const target = history[next];
        if (target !== undefined) {
          navValueRef.current = target;
          setHistoryCursor(next);
          props.onChange(target);
        }
      }
      e.preventDefault();
      return;
    }

    if (e.name === "down") {
      if (hasHint) {
        setHintCursor((c) => Math.min(suggestions.length - 1, c + 1));
      } else if (historyCursor !== -1) {
        const next = historyCursor + 1;
        if (next >= history.length) {
          // 越过最新条：恢复草稿，游标归位 -1。
          setHistoryCursor(-1);
          navValueRef.current = draftRef.current;
          props.onChange(draftRef.current);
        } else {
          const target = history[next];
          if (target !== undefined) {
            navValueRef.current = target;
            setHistoryCursor(next);
            props.onChange(target);
          }
        }
      }
      e.preventDefault();
      return;
    }

    // 其余键（可打印字符 / backspace / 左右等）不拦截，让 input 原生处理
    // 并通过 onInput 全量回报。
  }

  const borderColor = props.active ? pal.running : pal.border;

  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        borderStyle="rounded"
        borderColor={borderColor}
        paddingX={1}
      >
        <text>
          <span fg={props.active ? pal.running : pal.dim}>{"❯ "}</span>
        </text>
        <input
          value={props.value}
          focused={!props.disabled}
          placeholder={props.placeholder ?? ""}
          placeholderColor={pal.dim}
          textColor={pal.text}
          flexGrow={1}
          onInput={(v) => handleInput(v)}
          onKeyDown={(e) => handleKeyDown(e)}
        />
      </box>
      {hasHint && (
        <box flexDirection="column" marginTop={0}>
          {suggestions.map((cmd, i) => {
            const selected = i === hintCursor;
            const desc = SLASH_HINT_DESCRIPTIONS[cmd];
            return (
              <text
                key={cmd}
                fg={selected ? pal.selected : pal.dim}
                attributes={selected ? 1 : 0}
              >
                {`/${cmd}  ${desc}`}
              </text>
            );
          })}
        </box>
      )}
    </box>
  );
}
