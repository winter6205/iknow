/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-20-ripple.tsx
 *
 * 思考面板 · Design 20：涟漪扩散风（Ripple Diffuse）。
 *
 * 设计要点
 *  - double 双线边框，整框 borderColor 在 `pal.running` ↔ `pal.logoGold`
 *    间 2000ms alternate ease "inOutSine" 持续脉冲（呼吸，常驻 1）。
 *  - 标题 `≋ THINKING ≋`（波纹字符 `≋` U+224B 包裹，`pal.running` BOLD）。
 *  - Auto 圆点 ●/○：开时 ● 走 1000ms alternate ease "inOutSine" 在
 *    running ↔ logoGold 间持续呼吸（常驻 2，仅 Auto on 时挂）；关时
 *    ○ `pal.dim` 静态。
 *  - 切档触发涟漪扩散：focusIndex 变化时（用户 ←/→ 导航），以新档
 *    为中心，在 ~350ms 内依次推进 3 个相位 `· → ○ → ●`：
 *      ·  t=0   ：整行 `·`（涟漪尚未升起，水平面静默）
 *      ·  t=100 ：center=○ pal.logoGold（涟漪第一拍升起于中心）
 *      ·  t=200 ：center=● pal.running + 邻居=○ pal.logoGold（涟漪
 *                 传到 ring 1）
 *      ·  t=350 ：settled，center=● pal.running + 邻居=`·` pal.dim
 *                 （涟漪收束）
 *    三相位通过 `useTimeline.call(cb, timePoint)` 在 0/100/200ms 三个
 *    timePoint 切换 setRipplePhase(0|1|2) + t=350ms setRippleDone(true)
 *    —— 触发型，不计入常驻预算。
 *  - 5 档可视化行：5 个 cell（每个 1 字符 + 1 空格），按 cellRender
 *    规则输出字符与颜色；Auto on 时整行退化为 `·` pal.dim（disabled）。
 *  - 当前档指针 ▼（Auto off 时居 currentIndex cell 正下方，pal.running
 *    BOLD）—— 稳定状态指示，独立于焦点游标。
 *  - 焦点游标 ▸（focused 且 Auto off 时居 focusIndex 档位名前 1 格，
 *    pal.text BOLD）—— 用户操作位，与当前档是两个独立概念。
 *  - 档位名（中英对照）：低 / 中 / 高 / 超高 / 最大；当前档 BOLD +
 *    pal.running；其余 pal.dim。
 *  - 键位提示：Auto on 省 `[←/→]`。
 *
 * 颜色纪律：100% `tuiPalette` 现有 24 色 token，未新增任何颜色常量。
 *
 * 动效常驻预算 ≤ 2：
 *   常驻 1：边框呼吸 2000ms inOutSine alternate loop。
 *   常驻 2：Auto 圆点 fg 脉冲 1000ms inOutSine alternate loop（仅 Auto on，
 *           autoOn=false 时显式 `tl.dot.pause()`）。
 *   触发（不计入常驻）：涟漪扩散 call 序列（350ms 三相位 + 收束）。
 *
 * `useTimeline` 注意事项（@opentui/react 0.5）：hook 内部 mount effect
 * 仅在首次 render 把 Timeline 注入 engine；后续 render 返回的是引擎未
 * 注册的 fresh 实例，update 不会推进。`useRef(initialValue)` 仅消费
 * 首 render 的 initialValue，因此 `tlRefs.current` 始终指向引擎持有
 * 的 stable 实例，所有 `.add()` / `.call()` / `.pause()` / `.play()`
 * / `.resetItems()` 都在 stable ref 上调用。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useTimeline } from "@opentui/react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

// ── 常量 ──────────────────────────────────────────────────────────────

/** 5 档中文档名（用户硬需求：低 / 中 / 高 / 超高 / 最大）。 */
const LEVEL_NAMES_CN = ["低", "中", "高", "超高", "最大"] as const;

/** 涟漪 3 态字符（依次为：扩散点 → 中圈 → 实心）。 */
const RIPPLE_CHARS = ["·", "○", "●"] as const;

/** 涟漪相位 0→1→2 时间点（毫秒）。 */
const RIPPLE_T0 = 0;
const RIPPLE_T1 = 100;
const RIPPLE_T2 = 200;
const RIPPLE_DONE = 350;

/** Border 呼吸单程时长（alternate ping-pong = 2× 该值）。 */
const BORDER_PULSE_MS = 2000;

/** Auto 圆点 fg 脉冲单程时长（alternate ping-pong = 2× 该值）。 */
const DOT_PULSE_MS = 1000;

// ── 颜色工具 ──────────────────────────────────────────────────────────

/** `#rrggbb` → [r, g, b]∈[0,1]³。供 `mixHex` 用。 */
function hexToRgb(hex: string): readonly [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1] as string, 16);
  return [
    ((v >> 16) & 0xff) / 255,
    ((v >> 8) & 0xff) / 255,
    (v & 0xff & 0xff) / 255,
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

/** Border / dot 共用配色（pal.running ↔ pal.logoGold）。 */
const mixRunningGold = (t: number): string =>
  mixHex(tuiPalette.running, tuiPalette.logoGold, t);

// ── 渲染组件 ──────────────────────────────────────────────────────────

function RipplePanel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const autoOn = model.autoOn;
  const currentIndex = model.currentIndex;
  const focusIndex = model.focusIndex;
  const focused = model.open;
  const levels = EFFORT_LEVELS as readonly EffortLevel[];

  // ── 常驻状态（timeline 驱动） ──────────────────────────────────────
  const [borderColor, setBorderColor] = useState<string>(pal.running);
  const borderTargetRef = useRef<{ p: number }>({ p: 0 });
  const [dotColor, setDotColor] = useState<string>(pal.running);
  const dotTargetRef = useRef<{ p: number }>({ p: 0 });

  // ── 涟漪状态（call 序列驱动） ──────────────────────────────────────
  // rippleCenter = 涟漪源 = 切档后的 focusIndex；
  // ripplePhase ∈ {0,1,2} = 三态字符索引（·/○/●）；
  // rippleDone = 涟漪已收束（settled 态：center=●, 其余=·）。
  const [rippleCenter, setRippleCenter] = useState<number>(currentIndex);
  const [ripplePhase, setRipplePhase] = useState<0 | 1 | 2>(0);
  const [rippleDone, setRippleDone] = useState<boolean>(true);

  // ── Timeline 引用（useRef 锁首 render 实例，避开 hook 引用漂移） ──
  const borderTimeline = useTimeline({
    duration: BORDER_PULSE_MS * 2,
    loop: true,
    autoplay: true,
  });
  const dotTimeline = useTimeline({
    duration: DOT_PULSE_MS * 2,
    loop: true,
    autoplay: true,
  });
  const rippleTimeline = useTimeline({
    duration: RIPPLE_DONE + 20,
  });
  const tlRefs = useRef<{
    border: Timeline;
    dot: Timeline;
    ripple: Timeline;
  }>({
    border: borderTimeline,
    dot: dotTimeline,
    ripple: rippleTimeline,
  });
  const tl = tlRefs.current;

  // ── mount-only effect：挂常驻动画 + 初始 Auto gating ─────────────
  useEffect(() => {
    // Border 呼吸（alternate ping-pong，颜色在 running/logoGold 间插值）。
    tl.border.add(borderTargetRef.current, {
      p: 1,
      duration: BORDER_PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setBorderColor(mixRunningGold(v));
      },
    });
    // Auto 圆点 fg 脉冲（alternate ping-pong）：仅 Auto on 时挂载。
    tl.dot.add(dotTargetRef.current, {
      p: 1,
      duration: DOT_PULSE_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setDotColor(mixRunningGold(v));
      },
    });
    if (!autoOn) {
      tl.dot.pause();
      setDotColor(pal.running);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl]);

  // ── autoOn 切换 gating（dot 时空槽开关） ──────────────────────────
  useEffect(() => {
    if (autoOn) {
      tl.dot.play();
    } else {
      tl.dot.pause();
      setDotColor(pal.running);
    }
  }, [autoOn, tl, pal.running]);

  // ── 涟漪触发：focusIndex 变化时（用户 ←/→ 导航），3 态依次展开 ─
  // Auto on 时不触发（5 档 disabled）；focusIndex<0（Auto on 时游标
  // 在 Auto 上）同样跳过。resetItems 清掉上一轮未完成 call，避免堆
  // 积；然后 call(cb, timePoint) 在 0/100/200/350ms 4 个 timePoint
  // 切换 setRipplePhase(0|1|2) + setRippleDone(true)。
  const prevFocusRef = useRef<number>(focusIndex);
  useEffect(() => {
    if (prevFocusRef.current === focusIndex) return;
    prevFocusRef.current = focusIndex;
    if (autoOn || focusIndex < 0) return;

    setRippleCenter(focusIndex);
    setRippleDone(false);

    const localTl = tl.ripple;
    localTl.resetItems();
    localTl.call(() => setRipplePhase(0), RIPPLE_T0);
    localTl.call(() => setRipplePhase(1), RIPPLE_T1);
    localTl.call(() => setRipplePhase(2), RIPPLE_T2);
    localTl.call(() => setRippleDone(true), RIPPLE_DONE);
    localTl.play();
  }, [focusIndex, autoOn, tl]);

  // ── 单元字符 + 颜色派生（涟漪规则核心） ───────────────────────────
  // 给定 cell i（0..4）：
  //  · Auto on → `·` pal.dim（disabled 整行退化为 dim 静态）。
  //  · rippleDone → center (i === currentIndex) `●` pal.running，
  //    其余 `·` pal.dim（settled 稳态）。
  //  · 涟漪进行中 → 计算 d = |i - center|；cell 在涟漪波前（d > phase）
  //    显示 `·`；否则按 chars[phase - d] 取字符：
  //      ·  phase 0（t=0）  : center `·`、邻居 `·`、外圈 `·`
  //      ·  phase 1（t=100）: center `○` pal.logoGold、邻居 `·`、外圈 `·`
  //      ·  phase 2（t=200）: center `●` pal.running、邻居 `○` pal.logoGold、
  //                          外圈 `·` pal.dim
  // 颜色规则：`●` = pal.running（仅 center 在 phase 2 出现），`○` =
  // pal.logoGold（涟漪中态，传递中），`·` = pal.dim。
  const cellRender = (
    i: number
  ): { readonly ch: string; readonly fg: string; readonly attr: number } => {
    if (autoOn) {
      return { ch: "·", fg: pal.dim, attr: TextAttributes.NONE };
    }
    if (rippleDone) {
      if (i === currentIndex) {
        return {
          ch: "●",
          fg: pal.running,
          attr: TextAttributes.BOLD,
        };
      }
      return { ch: "·", fg: pal.dim, attr: TextAttributes.NONE };
    }
    const d = Math.abs(i - rippleCenter);
    if (d > ripplePhase) {
      return { ch: "·", fg: pal.dim, attr: TextAttributes.NONE };
    }
    const idx = Math.max(0, Math.min(2, ripplePhase - d));
    const ch = RIPPLE_CHARS[idx] ?? "·";
    let fg: string;
    let attr: number;
    if (ch === "●") {
      // 仅 center（d=0）能推进到 ●，必为 pal.running BOLD
      fg = pal.running;
      attr = TextAttributes.BOLD;
    } else if (ch === "○") {
      fg = pal.logoGold;
      attr = TextAttributes.BOLD;
    } else {
      fg = pal.dim;
      attr = TextAttributes.NONE;
    }
    return { ch, fg, attr };
  };

  const currentSafe = Math.max(0, Math.min(levels.length - 1, currentIndex));
  const focusSafe = Math.max(0, Math.min(levels.length - 1, focusIndex));

  // ── 当前档指针 ▼（Auto off 时居 currentIndex cell 正下方） ───────
  // 涟漪行字符宽度 1，间距 1 空格 → 索引 i 之前累计偏移 = i*2。
  const renderCurrentPointer = (): ReactNode | null => {
    if (autoOn) return null;
    const left = " ".repeat(currentSafe * 2);
    const trail = " ".repeat(
      Math.max(0, (levels.length - 1 - currentSafe) * 2)
    );
    return (
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {`${left}▼${trail}`}
        </span>
      </text>
    );
  };

  // ── 焦点游标 ▸（focused + Auto off 时居 focusIndex 档位名前） ────
  // 档位名（中文 1 字） + 间距 2 空格 → 索引 i 之前累计偏移 = i*3。
  const renderFocusCursor = (): ReactNode | null => {
    if (!focused || autoOn) return null;
    const left = " ".repeat(focusSafe * 3);
    const totalWidth = levels.length * 3 - 2; // 5×3 - 2 = 13 字符
    const trail = " ".repeat(Math.max(0, totalWidth - focusSafe * 3 - 1));
    return (
      <text>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          {`${left}▸${trail}`}
        </span>
      </text>
    );
  };

  const hint = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  return (
    <box
      flexDirection="column"
      borderStyle="double"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      width={Math.max(1, cols)}
    >
      {/* 标题：≋ THINKING ≋（波纹字符包裹） */}
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {"≋ THINKING ≋"}
        </span>
      </text>

      {/* Auto 行：●/○（开时 fg 脉冲，关时 ○ dim） */}
      <text>
        {autoOn ? (
          <>
            <span fg={dotColor} attributes={TextAttributes.BOLD}>
              {"●"}
            </span>
            <span fg={pal.text}>{"  AUTO  · "}</span>
            <span fg={pal.running}>{"adaptive"}</span>
            <span fg={pal.dim}>{"（跟随 env/provider）"}</span>
          </>
        ) : (
          <>
            <span fg={pal.dim}>{"○"}</span>
            <span fg={pal.text}>{"  AUTO  · "}</span>
            <span fg={pal.dim}>{"manual"}</span>
            <span fg={pal.dim}>{"（用户选 concrete 档位）"}</span>
          </>
        )}
      </text>

      {/* 涟漪扩散行：5 个 cell 横向并排（每个 1 字符 + 1 空格） */}
      <text wrapMode="none">
        {levels.map((level, i) => {
          const { ch, fg, attr } = cellRender(i);
          return (
            <span key={`ripple-${level}`} fg={fg} attributes={attr}>
              {`${ch}${i < levels.length - 1 ? " " : ""}`}
            </span>
          );
        })}
      </text>

      {/* 当前档指针 ▼（Auto off 时） */}
      {renderCurrentPointer()}

      {/* 档位名（中文） —— 当前档 BOLD + pal.running */}
      <text wrapMode="none">
        {levels.map((level, i) => {
          const isCurrent = i === currentIndex;
          const color = autoOn ? pal.dim : isCurrent ? pal.running : pal.dim;
          const attr = isCurrent ? TextAttributes.BOLD : TextAttributes.NONE;
          return (
            <span key={`lbl-${level}`} fg={color} attributes={attr}>
              {`${LEVEL_NAMES_CN[i] ?? ""}${i < LEVEL_NAMES_CN.length - 1 ? "  " : ""}`}
            </span>
          );
        })}
      </text>

      {/* 焦点游标 ▸（focused + Auto off 时） */}
      {renderFocusCursor()}

      {/* 键位提示 */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

// ── 导出 ──────────────────────────────────────────────────────────────
export const design20: ThinkingDesign = {
  meta: {
    id: "design-20-ripple",
    name: "涟漪扩散风",
    tag: "Ripple",
    summary:
      "double 双线呼吸边框 + 切档时涟漪从中心向外扩散（`·→○→●` 三相位 350ms）+ Auto 圆点 fg 脉冲 + 当前档指针与焦点游标正交分离。",
  },
  render: ({ model, cols }: ThinkingDesignProps): ReactElement =>
    (<RipplePanel model={model} cols={cols} />) as ReactElement,
};
