/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-16-bg-flow.tsx
 *
 * Thinking-effort 思考面板 — Design 16：背景渐变流光（BG Gradient Flow）。
 *
 * # 视觉总览
 *  5 档进度条 = bg 渐变流光（logoInk → running → logoGold，按字符位置分段
 *  染色）；进度条上常驻一道"光带"在底色上扫过（shimmer ping-pong），让渐
 *  变像液体一样流动。当前档（currentIndex）通过该档段的 bg={pal.bgRunning}
 *  灰绿反衬 + 下方 ▲ 游标呼吸表示；焦点游标（focusIndex）通过档位名的
 *  `▸ label ◂` running BOLD 包裹表示——两个独立视觉通道互不耦合（满足
 *  「当前档与焦点游标两个独立概念」硬需求）。
 *
 *  Auto 圆点开关两种视觉态：
 *   - 开 ● 绿（pal.add fg + pal.bgAdd bg）
 *   - 关 ● 红（pal.del fg + pal.bgDel bg）—— 用 task 建议的 token pair 营
 *     造「绿 = 自适应，红 = 手动」的色调对比；切换时触发圆点色渐变。
 *  Auto on 时 5 档 disabled：bar 全段去饱和到 pal.border 灰、档位名 dim、
 *  ▲ 隐藏、焦点游标退回到 Auto 圆点（焦点 -1 时不显示）。
 *
 * # OpenTUI 炫酷特性应用
 *  - `<text>` 内逐字符 `<span bg={...}>` 给字符底色（TextNodeOptions 支
 *    持 bg；reconciler 走 default prop 路径把 bg 写到 instance[bg]，参
 *    见 @opentui/react/chunk-5mwd1gcw.js setProperty）。这是本设计的核
 *    心炫酷点。
 *  - 3-stop 线性渐变 `gradAt(t)`：logoInk(0) → running(0.5) → logoGold(1)，
 *    RGB 线性插值（mixHex）。
 *  - shimmer 光：phase 0→1→0 alternate ping-pong，每字符在 base 渐变色上
 *    叠加一道三角窗的"白光"（mixHex(base, pal.accent, glow * 0.6)），制
 *    造「光带扫过背景」流动效果。常驻动效 1。
 *
 * # 动效挂钩（task 约束：常驻 ≤2，触发 ≥1）
 *  - 常驻 1（bg shimmer）：timeline loop duration = SHIMMER_MS * 2，
 *    item loop=true + alternate=true + ease linear，phase 0→1→0 持续来回；
 *    视觉无缝（无 onComplete snap）。onUpdate setPhase。
 *  - 常驻 2（▲ / Auto 焦点脉冲）：timeline loop duration = PULSE_MS * 2，
 *    item loop=true + alternate=true + ease inOutSine，pulse 0→1→0 呼吸；
 *    ▲ 游标 fg = mix(pal.dim, pal.running, pulse)（常驻可视）；Auto 圆
 *    点 mix 在 autoOn 切换时另行触发（不与 pulse 共用，避免重叠预算）。
 *  - 触发 1（切档 flash）：currentIndex 变化 → 当前档段"亮闪"——
 *    flashRef.g tween 0→1→0 over 400ms（outQuad 升 + inOutSine 落），
 *    当前档 bg 从 pal.bgRunning 渐变到 mix(bgRunning, pal.accent, 0.5)。
 *  - 触发 2（Auto 切换渐变）：autoOn 变化 → dotMix 0↔1 渐变（绿↔红），
 *    dotFg = mixHex(pal.add, pal.del, dotMix)，dotBg = mix(bgAdd, bgDel)。
 *  - 共存验证：常驻 shimmer + 常驻 pulse 同时活跃 = 2；触发动效（flash
 *    / dot tween）使用单独 tlTrigger，与常驻 timeline 隔离，互不干扰。
 *
 * # Timeline 引用模式（设计依据见 design-5:124-217）
 *  `useTimeline` 每次 render 都 new 一个 Timeline 实例，但只有首 render
 *  的实例被 useTimeline 内部的 mount effect 注册到 engine 并 play。后续
 *  render 返回的是未注册的 fresh 实例，engine.update 不会推进，动画静默
 *  失败。本组件用 `useRef` 锁住首 render 实例，所有 `.add()` / `.once()`
 *  / `.play()` 都作用在 stable ref 上，避开 hook 引用漂移。
 *
 * # 颜色纪律
 *  所有颜色 100% 来自 `tuiPalette`（theme.ts），未引入任何颜色常量；hex
 *  由 OpenTUI 渲染器按终端能力降级（NO_COLOR 等），应用层不手写 ANSI。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

// ── 常量 ─────────────────────────────────────────────────────────────────
/** bg shimmer 常驻周期（alternate ping-pong 一轮）。 */
const SHIMMER_MS = 2800;
/** ▲ 游标 / Auto 焦点脉冲常驻半周期。 */
const PULSE_MS = 900;
/** 切档 flash 上升 + 下降总时长。 */
const FLASH_UP_MS = 160;
const FLASH_DOWN_MS = 240;
/** Auto 圆点切换 tween 时长。 */
const DOT_TWEEN_MS = 240;

/** Bar 总宽（5 段 × 5 字符 = 25）。 */
const BAR_LEN = 25;
const SEG_LEN = 5;

/** 5 档段标签（与 _contract 的 EFFORT_LEVELS 同序：low/medium/high/xhigh/max）。 */
const LEVEL_LABELS: ReadonlyArray<string> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// ── 颜色工具 ──────────────────────────────────────────────────────────────
/** `#rrggbb` → [r, g, b]∈[0,1]³。非法 hex 回退白。 */
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

/** 两色按 t∈[0,1] 线性混合 → `#rrggbb`。 */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round((ar + (br - ar) * k) * 255);
  const g = Math.round((ag + (bg - ag) * k) * 255);
  const bl = Math.round((ab + (bb - ab) * k) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/**
 * 3-stop 线性渐变 logoInk(0) → running(0.5) → logoGold(1)。
 * 用于 bar 每字符的 base bg 颜色（按字符位置分段染色）。
 */
function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

/**
 * 三角窗光强：pos 在 center 附近时最大，±halfWidth 处为 0。
 * shimmer 光带在 base 渐变色上叠加此函数。
 */
function lightGlow(pos: number, center: number, halfWidth: number): number {
  return Math.max(0, 1 - Math.abs(pos - center) / halfWidth);
}

// ── 渲染组件 ──────────────────────────────────────────────────────────────
function BgFlowRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;
  const levels = EFFORT_LEVELS as readonly EffortLevel[];

  // ── Timeline 实例锁：useTimeline 每次 render new，仅首 render 注册。
  // 三条 timeline：shimmer（bg 流光常驻）、pulse（游标/焦点呼吸常驻）、
  // trigger（切档 flash / Auto 切换触发）。首 render 实例通过 useRef 锁
  // 住，所有 add/once/play 落在引擎持有的 stable ref 上。
  const shimmerFirst = useTimeline({
    duration: SHIMMER_MS * 2,
    loop: true,
  });
  const shimmerRef = useRef<Timeline | null>(null);
  if (shimmerRef.current === null) shimmerRef.current = shimmerFirst;
  const tlShimmer = shimmerRef.current;

  const pulseFirst = useTimeline({
    duration: PULSE_MS * 2,
    loop: true,
  });
  const pulseRef = useRef<Timeline | null>(null);
  if (pulseRef.current === null) pulseRef.current = pulseFirst;
  const tlPulse = pulseRef.current;

  const triggerFirst = useTimeline({
    duration: 1000,
    autoplay: false,
  });
  const triggerRef = useRef<Timeline | null>(null);
  if (triggerRef.current === null) triggerRef.current = triggerFirst;
  const tlTrigger = triggerRef.current;

  // ── 常驻动效 state（每帧 onUpdate setState）
  const [phase, setPhase] = useState(0); // shimmer phase 0..1
  const [pulse, setPulse] = useState(0); // pulse 0..1 alternate

  // ── 触发动效 ref（timeline 直接 mutate ref，force setState 触发重渲）
  const flashRef = useRef<{ g: number }>({ g: 0 });
  const dotRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const [, force] = useState(0);

  // 常驻 1: shimmer phase 0→1→0 alternate loop（无 snap，无缝往返）
  useEffect(() => {
    const target = { p: 0 };
    tlShimmer.add(target, {
      p: 1,
      duration: SHIMMER_MS,
      ease: "linear",
      loop: true,
      alternate: true,
      onUpdate: () => setPhase(target.p),
    });
  }, [tlShimmer]);

  // 常驻 2: pulse 0→1→0 alternate（驱动 ▲ 游标呼吸；与 shimmer 同时活跃）
  useEffect(() => {
    const target = { q: 0 };
    tlPulse.add(target, {
      q: 1,
      duration: PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: () => setPulse(target.q),
    });
  }, [tlPulse]);

  // 触发 1: currentIndex 变化 → 当前档段 flash 0→1→0（亮闪 ~400ms）
  const prevIdxRef = useRef<number>(currentIndex);
  useEffect(() => {
    if (prevIdxRef.current === currentIndex) return;
    prevIdxRef.current = currentIndex;
    flashRef.current.g = 0;
    tlTrigger.resetItems();
    tlTrigger.add(flashRef.current, {
      g: 1,
      duration: FLASH_UP_MS,
      ease: "outQuad",
      onUpdate: () => force((x) => x + 1),
    });
    tlTrigger.add(flashRef.current, {
      g: 0,
      duration: FLASH_DOWN_MS,
      ease: "inOutSine",
      onUpdate: () => force((x) => x + 1),
    });
    tlTrigger.play();
  }, [currentIndex, tlTrigger]);

  // 触发 2: autoOn 变化 → dotMix 0↔1（绿↔红渐变）
  const prevAutoRef = useRef<boolean>(autoOn);
  useEffect(() => {
    if (prevAutoRef.current === autoOn) return;
    prevAutoRef.current = autoOn;
    tlTrigger.resetItems();
    tlTrigger.add(dotRef.current, {
      mix: autoOn ? 1 : 0,
      duration: DOT_TWEEN_MS,
      ease: "inOutSine",
      onUpdate: () => force((x) => x + 1),
    });
    tlTrigger.play();
  }, [autoOn, tlTrigger]);

  // ── 派生：Auto 圆点颜色（绿↔红混合）
  const dotMix = dotRef.current.mix;
  const dotFg = mixHex(pal.add, pal.del, dotMix);
  const dotBg = mixHex(pal.bgAdd, pal.bgDel, dotMix);
  const dotGlyph = autoOn ? "●" : "○";
  const dotLabel = autoOn
    ? "adaptive (server picks effort)"
    : "concrete effort";

  // ── 派生：bar 每字符的 bg / fg
  // shimmer 光带中心（按字符索引 0..BAR_LEN）
  const lightCenter = phase * (BAR_LEN - 1);
  const flashG = flashRef.current.g;
  const curSegStart = currentIndex * SEG_LEN;

  /**
   * 字符 i 的视觉颜色：当前档前段（segment 0..currentIndex-1）= 渐变 +
   * shimmer 流光；当前档段（segment currentIndex）= bgRunning 反衬 + flash
   * 叠加；之后段（segment currentIndex+1..4）= 去饱和 dim。
   */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) {
      // Auto on disabled：全段去饱和
      return { bg: pal.border, fg: pal.dim };
    }
    const segIdx = Math.floor(i / SEG_LEN);
    if (segIdx > currentIndex) {
      // 之后未填充段
      return { bg: pal.border, fg: pal.dim };
    }
    if (segIdx === currentIndex) {
      // 当前档段：bgRunning 灰绿反衬 + flash 叠加
      const lit = mixHex(pal.bgRunning, pal.accent, flashG * 0.55);
      const fg = mixHex(pal.bgRunning, pal.running, flashG);
      return { bg: lit, fg };
    }
    // 已填充渐变段：base 渐变 + shimmer 光带
    const t = i / Math.max(1, BAR_LEN - 1);
    const base = gradAt(t);
    const glow = lightGlow(i, lightCenter, BAR_LEN * 0.32);
    const lit = mixHex(base, pal.accent, glow * 0.6);
    // fg 用 logoInk 暗化，形成"渐变底色 + 暗纹字符"的液体感
    const fg = mixHex(lit, pal.logoInk, 0.5);
    return { bg: lit, fg };
  }

  // ── 派生：档位名行（焦点游标 ▸ ◂ 包裹 + current bg 反衬）
  interface LabelSeg {
    readonly text: string;
    readonly fg: string;
    readonly bg: string | undefined;
    readonly bracket: boolean;
    readonly bold: boolean;
  }
  function labelFor(i: number): LabelSeg {
    const text = LEVEL_LABELS[i] ?? "";
    if (autoOn) {
      return { text, fg: pal.dim, bg: undefined, bracket: false, bold: false };
    }
    const isFocused = i === focusIndex && open;
    const isCurrent = i === currentIndex;
    if (isCurrent && isFocused) {
      return {
        text,
        fg: pal.text,
        bg: pal.bgRunning,
        bracket: true,
        bold: true,
      };
    }
    if (isCurrent) {
      return {
        text,
        fg: pal.running,
        bg: pal.bgRunning,
        bracket: false,
        bold: true,
      };
    }
    if (isFocused) {
      return {
        text,
        fg: pal.running,
        bg: undefined,
        bracket: true,
        bold: true,
      };
    }
    return { text, fg: pal.dim, bg: undefined, bracket: false, bold: false };
  }

  // ── 派生：▲ 游标位置 + 呼吸颜色
  const showCaret = !autoOn && open;
  const caretOffset = curSegStart + Math.floor(SEG_LEN / 2);
  const caretFg = mixHex(pal.dim, pal.running, pulse);

  // ── 键位提示
  const hint = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  return (
    <box flexDirection="column" paddingX={1} paddingY={0}>
      {/* 标题行 */}
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          ◈
        </span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          {"  THINKING  ·  BG FLOW"}
        </span>
        <span fg={pal.dim}>{"  ·  背景渐变流光"}</span>
      </text>

      {/* Auto 行：圆点（绿/红 + bg 同色对）+ AUTO + 状态描述 */}
      <text>
        <span fg={dotFg} bg={dotBg} attributes={TextAttributes.BOLD}>
          {dotGlyph}
        </span>
        <span
          fg={autoOn ? pal.running : pal.dim}
          attributes={TextAttributes.BOLD}
        >
          {"  AUTO"}
        </span>
        <span fg={pal.dim}>{`  ·  ${dotLabel}`}</span>
      </text>

      {/* 档位名行：focusIndex ▸◂ 包裹（焦点游标）；current bgRunning 反衬 */}
      <text>
        {levels.map((_lv, i) => {
          const seg = labelFor(i);
          const displayText = seg.bracket ? `▸ ${seg.text} ◂` : seg.text;
          const sep = i < levels.length - 1 ? "  " : "";
          return (
            <span
              key={i}
              fg={seg.fg}
              bg={seg.bg}
              attributes={seg.bold ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {displayText}
              {sep}
            </span>
          );
        })}
      </text>

      {/* bg 渐变流光条：5 段 × 5 字符，每字符独立 span + bg 染色 */}
      <text>
        {Array.from({ length: BAR_LEN }, (_, i) => {
          const { bg, fg } = colorAt(i);
          return (
            <span key={i} bg={bg} fg={fg}>
              █
            </span>
          );
        })}
      </text>

      {/* ▲ 当前档游标（独立通道；pulse 驱动呼吸；仅 Auto off 时显示） */}
      {showCaret && (
        <text>
          <span fg={pal.dim}>{" ".repeat(Math.max(0, caretOffset))}</span>
          <span fg={caretFg} attributes={TextAttributes.BOLD}>
            ▲
          </span>
          <span fg={pal.dim}>
            {" ".repeat(Math.max(0, BAR_LEN - caretOffset - 1))}
          </span>
        </text>
      )}

      {/* 键位提示 */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

// ── 导出 ──────────────────────────────────────────────────────────────────
export const design16: ThinkingDesign = {
  meta: {
    id: "design-16-bg-flow",
    name: "背景渐变流光",
    tag: "BG Gradient Flow",
    summary:
      "每字符 span bg 染色 + 3-stop 线性渐变 logoInk→running→logoGold + 三角窗 shimmer 光带 ping-pong；当前档 bgRunning 反衬 + ▲ 游标呼吸；焦点游标 ▸◂ 包裹与当前档正交；Auto 圆点绿/红 token pair 切换。",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    (<BgFlowRender {...props} />) as ReactElement,
};
