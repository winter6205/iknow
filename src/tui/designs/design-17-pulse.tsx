/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-17-pulse.tsx
 *
 * 思考面板设计 17：同心圆靶心脉冲风（demo gallery candidate）。
 *
 * 设计要点
 *  - 同心圆 / 靶心词汇：当前档同心圆 = 实心核心 `●` 外扩两圈（脉冲亮起时
 *    `⊙`，脉冲谷底 `·`），档位名水平排成 5 节；5 节同构同步呼吸，群靶中
 *    当前档金核独亮——「靶心 + 同心圆外环」即主题。额外在面板底部放一行
 *    `● currentLevel` 「锚定靶心」，与水平条当前档正交冗余，确保窄屏
 *    下视觉焦点不丢。
 *  - 呼吸脉冲（常驻，仅 Auto off 视觉生效）：当前档同心圆外环颜色在
 *    `pal.running`(金) ↔ `pal.logoGold`(粉金) 间明暗呼吸，useTimeline
 *    单实例 + item 层 `loop:true, alternate:true` 无限 ping-pong，
 *    1200ms inOutSine；同时另一属性 `fade` 走同节奏，超过 0.4 门限时
 *    把外环字符从 `·` 切到 `⊙`、并叠加 BOLD——呼吸亮起，外圈实心化。
 *  - 入场（一次性）：整面板 opacity 0 → 1、marginTop -1 → 0，
 *    450ms outExpo。
 *  - Enter 确认靶心落定（触发式）：currentIndex 变化 → 同心圆外环字符
 *    短时闪现 `◎`（重圈，模拟「脉冲外圈放大」），scale 1 → 1.22 → 1，
 *    300ms outBack，scale 数值驱动字符门限（>1.05 用 `◎`，否则 `⊙`/`·`）。
 *    Timeline 用 `add(target, props, startTime=tl.currentTime + 300ms)`
 *    显式错开两次 tween，避免两个 once 重复覆盖同一 target 属性。
 *  - Auto 圆点开关：`●`（开，pal.running↔pal.logoGold 呼吸变亮）/
 *    `○`（关，pal.dim 平铺）。Auto 切色 220ms outExpo；呼吸亮色
 *    1000ms inOutSine 常驻。
 *  - Auto 开时 5 档视觉禁用（核心字符回退 `⊙`，外圈固定 `·`，颜色全部
 *    pal.dim），把视觉焦点让给 Auto 圆点呼吸；关时 800ms outQuad 复位
 *    到呼吸初态。
 *  - 焦点游标与当前档严格正交：游标走 focusIndex（INVERSE 徽标
 *    `pal.accent`），金核心走 currentIndex（pal.running BOLD），两套
 *    互不绑定。
 *  - 面板圆角边框 `rounded`：pal.border idle → pal.running 焦点
 *    （model.open）。
 *
 * 动效预算：常驻 ≤ 2（当前档同心圆呼吸 + Auto 圆点呼吸）—— 两条都常驻
 * 循环，但渲染条件决定谁可见（autoOn 关时同心圆渲染、autoOn 开时圆点渲
 * 染），不会同时视觉叠加成 3 条。入场 / 靶心落定 / 切色均为一次性触发，
 * 不计入常驻。
 *
 * 颜色纪律：所有颜色 100% 来自 `tuiPalette`（theme.ts），未新增颜色
 * 常量；当前档核心 pal.running(金)，外环脉冲 pal.logoGold(粉金)，正文
 * pal.text，辅助 pal.dim。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import {
  EFFORT_LEVELS,
  type ThinkingDesign,
  type ThinkingDesignProps,
} from "./_contract.js";

/** 5 档名展示（把 `xhigh` 拆成可读的 `x-high`）。 */
const LEVEL_LABELS: ReadonlyArray<string> = EFFORT_LEVELS.map((level) =>
  level === "xhigh" ? "x-high" : level
);

/** 键位提示行。 */
const HINT =
  "[← →] 切档  ·  [Tab/Space] 切 Auto  ·  [Enter] 确认  ·  [Esc] 取消";

/** 当前档同心圆呼吸单程时长（alternate ping-pong 一轮 = 2×该值）。 */
const PULSE_MS = 1200;
/** Auto 圆点呼吸单程时长（仅 Auto on 视觉生效）。 */
const AUTO_DOT_PULSE_MS = 1000;
/** 面板入场时长（outExpo，一次性）。 */
const ENTRY_MS = 450;
/** 靶心落定单段时长（outBack，触发式；总 = 2 × CONFIRM_MS）。 */
const CONFIRM_MS = 300;
/** Auto 圆点切色时长（outExpo，触发式）。 */
const AUTO_DOT_SWAP_MS = 220;
/** 呼吸复位时长（Auto 切换回 off 时，outQuad，触发式）。 */
const PULSE_RESET_MS = 800;

/** 常驻 timeline duration：非 loop，永远够长，绕开 loop:true 的
 *  resetItems 重捕获初值陷阱（见 design-3-crt 注释）；无限循环靠
 *  item 层 `loop:true, alternate:true` 达成。 */
const INFINITE_MS = 3_600_000;

/** 外圈淡入层 BOLD 门限（0..1，BOLD 下表示「外圈亮起」）。 */
const RING_BOLD_THRESHOLD = 0.4;
/** 靶心落定字符门限（scale > 该值时外环 = `◎` 重圈）。 */
const CONFIRM_RING_THRESHOLD = 1.05;

/** 6 位 hex (`#rrggbb`) → 整数 RGB。 */
function parseHex(hex: string): { r: number; g: number; b: number } {
  const v = Number.parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/** 两 hex 色按 t (0..1) 线性插值（RGB 空间），t 越界 clamp。 */
function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const pa = parseHex(a);
  const pb = parseHex(b);
  const r = Math.round(pa.r + (pb.r - pa.r) * k);
  const g = Math.round(pa.g + (pb.g - pa.g) * k);
  const bl = Math.round(pa.b + (pb.b - pa.b) * k);
  const hex = ((r << 16) | (g << 8) | bl).toString(16).padStart(6, "0");
  return `#${hex}`;
}

/** 设计 17 主面板：hooks + 渲染。 */
function PulsePanel(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model, cols } = props;
  const { autoOn, currentIndex, focusIndex, open } = model;

  // useTimeline 每次 render 都 new 一个 Timeline 实例，但只有首个会被
  // engine 注册与驱动；用 ref 锁住首个实例，后续 add 都作用在它上面。
  const initialTimeline = useTimeline({ duration: INFINITE_MS });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  // timeline 直接改写这些 ref，setState 仅作 force 重渲触发器。
  const [, force] = useState(0);
  const entryRef = useRef<{ opacity: number; marginTop: number }>({
    opacity: 0,
    marginTop: -1,
  });
  const pulseRef = useRef<{ ring: number; fade: number }>({ ring: 0, fade: 0 });
  const dotRef = useRef<{ mix: number }>({ mix: autoOn ? 1 : 0 });
  const dotPulseRef = useRef<{ v: number }>({ v: autoOn ? 1 : 0 });
  const scaleRef = useRef<{ s: number }>({ s: 1 });

  // ── 常驻：当前档同心圆呼吸 + Auto 圆点呼吸 ──
  // 两条都常驻循环，渲染条件决定谁可见（见下方 showLevels / autoOn 分支），
  // 不互相 play/pause，避免 resetItems 触发初值重捕获。
  useEffect(() => {
    tl.add(pulseRef.current, {
      ring: 1,
      fade: 1,
      duration: PULSE_MS,
      ease: "inOutSine",
      alternate: true,
      loop: true,
      onUpdate: () => force((x) => x + 1),
    });
    tl.add(dotPulseRef.current, {
      v: 1,
      duration: AUTO_DOT_PULSE_MS,
      ease: "inOutSine",
      alternate: true,
      loop: true,
      onUpdate: () => force((x) => x + 1),
    });
    // mount-only；unmount 时 useTimeline 自动 pause + engine.unregister。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl]);

  // ── 入场（一次性触发）：opacity 0→1、marginTop -1→0。 ──
  useEffect(() => {
    tl.add(entryRef.current, {
      opacity: 1,
      marginTop: 0,
      duration: ENTRY_MS,
      ease: "outExpo",
      once: true,
      onUpdate: () => force((x) => x + 1),
    });
  }, [tl]);

  // ── 触发：Auto 切换门控 ──
  //  on → 把 ring/dot 视觉态复位（圆点 = running，环 = 0，环可见性
  //   靠 showLevels=false 渲染屏蔽；圆点颜色由 dotRef 切色 effect 接续）。
  //  off → 把 ring 从 0 缓拉到 1（呼吸复位），dot 颜色由切色 effect 接续。
  const prevAutoRef = useRef<boolean>(autoOn);
  useEffect(() => {
    if (prevAutoRef.current === autoOn) return;
    prevAutoRef.current = autoOn;
    if (autoOn) {
      pulseRef.current.ring = 0;
      pulseRef.current.fade = 0;
      dotPulseRef.current.v = 1;
    } else {
      pulseRef.current.ring = 0;
      pulseRef.current.fade = 0;
      dotPulseRef.current.v = 0;
      tl.add(pulseRef.current, {
        ring: 1,
        fade: 1,
        duration: PULSE_RESET_MS,
        ease: "outQuad",
        once: true,
        onUpdate: () => force((x) => x + 1),
      });
    }
  }, [autoOn, tl]);

  // ── 触发：Auto 圆点切色（autoOn 变化 → dim ↔ running）。 ──
  const dotSwapPrevRef = useRef<boolean>(autoOn);
  useEffect(() => {
    if (dotSwapPrevRef.current === autoOn) return;
    dotSwapPrevRef.current = autoOn;
    tl.add(dotRef.current, {
      mix: autoOn ? 1 : 0,
      duration: AUTO_DOT_SWAP_MS,
      ease: "outExpo",
      once: true,
      onUpdate: () => force((x) => x + 1),
    });
  }, [autoOn, tl]);

  // ── 触发：Enter 确认靶心落定（currentIndex 变化 → scale 1→1.22→1） ──
  // 用显式 startTime 把两段 outBack 错开，避免两次 once 同 startTime
  // 并发导致属性相互覆盖。item 到期（completed）后 `once:true` 自动从
  // items 数组 splice 出去，下次 currentIndex 变化时再重新 add，互不干扰。
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    scaleRef.current.s = 1;
    tl.add(scaleRef.current, {
      s: 1.22,
      duration: CONFIRM_MS,
      ease: "outBack",
      once: true,
      onUpdate: () => force((x) => x + 1),
    });
    tl.add(
      scaleRef.current,
      {
        s: 1,
        duration: CONFIRM_MS,
        ease: "outBack",
        once: true,
        onUpdate: () => force((x) => x + 1),
      },
      tl.currentTime + CONFIRM_MS
    );
  }, [currentIndex, tl]);

  // ── 派生值（ref 被 timeline 原地改写，force setState 后读到最新） ──
  const ringBright = pulseRef.current.ring;
  const ringBold = pulseRef.current.fade > RING_BOLD_THRESHOLD;
  const ringColor = mixHex(pal.running, pal.logoGold, ringBright);
  const dotColor = mixHex(pal.dim, pal.running, dotRef.current.mix);
  const dotGlow = mixHex(pal.running, pal.logoGold, dotPulseRef.current.v);
  const confirmScale = scaleRef.current.s;
  const entry = entryRef.current;
  const borderColor = open ? pal.running : pal.border;
  const showLevels = !autoOn;
  const autoDesc = autoOn
    ? "自适应档位 · server picks" // 自适应档位
    : "手动档位 · concrete effort"; // 手动档位

  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      width={Math.max(1, cols)}
      opacity={entry.opacity}
      marginTop={entry.marginTop}
    >
      {/* 标题：⊙ 装饰 + THINKING */}
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {"⊙ "}
        </span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          THINKING
        </span>
      </text>

      {/* Auto 行：圆点开关 + 状态说明（呼吸亮色 = on）。 */}
      <text>
        <span fg={autoOn ? dotGlow : dotColor} attributes={TextAttributes.BOLD}>
          {autoOn ? "●" : "○"}
        </span>
        <span fg={pal.dim}>
          {"  AUTO  ·  "}
          {autoDesc}
        </span>
      </text>

      {/* 5 档：当前档 = 金核心实心 + 外圈呼吸；其余 = 空心 ⊙。
          Auto on 时 5 档全部禁用（dim + 外环固定 `·`）。 */}
      <box flexDirection="row" alignItems="center">
        {LEVEL_LABELS.map((label, i) => {
          const current = showLevels && i === currentIndex;
          const focused = showLevels && i === focusIndex;
          const dim = !showLevels;
          const core = dim ? "⊙" : current ? "●" : "⊙";
          // 外环字符门限：dim 时固定 `·`，否则按 pulse/fade + 靶心落定 scale
          // 选 `◎`（重圈，落定瞬间）/ `⊙`（亮环，呼吸亮）/ `·`（暗环）。
          const ringCh = dim
            ? "·"
            : current
              ? confirmScale > CONFIRM_RING_THRESHOLD
                ? "◎"
                : ringBold
                  ? "⊙"
                  : "·"
              : "·";
          const coreColor = dim ? pal.dim : current ? pal.running : pal.text;
          const ringColorAt = dim ? pal.dim : current ? ringColor : pal.dim;
          return (
            <box key={label} flexDirection="row" alignItems="center" gap={0}>
              {/* 焦点游标（picker 打开时 INVERSE 徽标，正交于当前档金核心） */}
              <span
                fg={focused ? pal.accent : pal.dim}
                attributes={
                  focused ? TextAttributes.INVERSE : TextAttributes.NONE
                }
              >
                {focused ? " " : "·"}
              </span>
              <span
                fg={ringColorAt}
                attributes={
                  ringBold ? TextAttributes.BOLD : TextAttributes.NONE
                }
              >
                {ringCh}
              </span>
              <span
                fg={coreColor}
                attributes={current ? TextAttributes.BOLD : TextAttributes.NONE}
              >
                {core}
              </span>
              <span
                fg={ringColorAt}
                attributes={
                  ringBold ? TextAttributes.BOLD : TextAttributes.NONE
                }
              >
                {ringCh}
              </span>
              <span fg={dim ? pal.dim : current ? pal.running : pal.text}>
                {" "}
                {label}
              </span>
              <span fg={pal.dim}>
                {i < LEVEL_LABELS.length - 1 ? "   " : ""}
              </span>
            </box>
          );
        })}
      </box>

      {/* 锚定靶心行：当前档单独一行 `● currentLevel`，
          提示「这是当前档」+「外环呼吸在此」。Auto on 时整行隐藏。 */}
      {showLevels && (
        <box flexDirection="row" alignItems="center" marginTop={0}>
          <span fg={pal.running} attributes={TextAttributes.BOLD}>
            {"⊙ "}
          </span>
          <text fg={pal.running} attributes={TextAttributes.BOLD}>
            {LEVEL_LABELS[currentIndex] ?? ""}
          </text>
          <span fg={pal.dim}>{"  ·  呼吸外环 · 靶心落定"}</span>
        </box>
      )}

      {/* 键位提示 */}
      <text fg={pal.dim}>{HINT}</text>
    </box>
  );
}

export const design17: ThinkingDesign = {
  meta: {
    id: "design-17-pulse",
    name: "同心圆脉冲风",
    tag: "Concentric Pulse",
    summary:
      "同心圆靶心 + 外环呼吸脉冲（金↔粉金）+ 焦点游标/当前档正交 + Enter 靶心落定重圈闪现。",
  },
  render: ({ model, cols }) =>
    (<PulsePanel model={model} cols={cols} />) as ReactElement,
};
