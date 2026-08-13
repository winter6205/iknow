/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-25-flow-edge.tsx
 *
 * 思考面板 · Design 25：design-5 框架 + 流动水线边界底色（design-22 底色变体 C）。
 *
 * 与 design-22 的唯一区别在**底色叙事**：design-22 让一条 shimmer 光带扫过整条
 * 已填充区；本版把光完全收束到「当前档段 / 未填充段」的那条边界上，做成一条
 * 宽 2 段（segLen × 2）的柔光过渡带——像水位线一样在边界左右轻微流动，读者
 * 一眼就能看出"水位停在哪一档、并且还在动"。
 *
 * 帧结构（与 design-22 完全一致，沿用 design-5）：
 *   [圆角边框 borderColor 4 token 循环流光]
 *     ◆─ Thinking                ← 标题
 *     ◑  AUTO · 手动档位         ← 自动圆点 + 描述
 *
 *     ████████████████████      ← 进度条（灰阶填充 + 边界水线）
 *
 *     low   medium   high   xhigh   max   ← 5 档几何居中标签
 *     [←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消
 *
 * 进度条几何：完全复用 `_geometry.ts`（5 段等宽 + labelPad 居中），与 design-22
 * 逐列对齐，方便并排比较底色方案。
 *
 * 底色（灰阶 + 单一 accent 水线，无黄绿）：
 *   - 已填充段（[0, currentIndex]）：dim → text 稳定灰渐变，**无 shimmer**
 *   - 边界水线：中心 = 当前档段最右一列，三角窗半宽 = segLen（左右各铺一段）
 *     强度 glowEdge ∈ [0,1] → 底色向 `mixHex(pal.text, pal.accent, glowEdge*0.65)`
 *     过渡；水线中心随 2400 ms alternate 相位在 ±0.2*segLen 内左右晃动
 *   - 未填充段（> currentIndex）：`pal.border` 暗灰轨 + dim 字符（保持"干"的观感）
 *   - autoOn → 整条退化为均匀暗灰轨，水线停止，标签全部 dim
 *   - 保留 design-22 的边框 4 相位流光（8000 ms）
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
/** 边界水线左右流动一趟的时长（alternate ping-pong 单程）。 */
const EDGE_FLOW_MS = 2400;
/** 水线晃动幅度（相对 segLen 的半幅，± 0.2 段）。 */
const EDGE_SWAY = 0.9;
/** 水线最亮处向 accent 的混合上限。 */
const EDGE_MIX = 1;

// ── 颜色工具（design-5/16/22 同款 palette mix） ──────────────────────
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

/** 三角窗：中心 c、半宽 hw → [0,1] 强度（hw 外为 0）。 */
function triangleWindow(i: number, c: number, hw: number): number {
  if (hw <= 0) return 0;
  const d = Math.abs(i - c);
  if (d >= hw) return 0;
  return 1 - d / hw;
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
function FlowEdgeRender(props: ThinkingDesignProps): ReactNode {
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

  const edgeFirst = useTimeline({
    duration: EDGE_FLOW_MS,
    loop: true,
  });
  const edgeRef = useRef<Timeline | null>(null);
  if (edgeRef.current === null) edgeRef.current = edgeFirst;
  const tlEdge = edgeRef.current;

  // ── 常驻动效 state（每帧 setState） ──
  const [borderPhase, setBorderPhase] = useState(0);
  const [edgePhase, setEdgePhase] = useState(0.5); // 水线相位 0..1..0

  // ── 入场 + Auto 联动 ref（timeline 直接 mutate，force setState 触发重渲） ──
  const entryRef = useRef<{ marginTop: number; opacity: number }>({
    marginTop: -2,
    opacity: 0,
  });
  const autoMixRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const [, force] = useState(0);

  // 边框流光相位：8s 线性循环（onComplete 归零避免 reset 陷阱）
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

  // 常驻：水线相位 0→1→0（alternate ping-pong），驱动边界左右小幅流动
  useEffect(() => {
    const target = { p: 0 };
    tlEdge.add(target, {
      p: 1,
      duration: EDGE_FLOW_MS,
      ease: "linear",
      loop: true,
      alternate: true,
      onUpdate: () => setEdgePhase(target.p),
    });
  }, [tlEdge]);

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

  /** 水线中心列：当前档段最右一列 ± 0.2*segLen 的缓慢晃动。 */
  const edgeCenter =
    currentIndex * segLen + segLen - 1 + (edgePhase - 0.5) * segLen * EDGE_SWAY;

  /** 字符 i 的视觉颜色：稳定灰阶填充 + 边界柔光水线。 */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) return { bg: pal.border, fg: pal.dim };
    const segIdx = Math.min(SEG_COUNT - 1, Math.floor(i / segLen));
    if (segIdx > currentIndex) {
      // 未填充暗灰轨（水线不越界，保持"干"的观感）
      return { bg: pal.border, fg: pal.dim };
    }
    // 已填充段：3-stop 紫渐变基色（与 design-22/23/24 同步保留紫调）
    const filledEnd = (currentIndex + 1) * segLen;
    const base = gradAt(i / Math.max(1, filledEnd));
    // 边界水线：半宽 = segLen 的三角窗，越靠近边界越向 logoGold 过渡
    const glowEdge = triangleWindow(i, edgeCenter, segLen);
    const crest = mixHex(pal.logoInk, pal.logoGold, glowEdge * EDGE_MIX);
    const bg = mixHex(base, crest, glowEdge); // 中心点直接 crest = logoGold
    const fg = mixHex(bg, pal.logoInk, 0.5);
    return { bg, fg };
  }

  // ── 档位标签样式：焦点游标 ▸◂（移动中）/ 当前档提亮（已确认）/ 其余 dim ──
  const labels = ["low", "medium", "high", "xhigh", "max"] as const;
  function labelFor(i: number): { text: string; fg: string; bold: boolean } {
    const text = labels[i]!;
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

      {/* 进度条：稳定灰阶填充 + 当前档边界流动水线（铺满内宽） */}
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
export const design25: ThinkingDesign = {
  meta: {
    id: "design-25-flow-edge",
    name: "流光边界",
    tag: "Flow Edge",
    summary: "design-5 框架 + 当前档边界柔和流动水线，从左到右推进",
  },
  render: (p) => FlowEdgeRender(p) as unknown as ReactElement,
};
