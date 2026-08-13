/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-18-rising.tsx
 *
 * 思考面板设计 18：阶梯上升 / 涨潮瀑布（Rising Waterfall）。
 *
 * 设计要点
 *  - 视觉锚：底部一排 `▁▂▃▄▅▆▇█` 8 格阶梯字符，作为"水位"指示；当前档
 *    所在列是波峰，相邻列以三角函数渐降高度，整条字符阶梯从低往高"涨"
 *    起来（涨潮效果）。
 *  - 阶梯上升：切档（model.focusIndex / currentIndex 变化、autoOn 切换）
 *    时驱动 `useTimeline` 200-300ms 内逐级展开水位——用单一 waveClock
 *    0→1 线性的时间轴推 8 个 block 的局部进度（localT = waveClock *
 *    RISE_TOTAL/RISE_MS − i * STAGGER_MS/RISE_MS），渲染侧以 per-block
 *    缓动 + 字符映射实现"从左往右逐列涨起、颜色从灰渐金"瀑布动效。
 *  - 边框呼吸（常驻 1）：整框 borderColor 在 `pal.border` ↔ `pal.running`
 *    间 2600ms alternate inOutSine 缓慢呼吸，营造"水面倒影"质感。
 *  - Auto 圆点呼吸（常驻 2，仅 Auto on 时）：`●` 在 `pal.running` ↔
 *    `pal.logoGold` 间 1200ms alternate inOutSine；Auto off 时圆点为
 *    静态 `○ dim`，让出常驻槽。
 *  - 入场（一次性）：外层 box `marginTop -3 → 0`，360ms outQuad 滑落。
 *  - Auto 开时水位整体塌为 0（"退潮/枯水"）；Auto 关且 picker 关闭时
 *    波峰跟随 currentIndex，picker 打开时跟随 focusIndex（"涨潮"跟随
 *    当前交互档）。
 *  - 焦点游标 `▸`（pal.accent BOLD）前缀于 focusIndex 对应档位名，独
 *    立于 currentIndex（金色 BOLD 档位名）。
 *
 * 颜色纪律：所有颜色 100% 来自 `tuiPalette`，未新增任何颜色常量；hex 字
 * 符串由 OpenTUI 渲染器按终端能力降级，应用层不手写 ANSI。
 *
 * `useTimeline` 注意：hook 每次 render 都 new 一个 Timeline 实例，但只
 * 首个会被 engine 注册（@opentui/react index.js useTimeline 实现 mount
 * 副作用 `[]` 仅首次跑）。本设计用 `useRef` 懒初始化锁住首实例，所有
 * `.add()` / `.play()` / `.pause()` 都作用在该 stable ref 上，避开
 * 后续 render 引用漂移（pattern 来自 design-2 / design-5）。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { TextAttributes, type Timeline as TimelineT } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

// ── 常量 ──────────────────────────────────────────────────────────────
/** 水位阶梯字符（8 阶 U+2581–2588，由低到高）。 */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const BLOCKS_LEN = BLOCKS.length;

/** 水位阶梯列数 = BLOCKS_LEN（每列一格）。 */
const WAVE_BLOCKS = BLOCKS_LEN;

/** 单列从 0 涨到目标高度耗时（per-block rise）。 */
const RISE_MS = 260;
/** 列间阶梯延迟（wave 从左往右"扫"）。 */
const STAGGER_MS = 32;
/** 整条阶梯涨起总时长 = RISE_MS + (WAVE_BLOCKS-1) * STAGGER_MS。 */
const RISE_TOTAL_MS = RISE_MS + (WAVE_BLOCKS - 1) * STAGGER_MS;

/** 边框呼吸周期（alternate ping-pong = 2 × item duration）。 */
const BORDER_BREATH_MS = 2600;
/** Auto 圆点呼吸周期。 */
const DOT_BREATH_MS = 1200;
/** 面板入场滑落时长。 */
const ENTRY_MS = 360;

/** 每列目标高度函数（峰值在 peakCol，向两侧线性下降）。 */
const PEAK_FALLOFF = 2.6;

/** 当前档 → 8 列坐标的中心列（线性映射）。 */
function levelCenter(levelIdx: number): number {
  const t = levelIdx / (EFFORT_LEVELS.length - 1);
  return t * (WAVE_BLOCKS - 1);
}

/** 单列的目标高度（0..1）。autoOn 时一律返回 0（"退潮"）。 */
function targetHeightOf(blockIdx: number, peakCol: number | null): number {
  if (peakCol === null) return 0;
  const d = Math.abs(blockIdx - peakCol);
  return Math.max(0, 1 - d / PEAK_FALLOFF);
}

/** outQuad（[0,1] → [0,1]），per-block 字符映射的局部缓动。 */
function easeOutQuad(t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return 1 - (1 - k) * (1 - k);
}

// ── 颜色工具 ──────────────────────────────────────────────────────────
/** `#rrggbb` → {r,g,b}∈[0,255]。非法输入回退纯白（与 design-2 同口径）。 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return { r: 255, g: 255, b: 255 };
  const v = parseInt(m[1] as string, 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/** 两色按 t∈[0,1] RGB 线性插值 → `#rrggbb`。边框呼吸 / 水位着色都用。 */
function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const r = Math.round(pa.r + (pb.r - pa.r) * k);
  const g = Math.round(pa.g + (pb.g - pa.g) * k);
  const bl = Math.round(pa.b + (pb.b - pa.b) * k);
  const to2 = (n: number): string =>
    Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(bl)}`;
}

// ── 渲染组件 ──────────────────────────────────────────────────────────
function RisingWaterfall(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // ── Timeline 引用（useTimeline 每次 render 换实例 → useRef 锁首实例）
  const entryTimeline = useTimeline({ duration: ENTRY_MS, autoplay: true });
  const borderTimeline = useTimeline({
    duration: BORDER_BREATH_MS * 2,
    loop: true,
    autoplay: true,
  });
  const dotTimeline = useTimeline({
    duration: DOT_BREATH_MS * 2,
    loop: true,
    autoplay: true,
  });
  // 水位 time-line：autoplay:false（mount 时无 item、无需预播），手动在
  // 切档 effect 里 add item + play()。
  const waveTimeline = useTimeline({
    duration: RISE_TOTAL_MS,
    autoplay: false,
  });
  const tlRefs = useRef<{
    entry: TimelineT;
    border: TimelineT;
    dot: TimelineT;
    wave: TimelineT;
  }>({
    entry: entryTimeline,
    border: borderTimeline,
    dot: dotTimeline,
    wave: waveTimeline,
  });
  const tl = tlRefs.current;

  // ── 入场：marginTop -3 → 0，360ms outQuad。
  const entryTargetRef = useRef<{ y: number }>({ y: -3 });
  const [entryY, setEntryY] = useState<number>(-3);

  // ── 边框呼吸（常驻 1）：borderColor = mix(border, running, t)。
  const borderTargetRef = useRef<{ p: number }>({ p: 0 });
  const [borderColor, setBorderColor] = useState<string>(pal.border);

  // ── Auto 圆点呼吸（常驻 2，仅 autoOn 时活跃）：color = mix(running, logoGold, t)。
  const dotTargetRef = useRef<{ p: number }>({ p: 0 });
  const [dotColor, setDotColor] = useState<string>(pal.running);

  // ── 水位 clock（0..1）：单一 target 对象，整条阶梯按此驱动。
  const waveClockRef = useRef<{ waveClock: number }>({ waveClock: 1 });
  const [waveClock, setWaveClock] = useState<number>(1);
  // 首次渲染不触发动画（避免入场叠加）。
  const isFirstWaveRef = useRef<boolean>(true);

  // ── 派生：effectiveLevel（autoOn 时无波峰；picker 打开 → focusIndex；否则 currentIndex）
  const effectivePeak =
    autoOn || focusIndex < 0 || focusIndex >= EFFORT_LEVELS.length
      ? null
      : focusIndex;
  const effectivePeakCol =
    effectivePeak === null ? null : levelCenter(effectivePeak);

  // ── mount-only：挂载动画项 + dot gating。
  useEffect(() => {
    // 入场：once = true，add 后 timeline 立刻 play（autoplay:true）。
    tl.entry.add(entryTargetRef.current, {
      y: 0,
      duration: ENTRY_MS,
      ease: "outQuad",
      once: true,
      onUpdate: (a) => setEntryY(Math.round(a.targets[0]?.y ?? 0)),
    });
    // 边框呼吸：item-level loop + alternate（设计 03 INFINITE_MS 套路简化）。
    tl.border.add(borderTargetRef.current, {
      p: 1,
      duration: BORDER_BREATH_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (a) => {
        const v = a.targets[0]?.p ?? 0;
        setBorderColor(mixHex(pal.border, pal.running, v));
      },
    });
    // Auto 圆点呼吸：初始 gating（autoOn on → 留着；off → 暂停+回退 running）。
    tl.dot.add(dotTargetRef.current, {
      p: 1,
      duration: DOT_BREATH_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (a) => {
        const v = a.targets[0]?.p ?? 0;
        setDotColor(mixHex(pal.running, pal.logoGold, v));
      },
    });
    if (!autoOn) {
      tl.dot.pause();
      setDotColor(pal.running);
    }
    // 入场完成后再允许 wave 触发动画。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── autoOn 切换 gating：dot timeline 暂停/播放。
  useEffect(() => {
    if (autoOn) {
      tl.dot.play();
    } else {
      tl.dot.pause();
      setDotColor(pal.running);
    }
  }, [autoOn, tl, pal.running]);

  // ── 切档 / autoOn 切换 → 水位重涨。
  useEffect(() => {
    const wt = tl.wave;
    // 重置目标时钟 = 0（所有 block 的字符与颜色从最低/最暗起步）。
    waveClockRef.current.waveClock = 0;
    // 清空 items：上一次的 wave item (once:true) 通常已被 engine splice，
    // 但为保险手动清。
    wt.items.length = 0;
    wt.currentTime = 0;
    wt.isComplete = false;
    if (isFirstWaveRef.current) {
      // 首次渲染不触发动画（与入场叠加），直接把水位"灌满"。
      isFirstWaveRef.current = false;
      waveClockRef.current.waveClock = 1;
      setWaveClock(1);
      return;
    }
    wt.add(waveClockRef.current, {
      waveClock: 1,
      duration: RISE_TOTAL_MS,
      ease: "linear",
      once: true,
      onUpdate: (a) => {
        const v = a.targets[0]?.waveClock ?? 0;
        setWaveClock(v);
      },
    });
    wt.play();
  }, [effectivePeak, tl]);

  // ── 渲染时计算 8 列的字符与颜色 ──
  // waveClock 0..1 → 每列 localT = waveClock*ratio − i*staggerFrac（钳制 [0,1]）
  const ratio = RISE_TOTAL_MS / RISE_MS;
  const staggerFrac = STAGGER_MS / RISE_MS;
  const waveCells: { glyph: string; color: string }[] = [];
  for (let i = 0; i < WAVE_BLOCKS; i++) {
    const localT = Math.max(
      0,
      Math.min(1, waveClock * ratio - i * staggerFrac)
    );
    const eased = easeOutQuad(localT);
    const charIdx = Math.min(
      BLOCKS_LEN - 1,
      Math.round(eased * (BLOCKS_LEN - 1))
    );
    const targetH = targetHeightOf(i, effectivePeakCol);
    // 颜色：当前动画进度 × 目标高度 → dim↔running 混合（水涨时由暗变金）。
    const colorMix = eased * targetH;
    const fg = mixHex(pal.dim, pal.running, colorMix);
    waveCells.push({ glyph: BLOCKS[charIdx] ?? "▁", color: fg });
  }

  // ── 派生：label 行（focus 游标 + current 高亮 + 5 档名） ──
  const labelCells = EFFORT_LEVELS.map((level, i) => {
    const isCurrent = i === currentIndex;
    const isFocused = open && !autoOn && i === focusIndex;
    return { level, isCurrent, isFocused };
  });

  // ── 键位提示行 ──
  const hintText = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  return (
    <box
      flexDirection="column"
      borderStyle="double"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      marginTop={entryY}
      width={Math.max(1, cols)}
    >
      {/* 标题行：≋ Thinking（金 + logoGold 渐变前缀） */}
      <text>
        <span fg={pal.logoGold} attributes={TextAttributes.BOLD}>
          {"≋ "}
        </span>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          Thinking
        </span>
      </text>

      {/* Auto 行：●/○ + AUTO + 状态描述 */}
      <text>
        <span
          fg={autoOn ? dotColor : pal.dim}
          attributes={autoOn ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {autoOn ? "●" : "○"}
        </span>
        <span
          fg={autoOn ? pal.running : pal.dim}
          attributes={autoOn ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {`  AUTO  ·  ${autoOn ? "自适应档位" : "手动档位"}`}
        </span>
      </text>

      {/* 档位名行：focus ▸ 游标 + current 金高亮 */}
      <text wrapMode="none">
        {labelCells.map(({ level, isCurrent, isFocused }, i) => {
          const fg = isCurrent ? pal.running : isFocused ? pal.accent : pal.dim;
          const attr =
            isCurrent || isFocused ? TextAttributes.BOLD : TextAttributes.NONE;
          return (
            <span key={`lbl-${i}`} fg={fg} attributes={attr}>
              {isFocused ? "▸ " : "  "}
              {level}
              {i < labelCells.length - 1 ? "   " : ""}
            </span>
          );
        })}
      </text>

      {/* 水位阶梯 8 列：每列一格字符，颜色 dim→running 渐入 */}
      <text wrapMode="none">
        {waveCells.map((cell, i) => (
          <span key={`wave-${i}`} fg={cell.color}>
            {cell.glyph}
          </span>
        ))}
      </text>

      {/* 键位提示行 */}
      <text fg={pal.dim}>{hintText}</text>
    </box>
  );
}

// ── 导出 ──────────────────────────────────────────────────────────────
export const design18: ThinkingDesign = {
  meta: {
    id: "design-18-rising",
    name: "阶梯涨潮风",
    tag: "Rising Waterfall",
    summary:
      "double 边框呼吸 + 8 格水位阶梯随切档涨起 + Auto 圆点呼吸 + outQuad 滑落入场。",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    (<RisingWaterfall {...props} />) as ReactElement,
};
