/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-22-fused.tsx
 *
 * 思考面板 · Design 22：融合版本（design-5 圆角流光框 + design-16 渐变流光条）。
 *
 * 帧结构（沿用 design-5）：
 *   [圆角边框 borderColor 4 token 循环流光]
 *     ◆─ Thinking                ← 标题
 *     ◑  AUTO · 手动档位         ← 自动圆点 + 描述
 *
 *     ████████████████████      ← 流动进度条（design-16 流光条）
 *     ████████████████████
 *     ████████████████████
 *
 *     low         medium         high         xhigh        max   ← 5 档标签
 *     [←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消
 *
 * 进度条几何（_geometry.ts 提供，全部 5 段等宽）：
 *   - barLen = innerCols（向下取整到 5 的倍数）→ max 段贴最右、完全填充
 *   - 5 段各 segLen = barLen / 5（严格等宽，对应 low / medium / high / xhigh / max）
 *   - 标签严格居中到段中点（不等宽几何居中），5 档间隔一致
 *   - 每个断点对应一个档位，从断点位置能一眼看出当前档
 *
 * 底色（灰阶，无黄绿；本次反馈去掉 bgRunning 反衬）：
 *   - 已填充段（[0, currentIndex]）：dim → text 浅灰渐变 + shimmer 浮动光带
 *     扫过（alternate ping-pong 2800 ms，design-16 同款）
 *   - 当前档段亮度下限 0.5（聚焦在当前档，"浮动效果聚焦"）
 *   - 未填充段（currentIndex 之后）：`pal.border` 暗灰轨，dim 字符
 *   - 整条横向铺满圆角框内宽（不挤在左边）
 *   - autoOn → 整条退化为均匀暗灰轨，无填充、无光带、标签全部 dim
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
/** 边框流光 4 相位周期（design-5 同款）。 */
const BORDER_CYCLE_MS = 8_000;
/** 入场动画。 */
const ENTRY_DURATION_MS = 400;
/** Auto 圆点切换渐变。 */
const AUTO_DOT_DURATION_MS = 200;
/** bg shimmer 常驻周期（alternate ping-pong 一轮，design-16 同款）。 */
const SHIMMER_MS = 2800;

// ── 颜色工具（design-5/16 同款 palette mix） ─────────────────────────
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

/** 三角窗光带：中心 c，半宽 hw → [0,1] 强度。 */
function lightGlow(i: number, c: number, hw: number): number {
  const d = Math.abs(i - c);
  if (d >= hw) return 0;
  return 1 - d / hw;
}

/** 3-stop 线性渐变 logoInk(0) → running(0.5) → logoGold(1)，design-16 同款。 */
function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

/** 边框流光：相位 p ∈ [0, 4]，相邻 2 相位 RGB 插值。 */
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
function FusedFlowRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // ── Timeline 引用（useRef 锁首 render 实例，design-5/16 同款） ──
  const initialTimeline = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  const shimmerFirst = useTimeline({
    duration: SHIMMER_MS * 2,
    loop: true,
  });
  const shimmerRef = useRef<Timeline | null>(null);
  if (shimmerRef.current === null) shimmerRef.current = shimmerFirst;
  const tlShimmer = shimmerRef.current;

  // ── 常驻动效 state（每帧 setState） ──
  const [borderPhase, setBorderPhase] = useState(0);
  const [phase, setPhase] = useState(0); // shimmer

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

  // 常驻 1: shimmer phase 0→1→0 alternate
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

  /** 字符 i 的视觉颜色：3-stop 紫渐变（logoInk→running→logoGold）+
   *  白色 shimmer 光带扫过（浮动效果）；当前档段额外提亮聚焦（无 bgRunning）。
   *  这就是 design-16 原本的"紫色动效"，只是去掉了黄绿反衬。 */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) return { bg: pal.border, fg: pal.dim };
    const segIdx = Math.min(SEG_COUNT - 1, Math.floor(i / segLen));
    if (segIdx > currentIndex) {
      // 未填充暗灰轨
      return { bg: pal.border, fg: pal.dim };
    }
    // 已填充段：3-stop 紫渐变（保持 design-16 同款色感）
    const filledEnd = (currentIndex + 1) * segLen;
    const t = i / Math.max(1, filledEnd - 1);
    const base = gradAt(t);
    // 白色 shimmer 光带扫过（浮动效果）
    const lightCenter = phase * (barLen - 1);
    const glow = lightGlow(i, lightCenter, barLen * 0.32);
    const isCurrent = segIdx === currentIndex;
    const eff = isCurrent ? Math.max(glow, 0.55) : glow;
    const lit = mixHex(base, pal.text, eff * 0.65);
    const fg = mixHex(lit, pal.logoInk, 0.5);
    return { bg: lit, fg };
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
      {/* 标题 ◆─ Thinking（design-5 同款） */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
      </text>

      {/* Auto 行：◐/◑ + AUTO + 描述（design-5 同款） */}
      <text>
        <span fg={autoDotColor}>{`${autoDotGlyph}  `}</span>
        <span fg={pal.dim}>AUTO</span>
        <span fg={pal.dim}>{`  ·  ${autoDesc}`}</span>
      </text>

      {/* 流动进度条：灰阶填充 + shimmer 光带（铺满内宽，无每档小块） */}
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
export const design22: ThinkingDesign = {
  meta: {
    id: "design-22-fused",
    name: "流动条融合",
    tag: "Fused Flow",
    summary:
      "design-5 玻璃渐变框架 + design-16 流动进度条；5 段等宽 + 几何对齐标签 + 灰阶填充",
  },
  render: (p) => FusedFlowRender(p) as unknown as ReactElement,
};
