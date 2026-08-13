/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/gallery.tsx
 *
 * 思考面板设计画廊（demo 装配面）。
 *
 * 左侧：当前选中的 design 面板按 `PickerModel` 实时渲染（可交互：←/→ 切档、
 * Tab/Space 切 Auto、Enter 确认、Esc 关闭、Space 打开）。
 * 右侧：design 元数据（id / name / tag / summary）+ 控制提示。
 *
 * 纯演示；复用 `_contract.ts` 的 `reducePickerModel` 纯函数驱动模型态。
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

/** 左侧面板占宽（demo 屏左栏）。 */
const PANEL_COLS = 62;

/** 底部控制提示行（对应 useKeyboard 绑定的键）。 */
const GALLERY_HINT =
  "[1-9] 跳设计 · [+/-] 上下翻(19版) · [←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 关闭 · [q] 退出";

/** 触发左侧面板的模型态变化（键 → 模型事件）。 */
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
    open: true, // 打开即展示
  });

  const design = THINKING_DESIGNS[designIndex]!;

  useKeyboard((e) => {
    if (e.name === "q" && !e.ctrl && !e.meta) {
      onQuit();
      return;
    }
    // 设计切换：数字 1-9 直接跳；+ 下一版 / - 上一版（循环到 15）
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
    // picker 键事件
    const event = keyToPickerEvent(e.name ?? "");
    if (event !== null) {
      setModel((m) => reducePickerModel(m, event));
    }
  });

  const leftCols = Math.min(PANEL_COLS, cols - 2);

  return (
    <box flexDirection="column" width={cols} marginTop={1}>
      {/* 顶部设计序号 / 总览条 */}
      <text fg={pal.dim}>
        {`设计 ${designIndex + 1} / ${THINKING_DESIGNS.length}`}
      </text>

      <box flexDirection="row" gap={2} marginTop={1}>
        {/* 左栏：当前 design 面板 */}
        <box width={leftCols} flexDirection="column">
          <design.render model={model} cols={leftCols} />
        </box>

        {/* 右栏：design 元数据 */}
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

      {/* 底部控制提示 */}
      <box marginTop={1}>
        <text fg={pal.dim}>{GALLERY_HINT}</text>
      </box>
    </box>
  );
}

/** EFFORT_LEVELS 短名（demo 展示用）。 */
const LEVEL_NAMES = ["low", "medium", "high", "xhigh", "max"] as const;
function levelName(index: number): string {
  return LEVEL_NAMES[index] ?? String(index);
}
