/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-7-fill-slot.tsx
 *
 * Thinking-effort 思考面板 — Design 7：填充滑杆（Fill Slot）。
 *
 * 视觉风格要素（与任务描述一一对齐）：
 *  1. 整条进度条 `▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░` 亮（已走）vs 暗（未走）两段
 *     对比度强；亮区字符数按 `Math.round((currentIndex + 1) / 5 * totalChars)`
 *     动态计算（验收口径公式），5 档对应 5 个等距填充点。
 *  2. 顶部 Auto 圆点 `◐` / `◑` 玻璃半填充：开 auto = ◐ 亮（pal.running），
 *     关 auto = ◑ 暗（pal.dim），切 auto 时 dotColor mix 0↔1 200ms outExpo。
 *  3. 滑块为 `◂──▸` 框选已填充部分末端（不是 ● 圆点）：跟随填充末端
 *     平滑移动；切档 180ms outQuad 平滑滑，亮 `▓` 区随滑块伸缩**连续填充**
 *     ——fillProgress 通过 `target.progress` 连续插值，亮字符数按
 *     `Math.round(progress)` 逐帧重算，避免 5/10/14/19/24 离散跳变。
 *  4. 圆角边框 `borderStyle="rounded"` + borderColor 在 4 帧色 token
 *     `logoInk → running → logoGold → running` 间循环（8s linear，相邻
 *     帧 RGB 插值），制造玻璃流光边框。
 *  5. 入场：填充从 0 充到 currentIndex 的 filledTarget 400ms outExpo，
 *     类似电池充电动画；滑块 translateX 同步从 0 推到 filledTarget。
 *  6. Auto 联动：开 auto 时 fillColorMix→1（亮区转灰 = pal.dim），滑块
 *     opacity→0 淡出；关 auto 时从当前位置恢复（fillColorMix→0 恢复亮，
 *     滑块 opacity→1 淡入）。
 *
 * 颜色纪律：所有颜色 100% 来自 `tuiPalette`（theme.ts），未新增任何颜色
 * 常量；hex 字符串由 OpenTUI 渲染器按终端能力降级，应用层不写 ANSI。
 *
 * 动效挂钩（结合 design-1 / design-5 的成熟模式）：
 *  - 填充进度 timeline + Auto 联动 timeline：采用 design-1 的 `new Timeline`
 *    + `engine.register` / `unregister` 模式，按 mount-only 注册、按 prop
 *    变化在 effect 内 `resetItems + add + play` 触发，避免 useTimeline 每次
 *    render 返回新实例的引用漂移陷阱。
 *  - 边框流光 timeline：采用 design-5 的 `useTimeline({ loop: true })` +
 *    `useRef` 首 render 锁定模式，item 不 loop 而由 Timeline.loop 在周期末
 *    resetItems 前由 onComplete 把 phase 归零，下周期重新从 0 插值。
 *  - 滑块 translateX 由 onUpdate 内同步赋值给 `sliderRef.current.translateX`
 *    （绝对 box，OOG React reconciler 不干预），确保与 fillProgress 完全同步。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { BoxRenderable, TextAttributes, Timeline, engine } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import type { ThinkingDesign, ThinkingDesignProps } from "./_contract.js";

// ── 时长 / 周期常量 ────────────────────────────────────────────────────
/** 边框 4 相位全角周期（与 design-5 / 8s 对齐）。 */
const BORDER_CYCLE_MS = 8000;
/** 入场充电动效时长 + outExpo。 */
const ENTRY_MS = 400;
/** 切档滑块平滑动效时长 + outQuad。 */
const SLIDE_MS = 180;
/** Auto 联动 mix 渐变时长 + outExpo。 */
const AUTO_MS = 200;

// ── 边框流光 4 相位 token（按周期轮换，相邻相位 RGB 插值） ──────────
const FLOW_STOPS: ReadonlyArray<string> = [
  tuiPalette.logoInk,
  tuiPalette.running,
  tuiPalette.logoGold,
  tuiPalette.running,
];

// ── 颜色工具（与 design-5 同款，独立 inline） ────────────────────────
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

/** 由 phase（实数，0..FLOW_STOPS.length）查表 + 与下一档 mix，输出 borderColor。 */
function flowBorderColor(phase: number): string {
  const phases = FLOW_STOPS.length;
  const idx = Math.floor(phase);
  const f = Math.max(0, Math.min(1, phase - idx));
  const a = FLOW_STOPS[((idx % phases) + phases) % phases] ?? FLOW_STOPS[0]!;
  const b =
    FLOW_STOPS[(((idx + 1) % phases) + phases) % phases] ?? FLOW_STOPS[0]!;
  return mixHex(a, b, f);
}

// ── 渲染组件 ──────────────────────────────────────────────────────────
function FillSlotRender(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex } = model;

  // 进度条总字符数（按 panel cols 自适应，留出余量给滑块溢出 + 边距）。
  // 公式边界：cols < 24 → 12 字符下界；cols >= 36 → 24 字符上界。
  const totalChars = Math.max(12, Math.min(24, cols - 12));

  // 5 档对应填充字符数（任务验收口径公式）。
  const filledTarget = (idx: number): number =>
    Math.round(((idx + 1) / 5) * totalChars);

  // ── Refs ───────────────────────────────────────────────────────────
  // 填充进度：连续值，由 timeline 原地改写。亮区字符数 / 滑块 translateX
  // 都依赖它，所以一处真相驱动两处渲染。
  const fillProgressRef = useRef<{ progress: number }>({ progress: 0 });
  // Auto 联动 mix：fillColorMix（亮区运行色→灰）/ dotColorMix（暗→运行）/
  // sliderOpacity（1→0 淡出）。三个量同步 tween。
  const autoMixRef = useRef<{
    fillColorMix: number;
    dotColorMix: number;
    sliderOpacity: number;
  }>({
    fillColorMix: autoOn ? 1 : 0,
    dotColorMix: autoOn ? 1 : 0,
    sliderOpacity: autoOn ? 0 : 1,
  });
  // 滑块 box ref（imperative translateX 驱动）。
  const sliderRef = useRef<BoxRenderable | null>(null);
  // 索引 / Auto 切换检测前值（避免重复触发 tween）。
  const prevIndexRef = useRef<number>(currentIndex);
  const prevAutoRef = useRef<boolean>(autoOn);

  // ── Force re-render ────────────────────────────────────────────────
  const [borderPhase, setBorderPhase] = useState(0);
  const [, forceFill] = useState(0);
  const [, forceAuto] = useState(0);

  // ── Timelines ──────────────────────────────────────────────────────
  // 填充进度 timeline：懒创建一次（每次 render 不会重置），用
  // `engine.register` 手动挂入 timeline engine（design-1 同款）。
  const fillTlRef = useRef<Timeline | null>(null);
  if (fillTlRef.current === null) {
    fillTlRef.current = new Timeline({ autoplay: false });
  }
  const fillTl = fillTlRef.current;

  // Auto 联动 timeline：同上。
  const autoTlRef = useRef<Timeline | null>(null);
  if (autoTlRef.current === null) {
    autoTlRef.current = new Timeline({ autoplay: false });
  }
  const autoTl = autoTlRef.current;

  // 边框流光 timeline：useTimeline + useRef 首 render 锁定（design-5 同款）。
  const initialBorderTl = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const borderTlRef = useRef<Timeline | null>(null);
  if (borderTlRef.current === null) {
    borderTlRef.current = initialBorderTl;
  }
  const borderTl = borderTlRef.current;

  // mount-only：注册 / 反注册 fillTl + autoTl（cancel-on-close）。
  useEffect(() => {
    engine.register(fillTl);
    engine.register(autoTl);
    return () => {
      fillTl.pause();
      engine.unregister(fillTl);
      autoTl.pause();
      engine.unregister(autoTl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 边框流光相位循环 ────────────────────────────────────────────────
  // 与 design-5 同：item 不 loop，靠 Timeline.loop 在周期末 resetItems 前
  // 由 onComplete 归零 target.phase，下周期重新从 0 插值（无 capture 漂移）。
  useEffect(() => {
    const target = { phase: 0 };
    borderTl.add(target, {
      phase: FLOW_STOPS.length,
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

  // ── 入场（mount-only）：填充 0 → filledTarget，400ms outExpo 电池充电 ──
  // 滑块 translateX 同步由 onUpdate 内推 box.renderable，与 fillProgress
  // 完美同步（on mutating 后立刻调 forceFill 触发 re-render → render 读
  // progress → 重新计算 filled / sliderX）。
  useEffect(() => {
    const target = fillProgressRef.current;
    fillTl.resetItems();
    fillTl.add(target, {
      progress: filledTarget(currentIndex),
      duration: ENTRY_MS,
      ease: "outExpo",
      onUpdate: () => {
        forceFill((x) => x + 1);
      },
    });
    fillTl.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 切档：currentIndex 变化 → 填充进度 tween 到新 filledTarget ─────
  // 180ms outQuad。tween 期间 `target.progress` 连续插值，亮 `▓` 字符数
  // 按 Math.round(progress) 逐帧重算 → 亮区**连续伸缩**（不是 5/10/14/19/24
  // 离散跳变）。滑块 translateX 同步。
  useEffect(() => {
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    const target = fillProgressRef.current;
    fillTl.resetItems();
    fillTl.add(target, {
      progress: filledTarget(currentIndex),
      duration: SLIDE_MS,
      ease: "outQuad",
      onUpdate: () => {
        forceFill((x) => x + 1);
      },
    });
    fillTl.play();
  }, [currentIndex, fillTl]);

  // ── Auto 联动：autoOn 变化 → fillColorMix / dotColorMix / sliderOpacity
  // 同步 tween 200ms outExpo。auto on：亮区转灰（pal.running → pal.dim）
  // + 滑块 opacity → 0 淡出；auto off：从当前位置恢复（mix 复位 + 滑块
  // opacity 淡入）。三个量在同一 tween item 内同步，不分 timeline，避免
  // 多 timeline 推进节奏不齐的偏差。
  useEffect(() => {
    if (prevAutoRef.current === autoOn) return;
    prevAutoRef.current = autoOn;
    const target = autoMixRef.current;
    autoTl.resetItems();
    autoTl.add(target, {
      fillColorMix: autoOn ? 1 : 0,
      dotColorMix: autoOn ? 1 : 0,
      sliderOpacity: autoOn ? 0 : 1,
      duration: AUTO_MS,
      ease: "outExpo",
      onUpdate: () => {
        forceAuto((x) => x + 1);
      },
    });
    autoTl.play();
  }, [autoOn, autoTl]);

  // ── 派生值（ref 被 timeline 原地改写，force setState 后读到最新） ──
  const progress = fillProgressRef.current.progress;
  const filled = Math.max(0, Math.min(totalChars, Math.round(progress)));
  const unfilled = totalChars - filled;
  // 滑块 translateX = 填充末端位置（= filled 字符数）。上界钳制到
  // cols - 6 防止极窄终端下 4 字符滑块溢出 panel 边界。
  const sliderX = Math.max(0, Math.min(filled, cols - 6));
  const fillColor = mixHex(
    pal.running,
    pal.dim,
    autoMixRef.current.fillColorMix
  );
  const dotColor = mixHex(pal.dim, pal.running, autoMixRef.current.dotColorMix);
  const sliderOpacity = autoMixRef.current.sliderOpacity;
  const autoGlyph = autoOn ? "◐" : "◑";
  const autoDesc = autoOn
    ? "adaptive (server picks effort)"
    : "concrete effort";

  // ── 滑块 translateX 跟随进度（每次 re-render 后同步推 box.renderable）──
  // useEffect 无 deps，每次 render 都同步一次；onUpdate 的 forceFill 触发的
  // re-render 也会跑到这里，确保滑块位置 = 填充末端。
  useEffect(() => {
    if (sliderRef.current) {
      sliderRef.current.translateX = sliderX;
    }
  });

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      width={Math.max(1, cols)}
    >
      {/* 标题 ◆─ Thinking（装饰前缀金、内容文白） */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
      </text>

      {/* Auto 行：◐/◑ + AUTO + 描述（dot color tweens dim ↔ running） */}
      <text>
        <span fg={dotColor}>{`${autoGlyph}  `}</span>
        <span fg={pal.dim}>AUTO</span>
        <span fg={pal.dim}>{`  ·  ${autoDesc}`}</span>
      </text>

      {/* 进度条：亮 ▓ + 暗 ░ 两段，对比度强。亮区字符数 = filled（动态算） */}
      <text wrapMode="none">
        <span fg={fillColor}>{"▓".repeat(filled)}</span>
        <span fg={pal.dim}>{"░".repeat(unfilled)}</span>
      </text>

      {/* 滑块 ◂──▸ 框选已填充部分末端：absolute 定位的 box，translateX
          跟随 fillProgress（即跟随填充末端移动）。auto on 时 opacity→0
          淡出；auto off 时 opacity→1 淡入。 */}
      <box width="100%" flexDirection="row">
        <box
          ref={sliderRef}
          position="absolute"
          left={0}
          opacity={sliderOpacity}
        >
          <text
            fg={pal.running}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            ◂──▸
          </text>
        </box>
      </box>

      {/* 键位提示（auto on 时省略 [← →]）。 */}
      <text fg={pal.dim}>
        {autoOn
          ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
          : "[← →] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"}
      </text>
    </box>
  );
}

// ── 导出 ──────────────────────────────────────────────────────────────
export const design7: ThinkingDesign = {
  meta: {
    id: "design-7-fill-slot",
    name: "填充滑杆",
    tag: "Fill Slot",
    summary: "▓/░ 亮暗两段 + ◂──▸ 框选滑块 + 亮区连续伸缩 + 圆角流光边框",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    (<FillSlotRender {...props} />) as unknown as ReactElement,
};
