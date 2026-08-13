/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-5-gradient.tsx
 *
 * 思考面板设计 05：玻璃拟态 / 渐变流光风（demo gallery candidate）。
 *
 * 设计要点
 *  - 圆角边框流光：整框 borderColor 在 `pal.logoInk → pal.running → pal.logoGold
 *    → pal.running` 间循环（useTimeline 8s ease:"linear" loop，每 ~2s 切一档，
 *    相邻档间做 RGB 线性插值），近似任务所述"光带流过边框"——OpenTUI 单边框
 *    颜色 token 不支持 per-side 渐变，按设计 brief "选最容易实现且不破布局的方案"
 *    与"按周期切换 borderColor 颜色 token 制造流光感"两条建议，采用整框周期
 *    切换方案，避免 4 边拼接带来的圆角字符重叠 / yoga 布局副作用。
 *  - 入场：marginTop -2 → 0 + opacity 0 → 1，400ms outExpo（OpenTUI easing 表
 *    无 `inOutExpo`，按 brief 退化为 `outExpo`：指数末段无弹跳，符合"非常平滑
 *    的指数曲线"原意）。
 *  - Auto 圆点 ◐/◑ 半填充玻璃质感：切 Auto 时 ◐/◑ 字形 color 从 `pal.dim` 渐变
 *    到 `pal.running`，200ms outExpo。
 *  - 5 档密度阶梯：每档一个递增密度字符组合 `[▒, ▒▓, ▓, ▓█, █]`，相邻档文字密
 *    度递增；当前档指示字符 BOLD + pal.running 强调；切档时该字符色从 `pal.dim`
 *    → `pal.running` 平滑过渡 180ms outQuad。
 *  - 下方另起一行 dim 密度的 `▒▒▓▓▓█████` 整条锚定阶梯，对应设计 brief 必含元素
 *    4 "5 档 ▒▒▓▓▓█████ 密度阶梯"。
 *  - 键位提示 dim。
 *
 * 颜色纪律：高饱和度只用 `pal.running / pal.logoGold / pal.logoInk` 三色，正文
 * `pal.text`，辅助 `pal.dim`，未引入其他主题色。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { TextAttributes } from "@opentui/core";
import type { Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

/** 5 档密度组合序列（每档 1~2 字符，相邻档密度递增）。 */
const DENSITY_COMBOS: ReadonlyArray<string> = [
  "▒", // low    : ▒
  "▒▓", // medium : ▒▓
  "▓", // high   : ▓
  "▓█", // xhigh  : ▓█
  "█", // max    : █
];

/** 整条密度阶梯锚定文字（必含元素 4 验收口径）。 */
const LADDER_PREVIEW = "▒▒▓▓▓█████";

/** 边框流光 4 相位 token（按周期轮换，相邻相位 RGB 插值）。 */
const FLOW_STOPS: ReadonlyArray<string> = [
  tuiPalette.logoInk,
  tuiPalette.running,
  tuiPalette.logoGold,
  tuiPalette.running,
];

/** 边框全角周期：设计 brief 在 10000ms 处给值、必含元素 1 在 8s 处给值，取
 *  后者为准（"全角周期循环 8s"为硬性要求）。 */
const BORDER_CYCLE_MS = 8000;

/** 入场时长 + easing（OpenTUI 无 inOutExpo → outExpo）。 */
const ENTRY_DURATION_MS = 400;

/** Auto 圆点切色时长 + easing。 */
const AUTO_DOT_DURATION_MS = 200;

/** 当前档字符切色时长 + easing。 */
const LEVEL_DURATION_MS = 180;

/** RGB 三元组。 */
interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** #rrggbb → Rgb；非法输入返回 null（调用方回退到 from）。 */
function hexToRgb(hex: string): Rgb | null {
  if (hex.length !== 7 || hex[0] !== "#") return null;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

/** Rgb → #rrggbb（每通道 clamp + 0 补位）。 */
function rgbToHex({ r, g, b }: Rgb): string {
  const c = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** 两 hex 色按 t (0..1) 线性插值（RGB 空间）。t 越界 clamp。 */
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

function GradientDesignRender(props: ThinkingDesignProps) {
  const pal = tuiPalette;
  const { model } = props;

  // useTimeline 每次渲染会创建新的 Timeline 实例，但只有首个会被 engine 注册
  // 与驱动。锁住首个实例，后续动效都作用在该实例上，避免给到未注册的空
  // Timeline。autoOn / currentIndex 变化驱动的 tween 也复用同一实例。
  const initialTimeline = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  const [borderPhase, setBorderPhase] = useState(0);
  // force 用于驱动由 timeline 直接 mutate 的 ref（entryRef / autoMixRef /
  // levelMixRef）重渲染——`tick` 不被读取，仅作 setState 触发器。
  const [, force] = useState(0);

  // ── 入场 target：顶层 box 的 marginTop + opacity，被 timeline 直接改写 ──
  const entryRef = useRef<{ marginTop: number; opacity: number }>({
    marginTop: -2,
    opacity: 0,
  });
  // ── Auto 圆点 mix：0 = dim，1 = running ──
  const autoMixRef = useRef<{ mix: number }>({
    mix: model.autoOn ? 1 : 0,
  });
  // ── 当前档指示 mix：0 = dim，1 = running ──
  const levelMixRef = useRef<{ mix: number }>({ mix: 1 });

  // 边框流光相位：8s 线性循环，每帧 onUpdate → setBorderPhase（React bail-out
  // 跳过同值重渲；相邻 2 相位之间 RGB 插值，肉眼平滑无突变）。
  //
  // 不能给 item 设 loop:true：Timeline.loop 在周期结束时 resetItems → 重新
  // capture 初始值，此时 target.phase 已是 4，下一周期会冻结在 4。改为 item
  // onComplete 在 timeline reset 前把 target.phase 归零（update() 内 evaluateItem
  // 先于 loop-reset 执行），下一周期重新从 0 插值，无缝循环。
  useEffect(() => {
    const target = { phase: 0 };
    tl.add(target, {
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
  }, [tl]);

  // 入场动效（onMount once）：marginTop -2 → 0、opacity 0 → 1。
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

  // Auto 圆点切色：model.autoOn 变化 → dim ↔ running 200ms outExpo。
  useEffect(() => {
    const target = autoMixRef.current;
    const currentMix = target.mix;
    const targetMix = model.autoOn ? 1 : 0;
    if (currentMix === targetMix) return;
    tl.once(target, {
      mix: targetMix,
      duration: AUTO_DOT_DURATION_MS,
      ease: "outExpo",
      onUpdate: () => force((x) => x + 1),
    });
  }, [model.autoOn, tl]);

  // 当前档指示切色：model.currentIndex 变化 → dim → running 180ms outQuad。
  useEffect(() => {
    const target = levelMixRef.current;
    target.mix = 0;
    tl.once(target, {
      mix: 1,
      duration: LEVEL_DURATION_MS,
      ease: "outQuad",
      onUpdate: () => force((x) => x + 1),
    });
  }, [model.currentIndex, tl]);

  // ── 派生值（ref 被 timeline 原地改写，force setState 后读到最新） ──
  const entry = entryRef.current;
  const autoDotGlyph = model.autoOn ? "◐" : "◑"; // ◐ / ◑
  const autoDotColor = mixHex(pal.dim, pal.running, autoMixRef.current.mix);
  const currentLevelColor = mixHex(
    pal.dim,
    pal.running,
    levelMixRef.current.mix
  );
  const autoDesc = model.autoOn
    ? "自适应档位" // 自适应档位
    : "手动档位"; // 手动档位

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginTop={entry.marginTop}
      opacity={entry.opacity}
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
        <span fg={autoDotColor}>{`${autoDotGlyph}  `}</span>
        <span fg={pal.dim}>AUTO</span>
        <span fg={pal.dim}>{`  ·  ${autoDesc}`}</span>
      </text>

      {/* 5 档密度组合 + 档位名：每列 combo 上、name 下；当前档 BOLD 强调。 */}
      <box flexDirection="row" gap={2} alignItems="center">
        {EFFORT_LEVELS.map((level, i) => {
          const current = i === model.currentIndex;
          const combo = DENSITY_COMBOS[i] ?? "";
          return (
            <box key={level} flexDirection="column" alignItems="center">
              <text
                fg={current ? currentLevelColor : pal.dim}
                attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}
              >
                {combo}
              </text>
              <text
                fg={current ? pal.running : pal.dim}
                attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}
              >
                {level}
              </text>
            </box>
          );
        })}
      </box>

      {/* 密度阶梯锚定文字（必含元素 4 验收口径，整条 dim）。 */}
      <text fg={pal.dim}>{LADDER_PREVIEW}</text>

      {/* 键位提示。 */}
      <text fg={pal.dim}>
        {"[← →] 切档  ·  [Tab/Space] 切 Auto  ·  [Enter] 确认  ·  [Esc] 取消"}
      </text>
    </box>
  );
}

export const design5: ThinkingDesign = {
  meta: {
    id: "design-5-gradient",
    name: "玻璃渐变风", // 玻璃渐变风
    tag: "Glass Gradient",
    summary: "圆角 + 流光渐变边框 + outExpo 入场 + 切档颜色平滑过渡。", // 圆角 + 流光渐变边框 + outExpo 入场 + 切档颜色平滑过渡。
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    GradientDesignRender(props) as unknown as ReactElement,
};
