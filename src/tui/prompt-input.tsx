/** @jsxImportSource @opentui/react */
/**
 * src/tui/prompt-input.tsx
 *
 * #343 T6-C 修复项 B：TUI 输入框原生化（OpenTUI `<input>`）。
 * T8：渲染原语从 `<input>` 升级为 `<textarea>`（多行输入）。T8 在既有
 * 受控 value + onInput 全量字符串模型上叠加：
 *  - Enter 提交 / Shift+Enter 换行：onKeyDown 拦截 Enter 提交（preventDefault），
 *    Shift+Enter 不拦截 + keyBindings 显式绑 `shift+return → newline` ——
 *    OpenTUI 默认无 shift+return 绑定（fall-through 到字符插入但 ESC 序列被
 *    拒），必须显式补绑；mergeKeyBindings 按 name:modifiers 精确匹配，
 *    shift+return 与 return 是不同键，可区分。
 *  - 高度自适应：`maxLines` 上限内按 `\n` 逻辑行数增长，达上限后 textarea
 *    内部滚动（native buffer viewport）；
 *  - 受控 value 变化经 onContentChange 回读 plainText，防首字竞态同 input。
 *
 * 职责（与归档 PromptInput 一一对应）：
 *  - 完整受控输入：字符插入 / Backspace 删除 / Enter 提交（onSubmit） /
 *    Shift+Enter 换行 / ↑↓ 历史召回 / Tab 补全（onTabComplete + onSelectHint）；
 *  - 输入框下方候选提示（slash 词表）由本组件内部渲染，↑/↓ 在候选可见时
 *    调 hint cursor（hint 优先），无候选时调历史游标；
 *  - active 色边框（running 转亮色，V7 定稿）；
 *  - 不吞 Ctrl+C / Ctrl+O / Shift+Tab（让出给 app 层 useKeyboard）。
 *
 * 不产：行级滚动 / 行计数 / 镜像渲染树（spec SC3 删除清单）。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  KeyEvent,
  KeyBinding as TextareaKeyBinding,
  TextareaRenderable,
} from "@opentui/core";
import { SLASH_HINT_DESCRIPTIONS, type SlashCandidate } from "./slash.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

/** 多行输入行数上限（SSOT，textarea 高度与 chromeReserveRows 行账共用）。
 *  达此高度后 textarea 内部滚动，chromeReserveRows 内部封顶同步生效，
 *  避免输入框行账与 textarea 实际高度出现飘移。T8。 */
export const INPUT_MAX_LINES = 8;

/**
 * 输入框可见行数（SSOT，可单测）：按 `\n` 分割的物理行数，空 → 1 行。
 * 保守估算：不考虑软折行（wrapMode="word" 的视觉折行交由 textarea 内部处理，
 * 这里只保证"达 INPUT_MAX_LINES 后内部滚动"所需的行数基线）。T8。
 *
 * 注意：本函数计 *logical*（换行分割）行数，不计 wrapMode 视觉折行。
 * 命名保留 `Visible` 是历史原因（chromeReserveRows 早期调用），避免
 * 公开 API 改名；新代码如需 wrap-aware 行数请自行实现。T8。
 */
export function inputVisibleLineCount(value: string): number {
  return value.split("\n").length;
}

/**
 * T8：textarea 键位重绑。默认 `return → newline` 保留；Shift+Enter 换行
 * 显式补绑（OpenTUI 默认无 shift+return 绑定，fall-through 到字符插入但
 * ESC 序列被拒 → 需此绑定）。mergeKeyBindings 按 name:modifiers 精确匹配，
 * shift+return 与 return 是不同键，可区分。Enter 提交由 onKeyDown 拦截
 * （preventDefault 阻止 newline，直接 onSubmit）。
 */
const TEXTAREA_KEY_BINDINGS: TextareaKeyBinding[] = [
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "linefeed", shift: true, action: "newline" },
];

export interface PromptInputProps {
  readonly value: string;
  readonly placeholder?: string;
  /** running 态：线框转亮色（V7 定稿）。 */
  readonly active: boolean;
  /** 禁用输入（modal 活跃 / Esc 收起兜底）。原生 input `disabled` 无效；
   *   disabled 态：focused={false} 触发 blur 摘 keypressHandler；此 onKeyDown
   *   兜底（仅在 re-render 竞态窗口可达）。 */
  readonly disabled?: boolean;
  /** 终端列宽（描述按视觉列宽截断，#377 E 修复）。 */
  readonly cols: number;
  /** 多行输入上限（T8）；调用方与 chromeReserveRows 行账共用同一值。 */
  readonly maxLines?: number;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  /** 候选 hint 选中项 Enter 触发（不走 raw 文本解析）。#337 Phase C：
   *   candidate 为整个 SlashCandidate（静态命令 | skill），调用方按 kind 分流。 */
  readonly onSelectHint?: (candidate: SlashCandidate) => void;
  /** Tab 补全：调用方返回 null = 不动作；返补全串则覆盖 value。 */
  readonly onTabComplete?: (value: string, hintCursor: number) => string | null;
  /** 候选列表（任务 B）；PromptInput 内部维护 hintCursor + 渲染。
   *   #337 Phase C：类型放宽为 SlashCandidate（静态命令 | skill）。 */
  readonly hintSuggestions?: ReadonlyArray<SlashCandidate>;
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
  // 最近一次 ↑↓/Tab 导航写入的值。原生 textarea 的 value setter 在 commit 时
  // 同步回放一次 onContentChange（值相同），navValueRef 用来识别并跳过这次
  // 回放；由下方 useEffect 在下次值变化不一致时清除（handleContentChange 不
  // 主动清，否则回放会抢在 useEffect 前把守卫吃掉，导致 historyCursor 被误归位）。
  const navValueRef = useRef<string | null>(null);
  // T8：textarea 无 value setter —— 受控值经 ref.setText 重建 buffer。onContentChange
  // 回调是用户输入的唯一内容变更信号；程序写入（history/tab / submit 清空）由
  // 下方 sync effect 检测 buffer 与 props.value 不一致时 setText 强制同步。
  const textareaRef = useRef<TextareaRenderable | null>(null);

  useEffect(() => {
    if (navValueRef.current === props.value) return;
    navValueRef.current = null;
    if (historyCursor !== -1) setHistoryCursor(-1);
  }, [props.value, historyCursor]);

  // T8：受控值同步 —— props.value 变化且与 buffer 不一致时 setText 覆盖
  // （程序写入路径；用户输入路径 buffer 已先行更新，此 effect no-op）。
  // setText 会触发 content-changed 回放 → handleContentChange，由 navValueRef
  // / v === props.value 双重守卫拦截，不产生回环。
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (ta.plainText !== props.value) {
      ta.setText(props.value);
    }
  }, [props.value]);

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

  function handleContentChange(): void {
    const ta = textareaRef.current;
    if (!ta) return;
    const v = ta.plainText;
    // 防回环：程序写入值（history/tab）在 commit 时被 textarea 回放一次 —
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
      // T8：Shift+Enter 换行 —— 不拦截，交给 textarea 原生 newline；
      // Enter 提交（hint 可见时调 onSelectHint，否则 onSubmit）。
      if (!e.shift) {
        if (hasHint && props.onSelectHint) {
          const idx = Math.max(0, Math.min(hintCursor, suggestions.length - 1));
          const cmd = suggestions[idx];
          if (cmd !== undefined) props.onSelectHint(cmd);
        } else {
          props.onSubmit(props.value);
        }
        e.preventDefault();
      }
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

    // 其余键（可打印字符 / backspace / 左右等）不拦截，让 textarea 原生处理
    // 并通过 onContentChange 全量回报。
  }

  const borderColor = props.active ? pal.running : pal.border;
  // T8 高度自适应：按 `\n` 逻辑行数封顶 maxLines（达上限后 textarea 内部滚动）。
  // 行数计算复用 inputVisibleLineCount（SSOT，与 chromeReserveRows 共享）。
  const maxLines = props.maxLines ?? INPUT_MAX_LINES;
  const visibleLines = Math.max(
    1,
    Math.min(inputVisibleLineCount(props.value), maxLines)
  );

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
        <textarea
          ref={textareaRef}
          focused={!props.disabled}
          placeholder={props.placeholder ?? ""}
          placeholderColor={pal.dim}
          textColor={pal.text}
          height={visibleLines}
          wrapMode="word"
          flexGrow={1}
          keyBindings={TEXTAREA_KEY_BINDINGS}
          onContentChange={() => handleContentChange()}
          onKeyDown={(e) => handleKeyDown(e)}
        />
      </box>
      {hasHint && (
        <box flexDirection="column" marginTop={0}>
          {suggestions.map((candidate, i) => {
            const selected = i === hintCursor;
            const label =
              candidate.kind === "command" ? candidate.command : candidate.name;
            const desc =
              candidate.kind === "command"
                ? SLASH_HINT_DESCRIPTIONS[candidate.command]
                : (candidate.description ?? "加载技能");
            // #377 E：描述按视觉列宽截断（尾部 …），防止 skill 长描述撑爆
            // 屏外。预算 = cols − `/${label}  ` 前缀 − 3 列余量。
            const budget = Math.max(
              4,
              props.cols - visualWidth(`/${label}  `) - 3
            );
            const descShown = clipOneLineVisual(desc, budget);
            return (
              <text
                key={`${candidate.kind}-${label}`}
                fg={selected ? pal.selected : pal.dim}
                attributes={selected ? 1 : 0}
              >
                {`/${label}  ${descShown}`}
              </text>
            );
          })}
        </box>
      )}
    </box>
  );
}
