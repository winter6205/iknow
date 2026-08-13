/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-1-restrained.tsx
 *
 * 思考面板 · 5 版设计之 1：克制商务风（Restrained Business，demo gallery 候选）。
 *
 * 视觉纪律：
 *  - 单色强调：`pal.running` 金 + `pal.dim` 灰层次 + `pal.accent` 白；不引入
 *    渐变色阶，颜色过渡只走 opacity 叠印（Auto 圆点 ● 金 ↔ ○ 灰）。
 *  - 圆角边框 `borderStyle="rounded"`（与全 TUI 圆角线框体系一致）：
 *    `pal.border` 灰 idle，`pal.running` 金 焦点（model.open）。
 *  - 动效克制，100–250ms，无弹跳 / 无弹性 / 无循环脉冲：
 *      · 面板入场 fade：opacity 0 → 1，150ms，ease "inOutQuad"；
 *      · Enter 确认时金锚点滑动：translateX 由旧 currentIndex 位 → 新位，
 *        200ms，ease "outQuad"；金锚点是稳定状态指示，焦点游标
 *        `pal.accent` BOLD 仅反映 focusIndex，不参与滑动（正交）；
 *      · Auto 圆点开/关颜色渐变：● 金 ↔ ○ 灰，150ms，ease "inOutSine"。
 *
 * 动效挂钩（学习 design-4-minimal 的 ref 懒创建 + engine.register 模型）：
 *  - `useTimeline` 每次 render 都 new 一个 Timeline 实例，但只把第一个注册
 *    到 engine（@opentui/react index.js useTimeline）；后续 render 产生的
 *    实例未注册、engine.update 不会推进，动画静默失败。因此三条 timeline
 *    全部用 `useRef` 懒创建（保持同一实例），mount effect 里
 *    `engine.register`，unmount 时 `pause + unregister`（cancel-on-close）。
 *  - 金锚点：absolute `<box>` + translateX。translateX **绝不**作为 React
 *    prop（reconciler 每次 re-render 会用旧值覆盖 setter），仅由 mount
 *    时的 imperative 赋值与 timeline 的 `add({translateX: target})` 驱动。
 *  - 面板 fade-in：target = 整面板 `BoxRenderable.opacity`（Renderable 原生
 *    支持，setter 在 chunk-node-0yw3x5m7.js）。panel `<box>` 用 `opacity={0}`
 *    作初始 prop；timeline 每帧写入新值。reconciler 只在新旧 prop 不等时才
 *    set（updateProperties），所以 fade 期间 React 不会重置 opacity（详见
 *    chunk-5mwd1gcw.js updateProperties diff）。
 *  - Auto 圆点：`<text opacity={dotBlend}>` 包裹两个 `<span>`：● 金 + ○ 灰；
 *    text 的 opacity 走 React state，timeline 的 onUpdate 用 `animation.progress`
 *    （已是 ease 处理后 [0,1]，Timeline.d.ts）`setDotBlend` 驱动 state →
 *    React re-render → 叠印渐变。无需 mixHex 颜色插值。
 *
 * 面板结构（7 行）：圆角边框（顶/底各 1 行）+ 标题 THINKING + Auto 行 +
 * 档位行（5 档横排 + 金锚点 `▸ 档 ◂` 绝对定位叠加）+ 档位可视化条
 * `▁▂▃▄▅▆▇█`（8 格，当前档段金）+ 键位提示行。元素 1/7 同体 —— 圆角
 * 边框的顶行与底行就是上下边框，5 条内容行填在中间。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { KeyEvent } from "@opentui/core";
import { BoxRenderable, TextAttributes, Timeline, engine } from "@opentui/core";
import { tuiPalette } from "../theme.js";
import { EFFORT_LEVELS } from "./_contract.js";
import type {
  PickerEvent,
  PickerModel,
  ThinkingDesign,
  ThinkingDesignProps,
} from "./_contract.js";

/** 面板入场 fade 时长（inOutQuad）。 */
const FADE_MS = 150;
/** Enter 确认金锚点滑动时长（outQuad）。 */
const SLIDE_MS = 200;
/** Auto 圆点开/关颜色渐变时长（inOutSine）。 */
const DOT_MS = 150;

/** 8 格渐高 unicode block（低→高）。 */
const BLOCKS: ReadonlyArray<string> = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** 档位名展示标签（把 `xhigh` 拆成可读的 `x-high`）。 */
const LEVEL_LABELS: ReadonlyArray<string> = EFFORT_LEVELS.map((level) =>
  level === "xhigh" ? "x-high" : level
);

/** 键位提示行（dot 分隔）。 */
const HINT: string = "←/→ 档位 · Tab/Space Auto · Enter 确认 · Esc 取消";

/**
 * 当前档的可视化条金色段（4 块滑窗；5 档 × 4 块 ≈ 8 格）。
 * from/to 为 0-based 闭区间，且 to 钳制到 7（即 BLOCKS.length-1）。
 */
function goldSegment(currentIndex: number): {
  readonly from: number;
  readonly to: number;
} {
  const clamped = Math.max(0, Math.min(EFFORT_LEVELS.length - 1, currentIndex));
  const from = clamped;
  const to = Math.min(BLOCKS.length - 1, clamped + 3);
  return { from, to };
}

/**
 * 档位锚点绝对定位 X（相对档位行 content-start）。
 * 行结构：`"  " + labels.join("  ") + "  "`（两端 2 格 phantom margin），
 * 把 `▸ name ◂` 锚点恰好落在 `sep + name + sep` 的三段：前缀 2 格占左
 * sep、`name` 占中、后缀 2 格占右 sep。首尾锚的 X = sum_{j<k}(len(j)+2)；
 * 5 档分别落在 0 / 5 / 13 / 19 / 27（见 LEVEL_LABELS 长度）。
 */
function anchorX(currentIndex: number): number {
  const clamped = Math.max(0, Math.min(EFFORT_LEVELS.length - 1, currentIndex));
  let x = 0;
  for (let j = 0; j < clamped; j++) {
    x += (LEVEL_LABELS[j] ?? "").length + 2;
  }
  return x;
}

/** 面板主组件：hooks（3 条懒创建 timeline + mount 注册）+ 渲染。 */
function Panel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // refs —— 见文件头说明，translateX 仅由 imperative 赋值 + timeline 驱动。
  const panelRef = useRef<BoxRenderable | null>(null);
  const anchorRef = useRef<BoxRenderable | null>(null);
  const fadeTlRef = useRef<Timeline | null>(null);
  const slideTlRef = useRef<Timeline | null>(null);
  const dotTlRef = useRef<Timeline | null>(null);
  if (fadeTlRef.current === null)
    fadeTlRef.current = new Timeline({ autoplay: false });
  if (slideTlRef.current === null)
    slideTlRef.current = new Timeline({ autoplay: false });
  if (dotTlRef.current === null)
    dotTlRef.current = new Timeline({ autoplay: false });

  // Auto 圆点叠印进度 [0,1]：● 在上（opacity = dotOn），○ 在下常显。
  const [dotOn, setDotOn] = useState<number>(autoOn ? 1 : 0);

  // mount/unmount：注册三条 timeline、定位初始锚点、推入场 fade；
  // cleanup 全部反注册（cancel-on-close）。
  useEffect(() => {
    const fade = fadeTlRef.current;
    const slide = slideTlRef.current;
    const dot = dotTlRef.current;
    if (fade) engine.register(fade);
    if (slide) engine.register(slide);
    if (dot) engine.register(dot);

    if (anchorRef.current) {
      anchorRef.current.translateX = anchorX(model.currentIndex);
    }
    if (panelRef.current && fade) {
      fade.resetItems();
      fade.add(panelRef.current, {
        opacity: 1,
        duration: FADE_MS,
        ease: "inOutQuad",
      });
      fade.play();
    }

    return () => {
      if (fade) {
        fade.pause();
        engine.unregister(fade);
      }
      if (slide) {
        slide.pause();
        engine.unregister(slide);
      }
      if (dot) {
        dot.pause();
        engine.unregister(dot);
      }
    };
    // 仅 mount/unmount；model 不进 deps。
  }, []);

  // Enter 确认金锚点滑动：currentIndex 变化 → 200ms outQuad 滑到 anchorX。
  // 不动 focusIndex（焦点游标是白色 BOLD，由下方 spans 直接渲染）。
  const prevIndexRef = useRef<number>(model.currentIndex);
  useEffect(() => {
    const anchor = anchorRef.current;
    const tl = slideTlRef.current;
    if (!anchor || !tl) return;
    if (prevIndexRef.current === model.currentIndex) return;
    prevIndexRef.current = model.currentIndex;
    tl.resetItems();
    tl.add(anchor, {
      translateX: anchorX(model.currentIndex),
      duration: SLIDE_MS,
      ease: "outQuad",
    });
    tl.play();
  }, [model.currentIndex]);

  // Auto 圆点颜色渐变：autoOn 切换 → 150ms inOutSine，dotOn 0↔1。
  const prevAutoRef = useRef<boolean>(model.autoOn);
  useEffect(() => {
    const tl = dotTlRef.current;
    if (!tl) return;
    if (prevAutoRef.current === model.autoOn) return;
    prevAutoRef.current = model.autoOn;
    tl.resetItems();
    tl.add(
      { t: 0 },
      {
        t: 1,
        duration: DOT_MS,
        ease: "inOutSine",
        onUpdate: (a) => setDotOn(a.targets[0].t),
      }
    );
    tl.play();
  }, [model.autoOn]);

  const seg = goldSegment(currentIndex);
  const showAnchor =
    !autoOn && currentIndex >= 0 && currentIndex < EFFORT_LEVELS.length;
  const focusedNameIsCurrent = showAnchor && focusIndex === currentIndex;
  const borderColor = open ? pal.running : pal.border;
  const curLabel = LEVEL_LABELS[currentIndex] ?? "";

  return (
    <box
      ref={panelRef}
      flexDirection="column"
      borderStyle="rounded"
      borderColor={borderColor}
      paddingX={1}
      opacity={0}
      width={Math.max(1, cols)}
    >
      {/* 标题行 */}
      <text fg={pal.running} attributes={TextAttributes.BOLD}>
        THINKING
      </text>

      {/* Auto 行：●/○ 叠印 + 状态说明 */}
      <box flexDirection="row">
        <text>
          <span>{"Auto  "}</span>
        </text>
        <text opacity={autoOn ? dotOn : 1 - dotOn}>
          <span fg={pal.running} attributes={TextAttributes.BOLD}>
            ●
          </span>
          <span fg={pal.dim}>○</span>
        </text>
        <text fg={pal.dim}>
          {autoOn
            ? "  adaptive (server picks / no concrete effort)"
            : "  concrete effort"}
        </text>
      </box>

      {/* 档位行：5 档横排（首尾 phantom margin 让锚点首尾档不超界） +
         金锚点绝对定位叠加（translateX 由 timeline 驱动） */}
      <box width="100%" flexDirection="row">
        <text wrapMode="none">
          {LEVEL_LABELS.map((label, i) => {
            const isFocused = !autoOn && i === focusIndex;
            return (
              <span
                key={i}
                fg={isFocused ? pal.accent : pal.text}
                attributes={
                  isFocused ? TextAttributes.BOLD : TextAttributes.NONE
                }
              >
                {(i === 0 ? "  " : "  ") + label}
              </span>
            );
          })}
          <span>{"  "}</span>
        </text>
      </box>
      {showAnchor && (
        <box width="100%" flexDirection="row">
          <box ref={anchorRef} position="absolute" left={0}>
            <text
              fg={pal.running}
              attributes={TextAttributes.BOLD}
              wrapMode="none"
            >
              <span>{"▸ "}</span>
              <span
                fg={focusedNameIsCurrent ? pal.accent : pal.running}
                attributes={TextAttributes.BOLD}
              >
                {curLabel}
              </span>
              <span>{" ◂"}</span>
            </text>
          </box>
        </box>
      )}

      {/* 档位可视化条 8 格 */}
      <text wrapMode="none">
        {BLOCKS.map((block, i) => {
          const lit = !autoOn && i >= seg.from && i <= seg.to;
          return (
            <span key={i} fg={lit ? pal.running : pal.dim}>
              {block}
            </span>
          );
        })}
      </text>
      {/* 键位提示（独立行，避免与档位条挤爆窄终端） */}
      <text>
        <span fg={pal.dim}>{HINT}</span>
      </text>
    </box>
  );
}

/** 键路由：本设计不需定制键位（demo 默认覆盖 ←/→/Tab/Space/Enter/Esc）。 */
function reduceKey(_event: KeyEvent, _model: PickerModel): PickerEvent | null {
  return null;
}

export const design1: ThinkingDesign = {
  meta: {
    id: "design-1-restrained",
    name: "克制商务风",
    tag: "Restrained Business",
    summary:
      "低饱和、单色强调、动效 100–250ms 无弹跳。金锚点稳定，焦点白色游标正交。",
  },
  render: ({ model, cols }) =>
    (<Panel model={model} cols={cols} />) as ReactElement,
  reduceKey,
};
