/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-12-flow-slot.tsx
 *
 * 思考面板 · Design 12：双层流光槽（Dual Flow Slot，glass gradient 基调）。
 *
 * 视觉结构（顶层 Auto + 边框 + 两层垂直堆叠）：
 *   [圆角边框]（borderColor 在 4 个 token 间循环呼吸，独立于流光带节奏）
 *     ◐  Auto
 *     ═══·════·═══════·════    ← 上层流光带（fg token 周期切换 8s linear）
 *     ●                        ← 滑块（两层之间，x = currentIndex 在槽上的坐标）
 *     low medium high xhigh max   ← 下层档位名
 *
 * 设计要点（用户已定方案，逐条落地）：
 *  - 上层流光带：固定字符串 "═══·════·═══════·════"（═ U+2550 + · 拼成）。
 *    每个 `═` 字组的 fg 在 `pal.running → pal.logoGold → pal.logoInk →
 *    pal.accent` 之间循环（8s linear loop，4 段相位）。视觉上等价于
 *    "光点在管里流动"。
 *  - 下层档位名：`low medium high xhigh max`（5 段，段间 1 空格），是滑块
 *    x 坐标的几何基准（槽）。
 *  - 顶部 Auto 圆点：◐（开，玻璃半填充）/ ◑（关）。开时 fg 偏 `pal.running`，
 *    关时偏 `pal.dim`，切换 150ms outQuad 平滑过渡。
 *  - 滑块 ●：画在两层之间，位置 = currentIndex 在槽上的中点 x 坐标。由
 *    `sliderX` state 驱动（timeline onUpdate 每帧写入）；切档 200ms outQuad
 *    滑到新位置。
 *  - 圆角边框：`borderStyle="rounded"`，`borderColor` 在同一组 4 token
 *    之间循环（独立 phase，6s linear，与上层流光带 8s 不同步——两层独立呼吸）。
 *  - 入场：流光带"生长"——初始宽度 0，由 timeline 推到满宽 400ms outExpo
 *    （按字符数裁切模拟）；滑块随后（错峰 420ms）从 x=0 滑到初始档 x 坐标
 *    200ms outQuad。
 *  - 切档：滑块 200ms outQuad 滑到新位置；上层流光带 fg 颜色相位跟着滑块
 *    位置偏移（`currentIndex * 0.8` 作为派生 indexOffset 直接加在循环相位上，
 *    视觉上"光点流到滑块处"）。
 *  - Auto 联动：开 auto 时滑块淡出（opacity 1 → 0，150ms outQuad）+ 流光带
 *    相位归零（indexOffset 归 0，只剩基循环）；关 auto 时反向恢复。
 *
 * 颜色纪律：所有颜色 100% 来自 `tuiPalette`（theme.ts），未新增任何颜色
 * 常量；hex 字符串由 OpenTUI 渲染器按终端能力降级，应用层不写 ANSI。
 *
 * `useTimeline` 注意（同 design-5）：hook 每次 render 都 new 一个
 * Timeline 实例，但只把首 render 的注入 engine + play。后续 render 的
 * Timeline 未注册、`engine.update` 不会推进，动画静默失败。全部 timeline
 * 用 `useRef` 锁住首 render 实例，所有 `.add()` 落到 stable ref 上。
 * 常驻 timeline 两条（流光带 fg 循环 / 边框 borderColor 循环），用
 * `loop: true` + item `onComplete` 归零避免 resetItems 重捕获初值陷阱。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

// ── 常量 ──────────────────────────────────────────────────────────────

/** 上层流光带字符串：═ U+2550 + · 拼成，段间由 `·` 分隔形成"光点"间隔。 */
const FLOW_GLYPH = "═══·════·═══════·════";

/** 流光带 fg token 4 相位序列（循环；与边框 token 复用同一调色板但 phase 独立）。 */
const FLOW_TOKENS: ReadonlyArray<string> = [
  tuiPalette.running, // 1
  tuiPalette.logoGold, // 2
  tuiPalette.logoInk, // 3
  tuiPalette.accent, // 4
];

/** 流光带整周期：8s linear loop，4 token 各占 2s。 */
const FLOW_CYCLE_MS = 8000;

/** 边框呼吸整周期：与流光带错峰，6s linear loop，4 token 各占 1.5s。 */
const BORDER_CYCLE_MS = 6000;

/** 入场"生长"时长 + easing（outExpo）。 */
const ENTRY_DURATION_MS = 400;

/** 滑块入场错峰 delay（流光带生长完后再触发）。 */
const SLIDER_ENTRY_DELAY_MS = 420;

/** 滑块切档 / 入场滑动时长 + easing（outQuad）。 */
const SLIDER_DURATION_MS = 200;

/** Auto 联动（滑块淡出 + 圆点切色）时长 + easing。 */
const AUTO_DURATION_MS = 150;

// ── 颜色工具 ──────────────────────────────────────────────────────────

/** `#rrggbb` → [r,g,b]∈[0,1]³。 */
function hexToRgb(hex: string): readonly [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1] as string, 16);
  return [
    ((v >> 16) & 0xff) / 255,
    ((v >> 8) & 0xff) / 255,
    (v & 0xff) / 255,
  ] as const;
}

/** 两色按 t∈[0,1] 线性混合 → `#rrggbb` 字符串。 */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round((ar + (br - ar) * k) * 255);
  const g = Math.round((ag + (bg - ag) * k) * 255);
  const bl = Math.round((ab + (bb - ab) * k) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** phase（实数，0..FLOW_TOKENS.length）查表 + 与下一档 RGB 插值，输出 fg hex。 */
function tokenColorAt(phase: number, tokens: ReadonlyArray<string>): string {
  const n = tokens.length;
  const idx = Math.floor(phase);
  const f = Math.max(0, Math.min(1, phase - idx));
  const a = tokens[((idx % n) + n) % n] ?? tokens[0]!;
  const b = tokens[(((idx + 1) % n) + n) % n] ?? tokens[0]!;
  return mixHex(a, b, f);
}

// ── 几何 ──────────────────────────────────────────────────────────────

/** 计算档 i 中点的 x 坐标（在"段长 + 1 空格"几何基准下的字符偏移）。 */
function levelCenterX(index: number): number {
  let x = 0;
  for (let k = 0; k < index && k < EFFORT_LEVELS.length; k++) {
    x += EFFORT_LEVELS[k]!.length + 1; // 段长 + 1 空格
  }
  const segLen = EFFORT_LEVELS[index]!.length;
  return x + (segLen - 1) / 2; // 段中点 = 段起始 + (段长 - 1) / 2
}

// ── 渲染组件 ────────────────────────────────────────────────────────

function FlowSlotPanel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex } = model;

  // ── Timeline 引用（锁首 render 实例） ─────────────────────────────
  // 流光带 fg 循环：8s linear loop。
  const initialFlowTl = useTimeline({ duration: FLOW_CYCLE_MS, loop: true });
  // 边框呼吸：6s linear loop（与流光带不同步——两层独立呼吸）。
  const initialBorderTl = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  // 入场（流光带"生长"）。
  const initialEntryTl = useTimeline({
    duration: SLIDER_ENTRY_DELAY_MS + SLIDER_DURATION_MS + 40,
  });
  // 滑块切档滑动。
  const initialSliderTl = useTimeline({ duration: SLIDER_DURATION_MS + 20 });
  // Auto 联动（滑块淡出 + 圆点切色）。
  const initialAutoTl = useTimeline({ duration: AUTO_DURATION_MS + 20 });

  const flowTlRef = useRef<Timeline | null>(null);
  const borderTlRef = useRef<Timeline | null>(null);
  const entryTlRef = useRef<Timeline | null>(null);
  const sliderTlRef = useRef<Timeline | null>(null);
  const autoTlRef = useRef<Timeline | null>(null);
  if (flowTlRef.current === null) flowTlRef.current = initialFlowTl;
  if (borderTlRef.current === null) borderTlRef.current = initialBorderTl;
  if (entryTlRef.current === null) entryTlRef.current = initialEntryTl;
  if (sliderTlRef.current === null) sliderTlRef.current = initialSliderTl;
  if (autoTlRef.current === null) autoTlRef.current = initialAutoTl;
  const flowTl = flowTlRef.current;
  const borderTl = borderTlRef.current;
  const entryTl = entryTlRef.current;
  const sliderTl = sliderTlRef.current;
  const autoTl = autoTlRef.current;

  // ── 流光带基循环 phase（0..4，由 timeline 驱动） ───────────────────
  const [flowBasePhase, setFlowBasePhase] = useState(0);
  // ── 边框 phase（独立驱动边框颜色循环） ───────────────────────────
  const [borderPhase, setBorderPhase] = useState(0);
  // ── 流光带入场宽度 0..1（驱动"生长"） ────────────────────────────
  const [flowGrow, setFlowGrow] = useState(0);
  // ── 滑块 x 坐标（currentIndex → levelCenterX，timeline 驱动） ─────
  const [sliderX, setSliderX] = useState(0);
  // ── 滑块 opacity（Auto 联动淡出；1 = 可见） ──────────────────────
  const [sliderOpacity, setSliderOpacity] = useState(autoOn ? 0 : 1);
  // ── Auto 圆点 mix（0 = dim，1 = running；与滑块淡出同一 timeline） ─
  const [dotMix, setDotMix] = useState(autoOn ? 1 : 0);

  // 流光带 fg 基循环：8s linear loop，4 token 各占 2s。
  // 不能给 item 设 loop:true：同 design-5 注释，timeline.loop 在周期结
  // 束时 resetItems → 重新 capture 初始值，target.phase 会卡在末态。
  // 改为 item onComplete 在 reset 前把 target.phase 归零。
  useEffect(() => {
    const target = { phase: 0 };
    flowTl.add(target, {
      phase: FLOW_TOKENS.length,
      duration: FLOW_CYCLE_MS,
      ease: "linear",
      onComplete: () => {
        target.phase = 0;
      },
      onUpdate: () => {
        const next = target.phase;
        setFlowBasePhase((prev) => (prev === next ? prev : next));
      },
    });
  }, [flowTl]);

  // 边框呼吸：6s linear loop（独立节奏，与流光带不同步）。
  useEffect(() => {
    const target = { phase: 0 };
    borderTl.add(target, {
      phase: FLOW_TOKENS.length,
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
  }, [borderTl]);

  // 入场：流光带"生长"（宽度 0..1，outExpo 400ms），滑块随后（错峰
  // 420ms）从 x=0 滑到初始档 x 坐标。入场滑块用 setTimeout 调度并存入
  // ref，切档发生时先取消，避免与切档滑动冲突。
  const initialIndexRef = useRef(currentIndex);
  const entryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const target = { w: 0 };
    entryTl.add(target, {
      w: 1,
      duration: ENTRY_DURATION_MS,
      ease: "outExpo",
      onUpdate: () => {
        const next = target.w;
        setFlowGrow((prev) => (prev === next ? prev : next));
      },
    });
    // 滑块错峰滑入（mount 后 SLIDER_ENTRY_DELAY_MS 触发）。
    const sliderStart = { x: 0 };
    const targetX = levelCenterX(initialIndexRef.current);
    entryTimerRef.current = setTimeout(() => {
      entryTimerRef.current = null;
      sliderTl.add(sliderStart, {
        x: targetX,
        duration: SLIDER_DURATION_MS,
        ease: "outQuad",
        onUpdate: () => {
          const next = sliderStart.x;
          setSliderX((prev) => (prev === next ? prev : next));
        },
      });
    }, SLIDER_ENTRY_DELAY_MS);
    return () => {
      if (entryTimerRef.current !== null) {
        clearTimeout(entryTimerRef.current);
        entryTimerRef.current = null;
      }
    };
    // 两条 timeline 都是 ref 锁定的 stable 实例，效果等价 mount-only。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryTl, sliderTl]);

  // 切档：滑块 200ms outQuad 滑到新位置。流光带相位偏移不在这里改
  // state——`indexOffset = currentIndex * 0.8` 是派生值（见渲染处），
  // currentIndex 一变 fg 相位就跟着偏移，"光点流到滑块处"。
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    // 取消尚未触发的入场滑块，避免与本次切档滑动抢同一条 timeline。
    if (entryTimerRef.current !== null) {
      clearTimeout(entryTimerRef.current);
      entryTimerRef.current = null;
    }
    const sliderStart = { x: sliderX };
    const targetX = levelCenterX(currentIndex);
    sliderTl.add(sliderStart, {
      x: targetX,
      duration: SLIDER_DURATION_MS,
      ease: "outQuad",
      onUpdate: () => {
        const next = sliderStart.x;
        setSliderX((prev) => (prev === next ? prev : next));
      },
    });
    // sliderX 随动画每帧变化会重跑本 effect，guard 提前返回，不重复添加。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, sliderTl, sliderX]);

  // Auto 联动：开 auto 时滑块淡出 + 流光带相位归零（indexOffset 归 0，
  // 派生处见）；关 auto 时反向恢复。同一条 timeline 同时驱动滑块 opacity
  // 与 Auto 圆点 mix。
  const prevAutoRef = useRef<boolean>(autoOn);
  useEffect(() => {
    if (prevAutoRef.current === autoOn) return;
    const from = prevAutoRef.current ? 1 : 0; // 旧态
    const to = autoOn ? 1 : 0; // 新态
    prevAutoRef.current = autoOn;
    const autoTarget = { a: from };
    autoTl.add(autoTarget, {
      a: to,
      duration: AUTO_DURATION_MS,
      ease: "outQuad",
      onUpdate: () => {
        const v = autoTarget.a;
        setSliderOpacity(1 - v);
        setDotMix(v);
      },
    });
  }, [autoOn, autoTl]);

  // ── 派生 ──────────────────────────────────────────────────────────
  // 流光带相位 = 基循环 + 滑块位置偏移（每档 0.8 phase，4 token 跨 5 档）。
  // autoOn 时 indexOffset 归零 → "相位归零"只剩基循环。tokenColorAt 内部
  // 对超界 phase 取模，相位连续无跳变。
  const indexOffset = autoOn ? 0 : currentIndex * 0.8;
  const flowFg = tokenColorAt(flowBasePhase + indexOffset, FLOW_TOKENS);
  const borderFg = tokenColorAt(borderPhase, FLOW_TOKENS);
  const autoDotGlyph = autoOn ? "◐" : "◑";
  const autoDotFg = mixHex(pal.dim, pal.running, dotMix);
  const autoDesc = autoOn ? "自适应档位" : "手动档位";

  // 流光带入场"生长"：按 grow 比例裁切字符串前缀（FLOW_GLYPH 全宽 =
  // FLOW_GLYPH.length 个单宽字符，slice 按字符安全）。
  const visibleLen = Math.max(
    0,
    Math.min(FLOW_GLYPH.length, Math.round(FLOW_GLYPH.length * flowGrow))
  );
  const flowVisible = FLOW_GLYPH.slice(0, visibleLen);

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={borderFg}
      paddingX={1}
      paddingY={0}
      width={Math.max(1, cols)}
    >
      {/* 顶部 Auto 行：◐/◑ + AUTO + 描述 */}
      <box flexDirection="row">
        <text>
          <span fg={autoDotFg} attributes={TextAttributes.BOLD}>
            {autoDotGlyph}
          </span>
          <span fg={pal.dim}>{`  AUTO  ·  ${autoDesc}`}</span>
        </text>
      </box>

      {/* 上层流光带（fg 颜色循环，宽度由入场 grow 驱动） */}
      <text fg={flowFg} wrapMode="none">
        {flowVisible}
      </text>

      {/* 滑块 ●（两层之间，x = currentIndex 在槽上的坐标） */}
      <box width="100%" flexDirection="row">
        <text
          fg={pal.running}
          attributes={TextAttributes.BOLD}
          wrapMode="none"
          opacity={sliderOpacity}
        >
          {" ".repeat(Math.max(0, Math.round(sliderX))) + "●"}
        </text>
      </box>

      {/* 下层档位名（滑块 x 的几何基准；当前档金强调） */}
      <text wrapMode="none">
        {EFFORT_LEVELS.map((level, i) => {
          const current = i === currentIndex && !autoOn;
          return (
            <span
              key={level}
              fg={current ? pal.running : pal.dim}
              attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {level}
              {i < EFFORT_LEVELS.length - 1 ? " " : ""}
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

export const design12: ThinkingDesign = {
  meta: {
    id: "design-12-flow-slot",
    name: "双层流光槽",
    tag: "Dual Flow Slot",
    summary: "上层 ═·═ 流光带 + 下层档位名 + 滑块贯穿 + 双层独立流光呼吸",
  },
  render: ({ model, cols }: ThinkingDesignProps): ReactElement =>
    (<FlowSlotPanel model={model} cols={cols} />) as ReactElement,
};
