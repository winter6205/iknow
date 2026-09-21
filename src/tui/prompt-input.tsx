/** @jsxImportSource @opentui/react */
/**
 * TUI native prompt input (OpenTUI <textarea>, multi-line).
 * Layers on the existing controlled value + onInput full-string model:
 *  - Enter submits / Shift+Enter inserts a newline: onKeyDown intercepts
 *    Enter (preventDefault); Shift+Enter is not intercepted and keyBindings
 *    bind `shift+return → newline` explicitly — OpenTUI ships no shift+return
 *    binding (it falls through to character insertion but the ESC sequence is
 *    rejected), so the extra binding is mandatory; mergeKeyBindings matches by
 *    name:modifiers exactly, keeping shift+return distinct from return.
 *  - Auto height: grows by `\n` logical line count up to `maxLines`, after
 *    which the textarea scrolls internally (native buffer viewport);
 *  - Controlled-value changes read back plainText via onContentChange; same
 *    first-character race guard as input.
 *
 * Responsibilities:
 *  - Fully controlled input: char insert / Backspace / Enter submit (onSubmit)
 *    / Shift+Enter newline / ↑↓ history recall / Tab completion (onTabComplete
 *    + onSelectHint);
 *  - Candidate hints below the input (slash vocabulary) render inside this
 *    component; ↑/↓ move the hint cursor while hints are visible (hints win),
 *    otherwise the history cursor;
 *  - Active border color (brightens while running);
 *  - Does not swallow Ctrl+C / Ctrl+O / Shift+Tab (yielded to the app-layer
 *    useKeyboard).
 *
 * Does not produce: line-level scrolling / line counting / mirror render tree.
 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type {
  KeyEvent,
  KeyBinding as TextareaKeyBinding,
  TextareaRenderable,
} from "@opentui/core";
import { SLASH_HINT_DESCRIPTIONS, type SlashCandidate } from "./slash.js";
import { clipOneLineVisual, visualWidth } from "./tool-summary.js";
import { tuiPalette } from "./theme.js";

/** Max input lines (SSOT; the textarea height and the chromeReserveRows line
 *  budget share it). At this height the textarea scrolls internally and
 *  chromeReserveRows caps in sync, so the input's line budget never drifts
 *  from the textarea's real height. */
export const INPUT_MAX_LINES = 8;

/** Hint-list row cap (SSOT): more candidates than this render a scroll
 *  window following the hint cursor, and the app row budget
 *  (chromeReserveRows.inputHintRows) clamps to the same value — a short
 *  terminal never gets its chrome squeezed into overlapping rows. */
export const HINT_MAX_ROWS = 8;

/** Scroll-window start row (SSOT, unit-testable): the smallest start that
 *  keeps `cursor` inside `[start, start + maxRows)`, clamped to
 *  `[0, total - maxRows]`; `total <= maxRows` → 0 (no windowing). */
export function hintWindowStart(
  cursor: number,
  total: number,
  maxRows: number
): number {
  if (total <= maxRows) return 0;
  return Math.min(Math.max(cursor - maxRows + 1, 0), total - maxRows);
}

/**
 * Visible line count of the input (SSOT, unit-testable): physical lines
 * split by `\n`, empty → 1.
 * Conservative estimate: ignores soft wrapping (wrapMode="word" visual folds
 * are left to the textarea internals; this only guarantees the line baseline
 * for "scroll internally once INPUT_MAX_LINES is reached".
 *
 * Note: counts *logical* (newline-split) lines, not wrapMode visual folds.
 * The `Visible` name is historical (early chromeReserveRows caller), kept to
 * avoid renaming a public API; new code wanting wrap-aware counts should use
 * `inputWrapLineCount` (which fixed "any amount of input stays one line").
 */
export function inputVisibleLineCount(value: string): number {
  return value.split("\n").length;
}

/**
 * Wrap-aware visible line count of the input: actual lines after visual
 * folding at terminal width. Long text without `\n` also stretches the box
 * when it exceeds cols (fixing the 2026-08-14 user report "any amount of
 * input stays one line"). `cols` = terminal width; the inner usable width
 * deducts chrome (rounded border 2 + paddingX 2 + ❯ 2 = 6). visualWidth
 * already counts CJK as 2 columns, same source as OpenTUI textarea
 * wrapMode="word".
 */
export function inputWrapLineCount(value: string, cols: number): number {
  const INNER_CHROME_COLS = 6;
  const innerCols = Math.max(1, cols - INNER_CHROME_COLS);
  if (value.length === 0) return 1;
  let total = 0;
  for (const line of value.split("\n")) {
    if (line.length === 0) {
      total += 1;
      continue;
    }
    // Accumulate by visual width in innerCols; an over-wide line folds into
    // ceil(visualWidth/innerCols) lines.
    const w = visualWidth(line);
    total += Math.max(1, Math.ceil(w / innerCols));
  }
  return total;
}

/**
 * Textarea key rebinds. The default `return → newline` stays; Shift+Enter
 * newline is bound explicitly (OpenTUI ships no shift+return binding — it
 * falls through to character insertion but the ESC sequence is rejected).
 * mergeKeyBindings matches by name:modifiers exactly, so shift+return and
 * return are distinguishable. Enter submission is intercepted in onKeyDown
 * (preventDefault blocks the newline, then onSubmit directly).
 */
const TEXTAREA_KEY_BINDINGS: TextareaKeyBinding[] = [
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "linefeed", shift: true, action: "newline" },
];

export interface PromptInputProps {
  readonly value: string;
  readonly placeholder?: string;
  /** Running state: the border turns bright. */
  readonly active: boolean;
  /** Disable input (modal active / Esc collapse fallback). Native input
   *  `disabled` is ineffective; the disabled state: focused={false} blurs and
   *  detaches the keypressHandler; this onKeyDown is the fallback (only
   *  reachable in the re-render race window). */
  readonly disabled?: boolean;
  /** Terminal width (descriptions clipped by visual column width). */
  readonly cols: number;
  /** Multi-line input cap; callers share the same value with the
   *  chromeReserveRows line budget. */
  readonly maxLines?: number;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  /** Enter on the selected candidate hint (bypasses raw-text parsing);
   *  candidate is the whole SlashCandidate (static command | skill), callers
   *  branch by kind. */
  readonly onSelectHint?: (candidate: SlashCandidate) => void;
  /** Tab completion: returning null = no-op; a completion string overwrites value. */
  readonly onTabComplete?: (value: string, hintCursor: number) => string | null;
  /** Candidate list; PromptInput maintains hintCursor + rendering internally.
   *  Typed as SlashCandidate (static command | skill). */
  readonly hintSuggestions?: ReadonlyArray<SlashCandidate>;
  /** Command history (in-memory, valid within the session, not persisted). Only effective while hints are hidden. */
  readonly history?: ReadonlyArray<string>;
  /**
   * Leaving the input falls onto graph chrome: Tab with no completion, or
   * single-line Down while not browsing history. Return true = handled, do
   * not run the default Tab/Down.
   */
  readonly onLeaveToChrome?: () => boolean;
}

/** Imperative handle: the app-layer paste path writes the buffer directly —
 *  buffer-first like keypress, one source of truth (eliminates the
 *  last-writer-wins race between state-first paste and buffer-first keypress;
 *  see tests/tui/input-interleave-race.test.tsx). */
export interface PromptInputHandle {
  /** Insert text at the current cursor (synchronous native-buffer write + immediate onChange report). */
  readonly insertText: (text: string) => void;
}

export const PromptInput = forwardRef<PromptInputHandle, PromptInputProps>(
  function PromptInput(props, ref): ReactNode {
    const pal = tuiPalette;
    const suggestions = props.hintSuggestions ?? [];
    const hasHint = suggestions.length > 0;
    // Descriptions align to one column: every `/<label>` is padded to the
    // longest candidate's visual width (skill names may carry wide chars,
    // hence visualWidth rather than length).
    const hintLabelWidth = hasHint
      ? Math.max(
          ...suggestions.map((c) =>
            visualWidth(`/${c.kind === "command" ? c.command : c.name}`)
          )
        )
      : 0;
    const history = props.history ?? [];

    const [hintCursor, setHintCursor] = useState(0);
    // History-recall cursor: -1 = not browsing history; 0..length-1 = pointing
    // at a history entry.
    const [historyCursor, setHistoryCursor] = useState(-1);
    // Draft: saved when ↑ leaves the input scene; restored when ↓ passes the
    // newest entry (replaces the old overwrite-and-lose behavior).
    const draftRef = useRef("");
    // The value most recently written by ↑↓/Tab navigation. On commit the
    // native textarea replays one onContentChange after the value setter (same
    // value); navValueRef identifies and skips that replay; the useEffect below
    // clears it when the next value differs (handleContentChange must not
    // clear it, or the replay eats the guard before the useEffect and
    // historyCursor gets mis-reset).
    const navValueRef = useRef<string | null>(null);
    // The value last written programmatically via setText in the sync effect.
    // Invariant: buffer content == syncValueRef iff no user edit happened
    // since that programmatic write. setText's content-changed replay can
    // arrive late (passive effect scheduling); by then props.value has
    // advanced and navValueRef is null, so both guards miss — the replay is
    // misread as a real edit and onChange(stale) clobbers the newer
    // functional-update chain (reproduces whenever voice input fires paste
    // bursts <15ms apart: characters appear, then get instantly truncated).
    // This ref is the third guard: on replay, if the live buffer still equals
    // the last written value → skip; cleared immediately when a real edit
    // passes (otherwise a user deleting back to the same content would be
    // swallowed).
    const syncValueRef = useRef<string | null>(null);
    // The textarea has no value setter — the controlled value rebuilds the
    // buffer via ref.setText. onContentChange is the sole content-change
    // signal for user input; programmatic writes (history/tab / submit clear)
    // go through the sync effect below, which setTexts whenever buffer and
    // props.value disagree.
    const textareaRef = useRef<TextareaRenderable | null>(null);
    // In-flight report (echo in-flight): handleContentChange records v before
    // each onChange(v); cleared once the commit consumes it (props.value
    // caught up to v and it is not a programmatic write). Buffer-first writes
    // (keypress / paste insertText) change the buffer then report
    // immediately while React state queues behind — if a mid-queue commit
    // carries a stale props.value through the sync effect without
    // distinguishing the source, setText(stale) rolls the buffer back (late
    // rollback → the new segment is swallowed). Discrimination rule:
    // echoPending === buffer = state merely lags behind the buffer, skip
    // setText and wait for catch-up; otherwise it is a genuine programmatic
    // write (history/tab/rewind/submit — state-first, buffer untouched, so
    // echoPending differs from buffer), setText syncs as usual.
    const echoPendingRef = useRef<string | null>(null);

    // Imperative paste entry: buffer-first like keypress (insertText writes the
    // native buffer → synchronous content-changed emit → handleContentChange
    // reports the absolute value), bypassing the React state queue — queued
    // paste segments can no longer be clobbered by keypress's absolute-value
    // setState. The content-changed replay during insertText is guarded by
    // syncValueRef (after insertText, buffer != syncValueRef → judged a real
    // edit, path straight to onChange).
    useImperativeHandle(
      ref,
      (): PromptInputHandle => ({
        insertText: (text: string): void => {
          const ta = textareaRef.current;
          if (!ta || props.disabled) return;
          ta.insertText(text);
        },
      }),
      [props.disabled]
    );

    useEffect(() => {
      // Echo consumption: state has caught up with the in-flight report →
      // clear the marker, so later programmatic writes (Tab completion /
      // submit clear) are not misread as "echo in-flight" and skipped.
      if (echoPendingRef.current === props.value) echoPendingRef.current = null;
      if (navValueRef.current === props.value) return;
      navValueRef.current = null;
      if (historyCursor !== -1) setHistoryCursor(-1);
    }, [props.value, historyCursor]);

    // Controlled-value sync — when props.value changes and disagrees with the
    // buffer, setText overwrites (programmatic-write path; user-input paths
    // already updated the buffer first, so this effect no-ops). setText
    // triggers a content-changed replay → handleContentChange, intercepted by
    // the navValueRef / v === props.value guards, so no loop forms.
    useEffect(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      if (ta.plainText !== props.value) {
        // Buffer-first write (keypress / paste insertText) with its echo
        // in-flight: buffer content matching the in-flight report means state
        // merely lags behind the buffer — skip setText and wait for catch-up;
        // otherwise (echo already consumed, or this is a state-first
        // programmatic write like Tab completion / submit clear with the
        // buffer untouched) setText syncs as usual. Without source
        // discrimination, setText(stale) rolls the buffer back and swallows
        // the new segment (the input-interleave-race discriminating
        // regression), and would also break the Tab-completion / submit-clear
        // programmatic writes.
        if (echoPendingRef.current === ta.plainText) return;
        echoPendingRef.current = null;
        // setText resets the cursor to buffer start (setCursorByOffset(0)) —
        // the old setter behavior lost in the textarea migration. After a
        // programmatic write (↑/↓ recall / Tab completion / rewind refill /
        // paste append / submit clear), a user backspacing would "delete from
        // the first character". All programmatic writes in this app are full
        // replacements or tail appends, so **end-of-buffer cursor = the
        // uniformly correct UX** — gotoBufferEnd goes through
        // updateSelectionForMovement without emitting content-changed, no loop
        // with handleContentChange; a no-op when already at the end (stays
        // no-op-safe if upstream later preserves the cursor).
        //
        // Replaces the previous "setCursor(last line, visW) + min(savedCursor)"
        // composite — savedCursor goes stale in fast-typing windows
        // (accumulating across writes, clamping the cursor to a wrong
        // position); the user report "cursor shifts forward while typing fast"
        // was exactly this composite's fragility. Unifying to the end avoids
        // the stale-savedCursor risk and covers every programmatic path
        // (paste / rewind / submit clear).
        // Record syncValueRef before setText: the (possibly late) replay is
        // recognized and skipped through it.
        syncValueRef.current = props.value;
        ta.setText(props.value);
        ta.gotoBufferEnd();
      }
    }, [props.value]);

    // Input value / candidate-list length changed → clamp hintCursor when out of range.
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
      // Third anti-loop guard: the late replay of the sync effect's setText.
      // v reads the live buffer — equal to the last programmatic write means no
      // user edit in between, it is a replay, skip. A mismatch means a real
      // edit; clear the guard (the user deleting back to the same content must
      // not be swallowed).
      if (syncValueRef.current !== null) {
        if (v === syncValueRef.current) return;
        syncValueRef.current = null;
      }
      // Anti-loop: a programmatic value (history/tab) is replayed once by the
      // textarea at commit — when the value matches navValueRef, skip without
      // rewriting state. Clearing is left to the useEffect above (on the next
      // value change when it differs).
      if (navValueRef.current === v) return;
      if (v === props.value) return;
      echoPendingRef.current = v;
      props.onChange(v);
    }

    function handleKeyDown(e: KeyEvent): void {
      // The disabled state blurs via focused={false}, detaching the
      // keypressHandler; this branch is only reachable in the re-render race
      // window (kept defensively).
      if (props.disabled) {
        e.preventDefault();
        return;
      }

      // Yield global keys (Ctrl+C / Ctrl+O / Shift+Tab are handled by the app layer).
      if (e.ctrl || e.meta) return;
      if (e.shift && e.name === "tab") return;

      if (e.name === "return") {
        // Shift+Enter newline — not intercepted, native textarea handles it;
        // Enter submits (onSelectHint when hints are visible, else onSubmit).
        if (!e.shift) {
          if (hasHint && props.onSelectHint) {
            const idx = Math.max(
              0,
              Math.min(hintCursor, suggestions.length - 1)
            );
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
          } else if (props.onLeaveToChrome?.() === true) {
            e.preventDefault();
            return;
          }
        } else if (props.onLeaveToChrome?.() === true) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        return;
      }

      // ↑/↓ priority:
      //   1) hints visible → hint cursor;
      //   2) multiline input (logical \n lines or wrap-visual lines) → call
      //      ta.moveCursorUp/Down explicitly (visual-line movement); only at
      //      the boundary (already on the visual first/last line, so the move
      //      is a no-op) fall back to history;
      //   3) single line → history recall / draft restore.
      // The multiline test keys off `props.value` (controlled state; the
      // submit/programmatic-write backend is authoritative) — not
      // `ta.plainText`, because at the submit instant the textarea buffer is
      // not yet cleared by setText("") and would misjudge wrap-multiline
      // (regression scenario: `hist-line` wrapping to 2 lines at 80 cols).
      // Visual first/last-line tests use `ta.visualCursor.visualRow +
      // ta.scrollY` (document-level visual row), not onCursorChange's `line`
      // (logical row — constantly 0 under wrap, misjudging the boundary).
      // `inputWrapLineCount` is the SSOT pure function in this file.
      const ta = textareaRef.current;
      const isMultiline =
        inputWrapLineCount(props.value, props.cols) > 1 ||
        props.value.includes("\n");
      // Document-level visual row = scrollY + visualRow (scrollY > 0 under
      // wrap; scrollY=0 on a logical single line). Computed only inside the
      // multiline branch (the single-line path never needs it; avoids getter
      // cost/exceptions).
      const visualRowOf = (t: NonNullable<TextareaRenderable>): number =>
        t.scrollY + t.visualCursor.visualRow;
      // Total visual row count (wrap-aware).
      const totalVisualRowsOf = (t: NonNullable<TextareaRenderable>): number =>
        t.editorView.getTotalVirtualLineCount();

      if (e.name === "up") {
        if (hasHint) {
          setHintCursor((c) => Math.max(0, c - 1));
        } else if (isMultiline && ta !== null) {
          // Multiline: call native moveCursorUp (visual line up); if the
          // cursor is already on the visual first line (visualRow === 0),
          // moveCursorUp no-ops there → boundary → history recall.
          if (visualRowOf(ta) <= 0 && history.length > 0) {
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
          } else {
            ta.moveCursorUp();
          }
          e.preventDefault();
        } else if (history.length > 0) {
          // Single line: history recall (original logic).
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
          e.preventDefault();
        }
        return;
      }

      if (e.name === "down") {
        if (hasHint) {
          setHintCursor((c) => Math.min(suggestions.length - 1, c + 1));
        } else if (isMultiline && ta !== null) {
          // Multiline: call native moveCursorDown (visual line down); if the
          // cursor is on the visual last line (visualRow >= totalVisualRows -
          // 1), moveCursorDown is out of range → fall back to the draft only
          // while browsing history; otherwise do nothing (prevents a wrong
          // fallback overwrite when historyCursor === -1).
          if (visualRowOf(ta) >= totalVisualRowsOf(ta) - 1) {
            // On the visual last line: out of range → draft fallback only while
            // browsing history; not browsing → yield to the chrome focus ring
            // (multiline input yields once it visually overflows; Down enters
            // the subagent/graph ring).
            if (historyCursor !== -1) {
              const next = historyCursor + 1;
              if (next >= history.length) {
                // Passed the newest entry: restore the draft, reset cursor to -1.
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
            } else if (props.onLeaveToChrome?.() === true) {
              e.preventDefault();
              return;
            }
          } else {
            // Not the last line: call native moveCursorDown (visual line down).
            ta.moveCursorDown();
          }
          e.preventDefault();
        } else if (historyCursor !== -1) {
          const next = historyCursor + 1;
          if (next >= history.length) {
            // Passed the newest entry: restore the draft, reset cursor to -1.
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
          e.preventDefault();
        } else if (props.onLeaveToChrome?.() === true) {
          e.preventDefault();
        }
        return;
      }

      // All other keys (printable chars / backspace / left-right etc.) pass
      // through: the textarea handles them natively and reports full content
      // via onContentChange.
    }

    // The input stays border-only (operator feedback 2026-09-07): the fill
    // family belongs to committed message bubbles; the border alone separates
    // the input from the transcript (principle of least astonishment: no
    // background fill on a transient input area).
    const borderColor = props.active ? pal.running : pal.border;
    // Auto height: cap by wrap-aware visual line count against maxLines (the
    // textarea scrolls internally once capped). Long text without `\n` also
    // stretches when over-wide (2026-08-14 user report "any amount of input
    // stays one line"). Line counting reuses inputWrapLineCount (SSOT, sharing
    // the wrap-aware caliber with chromeReserveRows).
    const maxLines = props.maxLines ?? INPUT_MAX_LINES;
    const visibleLines = Math.max(
      1,
      Math.min(inputWrapLineCount(props.value, props.cols), maxLines)
    );
    // Scroll window for the hint list: only shifts when the cursor crosses
    // the window edge; labelWidth stays computed over the full list so the
    // description column does not jitter between window positions.
    const hintStart = hintWindowStart(
      hintCursor,
      suggestions.length,
      HINT_MAX_ROWS
    );
    const visibleHints = suggestions.slice(
      hintStart,
      hintStart + HINT_MAX_ROWS
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
            cursorStyle={{ blinking: false }}
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
            {visibleHints.map((candidate, i) => {
              const selected = hintStart + i === hintCursor;
              const label =
                candidate.kind === "command"
                  ? candidate.command
                  : candidate.name;
              const desc =
                candidate.kind === "command"
                  ? SLASH_HINT_DESCRIPTIONS[candidate.command]
                  : (candidate.description ?? "加载技能");
              // Clip descriptions to visual column width (trailing …) so long
              // skill descriptions never push lines off-screen. Budget = cols −
              // the padded `/label  ` prefix (labelWidth + 2) − 3 slack.
              const labelCell = `/${label}`;
              const prefix = `${labelCell}${" ".repeat(
                hintLabelWidth - visualWidth(labelCell)
              )}  `;
              const budget = Math.max(4, props.cols - hintLabelWidth - 2 - 3);
              const descShown = clipOneLineVisual(desc, budget);
              return (
                <text
                  key={`${candidate.kind}-${label}`}
                  fg={selected ? pal.selected : pal.dim}
                  attributes={selected ? 1 : 0}
                >
                  {`${prefix}${descShown}`}
                </text>
              );
            })}
          </box>
        )}
      </box>
    );
  }
);
