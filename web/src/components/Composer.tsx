import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { FOCUS_RING } from "../lib/ui";
import {
  commandTakesArg,
  menuKeyEvent,
  slashCandidates,
  slashSubmitDecision,
  type MenuKeyEvent,
  type SkillEntryLike,
  type SlashCommandName,
} from "../lib/slash";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { ThinkingToggle } from "./ThinkingToggle";
import { UsageChip } from "./UsageChip";
import {
  DEFAULT_THINKING_SETTINGS,
  type ThinkingSettings,
} from "../lib/thinking-settings";
import type { TokenUsage } from "../api/types";

export type ComposerProps = {
  disabled?: boolean;
  sending?: boolean;
  onSend: (text: string) => void | Promise<void>;
  /** slash 命令执行入口；"/" 开头的输入永不走 onSend。 */
  onCommand?: (name: SlashCommandName, arg?: string) => void;
  onSkillLoad?: (name: string, remainder: string) => void;
  skills?: ReadonlyArray<SkillEntryLike>;
  /** 非法 slash 输入提示通道（App 接 chat.pushNotice）；缺席 → 静默兜底。 */
  onNotice?: (text: string) => void;
  placeholder?: string;
  thinkingSettings?: ThinkingSettings;
  onThinkingChange?: (next: ThinkingSettings) => void;
  /** 上下文用量（透传输入框下方状态条的 UsageChip）。 */
  usage?: TokenUsage | null;
  contextWindow?: number | null;
  /** 模型名（health 下发）；状态条左半部显示。缺席 → 不显示。 */
  model?: string | null;
  /** 当前 permission mode 显示标签（如 "Default"）；缺席 → 徽标不渲染。 */
  permissionModeLabel?: string | null;
  /** Shift+Tab（或点击徽标）触发的模式循环切换（App 调后端端点）。 */
  onPermissionModeToggle?: () => void;
};

// Auto-grow cap: ~4 lines of text-sm with leading-snug plus padding. Past
// this, the pill scrolls internally — the pill itself never grows taller.
const MAX_HEIGHT_PX = 120;

export function Composer({
  disabled = false,
  sending = false,
  onSend,
  onCommand = () => {},
  onSkillLoad = () => {},
  skills = [],
  onNotice = () => {},
  placeholder = "输入问题…",
  thinkingSettings = DEFAULT_THINKING_SETTINGS,
  onThinkingChange = () => {},
  usage = null,
  contextWindow = null,
  model = null,
  permissionModeLabel = null,
  onPermissionModeToggle = () => {},
}: ComposerProps) {
  const [value, setValue] = useState("");
  const fieldId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const locked = disabled || sending;

  // Slash 补全菜单状态：selectedIndex 为键盘高亮项；Esc 关闭后 dismissed
  // 置位，直到输入再次变化才重新打开。
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const candidates = useMemo(
    () => slashCandidates(value, skills),
    [value, skills]
  );
  const menuOpen = !locked && !menuDismissed && candidates.length > 0;
  const selected = menuOpen
    ? Math.max(0, Math.min(selectedIndex, candidates.length - 1))
    : 0;

  // Auto-grow the textarea up to MAX_HEIGHT_PX; past the cap the pill scrolls.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const onChange = (next: string) => {
    setValue(next);
    setSelectedIndex(0);
    setMenuDismissed(false);
  };

  /** 采纳候选：带参命令补全形带尾随空格，等待参数输入。 */
  const acceptCandidate = useCallback((name: string) => {
    const takesArg = commandTakesArg(name);
    setValue(takesArg ? `/${name} ` : `/${name}`);
    setSelectedIndex(0);
    setMenuDismissed(false);
  }, []);

  const executeCommand = useCallback(
    (name: SlashCommandName, arg: string) => {
      onCommand(name, arg === "" ? undefined : arg);
      setValue("");
      setMenuDismissed(false);
    },
    [onCommand]
  );

  const executeSkill = useCallback(
    (name: string, remainder: string) => {
      onSkillLoad(name, remainder);
      setValue("");
      setMenuDismissed(false);
    },
    [onSkillLoad]
  );

  const submit = useCallback(async () => {
    const text = value.trim();
    if (!text || locked) return;
    const decision = slashSubmitDecision(text, skills);
    if (decision.kind === "execute") {
      executeCommand(decision.name, decision.arg);
      return;
    }
    if (decision.kind === "skill") {
      executeSkill(decision.name, decision.remainder);
      return;
    }
    if (decision.kind === "notice") {
      // 非法 slash 输入不静默：提示并保留输入框文本让用户修改。
      onNotice(decision.text);
      return;
    }
    try {
      await onSend(text);
      setValue("");
    } catch {
      // Keep draft text so the user can retry after a failed send.
    }
  }, [value, locked, onSend, onNotice, executeCommand, executeSkill, skills]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  /** 菜单键盘事件的纯状态写回（裁决在 lib/slash menuKeyEvent）。 */
  const applyMenuEvent = (ev: MenuKeyEvent) => {
    if (ev.kind === "move") {
      setSelectedIndex(ev.index);
    } else if (ev.kind === "dismiss") {
      setMenuDismissed(true);
    } else if (ev.kind === "accept") {
      acceptCandidate(ev.name);
    } else if (ev.kind === "enter") {
      if (ev.action.kind === "execute") {
        executeCommand(ev.action.name, ev.action.arg);
      } else if (ev.action.kind === "skill") {
        executeSkill(ev.action.name, ev.action.remainder);
      } else if (ev.action.kind === "accept") {
        setValue(ev.action.text);
        setSelectedIndex(0);
      } else {
        void submit(); // 菜单在场但无有效裁决 → 走提交裁决（含非法提示）
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Tab 切 permission mode（镜像 TUI 快捷键）：优先于 slash 菜单的
    // Tab 补全采纳，preventDefault 阻止浏览器反向移焦。徽标缺席（端点未
    // 装配）→ 不拦截，保留浏览器原生反向移焦。
    if (
      e.key === "Tab" &&
      e.shiftKey &&
      !e.nativeEvent.isComposing &&
      permissionModeLabel !== null
    ) {
      e.preventDefault();
      onPermissionModeToggle();
      return;
    }
    if (menuOpen && !e.nativeEvent.isComposing) {
      const ev = menuKeyEvent(
        { value, selectedIndex: selected, candidates, skills },
        e.key,
        e.shiftKey
      );
      if (ev.kind !== "ignore") {
        e.preventDefault();
        applyMenuEvent(ev);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      aria-label="消息输入"
      className="mx-auto flex w-full max-w-[var(--chat-max)] flex-col px-4 pb-5 pt-3"
    >
      {menuOpen ? (
        <SlashCommandMenu
          candidates={candidates}
          selectedIndex={selected}
          onPick={acceptCandidate}
        />
      ) : null}
      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor={fieldId}>
          消息
        </label>
        {/* Pill container — textarea + thinking toggle share one rounded-pill
            border so the trigger visually sits INSIDE the input (not as a
            separate element). textarea drops its own border/bg/radius and
            becomes transparent; the toggle anchors to the right inside the
            container with its own inner padding. Auto-grow still targets the
            textarea; the container itself never grows taller (past
            MAX_HEIGHT_PX the textarea scrolls internally). */}
        <div className="flex min-w-0 flex-1 items-end gap-1 rounded-pill border border-ink-3/30 bg-surface/70 pl-5 pr-1 py-1 transition-colors duration-200 ease-[var(--ease-soft)] focus-within:border-ink-3">
          <textarea
            id={fieldId}
            ref={textareaRef}
            value={value}
            disabled={locked}
            placeholder={placeholder}
            rows={1}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent py-2 text-sm leading-snug text-ink placeholder:text-ink-3 outline-none transition-colors duration-200 ease-[var(--ease-soft)] disabled:opacity-60"
          />
          <ThinkingToggle
            settings={thinkingSettings}
            onChange={onThinkingChange}
            disabled={locked}
          />
        </div>
        {/* Send button — sits outside the pill on the right, ghost until typing.
            Minimal round button (40×40), accent fill on idle, ink on hover. */}
        <button
          type="submit"
          disabled={locked || !value.trim()}
          aria-busy={sending}
          aria-label="发送"
          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-ink shadow-bubble transition-all duration-200 ease-[var(--ease-soft)] hover:-translate-y-px hover:bg-accent/90 ${FOCUS_RING} disabled:cursor-not-allowed disabled:bg-accent/40 disabled:text-ink disabled:shadow-none`}
        >
          {sending ? (
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-[1.5px] border-ink/30 border-t-ink"
            />
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-4 w-4"
            >
              <path d="M21 4 3 11l7 2.5L13 21l8-17z" />
              <path d="m10 13.5 11-9.5" />
            </svg>
          )}
        </button>
      </div>
      {/* 状态条：输入框下方。左 = 模型名 + permission mode 徽标（Shift+Tab
          切换）；右 = 用量块（token 明细 + 进度条 + 百分比）。右缘对齐 pill
          右缘（发送按钮 40px + gap 8px 在 pill 之外 → pr-12）。两者皆无 →
          整行不渲染。 */}
      {model || permissionModeLabel ? (
        <div className="mt-1.5 flex items-center justify-between gap-3 pl-2 pr-12 font-mono text-[10px] leading-none text-ink-3">
          <span className="flex min-w-0 items-center gap-2">
            {model ? <span className="truncate">{model}</span> : null}
            {permissionModeLabel ? (
              <button
                type="button"
                onClick={onPermissionModeToggle}
                title="Shift+Tab 切换权限模式"
                className={`shrink-0 rounded-pill border border-ink-3/30 px-1.5 py-0.5 transition-colors duration-200 ease-[var(--ease-soft)] hover:border-ink-3 ${FOCUS_RING}`}
              >
                {permissionModeLabel}
              </button>
            ) : null}
          </span>
          <UsageChip
            usage={usage}
            contextWindow={contextWindow}
            sending={sending}
          />
        </div>
      ) : null}
    </form>
  );
}
