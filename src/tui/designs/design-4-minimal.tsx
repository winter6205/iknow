/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-4-minimal.tsx
 *
 * Design #4 — 极简扁平风（接近 Claude Code / Linear 风味）。
 *
 * 视觉纪律：
 *  - 几乎无装饰：单色 `pal.text`（正文）+ `pal.running`（焦点金）+ `pal.dim`（次级）。
 *  - 不画块字符 / 圆点 / `[]` 装饰：纯文本档位名 + `>` 字符前缀。
 *  - Auto 行用 `[auto]` / `[manual]` 文本态开关，无圆点。
 *  - 顶/底各 1 行水平线（box `border` = `["top","bottom"]`，`borderStyle="single"`）。
 *  - 整体留白大：paddingX=2，行间用 flex gap=1。
 *
 * 动效（仅 1 个）：
 *  - 整面板 fade-in：opacity 0 → 1，200ms，ease "inOutQuad"。
 *  - 当前档 `>` 指示切换时横向滑移：translateX 由旧 offset → 新 offset，
 *    150ms，ease "outQuad"。
 *
 * 动效挂钩说明（translateX 这条线）：
 *  - `useRef<TextRenderable>(null)` 拿到 `>` 指示 `<text>` 的 Renderable 实例
 *    （OpenTUI `<text ref>` 走的是与 `<scrollbox ref>` 同样的 reconciler 路径，
 *    详见 chat-view.tsx sbRef 模式）。
 *  - `useTimeline` 每次 render 会 `new Timeline(options)` 出一个新实例，但只
 *    在 mount effect 里注册第一个到 engine（@opentui/react/index.js:136）。该
 *    模型在「动画一次性、mount 期 add」时没问题，但本设计 `>` 滑移需要每次
 *    currentIndex 变化时 `timeline.add(...)` —— 新 render 的 slideTimeline 实
 *    例未被注册、`engine.update` 不会推进它，动画静默失败。
 *    因此 slide/fade 两条 Timeline 都用 `useRef` 懒创建（保持同一实例），在
 *    独立 mount effect 里 `engine.register(timeline)` 注册，unmount 时
 *    `pause()` + `unregister()` 清理。
 *  - 触发链：currentIndex 变化 → `useEffect` 跑 → `slideRef.current.resetItems()`
 *    清旧动画 → `slideRef.current.add(indicatorRef.current, { translateX:
 *    newX, duration: 150, ease: "outQuad" })` 推入新动画 → `play()` 启动。
 *    Timeline 调度器每帧 `engine.update(deltaTime)` → `timeline.update` → 写
 *    target 的 `translateX` setter（OpenTUI Renderable 支持 set translateX）
 *    → 推进直到 `currentTime >= duration` 触发 `onComplete`。
 *  - fade-in 走另一条 Timeline：mount 时 `add(panelRef.current, { opacity: 1,
 *    duration: 200, ease: "inOutQuad" })`，初始 `opacity={0}` 由 container prop
 *    给出。
 *  - translateX 公式：`levelOffset(i)`（按字符数累加前序档位宽 + GAP）让
 *    `>` 精准落在当前档名字前 1 格（rest 态 `>` 在 x=0、prefix 1 空格、档位
 *    起始 x=2，故 `>` 目标 = levelOffset(i) ↔ result `> medium` 中间 1 空格）。
 *
 * 边框方案：box `border={["top","bottom"]}` + `borderStyle="single"` +
 * `borderColor={pal.border}`。左/右不画，只留顶/底水平线（OpenTUI BoxRenderable
 * 支持 `border: BorderSides[]` 只画指定边）。
 */
import { useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  BoxRenderable,
  TextAttributes,
  TextRenderable,
  Timeline,
  engine,
} from "@opentui/core";
import { tuiPalette } from "../theme.js";
import { EFFORT_LEVELS } from "./_contract.js";
import type {
  PickerModel,
  ThinkingDesign,
  ThinkingDesignProps,
} from "./_contract.js";

/** 档位之间用 3 空格分隔（与 brief 字面 "low   medium..." 对齐）。 */
const GAP = "   ";

/** 当前档 `>` 字符前缀的渲染色（autoOn 时无 `>`，回退 dim 灰占位 1 格）。 */
function indicatorColor(model: PickerModel): string {
  return model.autoOn ? tuiPalette.dim : tuiPalette.running;
}

/** 档位名之间的累计横向偏移（按字符数计算 `>` 该落到哪一格）。 */
function levelOffset(index: number): number {
  let x = 0;
  for (let k = 0; k < index && k < EFFORT_LEVELS.length; k++) {
    x += (EFFORT_LEVELS[k] ?? "").length + GAP.length;
  }
  return x;
}

function Panel(props: ThinkingDesignProps): ReactNode {
  const { model } = props;

  // 两条独立 timeline：fade-in 一次性（autoplay=true），slide 每次 currentIndex
  // 变化重置重放（autoplay=false）。useRef 懒创建保持同一实例，绕过
  // useTimeline 每次 render 换实例的坑。
  const fadeTimelineRef = useRef<Timeline | null>(null);
  const slideTimelineRef = useRef<Timeline | null>(null);

  if (fadeTimelineRef.current === null) {
    fadeTimelineRef.current = new Timeline({ autoplay: false });
  }
  if (slideTimelineRef.current === null) {
    slideTimelineRef.current = new Timeline({ autoplay: false });
  }

  // mount 时把两条 timeline 注册到 engine；unmount 反注册。
  useEffect(() => {
    const fade = fadeTimelineRef.current;
    const slide = slideTimelineRef.current;
    if (fade) engine.register(fade);
    if (slide) engine.register(slide);
    return () => {
      if (slide) {
        slide.pause();
        engine.unregister(slide);
      }
      if (fade) {
        fade.pause();
        engine.unregister(fade);
      }
    };
  }, []);

  const panelRef = useRef<BoxRenderable | null>(null);
  const indicatorRef = useRef<TextRenderable | null>(null);

  // 入场 fade-in：mount 推一条 opacity 0 → 1。
  useEffect(() => {
    if (!panelRef.current || !fadeTimelineRef.current) return;
    const fade = fadeTimelineRef.current;
    fade.resetItems();
    fade.add(panelRef.current, {
      opacity: 1,
      duration: 200,
      ease: "inOutQuad",
    });
    fade.play();
  }, [fadeTimelineRef]);

  // 当前档切换时 `>` 横向滑移（`>` 绑定 currentIndex；focusIndex 走 BOLD）。
  useEffect(() => {
    if (!indicatorRef.current || !slideTimelineRef.current) return;
    const slide = slideTimelineRef.current;
    slide.resetItems();
    slide.add(indicatorRef.current, {
      translateX: levelOffset(model.currentIndex),
      duration: 150,
      ease: "outQuad",
    });
    slide.play();
  }, [model.currentIndex, slideTimelineRef]);

  const autoLabel = model.autoOn ? "[auto]" : "[manual]";
  const hint = "tab toggle auto · arrows change · enter confirm · esc cancel";

  return (
    <box
      ref={panelRef}
      width="100%"
      flexDirection="column"
      paddingX={2}
      gap={1}
      border={["top", "bottom"]}
      borderStyle="single"
      borderColor={tuiPalette.border}
      opacity={0}
    >
      <text attributes={TextAttributes.BOLD} fg={tuiPalette.text}>
        Thinking
      </text>

      <text>
        <span fg={tuiPalette.dim}>Auto </span>
        <span fg={model.autoOn ? tuiPalette.running : tuiPalette.text}>
          {autoLabel}
        </span>
      </text>

      <box width="100%" flexDirection="row">
        <text ref={indicatorRef} fg={indicatorColor(model)}>
          {model.autoOn ? " " : ">"}
        </text>
        <text fg={tuiPalette.text}> </text>
        {EFFORT_LEVELS.map((level, i) => (
          <text
            key={level}
            fg={i === model.focusIndex ? tuiPalette.running : tuiPalette.text}
            attributes={
              i === model.focusIndex ? TextAttributes.BOLD : TextAttributes.NONE
            }
          >
            {level}
            {i < EFFORT_LEVELS.length - 1 ? GAP : ""}
          </text>
        ))}
      </box>

      <text fg={tuiPalette.dim}>{hint}</text>
    </box>
  );
}

/** Re-export a stable ReactElement wrapper so the render field matches the
 *  contract's `ReactElement` return type (OpenTUI JSX namespace declares
 *  Element = ReactNode, so a plain JSX expression is ReactNode, not ReactElement). */
export const design4: ThinkingDesign = {
  meta: {
    id: "design-4-minimal",
    name: "极简扁平风",
    tag: "Minimal Flat",
    summary: "无装饰、单色、留白大，仅 1 个动效：当前档指示横向滑移。",
  },
  render: (props) => (<Panel {...props} />) as ReactElement,
};
