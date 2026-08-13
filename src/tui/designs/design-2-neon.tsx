/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-2-neon.tsx
 *
 * Thinking-effort 思考面板 — Design 2：动感赛博风（NEON-GRID）。
 *
 * 5 版视觉候选之一（demo gallery 通过 1-5 切换）。每个 design 纯渲染 +
 * 复用 `_contract.ts` 的 `PickerModel` 接口；本文件只新增样式与动效，
 * 不触碰 `app.tsx` / `slash.ts` / `theme.ts` / `bundled.ts`（demo
 * gallery 聚合体），改 picker 形态时按 #343 选型流程。
 *
 * 视觉风格5要素（任务约束）：
 *  1. heavy 粗线边框（BorderStyle="heavy"）。
 *  2. 边框色在 `pal.running` ↔ `pal.logoGold` 之间 2000ms alternate
 *     ease "inOutSine" 持续脉冲（呼吸）。
 *  3. 入场 box 自身 `marginTop` 从 -2 → 0，400ms ease "outBack" 弹性
 *     回弹；入场动画仅 mount 时一次（一次性 onComplete 卸载）。
 *  4. title 行 `⚡ THINKING`（`pal.running` BOLD）+ 扫描线装饰
 *     `═══ · ═══ · ═══`（`pal.logoGold`）。
 *  5. 5 档递进色阶：低=pal.add / 中=pal.accent / 高=pal.running /
 *     极高=pal.logoGold / 顶=pal.error。该 5 档可视化条共 5 个高度
 *     递增的 `▁▂▃▄▅▆▇█` 字符（8 阶内均匀取 5 阶）。focused 时（picker
 *     打开 = `model.open`）全部统一升 `pal.running` BOLD。
 *  6. 当前档字符下划线脉冲：`BOLD|UNDERLINE` ↔ `BOLD`，800ms alternate
 *     ease "inOutSine"。Auto on 时本动画时空槽让给 Auto 圆点呼吸。
 *  7. Auto 圆点 `●` 在 `pal.running` ↔ `pal.logoGold` 之间 1000ms
 *     alternate ease "inOutSine" 呼吸（仅 Auto on 时）。
 *  8. 当前档指针 `▲`（U+25B2）居当前档字符正下方（仅 Auto off 时）。
 *  9. 键位提示：[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 ·
 *     [Esc] 取消（Auto on 时省 `[←/→]`）。
 *
 * 动效常驻预算：基础态 ≤ 2（边框呼吸 + 当前档下划线脉冲）。Auto on
 * 时切换为「边框呼吸 + Auto 圆点呼吸」两路，时空槽正好等于 2。入场
 * 一次性。切档 flash 走纯 React state + setTimeout（不挂 timeline，
 * 不计入"常驻"）。
 *
 * 周期非整数倍校验：
 *   边框周期 2000ms / 下划线周期 800ms / 圆点周期 1000ms。
 *   LCM(2000, 800, 1000) = 4000ms；模 4000ms 各相位不同时对齐于极
 *   端，避免视觉叠加闪点。各自的 timeline duration 取 2× item
 *   duration（alternate ping-pong 一轮 = 2 × item duration），在
 *   `timeline.loop=true` 触发的 resetItems 时恰好回到起点，无可见
 *   跳变。
 *
 * 颜色纪律：所有颜色 100% 来自 `tuiPalette`（theme.ts），未新增任
 * 何颜色常量；hex 字符串由 OpenTUI 渲染器按终端能力降级，应用层不
 * 写 ANSI。
 *
 * `useTimeline` 注意事项（来自 @opentui/react 0.5.1）：hook 实现的
 * mount 副作用 `useEffect(..., [])` 只在首次 render 执行，并把该
 * 次返回的 Timeline 注入 engine + play；后续 render 返回的是全新
 * Timeline（不会被 engine 处理）。因此本组件用 `useRef(useTimeline
 * 调用结果)` 捕获首 render 实例，所有 `.add()` / `.pause()` / `.play()`
 * 都在 stable ref 上调用，避开 hook 引用漂移。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useTimeline } from "@opentui/react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type PickerModel,
  type ThinkingDesign,
} from "./_contract.js";

// ── 常量 ──────────────────────────────────────────────────────────────
const FIVE_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const FIVE_BARS_HEIGHT = FIVE_BARS.length; // 8

/** 5 档色阶（用 `tuiPalette` 现有 token，禁止新增色）。 */
const COLORS = [
  tuiPalette.add, // low
  tuiPalette.accent, // medium
  tuiPalette.running, // high
  tuiPalette.logoGold, // xhigh
  tuiPalette.error, // max
] as const;

/** 周期（毫秒）—— 故意互不谐振（见头注释）。 */
const BORDER_PULSE_MS = 2000;
const UNDERLINE_PULSE_MS = 800;
const DOT_PULSE_MS = 1000;
const ENTRY_MS = 400;

// ── 颜色工具 ──────────────────────────────────────────────────────────
/** `#rrggbb` → [r, g, b]∈[0,1]³。供 `mixHex` 用。 */
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

/** 两色按 t∈[0,1] 线性混合 → `#rrggbb` 字符串。border 脉冲 / dot
 *  呼吸通过该函数把单项 0..1 数值映射回 hex 字符串喂给 `borderColor`
 *  / `fg` prop。 */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round((ar + (br - ar) * t) * 255);
  const g = Math.round((ag + (bg - ag) * t) * 255);
  const bl = Math.round((ab + (bb - ab) * t) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** 边框与 dot 用的同一调色板（pal.running ↔ pal.logoGold）—— 同
 *  一函数生成不同语义字符串，避免 shadowing 资源。 */
const mixRunningGold = (t: number): string =>
  mixHex(tuiPalette.running, tuiPalette.logoGold, t);

// ── 渲染组件 ────────────────────────────────────────────────────────
function Design2Neon(props: { readonly model: PickerModel }): ReactNode {
  const pal = tuiPalette;
  const { model } = props;
  const autoOn = model.autoOn;
  const currentIndex = model.currentIndex;
  const focused = model.open; // picker 打开 = focus 态
  const levels = EFFORT_LEVELS as readonly EffortLevel[];

  // ── 入场动画 ─────────────────────────────────────────────────────
  const [entryShift, setEntryShift] = useState<number>(-2);
  const entryTargetRef = useRef<{ shift: number }>({ shift: -2 });

  // ── 边框呼吸（常驻） ─────────────────────────────────────────────
  const [borderColor, setBorderColor] = useState<string>(pal.running);
  const borderTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── 当前档下划线脉冲（Auto off 时常驻） ──────────────────────────
  const [underlineOn, setUnderlineOn] = useState<boolean>(false);
  const underlineTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── Auto 圆点呼吸（Auto on 时常驻） ──────────────────────────────
  const [dotColor, setDotColor] = useState<string>(pal.running);
  const dotTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── 切档 flash（轻量） ───────────────────────────────────────────
  const [flashOn, setFlashOn] = useState<boolean>(false);

  // ── Timeline 引用 ────────────────────────────────────────────────
  // 每个 useTimeline 内部 mount effect 仅处理首 render 的 Timeline
  // ；后续 render 返回的是引擎未注册的 fresh 对象。`useRef` 的初始
  // 值在每次 render 重新求值，但 `.current` 仅保留首 render 引用，
  // 因此 `.add()` / `.pause()` / `.play()` 全部落到引擎持有的实例
  // 上。
  const entryTimeline = useTimeline({
    duration: ENTRY_MS,
    autoplay: true,
  });
  const borderTimeline = useTimeline({
    duration: BORDER_PULSE_MS * 2, // alternate ping-pong = 2× item duration
    loop: true,
    autoplay: true,
  });
  const underlineTimeline = useTimeline({
    duration: UNDERLINE_PULSE_MS * 2,
    loop: true,
    autoplay: true,
  });
  const dotTimeline = useTimeline({
    duration: DOT_PULSE_MS * 2,
    loop: true,
    autoplay: true,
  });
  const tlRefs = useRef<{
    entry: Timeline;
    border: Timeline;
    underline: Timeline;
    dot: Timeline;
  }>({
    entry: entryTimeline,
    border: borderTimeline,
    underline: underlineTimeline,
    dot: dotTimeline,
  });
  const tl = tlRefs.current;

  // ── mount-only effect：挂载动画项（一次性，不重挂） ─────────────
  // deps = [tl]（stable ref 首 render 引用），确保本 effect 仅在
  // 组件 mount 时跑一次，避免后续 render 因 entryTimeline 等是
  // 新对象而触发 `.add()` 累积。
  useEffect(() => {
    tl.entry.add(entryTargetRef.current, {
      duration: ENTRY_MS,
      ease: "outBack",
      once: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.shift ?? 0;
        setEntryShift(Math.round(v * 100) / 100);
      },
      onComplete: () => {
        setEntryShift(0);
      },
    });
    tl.border.add(borderTargetRef.current, {
      duration: BORDER_PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setBorderColor(mixRunningGold(v));
      },
    });
    tl.underline.add(underlineTargetRef.current, {
      duration: UNDERLINE_PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setUnderlineOn(v > 0.5);
      },
    });
    tl.dot.add(dotTargetRef.current, {
      duration: DOT_PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setDotColor(mixRunningGold(v));
      },
    });
    // 初始 gating：Auto on 才挂 dot 圆点；Auto off 才挂下划线脉冲。
    // 用 useTimeline 的 autoplay 在所有 timeline 上先 play，再按
    // autoOn 立刻 pause 不需要的，符合「常驻 ≤2」预算。
    if (autoOn) {
      tl.underline.pause();
      setUnderlineOn(false);
    } else {
      tl.dot.pause();
      setDotColor(pal.running);
    }
    // 注：mount-only；cleanup 留给 useTimeline 内部 unmount 效应。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl]);

  // ── autoOn 切换 gating（空间槽保证 ≤2 动画） ─────────────────────
  useEffect(() => {
    if (autoOn) {
      tl.underline.pause();
      setUnderlineOn(false);
      tl.dot.play();
    } else {
      tl.dot.pause();
      setDotColor(pal.running);
      tl.underline.play();
    }
  }, [autoOn, tl, pal.running]);

  // ── 切档 flash：当前档变化时 150ms 颜色高亮再还原 ─────────────
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    setFlashOn(true);
    const t = setTimeout(() => setFlashOn(false), 150);
    return () => clearTimeout(t);
  }, [currentIndex]);

  // ── 派生：当前档字符属性 ────────────────────────────────────────
  const currentAttr = ((): number => {
    let base = TextAttributes.BOLD;
    if (!autoOn && underlineOn) base |= TextAttributes.UNDERLINE;
    return base;
  })();

  // ── 扫描线装饰 ───────────────────────────────────────────────────
  const scanline = `═══ · ═══ · ═══`;

  // ── 键位提示 ─────────────────────────────────────────────────────
  const hintLines = autoOn
    ? `[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消`
    : `[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消`;

  // ── 5 档可视化条字符（8 阶 → 5 阶均匀映射） ─────────────────────
  const barOf = (levelIdx: number): string => {
    const h = Math.min(
      FIVE_BARS_HEIGHT - 1,
      Math.round((levelIdx * (FIVE_BARS_HEIGHT - 1)) / 4)
    );
    return FIVE_BARS[h] ?? "█";
  };

  // ── 当前档颜色（focused 态下所有档统一升 pal.running；平时按
  //  5 档色阶）。flash 期间短时切 pal.accent 增加视觉反馈。 ─────
  const colorOf = (i: number, isCurrent: boolean): string => {
    if (isCurrent && flashOn) return pal.accent;
    if (focused) return pal.running;
    return COLORS[i] ?? pal.dim;
  };

  return (
    <box
      flexDirection="column"
      marginTop={entryShift}
      borderStyle="heavy"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
    >
      {/* 标题行：⚡ THINKING + 扫描线 */}
      <box flexDirection="row">
        <text>
          <span fg={pal.running} attributes={TextAttributes.BOLD}>
            ⚡
          </span>
          <span fg={pal.running} attributes={TextAttributes.BOLD}>
            {"  THINKING  "}
          </span>
          <span fg={pal.logoGold}>{scanline}</span>
        </text>
      </box>

      {/* Auto 行 */}
      <box flexDirection="row" marginTop={0}>
        <text>
          {autoOn ? (
            <span fg={dotColor} attributes={TextAttributes.BOLD}>
              ●
            </span>
          ) : (
            <span fg={pal.dim}>○</span>
          )}
          <span>
            {"  AUTO  · adaptive (server picks effort / no concrete effort)"}
          </span>
        </text>
      </box>

      {/* 5 档可视化条 */}
      <box flexDirection="row" marginTop={0}>
        <text>
          {levels.map((level, i) => {
            const isCurrent = i === currentIndex;
            const color = colorOf(i, isCurrent);
            const attr = isCurrent ? currentAttr : TextAttributes.BOLD;
            return (
              <span key={`bar-${level}`} fg={color} attributes={attr}>
                {barOf(i)}
                {i < levels.length - 1 ? " " : ""}
              </span>
            );
          })}
        </text>
      </box>

      {/* 档位名 */}
      <box flexDirection="row" marginTop={0}>
        <text>
          {levels.map((level, i) => {
            const isCurrent = i === currentIndex;
            const color = isCurrent ? pal.running : pal.dim;
            const attr = isCurrent ? currentAttr : TextAttributes.NONE;
            return (
              <span key={`lbl-${level}`} fg={color} attributes={attr}>
                {level}
                {i < levels.length - 1 ? "  " : ""}
              </span>
            );
          })}
        </text>
      </box>

      {/* 当前档指针（仅 Auto off 时） */}
      {!autoOn && <CurrentPointer index={currentIndex} count={levels.length} />}

      {/* 键位提示 */}
      <box flexDirection="row" marginTop={0}>
        <text fg={pal.dim}>{hintLines}</text>
      </box>
    </box>
  );
}

// ── 当前档指针（▲ 居当前档字符正下方） ────────────────────────────────
/**
 * 条形行字符宽度 1，字符之间的分隔符宽 1（单空格），故索引 i 之前
 * 累计空白 = i * 2 个 ASCII 字符位置。指针行总宽 = (count - 1) * 2 + 1
 * 与条形行对齐（首尾 `▲` 下方紧贴首末字符）。
 */
function CurrentPointer(props: {
  readonly index: number;
  readonly count: number;
}): ReactNode {
  const pal = tuiPalette;
  const { index, count } = props;
  const safeIndex = Math.max(0, Math.min(count - 1, index));
  const leftPad = " ".repeat(safeIndex * 2);
  const trail = " ".repeat(Math.max(0, (count - 1 - safeIndex) * 2));
  return (
    <box flexDirection="row" marginTop={0}>
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {leftPad}▲{trail}
        </span>
      </text>
    </box>
  );
}

// ── 导出 ────────────────────────────────────────────────────────────
export const design2: ThinkingDesign = {
  meta: {
    id: "design-2-neon",
    name: "动感赛博风",
    tag: "Cyber Neon",
    summary:
      "heavy 边框 + 5档渐变色阶 + 边框呼吸脉冲 + 当前档 underline 脉冲 + outBack 入场。",
  },
  render: ({ model }) => (<Design2Neon model={model} />) as ReactElement,
};
