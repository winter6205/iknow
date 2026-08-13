/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-24-breathing.tsx
 *
 * 思考面板 · Design 24：呼吸填充（design-22 底色变体 B）。
 *
 * 帧结构沿用 design-22（design-5 圆角流光框 + 5 段等宽进度条 + 几何居中标签）：
 *   [圆角边框 borderColor 4 token 循环流光 8000ms]
 *     ◆─ Thinking                ← 标题
 *     ◑  AUTO · 手动档位         ← Auto 圆点 + 描述
 *
 *     ████████████████████      ← 整条呼吸脉冲底色（本设计核心区别）
 *     ████████████████████
 *     ████████████████████
 *
 *     low         medium         high         xhigh        max   ← 5 档标签
 *     [←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消
 *
 * 进度条几何（_geometry.ts 提供，全部 5 段等宽）：
 *   - innerCols = max(5, cols - 4)；barLen = floorTo5BarLen(innerCols)
 *   - 5 段各 segLen = barLen / 5；标签严格居中到段中点
 *
 * 底色（核心区别——"整条呼吸脉冲"，替换 design-22 的 shimmer 浮动光带）：
 *   - 已填充段（[0, currentIndex]）：`mixHex(pal.dim, pal.text, i / filledEnd)`
 *     灰渐变底，乘以全局 breath 亮度系数往 pal.accent mix
 *   - breath 公式：`breath(phase) = 0.5 + 0.5 * sin(2π * phase)`，
 *     phase ∈ [0,1] 由 timeline alternate ping-pong 驱动，周期 T = 3200ms
 *   - 亮度系数 `luma = 0.6 + 0.4 * breath` ∈ [0.6, 1.0]，再 `* 0.7` 往
 *     pal.accent mix，整条已填充段同步呼吸（亮峰时整条偏向 accent 暖白，
 *     暗谷时回退到灰渐变底）
 *   - 当前档段（segIdx === currentIndex）额外 +0.18 亮度往 pal.accent mix，
 *     保证呼吸低谷时仍突出
 *   - 未填充段（currentIndex 之后）/ autoOn：bg = pal.border，fg = pal.dim
 *     （不参与呼吸，保持暗灰轨）
 *   - border 边框流光保留 design-5/22 同款 8000ms 4 相位
 *
 * 颜色纪律：底色仅用 pal.dim / pal.text / pal.accent / pal.border；前景
 * 字符用 logoInk mix 提供对比度（design-22 同款 fg 处理，仅作用在 fg，不
 * 做底色）。
 */
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import { type ThinkingDesign, type ThinkingDesignProps } from "./_contract.js";
import {
  SEG_COUNT,
  floorTo5BarLen,
  labelPad,
  segmentLen,
} from "./_geometry.js";

// ── 常量 ──────────────────────────────────────────────────────────────
/** 边框流光 4 相位周期（design-5/22 同款）。 */
const BORDER_CYCLE_MS = 8_000;
/** 入场动画。 */
const ENTRY_DURATION_MS = 400;
/** Auto 圆点切换渐变。 */
const AUTO_DOT_DURATION_MS = 200;
/** 整条呼吸脉冲：phase 0→1 单程 3200ms，alternate ping-pong 一轮 = 2*3200ms
 *  内 2 个完整 sin 周期；T = 3200ms 即 task 给定的"呼吸"基线周期。 */
const BREATH_MS = 3_200;

// ── 颜色工具 ──────────────────────────────────────────────────────────
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

/** 3-stop 线性渐变 logoInk(0) → running(0.5) → logoGold(1)，design-16 同款。 */
function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

/** 边框流光：相位 p ∈ [0, 4]，相邻 2 相位 RGB 插值（design-5/22 同款）。 */
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

// ── 渲染主组件 ──────────────────────────────────────────────────────
function BreathingRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // ── Timeline 引用（useRef 锁首 render 实例，design-5/22 同款） ──
  const initialTimeline = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  // 呼吸脉冲 timeline：item 层 loop + alternate ping-pong（TimelineOptions
  // 不支持顶层 alternate，与 design-22 shimmer 同款模式；顶层仅提供驱动）
  const breathFirst = useTimeline({
    duration: BREATH_MS,
    loop: true,
  });
  const breathRef = useRef<Timeline | null>(null);
  if (breathRef.current === null) breathRef.current = breathFirst;
  const tlBreath = breathRef.current;

  // ── 常驻动效 state（每帧 setState） ──
  const [borderPhase, setBorderPhase] = useState(0);
  const [phase, setPhase] = useState(0); // breath phase ∈ [0,1]

  // ── 入场 + Auto 联动 ref（timeline 直接 mutate，force setState 触发重渲） ──
  const entryRef = useRef<{ marginTop: number; opacity: number }>({
    marginTop: -2,
    opacity: 0,
  });
  const autoMixRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const [, force] = useState(0);

  // 边框流光相位：8s 线性循环（onComplete 归零避免 reset 陷阱，design-5 同款）
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

  // 常驻：breath phase 0→1→0 alternate（整条呼吸脉冲相位）
  useEffect(() => {
    const target = { p: 0 };
    tlBreath.add(target, {
      p: 1,
      duration: BREATH_MS,
      ease: "linear",
      loop: true,
      alternate: true,
      onUpdate: () => setPhase(target.p),
    });
  }, [tlBreath]);

  // 入场动效：marginTop -2 → 0、opacity 0 → 1
  useEffect(() => {
    const target = entryRef.current;
    tl.once(target, {
      marginTop: 0,
      opacity: 1,
      duration: ENTRY_DURATION_MS,
      ease: "outExpo",
      onUpdate: () => force((x) => x + 1),
    });
  }, [tl]);

  // Auto 圆点切色：dim ↔ running 200ms outExpo
  useEffect(() => {
    const target = autoMixRef.current;
    const currentMix = target.mix;
    const targetMix = autoOn ? 1 : 0;
    if (currentMix === targetMix) return;
    tl.once(target, {
      mix: targetMix,
      duration: AUTO_DOT_DURATION_MS,
      ease: "outExpo",
      onUpdate: () => force((x) => x + 1),
    });
  }, [autoOn, tl]);

  // ── 进度条几何（共享 _geometry.ts） ──
  //   border 左右 2 列 + paddingX 各 1 列 = 4 列固定开销
  const innerCols = Math.max(SEG_COUNT, cols - 4);
  const barLen = floorTo5BarLen(innerCols);
  const segLen = segmentLen(barLen);

  // ── 派生值 ──
  const entry = entryRef.current;
  const autoDotGlyph = autoOn ? "◐" : "◑";
  const autoDotColor = mixHex(pal.dim, pal.running, autoMixRef.current.mix);
  const autoDesc = autoOn ? "自适应档位" : "手动档位";

  // breath 公式：phase ∈ [0,1]，breath = 0.5 + 0.5 * sin(2π * phase) ∈ [0,1]
  const breath = 0.5 + 0.5 * Math.sin(2 * Math.PI * phase);
  // 呼吸幅度：0..1 整段（深紫→亮紫），让动效肉眼可见
  const luma = breath;

  /** 字符 i 的视觉颜色：紫渐变基色 + 整条呼吸脉冲（低=luma→深紫 logoInk，
   *  高=luma 的明亮 base）。当前档段额外 +0.25 亮度保持可见。 */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) return { bg: pal.border, fg: pal.dim };
    const segIdx = Math.min(SEG_COUNT - 1, Math.floor(i / segLen));
    if (segIdx > currentIndex) {
      // 未填充暗灰轨
      return { bg: pal.border, fg: pal.dim };
    }
    const filledEnd = (currentIndex + 1) * segLen;
    const t = i / Math.max(1, filledEnd - 1);
    // 紫渐变基色
    const base = gradAt(t);
    // 呼吸：低 luma → 整条混进 logoInk 深紫（暗），高 luma → 接近 base（亮）
    const lit = mixHex(base, pal.logoInk, (1 - luma) * 0.7);
    let out = lit;
    if (segIdx === currentIndex) {
      // 当前档 +0.3 亮度（呼吸低谷时仍突出）
      out = mixHex(lit, pal.text, 0.3);
    }
    const fg = mixHex(out, pal.logoInk, 0.5);
    return { bg: out, fg };
  }

  // ── 档位标签样式：焦点游标 ▸◂（移动中）/ 当前档提亮（已确认）/ 其余 dim ──
  const labels = ["low", "medium", "high", "xhigh", "max"] as const;
  function labelFor(i: number): { text: string; fg: string; bold: boolean } {
    const text = labels[i];
    if (autoOn) return { text, fg: pal.dim, bold: false };
    if (open && i === focusIndex)
      return { text: `▸ ${text} ◂`, fg: pal.running, bold: true };
    if (i === currentIndex) return { text, fg: pal.accent, bold: true };
    return { text, fg: pal.dim, bold: false };
  }

  // ── 档位标签行节点：labelPad 把标签居中到段中点，逐段拼成 barLen 宽 ──
  const labelNodes: ReactNode[] = [];
  for (let i = 0; i < labels.length; i++) {
    const seg = labelFor(i);
    const { lead, pad } = labelPad(segLen, seg.text);
    labelNodes.push(<span key={`p${i}`}>{" ".repeat(lead)}</span>);
    labelNodes.push(
      <span
        key={`l${i}`}
        fg={seg.fg}
        attributes={seg.bold ? TextAttributes.BOLD : TextAttributes.NONE}
      >
        {seg.text}
      </span>
    );
    labelNodes.push(<span key={`t${i}`}>{" ".repeat(pad)}</span>);
  }

  // ── 键位提示（按当前 auto 状态分支） ──
  const hint = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[← →] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  // ── 渲染 ──
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginTop={entry.marginTop}
      opacity={entry.opacity}
      width={Math.max(1, cols)}
    >
      {/* 标题 ◆─ Thinking（design-5/22 同款） */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
      </text>

      {/* Auto 行：◐/◑ + AUTO + 描述（design-5/22 同款） */}
      <text>
        <span fg={autoDotColor}>{`${autoDotGlyph}  `}</span>
        <span fg={pal.dim}>AUTO</span>
        <span fg={pal.dim}>{`  ·  ${autoDesc}`}</span>
      </text>

      {/* 呼吸脉冲进度条：灰渐变底 + 整条 luma 呼吸（design-22 替换为
          呼吸底色，不再用 shimmer 浮动光带） */}
      <text wrapMode="none">
        {Array.from({ length: barLen }, (_, i) => {
          const { bg, fg } = colorAt(i);
          return (
            <span key={i} bg={bg} fg={fg}>
              █
            </span>
          );
        })}
      </text>

      {/* 档位标签行：5 档各居中到段中点（几何对齐，断点对档位） */}
      <text wrapMode="none">{labelNodes}</text>

      {/* 键位提示 */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

// ── 导出 ──────────────────────────────────────────────────────────────
export const design24: ThinkingDesign = {
  meta: {
    id: "design-24-breathing",
    name: "呼吸填充",
    tag: "Breathing Fill",
    summary: "design-5 框架 + 整条已填充段 3.2s 同步呼吸脉冲底色",
  },
  render: (p) => BreathingRender(p) as unknown as ReactElement,
};
