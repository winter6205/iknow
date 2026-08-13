/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-23-static-gray.tsx
 *
 * 思考面板 · Design 23：静态灰阶（design-22 底色变体 A，design-5 框架）。
 *
 * 与 design-22 的关系：同帧结构、同 5 段等宽几何、同边框流光；**唯一区别是
 * 底色**——design-22 是"shimmer 浮动光带扫过"的动态填充，design-23 是
 * "完全静态的浅灰渐变填充"，无任何底色动效（不动效对比版）。
 *
 * 帧结构（与 design-22 完全一致）：
 *   [圆角边框 borderColor 4 token 循环流光]（保留——frame 装饰，非底色动效）
 *     ◆─ Thinking                ← 标题
 *     ◑  AUTO · 手动档位         ← 自动圆点 + 描述
 *
 *     ████████████████████      ← 静态灰阶进度条（无 shimmer / 无补间）
 *     ████████████████████
 *     ████████████████████
 *
 *     low         medium         high         xhigh        max   ← 5 档标签
 *     [←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消
 *
 * 进度条几何（_geometry.ts 共享，与 design-22 完全一致，禁止改动）：
 *   - innerCols = max(SEG_COUNT, cols - 4)；barLen = floorTo5BarLen(innerCols)
 *   - 5 段各 segLen = barLen / 5（严格等宽 → max 段贴最右、完全填充）
 *   - 标签用 labelPad(segLen, text) 居中到段中点，5 档间隔一致
 *   - 每个断点对应一个档位，从断点位置能一眼看出当前档
 *
 * 底色（静态灰阶，完全无动效；本次变体的关键区别）：
 *   - 已填充段（[0, currentIndex]）：dim → text 浅灰渐变（静态，无 shimmer）
 *   - 已填充段中当前档段（currentIndex 段）：底色再向 pal.accent 提亮 30%
 *     （mix base accent 0.3），无动效下"当前档"也清楚
 *   - 未填充段（currentIndex 之后）：bg pal.border 暗灰轨 + dim 字符
 *   - autoOn → 整条退化为均匀暗灰轨，无填充、标签全部 dim
 *
 * 颜色纪律：底色只用 pal.dim / pal.text / pal.accent / pal.border 四个 token
 *   （经 mixHex 派生）；不用 pal.running / pal.bgRunning 做底色（用户反馈过
 *   金黄/灰绿对底色不合适）。running 只出现在 frame 装饰（边框流光 / 标题
 *   前缀 / Auto 圆点 / 焦点标签），不算底色。
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
/** 边框流光 4 相位周期（design-5 同款；frame 装饰，唯一保留的动效）。 */
const BORDER_CYCLE_MS = 8_000;
/** 入场动画。 */
const ENTRY_DURATION_MS = 400;
/** Auto 圆点切换渐变。 */
const AUTO_DOT_DURATION_MS = 200;
/** 当前档段底色向 accent 提亮比例（静态 30%）。 */
/** 3-stop 线性渐变 logoInk(0) → running(0.5) → logoGold(1)，design-16 同款。 */
function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

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

/** 边框流光：相位 p ∈ [0, 4]，相邻 2 相位 RGB 插值（design-5 同款）。 */
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
function StaticGrayRender(props: ThinkingDesignProps): ReactNode {
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

  // ── 常驻动效 state（边框流光每帧 setState；底色无任何动效 state） ──
  const [borderPhase, setBorderPhase] = useState(0);

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

  // ── 进度条几何（共享 _geometry.ts，与 design-22 完全一致，禁止改动） ──
  //   border 左右 2 列 + paddingX 各 1 列 = 4 列固定开销
  const innerCols = Math.max(SEG_COUNT, cols - 4);
  const barLen = floorTo5BarLen(innerCols);
  const segLen = segmentLen(barLen);

  // ── 派生值 ──
  const entry = entryRef.current;
  const autoDotGlyph = autoOn ? "◐" : "◑";
  const autoDotColor = mixHex(pal.dim, pal.running, autoMixRef.current.mix);
  const autoDesc = autoOn ? "自适应档位" : "手动档位";

  /** 字符 i 的视觉颜色：静态浅灰渐变填充（无 shimmer / 无补间动画）；
   *  当前档段底色再向 pal.accent 提亮 30%，无动效下也清楚"当前档"。 */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) return { bg: pal.border, fg: pal.dim };
    const segIdx = Math.min(SEG_COUNT - 1, Math.floor(i / segLen));
    if (segIdx > currentIndex) {
      // 未填充暗灰轨
      return { bg: pal.border, fg: pal.dim };
    }
    // 已填充段：dim → text 浅灰渐变（静态，无动效）
    const filledEnd = (currentIndex + 1) * segLen;
    const t = i / Math.max(1, filledEnd - 1);
    // 静态紫灰渐变：logoInk(0) → running(0.5) → logoGold(1) 3-stop，无任何条内动效
    const base = gradAt(t);
    // 当前档段：整体提亮 15%（静态，无动效）——清晰标出当前档
    const isCurrent = segIdx === currentIndex;
    const lit = isCurrent ? mixHex(base, pal.text, 0.15) : base;
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

      {/* 静态灰阶进度条：dim→text 浅灰渐变填充，无 shimmer（铺满内宽） */}
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
export const design23: ThinkingDesign = {
  meta: {
    id: "design-23-static-gray",
    name: "静态灰阶",
    tag: "Static Gray",
    summary: "design-5 框架 + 完全静态的浅灰渐变填充，无动效底色",
  },
  render: (p) => StaticGrayRender(p) as unknown as ReactElement,
};
