/** @jsxImportSource @opentui/react */
/**
 * src/tui/config-panel.tsx
 *
 * `/config` settings panel (ADR-0096): bare `/config` opens a floating panel
 * of the same family as `/model` with three rows (FS isolation mode / worktree
 * gate / subagent concurrency cap); `/config …` with arguments keeps the
 * existing `applyFsModeCommand` path unchanged.
 *
 * Interaction semantics (same SSOT as model-picker / memory-picker — the
 * picker-family triplet of State + reducer + rows function + component):
 *  - ↑/↓ → move focus (clamp [0, ROW_COUNT-1], always three rows);
 *  - Enter → fix (FS row: flip the holder then persist; cap row: cycle the cap
 *    holder then persist; worktree row: flip the worktree holder then persist
 *    — all three rows are live);
 *  - Esc → commit (**close directly**, no save-staged semantics) — Enter
 *    persists immediately on flip, so there is no uncommitted staged state to
 *    save; same cancel semantics as model-picker;
 *  - ctrl/meta → ignore (leave them to the app layer).
 *
 * Row budget: `configPickerRows()` = border 2 + title 1 + 3 content rows +
 * key hints 1 = 7. **Excludes marginBottom=1** (same convention as
 * modelPickerRows / thinkingPickerRows / memoryPickerRows, accounted by the
 * +1 in chromeReserveRows).
 *
 * The three rows (closed value sets, illegal states unreachable — the panel
 * has no free-text input):
 *  - FS isolation mode `global | workspace` (live row): flip via
 *    `props.fsMode?.set()` then fire-and-forget `props.onPersistFsMode`;
 *    failure → notice.
 *  - worktree gate `ON | OFF` (live row): flip via
 *    `props.worktreeOnMutateHolder.set(...)` then fire-and-forget
 *    `onPersistWorktreeOnMutate`; failure → notice (holder stays applied,
 *    same as the FS / cap rows — never rolled back).
 *  - subagent concurrency cap `3 | 5 | 9 | 15 | unlimited` (live row): cycle
 *    the cap holder via `nextSubagentCap` then fire-and-forget
 *    `onPersistSubagentCap`; failure → notice (same shape as the FS row).
 */
import { useEffect, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import type { ModalKeyEvent } from "./modal.js";
import type {
  FsIsolationMode,
  FsModeContext,
} from "../harness/sandbox/fs-mode.js";
import type { WorktreeGateReader } from "../harness/isolation/worktree-gate.js";
import { tuiPalette } from "./theme.js";
import { BORDER_CYCLE_MS, flowBorderColor } from "./designs/_color.js";

/**
 * Config panel width (picker family but **independent value**, not reusing
 * PICKER_WIDTH). The three rows carry a right-side switch hint (see
 * fsNextHint below; CJK labels count as 2 cols each); the widest content row
 * is 51 cols (the FS row with its CJK label + hint; the cap row peaks at 47)
 * — PICKER_WIDTH=50 leaves only 46 inner cols, which would wrap rows into two
 * lines and push `configPickerRows()` past its budget, squeezing the
 * transcript (width budget rule: inner width ≥ widest row). 56 − border 2 −
 * paddingX 2 = 52 ≥ 51. The row budget itself is width-independent (row
 * count unchanged).
 */
export const CONFIG_PICKER_WIDTH = 56;

/** The three rows: always 3 (FS / worktree / cap). Future rows add lines, not columns. */
export const CONFIG_PICKER_ROW_COUNT = 3;

/** Subagent concurrency cap, display-only value (closed set; undefined = not wired, shows "—"). */
export type SubagentCapDisplay = number | "unlimited" | undefined;

/**
 * Concurrency-cap display string (display-only; replaced by holder.get()
 * once wired). undefined → "—" (placeholder for not-wired / missing startup
 * assembly).
 */
export function formatSubagentCapDisplay(cap: SubagentCapDisplay): string {
  if (cap === undefined) return "—";
  if (cap === "unlimited") return "unlimited";
  return String(cap);
}

/** Subagent concurrency cap closed set (the single source the panel's Enter cycles through). 3→5→9→15→unlimited→3. */
export const SUBAGENT_CAP_CYCLE: ReadonlyArray<number | "unlimited"> = [
  3,
  5,
  9,
  15,
  "unlimited",
];

/**
 * Next cap within the closed set (pure): `3 → 5 → 9 → 15 → "unlimited" → 3`.
 * Illegal input (including undefined) → start at the default 3 (consistent
 * with the first Enter after the "—" placeholder: don't preset an initial
 * value, fall back to the set minimum so the holder is never slammed to an
 * unexpectedly large value). Callers go through the panel's Enter path and
 * never pass illegal values; this function is the fail-closed backstop.
 */
export function nextSubagentCap(
  current: number | "unlimited" | undefined
): number | "unlimited" {
  if (current === undefined) return SUBAGENT_CAP_CYCLE[0]!;
  const idx = SUBAGENT_CAP_CYCLE.indexOf(current as number | "unlimited");
  if (idx < 0) return SUBAGENT_CAP_CYCLE[0]!;
  return SUBAGENT_CAP_CYCLE[(idx + 1) % SUBAGENT_CAP_CYCLE.length]!;
}

/**
 * Worktree gate display string. `undefined` (not wired / missing startup
 * assembly) → "OFF" (same direction as the fail-closed default of
 * `resolveWorktreeOnMutate`).
 */
export function formatWorktreeOnMutateDisplay(on: boolean | undefined): string {
  return on === true ? "ON" : "OFF";
}

/**
 * Worktree gate flip (pure): `ON ↔ OFF` closed-set toggle. The panel only
 * produces these two values; the holder's internal `set` additionally guards
 * with a typeof-boolean check (fail-closed, same shape as
 * `createFsModeContext`'s set).
 */
export function toggleWorktreeOnMutate(on: boolean): boolean {
  return !on;
}

/**
 * Panel state (shared by reducer + component). `focusedIndex` is the only
 * in-panel staged state (clamped to [0, CONFIG_PICKER_ROW_COUNT-1]); every
 * other field is a render-time snapshot (from props / fsMode.get(), not
 * stored in this component — to stay in sync with the holders).
 */
export interface ConfigPickerState {
  readonly focusedIndex: 0 | 1 | 2;
}

export type ConfigPickerAction =
  | { readonly kind: "move"; readonly index: 0 | 1 | 2 }
  | { readonly kind: "fix" }
  | { readonly kind: "commit" }
  | { readonly kind: "ignore" };

/**
 * Key-routing pure function (consumed by the host's useKeyboard):
 *  - ctrl/meta → ignore (Ctrl+C/O not swallowed);
 *  - Esc → commit (close directly — Enter persists immediately, so there is
 *    no staged state to save);
 *  - ↑/↓ → move, clamp [0, ROW_COUNT-1];
 *  - Enter → fix (which row to change is decided by focusedIndex; the
 *    component layer dispatches to the corresponding handler and the host
 *    decides whether to actually write);
 *  - anything else → ignore.
 */
export function reduceConfigPickerKey(
  event: ModalKeyEvent,
  opts: { readonly focusedIndex: 0 | 1 | 2 }
): ConfigPickerAction {
  const { key } = event;
  if (key.ctrl || key.meta) return { kind: "ignore" };
  if (key.escape) return { kind: "commit" };
  if (key.upArrow) {
    return {
      kind: "move",
      index: Math.max(
        0,
        Math.min(CONFIG_PICKER_ROW_COUNT - 1, opts.focusedIndex - 1)
      ) as 0 | 1 | 2,
    };
  }
  if (key.downArrow) {
    return {
      kind: "move",
      index: Math.max(
        0,
        Math.min(CONFIG_PICKER_ROW_COUNT - 1, opts.focusedIndex + 1)
      ) as 0 | 1 | 2,
    };
  }
  if (key.return) return { kind: "fix" };
  return { kind: "ignore" };
}

/**
 * FS mode flip (pure): `global ↔ workspace` closed-set toggle. The panel only
 * produces these two values; the holder's internal `set` additionally guards
 * through `parseFsModeFlag` (fail-closed).
 */
export function toggleFsMode(mode: FsIsolationMode): FsIsolationMode {
  return mode === "global" ? "workspace" : "global";
}

/**
 * Total terminal rows (row-budget SSOT, pure): border 2 + title 1 + 3 content
 * rows + key hints 1 = 7. **Excludes marginBottom=1** — accounted by the +1
 * in chromeReserveRows (same convention as modelPickerRows /
 * thinkingPickerRows / memoryPickerRows).
 */
export function configPickerRows(): number {
  return 7;
}

/**
 * Translates the panel's fix action into "which row to write". The host uses
 * this to dispatch to the FS holder / worktree holder / cap holder. Pure
 * routing only: focusedIndex → row kind, touching no holder and writing no
 * file — the real set + persist happens inline in app.tsx (behavior stays
 * with the host; this leaf only discriminates, so the component never triggers
 * engine writes inline).
 */
export type ConfigRowKind = "fsMode" | "worktreeOnMutate" | "subagentCap";

export function configRowKindFor(focusedIndex: 0 | 1 | 2): ConfigRowKind {
  if (focusedIndex === 0) return "fsMode";
  if (focusedIndex === 1) return "worktreeOnMutate";
  return "subagentCap";
}

/**
 * The worktree row's three display values (value / hint / readOnly), collapsed
 * into two branches by "is the holder present". Extracted to module level
 * because `ConfigPicker` is an existing over-budget component (every new
 * panel branch would hit the S5 ratchet), and this projection belongs to the
 * same family as `capValue` / `fsValue` — render-time snapshots that write
 * nothing.
 *
 * Holder present → live `holder.get()` read + a hint showing what Enter would
 * switch to (same standard as the FS / cap rows) + editable; absent → static
 * `worktreeOn` snapshot + no hint + read-only (`row()` then renders the
 * display-only marker instead of the hint).
 */
function worktreeRowDisplay(props: {
  readonly worktreeOnMutateHolder?: WorktreeGateReader;
  readonly worktreeOn?: boolean;
}): {
  readonly value: string;
  readonly hint: string;
  readonly readOnly: boolean;
} {
  const holder = props.worktreeOnMutateHolder;
  if (holder === undefined) {
    return {
      value: formatWorktreeOnMutateDisplay(props.worktreeOn),
      hint: "",
      readOnly: true,
    };
  }
  const current = holder.get();
  return {
    value: formatWorktreeOnMutateDisplay(current),
    hint: `Enter 切换为 ${formatWorktreeOnMutateDisplay(toggleWorktreeOnMutate(current))}`,
    readOnly: false,
  };
}

/**
 * ConfigPicker — settings panel with the rounded flowing-border style.
 * Persistent overlay: fixed width CONFIG_PICKER_WIDTH (56, independent of
 * PICKER_WIDTH — the rows carry wider right-side hints) and alignSelf
 * flex-start (same as model-picker); rows predicted by configPickerRows
 * (7).
 *
 * All three rows behave the same on Enter: flip the respective holder then
 * fire-and-forget persist (failures surface via an app-layer notice; the
 * holder is not rolled back); a missing holder → no-op + display-only.
 */
export function ConfigPicker(props: {
  readonly state: ConfigPickerState;
  readonly fsMode: FsModeContext | undefined;
  /**
   * Worktree-gate runtime holder (same shape as `subagentCapHolder`). When
   * present the row reads `holder.get()` live (every render) and Enter is
   * active; when absent it falls back to the static `worktreeOn` snapshot
   * (still read-only).
   */
  readonly worktreeOnMutateHolder?: WorktreeGateReader;
  /**
   * Worktree-gate startup snapshot (display-only; superseded by the holder
   * when present). undefined → "OFF" placeholder.
   */
  readonly worktreeOn?: boolean;
  /**
   * Subagent-cap runtime holder. When present the cap row reads
   * `holder.get()` live (every render, same shape as fsMode); when absent it
   * falls back to `subagentCapDisplay` (startup snapshot).
   */
  readonly subagentCapHolder?: {
    readonly get: () => number | "unlimited";
  };
  /**
   * Subagent-cap startup snapshot (display-only; overridden by
   * subagentCapHolder when wired; kept as a test fixture / legacy-host
   * fallback). undefined → "—" placeholder.
   */
  readonly subagentCapDisplay?: SubagentCapDisplay;
  /**
   * Whether a holder is wired for the cap row (decides if Enter is active on
   * it); the host (TuiApp) passing undefined degrades the cap row to
   * read-only.
   */
  readonly capRowInteractive?: boolean;
  /**
   * Re-render trigger (incremented by the host after Enter flips a holder).
   * Holders are plain objects and `get()` does not subscribe — without this
   * prop the component would still re-run on parent renders, but passing it
   * explicitly makes "why does this refresh" self-documenting in types, and
   * guards against silent staleness if the component is ever memoized.
   */
  readonly renderTick?: number;
}): ReactNode {
  const pal = tuiPalette;
  const { focusedIndex } = props.state;

  const tl = useTimeline();
  const [borderPhase, setBorderPhase] = useState(0);
  useEffect(() => {
    const target = { phase: 0 };
    tl.add(target, {
      phase: 4,
      duration: BORDER_CYCLE_MS,
      ease: "linear",
      onComplete: () => {
        target.phase = 0;
      },
      onUpdate: () => {
        const next = target.phase;
        setBorderPhase((prev) => (prev === next ? prev : next));
      },
    });
  }, [tl]);

  // FS row live value: read the holder at call time (snapshot semantics while
  // the panel is open — same as envDisplay.get(); holder absent → display
  // "global" by default). Keeps host snapshots out of TuiApp's props (S5 hard
  // gate on component branches).
  const fsValue = props.fsMode?.get() ?? "global";
  const fsOther = toggleFsMode(fsValue);
  // FS row's pending-value preview (not staged state — just shows the user
  // what Enter would flip to), same projection style as memory-picker's
  // descOn/descOff; writes no persisted field.
  const fsNextHint = `Enter 切换为 ${fsOther}`;
  // Worktree row live value + preview: holder present → live holder.get()
  // (Enter flips the holder → next render shows the new value, consistent
  // with the FS / cap rows); absent → fall back to props.worktreeOn (startup
  // snapshot) + no hint (read-only). Both branches collapse in a module-level
  // helper (ConfigPicker is an existing god component).
  const worktreeRow = worktreeRowDisplay(props);
  // Cap row live value: holder present → live holder.get() (Enter flips the
  // holder → next render shows the new value, same shape as fsMode); holder
  // absent → fall back to props.subagentCapDisplay (startup snapshot).
  const capValue = formatSubagentCapDisplay(
    props.subagentCapHolder !== undefined
      ? props.subagentCapHolder.get()
      : props.subagentCapDisplay
  );
  // Cap row preview: shows what Enter would switch to — same standard as the
  // FS row's fsNextHint. capRowInteractive=false → no hint (degrades to
  // read-only).
  const capCurrentValue =
    props.subagentCapHolder !== undefined
      ? props.subagentCapHolder.get()
      : props.subagentCapDisplay;
  const capNextHint =
    props.capRowInteractive === true
      ? `Enter 切换为 ${formatSubagentCapDisplay(nextSubagentCap(capCurrentValue))}`
      : "";

  function row(
    index: 0 | 1 | 2,
    label: string,
    value: string,
    hint: string,
    readOnly: boolean
  ): ReactNode {
    const focused = focusedIndex === index;
    const fg = focused ? pal.running : pal.text;
    const prefix = focused ? "▸ " : "  ";
    return (
      <text>
        <span fg={focused ? pal.running : pal.dim}>{prefix}</span>
        <span
          fg={fg}
          attributes={focused ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {`${label}  ${value}`}
        </span>
        {!readOnly && <span fg={pal.dim}>{`  ·  ${hint}`}</span>}
        {readOnly && <span fg={pal.dim}>{`  ·  (仅显示)`}</span>}
      </text>
    );
  }

  // The three panelSlot rows render no free text (label + value + hint all
  // close over constants), so const-literalize per row index to avoid the
  // implicit escaping of JSX string concatenation.
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      width={CONFIG_PICKER_WIDTH}
      alignSelf="flex-start"
    >
      {/* Title: settings (◆─ shared panel prefix) */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          设置
        </span>
      </text>
      {row(0, "文件系统隔离档", fsValue, fsNextHint, false)}
      {row(
        1,
        "worktree 门禁",
        worktreeRow.value,
        worktreeRow.hint,
        worktreeRow.readOnly
      )}
      {row(
        2,
        "子代理并发上限",
        capValue,
        capNextHint,
        props.capRowInteractive !== true
      )}
      <text fg={pal.dim} wrapMode="none">
        [↑↓] 选择 · [Enter] 切换 · [Esc] 关闭
      </text>
    </box>
  );
}
