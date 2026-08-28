/** @jsxImportSource @opentui/react */
/**
 * src/tui/memory-picker.tsx
 *
 * /memory 双开关面板：自动记忆（autoExtract）+ Dream。
 * 交互对齐 thinking-picker：Space/Tab 翻转当前行、Enter 固定不关、Esc 保存退出。
 * Dream 仅在自动记忆开启时可改；关掉自动记忆时 Dream 强制关。
 */
import { useEffect, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import type { ModalKeyEvent } from "./modal.js";
import { PICKER_WIDTH } from "./thinking-picker.js";
import { tuiPalette } from "./theme.js";

export interface MemoryPreview {
  readonly autoExtract: boolean;
  readonly dream: boolean;
}

export interface CommittedMemoryPatch {
  readonly autoExtract: boolean;
  readonly dream: boolean;
}

export type MemoryToggleRow = "autoExtract" | "dream";

export type MemoryPickerAction =
  | { readonly type: "move"; readonly index: 0 | 1 }
  | { readonly type: "toggle" }
  | { readonly type: "fix" }
  | { readonly type: "commit" }
  | { readonly type: "ignore" };

export function seedMemoryPreview(
  memory:
    { readonly autoExtract?: boolean; readonly dream?: boolean } | undefined
): MemoryPreview {
  const autoExtract = memory?.autoExtract === true;
  const dream = autoExtract && memory?.dream === true;
  return { autoExtract, dream };
}

export function applyMemoryPreviewToggle(
  state: MemoryPreview,
  row: MemoryToggleRow
): MemoryPreview {
  if (row === "autoExtract") {
    const autoExtract = !state.autoExtract;
    return { autoExtract, dream: autoExtract ? state.dream : false };
  }
  if (!state.autoExtract) return state;
  return { autoExtract: true, dream: !state.dream };
}

export function committedMemoryPatch(
  state: MemoryPreview
): CommittedMemoryPatch {
  return {
    autoExtract: state.autoExtract,
    dream: state.autoExtract && state.dream,
  };
}

export function reduceMemoryPickerKey(
  event: ModalKeyEvent,
  opts: { readonly focusedIndex: number }
): MemoryPickerAction {
  const { key } = event;
  if (key.ctrl || key.meta) return { type: "ignore" };
  if (key.escape) return { type: "commit" };
  if (key.downArrow || key.upArrow) {
    const delta = key.downArrow ? 1 : -1;
    const next = Math.max(0, Math.min(1, opts.focusedIndex + delta));
    return { type: "move", index: next as 0 | 1 };
  }
  if (key.space || key.tab) return { type: "toggle" };
  if (key.return) return { type: "fix" };
  return { type: "ignore" };
}

/** 边框 2 + 标题 + 两行开关 + 键位提示。不含 marginBottom。 */
export function memoryPickerRows(): number {
  return 6;
}

function hexToRgb(hex: string): readonly [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1]!, 16);
  return [
    ((v >> 16) & 0xff) / 255,
    ((v >> 8) & 0xff) / 255,
    (v & 0xff) / 255,
  ] as const;
}

function mixHex(a: string, b: string, t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round((ar + (br - ar) * tt) * 255);
  const g = Math.round((ag + (bg - ag) * tt) * 255);
  const bl = Math.round((ab + (bb - ab) * tt) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g
    .toString(16)
    .padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

function flowBorderColor(phase: number): string {
  const n = 4;
  const idx = Math.floor(phase) % n;
  const f = phase - Math.floor(phase);
  const tokens = [
    tuiPalette.logoInk,
    tuiPalette.running,
    tuiPalette.logoGold,
    tuiPalette.running,
  ];
  const a = tokens[idx]!;
  const b = tokens[(idx + 1) % n]!;
  return mixHex(a, b, f);
}

const BORDER_CYCLE_MS = 8_000;

export interface MemoryPickerState extends MemoryPreview {
  readonly focusedIndex: 0 | 1;
}

export function MemoryPicker(props: {
  readonly state: MemoryPickerState;
}): ReactNode {
  const pal = tuiPalette;
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

  const { autoExtract, dream, focusedIndex } = props.state;
  const dreamLocked = !autoExtract;

  function row(
    index: 0 | 1,
    label: string,
    on: boolean,
    descOn: string,
    descOff: string,
    locked: boolean
  ): ReactNode {
    const focused = focusedIndex === index;
    const dimmed = locked;
    const enabledLook = on && !dimmed;
    const dotGlyph = enabledLook ? "◐" : "◑";
    const modeLabel = on ? "ON" : "OFF";
    const desc = locked ? "需先开启自动记忆" : on ? descOn : descOff;
    const fg = dimmed ? pal.dim : enabledLook ? pal.running : pal.dim;
    const prefix = focused ? "▸ " : "  ";
    return (
      <text>
        <span fg={focused ? pal.running : pal.dim}>{prefix}</span>
        <span fg={fg}>{`${dotGlyph}  ${label}  ${modeLabel}`}</span>
        <span fg={pal.dim}>{`  ·  ${desc}`}</span>
      </text>
    );
  }

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      width={PICKER_WIDTH}
      alignSelf="flex-start"
    >
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          记忆开关
        </span>
      </text>
      {row(0, "自动记忆", autoExtract, "抽取已开启", "抽取已关闭", false)}
      {row(1, "Dream", dream, "合并趟已开启", "合并趟已关闭", dreamLocked)}
      <text fg={pal.dim} wrapMode="none">
        [↑↓] 选择 · [Space] 切换 · [Enter] 固定 · [Esc] 保存退出
      </text>
    </box>
  );
}
