/** @jsxImportSource @opentui/react */
/**
 * src/tui/modal.tsx
 *
 * TUI modal render slot:
 *  - `SelectModal`: generic select modal (title + option list + selected
 *    index + key hint), pure rendering with no internal state (the selected
 *    index / key routing is held by the host);
 *  - `ModalHost`: dispatches rendering on the modal discriminated union
 *    (permission / select), returning null when no modal is active;
 *  - the permission-confirmation instance = `PERMISSION_ANSWERS`
 *    (y/a/n = once/always/reject) fed into SelectModal, with key routing via
 *    the pure function `reduceModalKey` (consumed by the host's useKeyboard;
 *    the OpenTUI KeyEvent is projected into a ModalKeyEvent by
 *    `modalKeyEventOf`).
 *
 * Row-accounting discipline: rendering and accounting share `wrapModalLines`
 * (wrap-ansi, trim:false + hard:true) to fold each logical line into physical
 * lines — SelectModal renders one `<text>` per physical line, box height = 2
 * border rows + physical lines, and `selectModalRows` predicts with the same
 * formula, so the two never drift.
 */
import type { ReactNode } from "react";
import { TextAttributes, type KeyEvent } from "@opentui/core";
import wrapAnsi from "wrap-ansi";
import { tuiPalette } from "./theme.js";

/** Generic option: hotkey direct-select (case-insensitive); description is an inline supplement. */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly hotkey?: string;
  readonly description?: string;
}

/** SelectModal content descriptor (single source shared by rendering and row accounting). */
export interface SelectModalContent {
  readonly title: string;
  readonly description?: string;
  readonly options: ReadonlyArray<SelectOption>;
  /** Bottom key-hint line (default = the generic ↑↓/Enter/Esc hint). */
  readonly hint?: string;
}

/** Permission confirmation tri-state: once = allow this time; always = always allow (this session); reject = deny. */
export type PermissionAnswer = "once" | "always" | "reject";

export const PERMISSION_ANSWERS: ReadonlyArray<SelectOption> = Object.freeze([
  Object.freeze({ value: "once", hotkey: "y", label: "本次允许" }),
  Object.freeze({
    value: "always",
    hotkey: "a",
    label: "总是允许（本会话）",
  }),
  Object.freeze({ value: "reject", hotkey: "n", label: "拒绝" }),
]);

export const PERMISSION_MODAL_HINT = "y/a/n 直选 · ↑↓ + Enter · Esc 收起";
export const SELECT_MODAL_HINT = "↑↓ 选择 · Enter 确认 · Esc 收起";

/** Modal discriminated union (ModalHost dispatch entry). */
export type TuiModal =
  | {
      readonly kind: "permission";
      readonly tool: string;
      readonly summaryHint: string;
      readonly selectedIndex: number;
    }
  | ({ readonly kind: "select" } & SelectModalContent & {
        readonly selectedIndex: number;
      });

/** Permission modal content descriptor (single source for rendering + row accounting). */
export function permissionModalContent(ask: {
  readonly tool: string;
  readonly summaryHint: string;
}): SelectModalContent {
  return {
    title: `允许执行 ${ask.tool}？`,
    ...(ask.summaryHint.length > 0 ? { description: ask.summaryHint } : {}),
    options: PERMISSION_ANSWERS,
    hint: PERMISSION_MODAL_HINT,
  };
}

/** Option line plain text (hotkey prefix + description); shared by rendering and row accounting. */
export function selectOptionLine(option: SelectOption): string {
  const hotkey = option.hotkey ? `[${option.hotkey}] ` : "";
  const desc = option.description ? `  ${option.description}` : "";
  return `${hotkey}${option.label}${desc}`;
}

/** Inner text width: terminal cols - 2 border columns - 1 paddingX on each
 *  side. When cols is extremely narrow (<4) it floors to 0 (no minimum — a
 *  floor would overestimate inner width and underestimate wrapped rows on
 *  narrow terminals). */
export function selectModalInnerWidth(cols: number): number {
  return Math.max(0, cols - 4);
}

/**
 * Fold content lines into physical lines via wrapping: wrap-ansi with
 * `{trim:false, hard:true}`. Inner width ≤ 0 (cols<4 degenerate terminal)
 * cannot wrap further → counted as 1 line. Rendering (SelectModal) and row
 * accounting (selectModalRows) share this function — single source.
 */
export function wrapModalLines(s: string, inner: number): string[] {
  if (inner <= 0) return [s];
  return wrapAnsi(s, inner, { trim: false, hard: true }).split("\n");
}

/**
 * Terminal rows the modal box actually occupies (row-accounting SSOT,
 * unit-testable): 2 border rows + the wrapped row counts of title /
 * description / options / key hint. The selected row's `❯ ` prefix and the
 * unselected rows' two-space prefix are equal width (2 columns each), so the
 * wrap prediction uses the selected form (the widest).
 */
export function selectModalRows(
  content: SelectModalContent,
  cols: number,
  selectedIndex = 0
): number {
  const inner = selectModalInnerWidth(cols);
  let rows = 2; // rounded border: top + bottom frame lines
  rows += wrapModalLines(content.title, inner).length;
  if (content.description !== undefined && content.description.length > 0) {
    rows += wrapModalLines(content.description, inner).length;
  }
  content.options.forEach((opt, i) => {
    const prefix = i === selectedIndex ? "❯ " : "  ";
    rows += wrapModalLines(`${prefix}${selectOptionLine(opt)}`, inner).length;
  });
  const hint = content.hint ?? SELECT_MODAL_HINT;
  rows += wrapModalLines(hint, inner).length;
  return rows;
}

/** Permission modal row count (charged into the chrome row accounting). */
export function permissionModalRows(
  ask: {
    readonly tool: string;
    readonly summaryHint: string;
  },
  cols: number,
  selectedIndex = 0
): number {
  return selectModalRows(permissionModalContent(ask), cols, selectedIndex);
}

/** Width of the selected row's `❯ ` / unselected rows' two-space prefix (2 columns each). */
const OPTION_PREFIX = "❯ ";

/**
 * Generic select modal (pure rendering): rounded frame + title + optional
 * description + option list + bottom key hint. selectedIndex is held by the
 * host (the ↑↓ / Enter / hotkey / Esc key routing lives in the host's
 * useKeyboard via the pure reduceModalKey).
 *
 * Each logical line is first folded into physical lines by wrapModalLines and
 * rendered row-by-row as `<text>` — same source as selectModalRows, so box
 * height = predicted row count (row-accounting invariant).
 */
export function SelectModal(props: {
  readonly content: SelectModalContent;
  readonly selectedIndex: number;
  readonly cols: number;
}): ReactNode {
  const pal = tuiPalette;
  const { content, selectedIndex, cols } = props;
  const inner = selectModalInnerWidth(cols);
  const hint = content.hint ?? SELECT_MODAL_HINT;
  const lines: ReactNode[] = [];

  wrapModalLines(content.title, inner).forEach((line, i) => {
    lines.push(
      <text
        key={`title-${i}`}
        fg={pal.running}
        attributes={TextAttributes.BOLD}
      >
        {line}
      </text>
    );
  });
  if (content.description !== undefined && content.description.length > 0) {
    wrapModalLines(content.description, inner).forEach((line, i) => {
      lines.push(
        <text key={`desc-${i}`} fg={pal.dim}>
          {line}
        </text>
      );
    });
  }
  content.options.forEach((opt, optIdx) => {
    const selected = optIdx === selectedIndex;
    const prefix = selected ? OPTION_PREFIX : "  ";
    wrapModalLines(`${prefix}${selectOptionLine(opt)}`, inner).forEach(
      (line, i) => {
        // Selected item's first physical line: `❯ ` prefix in accent, the rest in body colour (to distinguish from unselected).
        if (selected && i === 0 && line.startsWith(OPTION_PREFIX)) {
          lines.push(
            <text key={`opt-${optIdx}-${i}`}>
              <span fg={pal.accent}>{OPTION_PREFIX}</span>
              <span fg={pal.text} attributes={TextAttributes.BOLD}>
                {line.slice(OPTION_PREFIX.length)}
              </span>
            </text>
          );
          return;
        }
        lines.push(
          <text
            key={`opt-${optIdx}-${i}`}
            fg={selected ? pal.text : pal.dim}
            attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
          >
            {line}
          </text>
        );
      }
    );
  });
  wrapModalLines(hint, inner).forEach((line, i) => {
    lines.push(
      <text key={`hint-${i}`} fg={pal.dim}>
        {line}
      </text>
    );
  });

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={pal.running}
      paddingX={1}
      marginBottom={1}
    >
      {lines}
    </box>
  );
}

/**
 * ModalHost: the modal render slot. No active modal → null (0 row
 * accounting); permission → the three-option confirmation; select → generic
 * selection. The host holds state + key routing; Host only dispatches
 * rendering.
 */
export function ModalHost(props: {
  readonly modal: TuiModal | undefined;
  readonly cols: number;
}): ReactNode {
  const { modal, cols } = props;
  if (modal === undefined) return null;
  if (modal.kind === "permission") {
    return (
      <SelectModal
        content={permissionModalContent(modal)}
        selectedIndex={modal.selectedIndex}
        cols={cols}
      />
    );
  }
  return (
    <SelectModal
      content={modal}
      selectedIndex={modal.selectedIndex}
      cols={cols}
    />
  );
}

/** Key-input slice for reduceModalKey / reduceThinkingSwitchKey /
 *  reduceThinkingEffortKey (the projected form of the host's key event).
 *  OpenTUI KeyEvent.name value domain (same as the parse.keypress constants):
 *  ↑/↓ = "up"/"down", ←/→ = "left"/"right", Enter/Esc/Tab/Space =
 *  "return"/"escape"/"tab"/"space". */
export interface ModalKeyEvent {
  readonly input: string;
  readonly key: {
    readonly upArrow: boolean;
    readonly downArrow: boolean;
    readonly leftArrow: boolean;
    readonly rightArrow: boolean;
    readonly tab: boolean;
    readonly space: boolean;
    readonly return: boolean;
    readonly escape: boolean;
    readonly ctrl: boolean;
    readonly meta: boolean;
  };
}

/** OpenTUI KeyEvent → ModalKeyEvent projection (the single adapter between
 *  the host's useKeyboard and reduceModalKey; single-char printable keys go
 *  through the hotkey direct-select channel). */
export function modalKeyEventOf(e: KeyEvent): ModalKeyEvent {
  return {
    input: typeof e.name === "string" && e.name.length === 1 ? e.name : "",
    key: {
      upArrow: e.name === "up",
      downArrow: e.name === "down",
      leftArrow: e.name === "left",
      rightArrow: e.name === "right",
      tab: e.name === "tab",
      space: e.name === "space",
      return: e.name === "return",
      escape: e.name === "escape",
      ctrl: e.ctrl,
      meta: e.meta,
    },
  };
}

/** reduceModalKey decision result. */
export type ModalKeyAction =
  | { readonly type: "move"; readonly index: number }
  | { readonly type: "select"; readonly value: string }
  | { readonly type: "dismiss" }
  | { readonly type: "ignore" };

/**
 * Modal key-routing pure function (consumed by the host's useKeyboard, unit-testable):
 *  - ↑/↓ move the selected index (clamped); Enter selects the current item; Esc dismisses;
 *  - printable characters direct-select by hotkey (case-insensitive);
 *  - ctrl/meta combos and unmatched characters → ignore (the host decides whether to swallow the key).
 */
export function reduceModalKey(
  event: ModalKeyEvent,
  modal: {
    readonly options: ReadonlyArray<SelectOption>;
    readonly selectedIndex: number;
  }
): ModalKeyAction {
  const { options, selectedIndex } = modal;
  const { input, key } = event;
  if (key.ctrl || key.meta) return { type: "ignore" };
  if (key.upArrow) {
    return { type: "move", index: Math.max(0, selectedIndex - 1) };
  }
  if (key.downArrow) {
    return {
      type: "move",
      index: Math.min(options.length - 1, selectedIndex + 1),
    };
  }
  if (key.return) {
    const current = options[selectedIndex];
    return current !== undefined
      ? { type: "select", value: current.value }
      : { type: "ignore" };
  }
  if (key.escape) return { type: "dismiss" };
  const lower = input.toLowerCase();
  if (lower.length > 0) {
    const hit = options.find(
      (opt) => opt.hotkey !== undefined && opt.hotkey.toLowerCase() === lower
    );
    if (hit !== undefined) return { type: "select", value: hit.value };
  }
  return { type: "ignore" };
}
