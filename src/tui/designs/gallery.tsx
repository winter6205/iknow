/** @jsxImportSource @opentui/react */
/**
 * Thinking-panel design gallery (demo assembly surface).
 *
 * Left: the selected design panel rendered live from `PickerModel`
 * (interactive: ←/→ switch level, Tab/Space toggle Auto, Enter confirm,
 * Esc close, Space open).
 * Right: design metadata (id / name / tag / summary) + control hints.
 *
 * Demo only; drives model state via the pure `reducePickerModel` from
 * `_contract.ts`.
 */
import { useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { THINKING_DESIGNS } from "./index.js";
import {
  reducePickerModel,
  type PickerEvent,
  type PickerModel,
} from "./_contract.js";
import { tuiPalette } from "../theme.js";

/** Left panel width (demo left column). */
const PANEL_COLS = 62;

/** Bottom control hint line (matches the useKeyboard bindings). */
const GALLERY_HINT =
  "[1-9] 跳设计 · [+/-] 上下翻(19版) · [←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 关闭 · [q] 退出";

/** Map keys to model events that drive the left panel. */
function keyToPickerEvent(name: string): PickerEvent | null {
  switch (name) {
    case "left":
      return { type: "left" };
    case "right":
      return { type: "right" };
    case "tab":
      return { type: "tab" };
    case "space":
      return { type: "space" };
    case "return":
      return { type: "confirm" };
    case "escape":
      return { type: "cancel" };
    default:
      return null;
  }
}

export function DesignGallery(props: {
  readonly cols: number;
  readonly onQuit: () => void;
}): ReactNode {
  const pal = tuiPalette;
  const { cols, onQuit } = props;
  const [designIndex, setDesignIndex] = useState(0);
  const [model, setModel] = useState<PickerModel>({
    autoOn: false,
    currentIndex: 1, // medium
    focusIndex: 1,
    open: true, // show immediately on open
  });

  const design = THINKING_DESIGNS[designIndex]!;

  useKeyboard((e) => {
    if (e.name === "q" && !e.ctrl && !e.meta) {
      onQuit();
      return;
    }
    // design switching: digits 1-9 jump directly; + next / - previous (cyclic)
    const name = e.name ?? "";
    if (/^[1-9]$/.test(name)) {
      const idx = Number(name) - 1;
      setDesignIndex(Math.min(idx, THINKING_DESIGNS.length - 1));
      setModel((m) => ({ ...m, open: true }));
      return;
    }
    if (name === "plus" || name === "=") {
      setDesignIndex((i) => (i + 1) % THINKING_DESIGNS.length);
      setModel((m) => ({ ...m, open: true }));
      return;
    }
    if (name === "minus" || name === "-") {
      setDesignIndex(
        (i) => (i - 1 + THINKING_DESIGNS.length) % THINKING_DESIGNS.length
      );
      setModel((m) => ({ ...m, open: true }));
      return;
    }
    if (e.ctrl || e.meta) return;
    // picker key events
    const event = keyToPickerEvent(e.name ?? "");
    if (event !== null) {
      setModel((m) => reducePickerModel(m, event));
    }
  });

  const leftCols = Math.min(PANEL_COLS, cols - 2);

  return (
    <box flexDirection="column" width={cols} marginTop={1}>
      {/* top design index / overview bar */}
      <text fg={pal.dim}>
        {`设计 ${designIndex + 1} / ${THINKING_DESIGNS.length}`}
      </text>

      <box flexDirection="row" gap={2} marginTop={1}>
        {/* left column: current design panel */}
        <box width={leftCols} flexDirection="column">
          <design.render model={model} cols={leftCols} />
        </box>

        {/* right column: design metadata */}
        <box flexDirection="column" width={Math.max(20, cols - leftCols - 4)}>
          <text fg={pal.running} attributes={TextAttributes.BOLD}>
            {design.meta.name}
          </text>
          <text fg={pal.dim}>{`id: ${design.meta.id}`}</text>
          <text fg={pal.dim}>{`tag: ${design.meta.tag}`}</text>
          <text
            fg={pal.dim}
          >{`model: auto=${model.autoOn} idx=${model.currentIndex}`}</text>
          <text fg={pal.text} wrapMode="word">
            {design.meta.summary}
          </text>
          <text fg={pal.dim}>{"─".repeat(40)}</text>
          <text
            fg={pal.dim}
          >{`当前档: ${model.autoOn ? "auto" : levelName(model.currentIndex)}`}</text>
        </box>
      </box>

      {/* bottom control hints */}
      <box marginTop={1}>
        <text fg={pal.dim}>{GALLERY_HINT}</text>
      </box>
    </box>
  );
}

/** Short names for EFFORT_LEVELS (demo display). */
const LEVEL_NAMES = ["low", "medium", "high", "xhigh", "max"] as const;
function levelName(index: number): string {
  return LEVEL_NAMES[index] ?? String(index);
}
