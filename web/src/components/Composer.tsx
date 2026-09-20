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
  /** Slash-command entry point; input starting with "/" never reaches onSend. */
  onCommand?: (name: SlashCommandName, arg?: string) => void;
  onSkillLoad?: (name: string, remainder: string) => void;
  skills?: ReadonlyArray<SkillEntryLike>;
  /** Notice channel for invalid slash input (App wires chat.pushNotice); absent → silent fallback. */
  onNotice?: (text: string) => void;
  placeholder?: string;
  thinkingSettings?: ThinkingSettings;
  onThinkingChange?: (next: ThinkingSettings) => void;
  /** Context usage (passed through to the UsageChip in the status bar below the input). */
  usage?: TokenUsage | null;
  contextWindow?: number | null;
  /** Model name (delivered by health); shown on the status bar's left half. Absent → hidden. */
  model?: string | null;
  /** Current permission-mode label (e.g. "Default"); absent → badge not rendered. */
  permissionModeLabel?: string | null;
  /** Mode-cycle trigger from Shift+Tab (or badge click); App calls the backend endpoint. */
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

  // Slash-completion menu state: selectedIndex is the keyboard highlight; Esc
  // sets dismissed, and the menu reopens only once the input changes again.
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

  /** Accept a candidate: arg-taking commands complete with a trailing space, awaiting the argument. */
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
      // Invalid slash input is not silent: notify and keep the draft so the user can fix it.
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

  /** Pure state write-back for menu key events (decisions live in lib/slash menuKeyEvent). */
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
        void submit(); // menu present but no valid decision → fall through to submit decision (incl. invalid-input notice)
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Tab cycles permission mode (mirrors the TUI shortcut) and wins over
    // the slash menu's Tab-accept; preventDefault blocks the browser's reverse
    // focus move. No badge (endpoint not assembled) → no interception, native
    // reverse focus move is kept.
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
      {/* Status bar below the input. Left = model name + permission-mode badge
          (Shift+Tab to cycle); right = usage block (token breakdown + progress
          bar + percent). Right edge aligns with the pill's right edge (send
          button 40px + 8px gap sit outside the pill → pr-12). Neither present
          → row not rendered. */}
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
