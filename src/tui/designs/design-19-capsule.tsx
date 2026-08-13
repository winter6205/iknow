/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-19-capsule.tsx
 *
 * 思考面板设计 19：反白胶囊按钮（Capsule Neon）。
 *
 * 视觉风格 5 要素（任务约束）：
 *  1. 圆角边框 `borderStyle="rounded"`，打开时 `pal.running` 金色焦点框。
 *  2. 5 档 concrete effort 全部渲染为等宽 8 列胶囊 `[  低   ]` 形态
 *     （label 居中 padding 到 6 列内容），clear caption +
 *     等宽布局让"胶囊从旧档滑到新档"动效的对位零成本。
 *  3. 当前档：整胶囊（连括号）用 `TextAttributes.INVERSE` 反白 — fg
 *     `pal.bgRunning` 灰绿 / bg `pal.running` 金 ↔ `pal.logoGold` 粉
 *     金渐变脉冲；INVERSE 终端 swap 出"金底灰字"被按下的反白胶囊。
 *  4. 切档动效：胶囊 overlay（绝对定位 `<box>` + `translateX`）从旧
 *     currentIndex x 位 → 新 currentIndex x 位，200ms ease `inOutQuad` —
 *     useTimeline 持有实例 + 每次 currentIndex 变化 resetItems + add
 *     translateX（initialValues 由 timeline 自动捕获起点）。
 *  5. 焦点游标 ▲ 与当前档是两个独立概念：当前档是稳定的 INVERSE 胶囊
 *     （确认后位置稳定），焦点游标是单独的 `accent ↔ dim` 颜色脉冲
 *     三角，作为 picker 打开时 ←/→ 移动的"待确认"指示。
 *  6. Auto 圆点开关以 ●/○ 形态切换 + 整胶囊 `[ AUTO ]` 在 autoOn 时
 *     整胶囊 INVERSE 压下（与当前档胶囊同款 glow），5 档 disabled 走
 *     `pal.dim` + `TextAttributes.DIM` 双 dim。
 *  7. 动效预算：常驻 ≤ 2 — 反白胶囊 glow `pal.running ↔ pal.logoGold`
 *     1400ms alternate inOutSine + 焦点游标 `pal.accent ↔ pal.dim`
 *     700ms alternate inOutSine。Auto 切换时 5 档 disabled，焦点跳
 *     到 Auto；常驻两路互斥（autoOn 决定哪条 capsule 持有 glow）。
 *
 * 反白胶囊怎么用 INVERSE：`<span fg={pal.bgRunning} bg={glowColor}
 * attributes={TextAttributes.INVERSE}>{label}</span>`。INVERSE 是终
 * 端反白（SGR 7 reverse video），swap fg ↔ bg — 所见 cell 的渲染文本
 * 色 = bg prop 颜色，渲染背景 = fg prop 颜色。`bg` 接 `pal.running`
 * 金（或其脉冲值）→ 渲染文本金色；`fg` 接 `pal.bgRunning` 灰绿 →
 * 渲染背景灰绿；整个胶囊被压成"金 label 字符 × 灰绿底"，像一颗金属
 * 按钮被按下。换 fg 调胶囊底色（常驻灰绿），bg 调胶囊文本色（脉冲
 * 金↔粉金），glow 时间线只动一个 prop 数值。
 *
 * 滑动对位怎么挂钩：胶囊是顶层 `<box width="100%" flexDirection="row"
 * gap={2}>` 内的 5 个 `<text>`；`!autoOn` 时同 row 多挂一个
 * `<box ref={capsuleRef} position="absolute" left={0} top={0}>` 装
 * 反白胶囊文字。`translateX` 只由 mount (`x(currentIndex)` 初始化) +
 * `useTimeline` 的 `add({translateX: x(new), duration: 200, ease:
 * "inOutQuad"})` 驱动，永不在 JSX prop 出现（reconciler 在每次
 * re-render 会用旧值覆盖 setter）。父 row 高度由 5 个 in-flow `<text>`
 * 撑起 = 1 行，absolute overlay 落在 top=0 与按钮行同高度。
 *
 * 颜色纪律：所有颜色 100% 来自 `tuiPalette`（theme.ts），未新增任
 * 何颜色常量；hex 字符串由 OpenTUI 渲染器按终端能力降级，应用层不
 * 写 ANSI。
 */
import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  TextAttributes,
  type BoxRenderable,
  type Timeline,
} from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { tuiPalette } from "../theme.js";
import { type ThinkingDesign, type ThinkingDesignProps } from "./_contract.js";

// ── 常量 ──────────────────────────────────────────────────────────────
/** 切档滑动时长（inOutQuad）。 */
const SLIDE_MS = 200;
/** 反白胶囊 glow 单程时长（alternate ping-pong = 2 × 单程）。 */
const GLOW_MS = 1400;
/** 焦点游标颜色脉冲单程时长。 */
const CURSOR_MS = 700;
/** 面板入场 fade 时长。 */
const ENTRY_MS = 280;

/** 等宽胶囊宽度（含两侧方括号）。 */
const BUTTON_W = 8;
/** 胶囊之间间距。 */
const GAP = 2;
/** 单步宽度 = 胶囊宽 + 间距。 */
const STEP = BUTTON_W + GAP;

/** 5 档中文标签 + 视觉宽度（终端列数）。 */
const LEVEL_LABELS: ReadonlyArray<{ label: string; width: number }> = [
  { label: "低", width: 2 },
  { label: "中", width: 2 },
  { label: "高", width: 2 },
  { label: "超高", width: 4 },
  { label: "最大", width: 4 },
];

/** Auto 胶囊宽度 4 内容居中。 */
const AUTO_LABEL = "AUTO";
const AUTO_WIDTH = 4;

/** 焦点游标 ▲ 在胶囊行内的列偏移（对准 8 宽胶囊中心）。 */
const LEVEL_CURSOR_X = (i: number): number => i * STEP + 4;
/** Auto 胶囊中心列（在 Auto dot 行内：dot(1) + gap(1) + capsule[] 中心 4 = 6）。 */
const AUTO_CURSOR_X = 6;

// ── 文本工具 ──────────────────────────────────────────────────────────
/**
 * 把 label 居中 padding 到 6 列内容内，返回完整 8 列胶囊
 * 字符串 `[<inner>]`。所有 5 档字符串拼接后等宽，相邻胶囊对位
 * 精确到 1 列，translateX 滑动动画的对位计算零成本。
 */
function capsuleText(label: string, width: number): string {
  const inner = 6;
  const padTotal = inner - width;
  const padLeft = Math.max(0, Math.floor(padTotal / 2));
  const padRight = Math.max(0, padTotal - padLeft);
  return "[" + " ".repeat(padLeft) + label + " ".repeat(padRight) + "]";
}

const AUTO_CAPSULE = capsuleText(AUTO_LABEL, AUTO_WIDTH);

// ── 颜色工具 ──────────────────────────────────────────────────────────
/** `#rrggbb` → [r, g, b]∈[0,1]³。 */
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

/** 两色按 t∈[0,1] 线性混合 → `#rrggbb`。供 glow / cursor 脉冲用。 */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round((ar + (br - ar) * k) * 255);
  const g = Math.round((ag + (bg - ag) * k) * 255);
  const bl = Math.round((ab + (bb - ab) * k) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

// ── 渲染组件 ──────────────────────────────────────────────────────────
function CapsuleDesign(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model } = props;
  const autoOn = model.autoOn;
  const currentIndex = model.currentIndex;
  const focusIndex = model.focusIndex;
  const open = model.open;

  // refs —— 见头注释：translateX/opacity 仅由 mount/timeline 写，不进 JSX prop。
  const panelRef = useRef<BoxRenderable | null>(null);
  const capsuleRef = useRef<BoxRenderable | null>(null);

  // 三个 useTimeline 实例：锁住首 render 的 injected Timeline（后续 render
  // 产生的新实例未被 engine 注册，仅 ref 持有首实例；autoplay 行为由
  // useTimeline 内部的首 render effect 触发）。
  const glowTimeline = useTimeline({
    duration: GLOW_MS * 2, // alternate ping-pong 一轮 = 2 × 单程
    loop: true,
    autoplay: true,
  });
  const cursorTimeline = useTimeline({
    duration: CURSOR_MS * 2,
    loop: true,
    autoplay: true,
  });
  const slideTimeline = useTimeline({
    duration: SLIDE_MS,
    autoplay: false,
  });
  const tlRefs = useRef<{
    glow: Timeline;
    cursor: Timeline;
    slide: Timeline;
  }>({
    glow: glowTimeline,
    cursor: cursorTimeline,
    slide: slideTimeline,
  });
  const tl = tlRefs.current;

  // 状态：被 timeline onUpdate 驱动。
  const [capsuleFg, setCapsuleFg] = useState<string>(pal.running);
  const [cursorColor, setCursorColor] = useState<string>(pal.accent);

  const glowRef = useRef<{ p: number }>({ p: 0 });
  const cursorRef = useRef<{ p: number }>({ p: 0 });

  // mount-only：注册三个常驻/一次性动效 + 初始化胶囊 translateX。
  useEffect(() => {
    const panel = panelRef.current;

    // 1) 反白胶囊 glow：alternate 脉冲驱动 capsuleFg（renderable cell bg）。
    tl.glow.add(glowRef.current, {
      duration: GLOW_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setCapsuleFg(mixHex(pal.running, pal.logoGold, v));
      },
    });

    // 2) 焦点游标颜色脉冲：accent ↔ dim。
    tl.cursor.add(cursorRef.current, {
      duration: CURSOR_MS,
      ease: "inOutSine",
      loop: true,
      alternate: true,
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        setCursorColor(mixHex(pal.accent, pal.dim, v));
      },
    });

    // 3) 面板入场 fade：opacity 0 → 1（panel.opacity prop 永远 0，timeline
    //    写 renderable 数值，reconciler 跳过 prop 同值 set）。
    if (panel) {
      tl.glow.add(panel, {
        opacity: 1,
        duration: ENTRY_MS,
        ease: "inOutSine",
        once: true,
      });
    }

    // 4) 初始化胶囊 translateX。
    const capsule = capsuleRef.current;
    if (capsule) {
      capsule.translateX = currentIndex * STEP;
    }

    // cleanup 由 useTimeline 内部 unmount 效应统一处理（pause + unregister）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切档 slide：currentIndex 变化 → 重置 slide timeline + 写入新 translateX。
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    const capsule = capsuleRef.current;
    if (!capsule) return;
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    tl.slide.resetItems();
    tl.slide.add(capsule, {
      translateX: currentIndex * STEP,
      duration: SLIDE_MS,
      ease: "inOutQuad",
    });
    tl.slide.play();
  }, [currentIndex, tl]);

  // autoOn 切换：胶囊 overlay 重 remount，重置 translateX + 暂停 slide。
  useEffect(() => {
    if (autoOn) {
      tl.slide.pause();
      tl.slide.resetItems();
      return;
    }
    const capsule = capsuleRef.current;
    if (capsule) {
      capsule.translateX = currentIndex * STEP;
    }
    tl.slide.pause();
    tl.slide.resetItems();
  }, [autoOn, currentIndex, tl]);

  // 派生
  const borderColor = open ? pal.running : pal.border;
  const descText = autoOn ? "adaptive" : "concrete effort";
  const hintText = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  // 焦点游标 x：focusIndex === -1 时指向 Auto 胶囊（picker 打开时）；>= 0
  // 时指向对应档位胶囊中心。
  const cursorX =
    focusIndex === -1 ? AUTO_CURSOR_X : LEVEL_CURSOR_X(focusIndex);
  const cursorVisible = open;

  // 当前档反向胶囊的字符串（autoOn 时该 overlay 不渲染，引用不到）。
  const curLabel = LEVEL_LABELS[currentIndex] ?? LEVEL_LABELS[1]!;
  const curCapsuleText = capsuleText(curLabel.label, curLabel.width);

  return (
    <box
      ref={panelRef}
      flexDirection="column"
      borderStyle="rounded"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
      opacity={0}
    >
      {/* 标题 */}
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {"◈ THINKING"}
        </span>
        <span fg={pal.dim}>{"  │  CAPSULE PICKER"}</span>
      </text>

      {/* Auto 行：圆点 + Auto 胶囊 + 描述 */}
      <box flexDirection="row" marginTop={0}>
        <text wrapMode="none">
          <span
            fg={autoOn ? pal.running : pal.dim}
            attributes={autoOn ? TextAttributes.BOLD : TextAttributes.NONE}
          >
            {autoOn ? "●" : "○"}
          </span>
          <span>{"  "}</span>
          {autoOn ? (
            <span
              fg={pal.bgRunning}
              bg={capsuleFg}
              attributes={TextAttributes.INVERSE | TextAttributes.BOLD}
            >
              {AUTO_CAPSULE}
            </span>
          ) : (
            <span fg={pal.text}>{AUTO_CAPSULE}</span>
          )}
          <span fg={pal.dim}>{`  ${descText}`}</span>
        </text>
      </box>

      {/* 5 档胶囊行 + 反白胶囊 overlay（!autoOn 时） */}
      <box
        width="100%"
        flexDirection="row"
        gap={GAP}
        alignItems="flex-start"
        marginTop={0}
      >
        {LEVEL_LABELS.map((item) => {
          const disabled = autoOn;
          return (
            <text key={item.label} wrapMode="none">
              <span
                fg={disabled ? pal.dim : pal.text}
                attributes={disabled ? TextAttributes.DIM : TextAttributes.NONE}
              >
                {capsuleText(item.label, item.width)}
              </span>
            </text>
          );
        })}
        {!autoOn && (
          <box ref={capsuleRef} position="absolute" left={0} top={0}>
            <text wrapMode="none">
              <span
                fg={pal.bgRunning}
                bg={capsuleFg}
                attributes={TextAttributes.INVERSE | TextAttributes.BOLD}
              >
                {curCapsuleText}
              </span>
            </text>
          </box>
        )}
      </box>

      {/* 焦点游标 ▲（当前档与游标是独立概念：游标 ≠ current） */}
      {cursorVisible && (
        <box marginTop={0}>
          <text wrapMode="none">
            <span fg={cursorColor} attributes={TextAttributes.BOLD}>
              {" ".repeat(cursorX) + "▲"}
            </span>
          </text>
        </box>
      )}

      {/* 键位提示 */}
      <box marginTop={0}>
        <text fg={pal.dim}>{hintText}</text>
      </box>
    </box>
  );
}

// ── 导出 ──────────────────────────────────────────────────────────────
export const design19: ThinkingDesign = {
  meta: {
    id: "design-19-capsule",
    name: "反白胶囊风",
    tag: "Capsule Neon",
    summary:
      "等宽 5 档 [低] [中] [高] [超高] [最大] 胶囊 · 当前档整胶囊 INVERSE + 金↔粉金光晕脉冲 · 200ms inOutQuad translateX 滑入新档 · 焦点游标 ▲ 与当前档独立。",
  },
  render: (props: ThinkingDesignProps): ReactElement =>
    (<CapsuleDesign {...props} />) as ReactElement,
};
