/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-21-aurora.tsx
 *
 * 思考面板 · 极光粒子风（Thinking 面板设计 21，demo gallery 候选）。
 *
 * 设计语言
 *  - 「极光 = 绿色（pal.add）+ 灰绿（pal.bgRunning）+ 粉金（pal.logoGold）」
 *    三色调；正文 `pal.text`，辅助 `pal.dim`，不新增任何颜色常量。
 *  - 5 档轨道上撒 8 个「极光粒子」：5 个「轨道粒子」（每档 1 个 `·`，
 *    绿系闪烁）+ 3 个「间隙漂移点」（`: ° • ·` 三字符随相位轮替，
 *    粉金系闪烁）。共 3 组错相位 alternate loop（800 / 1100 / 1400ms），
 *    由 3 条 `useTimeline` 驱动（任务硬性要求：≥ 3 错相位粒子动效）。
 *  - 当前档指示 = 亮 `●`（pal.running BOLD），以 translateX（200ms
 *    outQuad）从旧档"飞"到新档——这是切档的唯一位移动效。
 *  - 焦点游标独立于当前档：focusIndex 在档位标签行以 `pal.accent` BOLD
 *    显示（autoOn 时 focusIndex=-1，焦点回到 Auto 标签）。
 *  - Auto 圆点硬需求两态：开 `●`（金 BOLD）/ 关 `○`（灰 dim）。
 *  - 入场：整面板 opacity 0 → 1，220ms outQuad，无弹跳。
 *
 * 动效挂钩
 *  - 3 条粒子 timeline 走 `useTimeline({ duration: INFINITE_MS })`：hook
 *    首 render 实例经 mount effect 自动 `play + engine.register`，unmount
 *    自动 `pause + unregister`；后续 render 返回的是未注册的 fresh
 *    Timeline，被 GC 掉（design-2 / design-3 已验证）。每条 timeline 用
 *    item 级 `loop: true, alternate: true` 永续 0↔1 振荡，配合不同
 *    `duration` + 组内 `startTime` 错位实现「三组错相位」。
 *  - 滑块 translateX 走 useRef lazy Timeline + engine.register 模式
 *    （design-1 / design-4 验证）：每次 currentIndex 变化 resetItems +
 *    add + play。translateX 绝不出现在 React prop（reconciler 会按旧值
 *    set 覆盖），仅由 imperative 初始赋值与 timeline 的 add 驱动。
 *  - 入场 fade 走同模式的 useRef lazy Timeline + engine.register。
 *  - 粒子相位变化以「quantize 到 1/16 阶」+ force setState 触发 React 重渲
 *    （design-5 验证），每粒子每次跨阶才 force 一次，整体降频到约 2-4 次
 *    重渲/秒，避免每帧重渲。
 *
 * 动效常驻预算：3 条粒子 timeline（"极光粒子明灭" 1 类）+ 滑块飞行动效 +
 * 入场 fade。滑块与入场都是事件触发而非常驻，常驻类别仅 1 类 ≤ 2 类别。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { BoxRenderable, TextAttributes, Timeline, engine } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import { EFFORT_LEVELS } from "./_contract.js";
import type { ThinkingDesign, ThinkingDesignProps } from "./_contract.js";

// ── 常量 ────────────────────────────────────────────────────────────────
/** 粒子明灭三组错相位周期（ms）。任务硬性要求 ≥ 3 组。 */
const PARTICLE_PERIODS: readonly [number, number, number] = [800, 1100, 1400];

/** timeline 层"足够长"时长（1h）：绕开 timeline loop resetItems 重捕获
 *  初值陷阱；item 层 `loop: true, alternate: true` 自带永续振荡，无需
 *  timeline 层 loop。 */
const INFINITE_MS = 3_600_000;

/** 入场 fade 时长（outQuad，无弹跳）。 */
const FADE_MS = 220;

/** 滑块位移时长（切档时主粒子从旧档飞到新档）。 */
const SLIDE_MS = 200;

/** 极光轨道总宽（与档位行 `" low  medium  high  xhigh  max "` 对齐；
 *  1 + 3 + 2 + 6 + 2 + 4 + 2 + 5 + 2 + 3 + 1 = 31）。 */
const TRACK_LEN = 31;

/** 5 档轨道中心横坐标（由档位行文本坐标推得）。
 *   " low  medium  high  xhigh  max "
 *     ^1   ^6       ^14    ^20      ^27
 *      ^2  ^9.5→8   ^15.5→16 ^22.5→22  ^28.5→28 */
const LEVEL_X: readonly number[] = [2, 8, 15, 22, 28];

/** 3 个间隙漂移点横坐标（落在档与档的中点附近）。 */
const DRIFT_X: readonly number[] = [5, 12, 25];

// ── 颜色工具 ────────────────────────────────────────────────────────────
/** `#rrggbb` → [r, g, b]∈[0, 255]³；非法 hex 返 0（兜底）。 */
function parseHex(hex: string): readonly [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff] as const;
}
/** 两 hex 色按 t∈[0, 1] 线性混合 → `#rrggbb`。 */
function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  const hex = ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0");
  return `#${hex}`;
}

/** 漂移点按 quantize 相位选择当前字符。三档阈值：低相位→首字，
 *  中相位→次字，高相位→尾字。轨道粒子字形集长度为 1，直接返回。 */
function driftGlyph(glyphs: readonly string[], q: number): string {
  if (glyphs.length === 1) return glyphs[0] ?? "·";
  let idx = 0;
  if (q >= 0.75) idx = 2;
  else if (q >= 0.4) idx = 1;
  return glyphs[idx] ?? glyphs[0] ?? "·";
}

// ── 粒子规格表（8 个错相位极光粒子） ──────────────────────────────────────
interface ParticleSpec {
  /** 轨道内横坐标。 */
  readonly x: number;
  /** 字符集：轨道粒子单字 `·`；漂移点随相位在三字之间轮替，模拟漂移。 */
  readonly glyphs: readonly string[];
  /** 错相位组索引（0/1/2 → 800/1100/1400ms）。 */
  readonly periodIdx: number;
  /** 组内起始时间错位（ms）。 */
  readonly startMs: number;
  /** orbiter = 档位轨道粒子（绿系闪烁）；drift = 间隙漂移点（金系闪烁）。 */
  readonly kind: "orbiter" | "drift";
}

/** 8 个极光粒子：5 轨道 + 3 漂移；三组错相位 alternate loop（800/1100/1400ms）。
 *  组 A 800ms：orbiters 0/2 + drift 12（共 3 个）
 *  组 B 1100ms：orbiters 1/3 + drift  5（共 3 个）
 *  组 C 1400ms：orbiter 4 + drift 25    （共 2 个） */
const PARTICLE_SPECS: readonly ParticleSpec[] = [
  { x: LEVEL_X[0]!, glyphs: ["·"], periodIdx: 0, startMs: 0, kind: "orbiter" },
  { x: LEVEL_X[1]!, glyphs: ["·"], periodIdx: 1, startMs: 0, kind: "orbiter" },
  {
    x: LEVEL_X[2]!,
    glyphs: ["·"],
    periodIdx: 0,
    startMs: 400,
    kind: "orbiter",
  },
  {
    x: LEVEL_X[3]!,
    glyphs: ["·"],
    periodIdx: 1,
    startMs: 550,
    kind: "orbiter",
  },
  { x: LEVEL_X[4]!, glyphs: ["·"], periodIdx: 2, startMs: 0, kind: "orbiter" },
  {
    x: DRIFT_X[0]!,
    glyphs: [":", "•", "·"],
    periodIdx: 1,
    startMs: 275,
    kind: "drift",
  },
  {
    x: DRIFT_X[1]!,
    glyphs: ["°", ":", "•"],
    periodIdx: 0,
    startMs: 200,
    kind: "drift",
  },
  {
    x: DRIFT_X[2]!,
    glyphs: ["•", "°", ":"],
    periodIdx: 2,
    startMs: 350,
    kind: "drift",
  },
];

// ── 渲染组件 ────────────────────────────────────────────────────────────
function AuroraPanel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex } = model;

  // ── 引用：面板（fade opacity）、滑块（translateX）、粒子相位（timeline
  //    直接改写 + quantize 桶 + force 触发重渲）。 ──
  const panelRef = useRef<BoxRenderable | null>(null);
  const sliderRef = useRef<BoxRenderable | null>(null);
  const particleTargetsRef = useRef<ReadonlyArray<{ p: number; q: number }>>(
    PARTICLE_SPECS.map(() => ({ p: 0, q: 0 }))
  );
  const [, force] = useState(0);

  // ── 3 条错相位粒子 timeline：`useTimeline` 首 render 实例被 engine 注册
  //    与 play；后续 render 返回的 fresh Timeline 未注册——被 GC。
  //    useRef 锁住首 render 实例，把 slide/fade 两条懒创建的 Timeline
  //    也合并到一个稳定 ref 里（design-2 / design-4 验证模式）。 ──
  const particleTlA = useTimeline({ duration: INFINITE_MS, autoplay: false });
  const particleTlB = useTimeline({ duration: INFINITE_MS, autoplay: false });
  const particleTlC = useTimeline({ duration: INFINITE_MS, autoplay: false });
  const tlRef = useRef({
    a: particleTlA,
    b: particleTlB,
    c: particleTlC,
    slide: new Timeline({ autoplay: false }),
    fade: new Timeline({ autoplay: false }),
  });
  const tl = tlRef.current;

  // ── mount/unmount：注册 slide/fade 两条 lazy timeline；初始化滑块位置
  //    与入场 fade；按错相位组添加 8 个粒子项并启动。 ──
  useEffect(() => {
    engine.register(tl.slide);
    engine.register(tl.fade);

    // 入场 fade-in：panelRef.current.opacity 0 → 1
    if (panelRef.current) {
      tl.fade.resetItems();
      tl.fade.add(panelRef.current, {
        opacity: 1,
        duration: FADE_MS,
        ease: "outQuad",
        onComplete: () => force((x) => x + 1),
      });
      tl.fade.play();
    }

    // 粒子：3 条 timeline，按 PARTICLE_SPECS.periodIdx 派发；组内 startMs
    // 再错位形成 8 个互不重合的明灭相位。target.q 存 1/16 quantize 值，
    // onUpdate 跨桶时再 force——避免每帧 8 次 setState。
    const groups: ReadonlyArray<Timeline> = [tl.a, tl.b, tl.c];
    PARTICLE_SPECS.forEach((spec, i) => {
      const gtl = groups[spec.periodIdx]!;
      const target = particleTargetsRef.current[i]!;
      const period = PARTICLE_PERIODS[spec.periodIdx]!;
      gtl.add(
        target,
        {
          p: 1,
          duration: period,
          ease: "inOutSine",
          alternate: true,
          loop: true,
          onUpdate: (a) => {
            const v = Math.round((a.targets[0]?.p ?? 0) * 16) / 16;
            if (target.q !== v) {
              target.q = v;
              force((x) => x + 1);
            }
          },
        },
        spec.startMs
      );
    });
    tl.a.play();
    tl.b.play();
    tl.c.play();

    return () => {
      tl.slide.pause();
      engine.unregister(tl.slide);
      tl.fade.pause();
      engine.unregister(tl.fade);
      // 粒子 timeline 由 useTimeline 的 unmount effect 自动 pause + unregister
    };
  }, [tl]);

  // ── autoOn 切换：滑块从无到有 / 从有到无，重新挂载时直接吸附到当前档位
  //    （不走飞行动画——切档飞行专用于用户在档位行手动左右切换）。 ──
  useEffect(() => {
    if (sliderRef.current) {
      sliderRef.current.translateX = LEVEL_X[currentIndex] ?? 0;
    }
  }, [autoOn, currentIndex]);

  // ── 切档滑块飞行：currentIndex 变化 → translateX 从旧位 → 新位，
  //    200ms outQuad。 ──
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    tl.slide.resetItems();
    tl.slide.add(slider, {
      translateX: LEVEL_X[currentIndex] ?? 0,
      duration: SLIDE_MS,
      ease: "outQuad",
    });
    tl.slide.play();
  }, [currentIndex, tl]);

  // ── 派生 ──
  const focusOnAuto = autoOn && focusIndex === -1;
  const sliderVisible = !autoOn;
  const hint = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";
  const borderColor = autoOn ? pal.running : pal.bgRunning;

  // 轨道 spans：按位置排序后构造 `─` 基线 + 粒子 span；颜色随粒子
  // quantize 相位从「轨道背景色」mix 到「极光色」（绿/金），字符本身
  // 漂移点按相位在三字之间轮替——配合空间错位形成极光漂移视感。
  const trackSpans = (): ReactNode => {
    const sorted = PARTICLE_SPECS.map((spec, i) => ({
      spec,
      target: particleTargetsRef.current[i]!,
    }))
      .slice()
      .sort((a, b) => a.spec.x - b.spec.x);
    const out: ReactNode[] = [];
    let pos = 0;
    sorted.forEach(({ spec, target }, j) => {
      if (spec.x > pos) {
        const pad = spec.x - pos;
        out.push(
          <span key={`base-${j}`} fg={pal.bgRunning}>
            {"─".repeat(pad)}
          </span>
        );
      }
      const q = target.q;
      const fg =
        spec.kind === "orbiter"
          ? mixHex(pal.bgRunning, pal.add, q)
          : mixHex(pal.dim, pal.logoGold, q);
      const glyph = driftGlyph(spec.glyphs, q);
      out.push(
        <span
          key={`p-${spec.x}`}
          fg={fg}
          attributes={q > 0.55 ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {glyph}
        </span>
      );
      pos = spec.x + 1;
    });
    if (pos < TRACK_LEN) {
      out.push(
        <span key="base-tail" fg={pal.bgRunning}>
          {"─".repeat(TRACK_LEN - pos)}
        </span>
      );
    }
    return out;
  };

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
      {/* 标题 ◆─ Thinking · aurora（金 ◆ + 白 THINKING + dim 副标） */}
      <text>
        <span fg={pal.logoGold} attributes={TextAttributes.BOLD}>
          {"◆ "}
        </span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
        <span fg={pal.dim}>{"  ·  aurora effort"}</span>
      </text>

      {/* Auto 行：●/○ 两态 + AUTO 标签（焦点回 Auto 时高亮） */}
      <text>
        <span
          fg={autoOn ? pal.running : pal.dim}
          attributes={autoOn ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {autoOn ? "●" : "○"}
        </span>
        <span
          fg={focusOnAuto ? pal.accent : pal.dim}
          attributes={focusOnAuto ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {"  AUTO  ·  "}
        </span>
        <span fg={pal.dim}>
          {autoOn ? "adaptive (server picks)" : "concrete effort"}
        </span>
      </text>

      {/* 档位标签行（焦点游标）：focusIndex 在该行以 accent BOLD 显示。 */}
      <text wrapMode="none">
        <span fg={pal.dim}> </span>
        {EFFORT_LEVELS.map((level, i) => {
          const isFocused = !autoOn && i === focusIndex;
          return (
            <span
              key={level}
              fg={isFocused ? pal.accent : pal.dim}
              attributes={isFocused ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {level}
              {i < EFFORT_LEVELS.length - 1 ? "  " : ""}
            </span>
          );
        })}
        <span fg={pal.dim}> </span>
      </text>

      {/* 极光轨道 + 滑块 overlay：轨道文本提供行高，滑块 absolute overlay
          在当前档中心 x；切档时 translateX 飞行。 */}
      <box width="100%" flexDirection="row">
        <text wrapMode="none">{trackSpans()}</text>
        {sliderVisible && (
          <box ref={sliderRef} position="absolute" left={0}>
            <text fg={pal.running} attributes={TextAttributes.BOLD}>
              {"●"}
            </text>
          </box>
        )}
      </box>

      {/* 键位提示 */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

export const design21: ThinkingDesign = {
  meta: {
    id: "design-21-aurora",
    name: "极光粒子风",
    tag: "Aurora Particles",
    summary:
      "极光三色调（绿/灰绿/粉金）+ 8 个错相位极光粒子 + 三组 alternate loop（800/1100/1400ms）+ 滑块 translateX 飞档。",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    (<AuroraPanel {...props} />) as ReactElement,
};
