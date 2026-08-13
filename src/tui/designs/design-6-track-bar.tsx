/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-6-track-bar.tsx
 *
 * Thinking 面板 · 6 版设计：连续渐高 track + 滑块（glass gradient 基调）。
 *
 * 设计要点
 *  - 整条连续 progress bar：8 格渐高（▁→█）→ 4 格 █ 平顶 → 8 格渐低（█→▁）
 *    的对称梯形（width 数值插值：`trackGrowth: 0→1`，cells 显示前
 *    `round(w * N)` 个，整条从 0 宽"生长"）。
 *  - 入场（400ms outExpo）：track 生长 → 完成后滑块从 x=0 淡入 + 200ms
 *    outQuad 滑到初始档位，再 140ms outBack 微回弹"卡到位"。
 *  - 切档动效：滑块 translateX 200ms outQuad 平滑滑动；到位后轻微 outBack
 *    回弹"卡到位"。translateX 直接由 timeline 写入 Renderable 的
 *    `set translateX(value)`（`ref.current.translateX` 是 Renderable 的
 *    setter，captureInitialValues→applyAnimationAtProgress 每帧
 *    `target[key] = newValue` 触发 setter，无需 React state）。
 *  - 滑块所在段进度条最亮：每 cell 亮度
 *      `b = exp(-((cell - sliderX)/sigma)^2)`，σ = N/4；色彩
 *    `mixHex(pal.dim, pal.running, b)`，档位切换时亮度带跟着滑块移动。
 *  - Auto 圆点 ◐/◑（开/关），dot mix 200ms outExpo 切色 dim ↔ running。
 *  - 边框流光（8s linear 循环）：pal.logoInk → pal.running → pal.logoGold
 *    → pal.running 四相位，相邻相位 RGB 插值近似"光带流过边框"。
 *    Timeline duration 取 INFINITE_MS（1h）避免 timeline.loop 触发
 *    resetItems 重捕获 initialValues 导致相位冻结的陷阱（见设计 3/5）。
 *  - Auto 联动：开 auto 时滑块淡出（Renderable.opacity → 0，150ms
 *    outQuad），整条进度条转 pal.dim；关 auto 时滑块淡回 opacity=1 并
 *    从当前位置滑到 currentIndex 对应位置（200ms outQuad + outBack）。
 *  - 颜色纪律：仅用 pal.dim/pal.running/pal.logoInk/pal.logoGold/pal.text，
 *    未新增任何颜色常量。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { TextRenderable, Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

// ── track 形态 ────────────────────────────────────────────────────────
/** 渐高 unicode block（▁→█，高度 1..8）。 */
const RAMP = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
/** 渐低 unicode block（█→▁，高度 8..1）。 */
const FALL = ["█", "▇", "▆", "▅", "▄", "▃", "▂", "▁"] as const;
/** 梯形平顶 `█` × N。 */
const PLATEAU = ["█", "█", "█", "█"] as const;
/** 整条 track：`▁▂▃▄▅▆▇█` → `████` → `█▇▆▅▄▃▂▁`，共 20 cells。 */
const TRACK: ReadonlyArray<string> = [...RAMP, ...PLATEAU, ...FALL];
const CELL_COUNT = TRACK.length;

// ── 时长 / easing ─────────────────────────────────────────────────────
/** 入场 track 生长（outExpo，OpenTUI 无 inOutExpo → outExpo）。 */
const ENTRY_GROW_MS = 400;
/** 切档主滑动（outQuad）。 */
const SLIDE_MAIN_MS = 200;
/** 切档到位回弹（outBack）。 */
const SLIDE_BOUNCE_MS = 140;
/** 回弹向左预推距离（cell）。 */
const SLIDE_BOUNCE_PUSH = 1.5;
/** 边框流光整角周期（8s linear 循环）。 */
const BORDER_CYCLE_MS = 8000;
/** Auto 圆点切色。 */
const DOT_TWEEN_MS = 200;
/** Auto on/off 时滑块淡入/淡出。 */
const SLIDER_FADE_MS = 150;
/** 初始淡入 + 滑入衔接。 */
const INTRO_FADE_MS = 120;
/** timeline duration 给够大避免 loop reset 陷阱。 */
const INFINITE_MS = 3_600_000;

// ── 边框流光 4 相位 ───────────────────────────────────────────────────
const FLOW_STOPS: ReadonlyArray<string> = [
  tuiPalette.logoInk,
  tuiPalette.running,
  tuiPalette.logoGold,
  tuiPalette.running,
];

// ── 颜色工具（hexToRgb / rgbToHex / mixHex） ──────────────────────────
interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}
function hexToRgb(hex: string): Rgb | null {
  if (hex.length !== 7 || hex[0] !== "#") return null;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}
function rgbToHex({ r, g, b }: Rgb): string {
  const c = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mixHex(a: string, b: string, t: number): string {
  const aa = hexToRgb(a);
  const bb = hexToRgb(b);
  if (aa === null || bb === null) return a;
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex({
    r: aa.r + (bb.r - aa.r) * k,
    g: aa.g + (bb.g - aa.g) * k,
    b: aa.b + (bb.b - aa.b) * k,
  });
}
/** 由 phase（实数 0..FLOW_STOPS.length）查表 + 与下一档 mix，输出 borderColor。 */
function flowBorderColor(phase: number): string {
  const phases = FLOW_STOPS.length;
  const idx = Math.floor(phase);
  const f = Math.max(0, Math.min(1, phase - idx));
  const a = FLOW_STOPS[((idx % phases) + phases) % phases] ?? FLOW_STOPS[0]!;
  const b =
    FLOW_STOPS[(((idx + 1) % phases) + phases) % phases] ?? FLOW_STOPS[0]!;
  return mixHex(a, b, f);
}

/** 5 档 → track cell 位置（0..CELL_COUNT-1，含小数）。 */
function levelCellPos(levelIndex: number): number {
  const last = EFFORT_LEVELS.length - 1;
  if (last <= 0) return 0;
  return (levelIndex / last) * (CELL_COUNT - 1);
}

/** 高斯衰减亮度（slider 所在段最亮）。σ=N/4。 */
function cellBrightness(cellIdx: number, sliderX: number): number {
  const sigma = CELL_COUNT / 4;
  const d = cellIdx - sliderX;
  return Math.exp(-((d / sigma) * (d / sigma)));
}

// ── 组件 ──────────────────────────────────────────────────────────────
function TrackBarRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model } = props;
  const autoOn = model.autoOn;
  const currentIndex = model.currentIndex;

  // useTimeline 每 render new Timeline，但 mount effect 只注册首实例。
  // 锁首实例复用，避免后续 .add() 落到未注册的 Timeline 上（见设计 5）。
  const initialTimeline = useTimeline({
    duration: INFINITE_MS,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  // ── 派生 ref（被 timeline 原地改写，force 后读到最新） ──
  const trackGrowthRef = useRef<{ w: number }>({ w: 0 });
  const sliderXRef = useRef<{ x: number }>({
    x: levelCellPos(currentIndex),
  });
  const dotMixRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const slideTokenRef = useRef<number>(0);
  const modelRef = useRef(model);
  modelRef.current = model;

  const [borderPhase, setBorderPhase] = useState(0);
  // force 用于驱动 ref → re-render 同步（border / dot mix / sliderX 派生）。
  const [, force] = useState(0);

  const sliderRenderableRef = useRef<TextRenderable | null>(null);

  // ── 取消指定属性上的 pending animations（避免叠加 / 冲突） ──
  const cancelSliderAnim = (props: ReadonlyArray<string>): void => {
    const slider = sliderRenderableRef.current;
    if (!slider) return;
    tl.items = tl.items.filter(
      (item) =>
        !(
          item.type === "animation" &&
          item.target.includes(slider) &&
          props.some((p) => p in (item.properties ?? {}))
        )
    );
  };

  // ── 滑到目标档位：outQuad 200ms → outBack 140ms 微回弹 ──
  const slideTo = (pos: number): void => {
    const slider = sliderRenderableRef.current;
    if (!slider) return;
    cancelSliderAnim(["translateX"]);
    const token = ++slideTokenRef.current;
    const bumpX = (): void => {
      const x = slider.translateX;
      sliderXRef.current.x = x;
      force((n) => n + 1);
    };
    tl.once(slider, {
      translateX: pos,
      duration: SLIDE_MAIN_MS,
      ease: "outQuad",
      onUpdate: bumpX,
      onComplete: () => {
        if (token !== slideTokenRef.current) return;
        const startX = Math.max(0, pos - SLIDE_BOUNCE_PUSH);
        if (startX === pos) return; // pos=0：无可回弹空间
        slider.translateX = startX;
        tl.once(slider, {
          translateX: pos,
          duration: SLIDE_BOUNCE_MS,
          ease: "outBack",
          onUpdate: bumpX,
        });
      },
    });
  };

  // ── mount：边框流光（item loop ∞）+ track 生长 + 初始 slider 状态 ──
  useEffect(() => {
    const initialAutoOn = modelRef.current.autoOn;
    const initialIndex = modelRef.current.currentIndex;

    // 边框相位 0 → FLOW_STOPS.length，infinite loop，linear。timeline duration
    // 1h 不触发 timeline.loop reset；item-level loop:true 让 phase 自身循环。
    const phaseTarget = { phase: 0 };
    tl.add(phaseTarget, {
      phase: FLOW_STOPS.length,
      duration: BORDER_CYCLE_MS,
      ease: "linear",
      loop: true,
      onUpdate: () => {
        const next = phaseTarget.phase;
        setBorderPhase((prev) => (prev === next ? prev : next));
      },
    });

    // 初始 sliderX 与初始生长。
    sliderXRef.current.x = levelCellPos(initialIndex);

    // mount 即隐藏 slider（autoOn 初始态）。
    const slider = sliderRenderableRef.current;
    if (slider && initialAutoOn) {
      slider.opacity = 0;
    }

    // track 生长 0 → 1（outExpo）。
    const growTarget = trackGrowthRef.current;
    growTarget.w = 0;
    tl.once(growTarget, {
      w: 1,
      duration: ENTRY_GROW_MS,
      ease: "outExpo",
      onUpdate: () => force((n) => n + 1),
      onComplete: () => {
        // 入场后：手动档 → 淡入 + 滑到当前档；auto 档 → slider 保持隐藏。
        if (modelRef.current.autoOn) return;
        const s = sliderRenderableRef.current;
        if (!s) return;
        s.opacity = 0;
        // 淡入 + 滑入并发：opacity 0→1 同时 translateX 0→initialPos。
        cancelSliderAnim(["translateX", "opacity"]);
        const token = ++slideTokenRef.current;
        tl.once(s, {
          opacity: 1,
          duration: INTRO_FADE_MS,
          ease: "outQuad",
        });
        tl.once(s, {
          translateX: levelCellPos(modelRef.current.currentIndex),
          duration: SLIDE_MAIN_MS,
          ease: "outQuad",
          onUpdate: () => {
            sliderXRef.current.x = s.translateX;
            force((n) => n + 1);
          },
          onComplete: () => {
            if (token !== slideTokenRef.current) return;
            const pos = levelCellPos(modelRef.current.currentIndex);
            const startX = Math.max(0, pos - SLIDE_BOUNCE_PUSH);
            if (startX === pos) return;
            s.translateX = startX;
            tl.once(s, {
              translateX: pos,
              duration: SLIDE_BOUNCE_MS,
              ease: "outBack",
              onUpdate: () => {
                sliderXRef.current.x = s.translateX;
                force((n) => n + 1);
              },
            });
          },
        });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl]);

  // ── dot ◐/◑ 切色：autoOn 变化 → dim ↔ running ──
  useEffect(() => {
    const target = dotMixRef.current;
    const currentMix = target.mix;
    const targetMix = autoOn ? 1 : 0;
    if (currentMix === targetMix) return;
    tl.once(target, {
      mix: targetMix,
      duration: DOT_TWEEN_MS,
      ease: "outExpo",
      onUpdate: () => force((n) => n + 1),
    });
  }, [autoOn, tl]);

  // ── autoOn 切换：slider 淡入/淡出 ──
  useEffect(() => {
    const slider = sliderRenderableRef.current;
    if (!slider) return;
    cancelSliderAnim(["opacity"]);
    if (autoOn) {
      tl.once(slider, {
        opacity: 0,
        duration: SLIDER_FADE_MS,
        ease: "outQuad",
      });
    } else {
      // 手动档：先把 slider opacity 拉回 1（若仍是 0），并滑到当前档位。
      tl.once(slider, {
        opacity: 1,
        duration: INTRO_FADE_MS,
        ease: "outQuad",
      });
      slideTo(levelCellPos(modelRef.current.currentIndex));
    }
  }, [autoOn, tl]);

  // ── 切档：currentIndex 变化 → slideTo ──
  useEffect(() => {
    if (modelRef.current.autoOn) return;
    slideTo(levelCellPos(currentIndex));
  }, [currentIndex, tl]);

  // ── 派生（render 读取 refs） ──
  const grow = Math.max(0, Math.min(1, trackGrowthRef.current.w));
  const visibleCells = Math.max(
    0,
    Math.min(CELL_COUNT, Math.round(grow * CELL_COUNT))
  );
  const sliderX = sliderXRef.current.x;
  const dotGlyph = autoOn ? "◐" : "◑";
  const dotColor = mixHex(pal.dim, pal.running, dotMixRef.current.mix);
  const sliderColor = pal.running;
  const autoDesc = autoOn ? "自适应档位" : "手动档位";

  // ── render ──
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      gap={1}
    >
      {/* 标题 */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
      </text>

      {/* Auto 行 */}
      <text>
        <span fg={dotColor}>{`${dotGlyph}  `}</span>
        <span fg={pal.dim}>AUTO</span>
        <span fg={pal.dim}>{`  ·  ${autoDesc}`}</span>
      </text>

      {/* 滑块行：独立行；dot 的 translateX 由 timeline 写入 Renderable。 */}
      <box height={1}>
        <text
          ref={sliderRenderableRef}
          fg={sliderColor}
          attributes={TextAttributes.BOLD}
        >
          ●
        </text>
      </box>

      {/* track：整条渐高 block（生长中的 cell 数 = visibleCells）。 */}
      <text wrapMode="none">
        {TRACK.slice(0, visibleCells).map((cell, idx) => {
          const color = autoOn
            ? pal.dim
            : mixHex(pal.dim, pal.running, cellBrightness(idx, sliderX));
          return (
            <span key={`cell-${idx}`} fg={color}>
              {cell}
            </span>
          );
        })}
      </text>

      {/* 档位名 */}
      <text>
        {EFFORT_LEVELS.map((level, i) => {
          const isCurrent = i === currentIndex;
          return (
            <span
              key={level}
              fg={isCurrent ? pal.running : pal.dim}
              attributes={isCurrent ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {`${level}${i < EFFORT_LEVELS.length - 1 ? "  " : ""}`}
            </span>
          );
        })}
      </text>

      {/* 键位提示 */}
      <text fg={pal.dim}>
        {"[← →] 切档  ·  [Tab/Space] 切 Auto  ·  [Enter] 确认  ·  [Esc] 取消"}
      </text>
    </box>
  );
}

export const design6: ThinkingDesign = {
  meta: {
    id: "design-6-track-bar",
    name: "连续渐高条",
    tag: "Continuous Track",
    summary: "整条渐高 block + 滑块滑动 + 流光联动 + 圆角流光边框",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    TrackBarRender(props) as unknown as ReactElement,
};
