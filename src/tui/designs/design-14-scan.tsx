/** @jsxImportSource @opentui/react */
/**
 * src/tui/designs/design-14-scan.tsx
 *
 * 思考面板设计 14 — 扫描线霓虹（Scan Neon）。
 *
 * 设计要点
 *  - double 双线边框，整框 borderColor 在 `pal.running` ↔ `pal.logoGold`
 *    间 1500ms alternate ease "inOutSine" 持续脉冲（呼吸）。
 *  - 顶部独立扫描线行：24 段 `─` 字符，`useTimeline` 驱动 lit 位置
 *    0→23 线性循环（每位置 120ms dwell ≈ 2.88s 全程扫描），当前段
 *    `pal.running` BOLD + 其余 `pal.dim` DIM —— 持续的水平扫描穿过
 *    面板标题正下方，强化"扫描"主题。
 *  - 标题 `▓▒░ THINKING ░▒▓`（块字符渐变包裹，`pal.running` BOLD），
 *    UNDERLINE 装饰横贯标题底。
 *  - Auto 圆点 ●/○：开时 ● 挂 `TextAttributes.BLINK`（terminal 原生
 *    SGR 5 闪烁）+ fg 同步在 running/logoGold 间 timeline 驱动脉冲
 *    —— 跨终端兼容（支持 BLINK 的终端走原生，不支持的终端至少看
 *    到 fg 颜色脉冲）。关时 ○ `pal.dim` 静态。
 *  - 5 档可视化条 `▁▂▃▄▅`（递增）+ 中文档位名（低/中/高/超高/最大）。
 *    当前档位字符挂 `TextAttributes.UNDERLINE` + BOLD + `pal.running`。
 *  - 触发动效：切档时当前档位字符颜色在 `pal.error → pal.running` 间
 *    250ms outQuad 衰减（flashMix 1→0），快速"红闪 → 稳定"反馈。
 *  - Auto on 时 5 档整体降为 `pal.dim`（disabled 视觉）+ 不显示当前
 *    档指针 ▶（用户已被 Auto 接管）。
 *  - 当前档指针 ▶（固定指向 currentIndex 字符下方）+ 焦点游标 ▸
 *    （仅 picker open 时白色指向 focusIndex 档位名前 1 格）：两个独
 *    立视觉元素 —— 当前档是稳定状态指示，焦点游标是用户操作位。
 *
 * 颜色纪律：100% `tuiPalette` 现有 24 色 token，无新增颜色常量。
 *
 * 动效预算：常驻 ≤ 2（border 脉冲 + 扫描光带位置循环），
 * Auto on 时额外 +1 常驻（dot 颜色脉冲），仍 ≤ 3；切档 flash 由独立
 * timeline 触发 onUpdate 驱动 state，不计入常驻。
 *
 * `useTimeline` 注意事项：hook 在 mount effect 之后只把首次 render 的
 * Timeline 注入 engine；后续 render 返回新实例但不被处理。本组件用
 * `useRef` 捕获首 render 实例，所有 `.add()` / `.pause()` / `.play()`
 * / `.resetItems()` 都在 stable ref 上调用，避开 hook 引用漂移。
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
/** 5 档可视化条（递增密度）。 */
const FIVE_BARS = ["▁", "▂", "▃", "▄", "▅"] as const;
/** 中文档位名（用户硬需求：低/中/高/超高/最大）。 */
const LEVEL_NAMES_CN = ["低", "中", "高", "超高", "最大"] as const;

/** 扫描线行总宽（24 段 `─`）。 */
const SCAN_POSITIONS = 24;
const SCAN_SWEEP_MS = 120; // 单格 dwell
const SCAN_CYCLE_MS = SCAN_SWEEP_MS * SCAN_POSITIONS; // ≈ 2.88s 全程

/** Border 呼吸单程时长（alternate → 完整周期 = 2×）。 */
const BORDER_PULSE_MS = 1500;

/** Auto 圆点 fg 颜色脉冲单程时长（仅 Auto on 时挂载）。 */
const DOT_PULSE_MS = 700;

/** 切档 flash 衰减时长。 */
const FLASH_MS = 250;

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

/** 两色按 t∈[0,1] 线性混合 → `#rrggbb` 字符串。 */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round((ar + (br - ar) * t) * 255);
  const g = Math.round((ag + (bg - ag) * t) * 255);
  const bl = Math.round((ab + (bb - ab) * t) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** Border 脉冲 + dot 颜色脉冲共用配色（pal.running ↔ pal.logoGold）。 */
const mixRunningGold = (t: number): string =>
  mixHex(tuiPalette.running, tuiPalette.logoGold, t);

// ── 渲染组件 ──────────────────────────────────────────────────────────
function Design14Scan(props: ThinkingDesignProps): ReactNode {
  const pal = tuiPalette;
  const { model } = props;
  const autoOn = model.autoOn;
  const currentIndex = model.currentIndex;
  const focusIndex = model.focusIndex;
  const focused = model.open;
  const levels = EFFORT_LEVELS as readonly EffortLevel[];

  // ── 边框呼吸（常驻） ──────────────────────────────────────────────
  const [borderColor, setBorderColor] = useState<string>(pal.running);
  const borderTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── 扫描线光带位置（常驻） ───────────────────────────────────────
  const [scanPos, setScanPos] = useState<number>(0);
  const scanTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── Auto 圆点 fg 颜色脉冲（Auto on 时挂载） ──────────────────────
  const [dotColor, setDotColor] = useState<string>(pal.running);
  const dotTargetRef = useRef<{ p: 0 }>({ p: 0 });

  // ── 切档 flash（触发） ───────────────────────────────────────────
  const [flashMix, setFlashMix] = useState<number>(0); // 0=settled, 1=full flash
  const flashTargetRef = useRef<{ p: number }>({ p: 0 });

  // ── Timeline 引用（锁首 render 实例，避开 hook 引用漂移） ────────
  const borderTimeline = useTimeline({
    duration: BORDER_PULSE_MS * 2, // alternate ping-pong = 2× item duration
    loop: true,
    autoplay: true,
  });
  const scanTimeline = useTimeline({
    duration: SCAN_CYCLE_MS,
    loop: true,
    autoplay: true,
  });
  const dotTimeline = useTimeline({
    duration: DOT_PULSE_MS * 2,
    loop: true,
    autoplay: true,
  });
  const flashTimeline = useTimeline({
    duration: FLASH_MS,
    autoplay: false,
  });
  const tlRefs = useRef<{
    border: Timeline;
    scan: Timeline;
    dot: Timeline;
    flash: Timeline;
  }>({
    border: borderTimeline,
    scan: scanTimeline,
    dot: dotTimeline,
    flash: flashTimeline,
  });
  const tl = tlRefs.current;

  // ── mount-only effect：挂载动画项（一次性，不重挂） ─────────────
  useEffect(() => {
    // Border 呼吸（alternate ping-pong，颜色在 running/logoGold 间插值）。
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

    // 扫描光带位置：target.p 从 0 线性增到 1，每帧把 progress 量化
    // 到 0..SCAN_POSITIONS-1 → setScanPos()。onComplete 手动归零，
    // 绕开 timeline.loop=true 的 resetItems capture 陷阱（design-5
    // 同款模式）。
    tl.scan.add(scanTargetRef.current, {
      duration: SCAN_CYCLE_MS,
      ease: "linear",
      onComplete: () => {
        scanTargetRef.current.p = 0;
      },
      onUpdate: (anim) => {
        const v = anim.targets[0]?.p ?? 0;
        const next = Math.floor(v * SCAN_POSITIONS) % SCAN_POSITIONS;
        setScanPos((prev) => (prev === next ? prev : next));
      },
    });

    // Auto 圆点 fg 脉冲（alternate ping-pong）：running ↔ logoGold。
    // 仅 Auto on 时活跃。
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

    // 初始 gating：Auto on 才挂 dot 圆点颜色脉冲；Auto off 时暂停。
    if (!autoOn) {
      tl.dot.pause();
      setDotColor(pal.running);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tl]);

  // ── autoOn 切换 gating（dot 时空槽开关） ─────────────────────────
  useEffect(() => {
    if (autoOn) {
      tl.dot.play();
    } else {
      tl.dot.pause();
      setDotColor(pal.running);
    }
  }, [autoOn, tl, pal.running]);

  // ── 切档 flash 触发：currentIndex 变化时，flashMix 立即置 1 →
  //  250ms outQuad 衰减到 0（颜色从 pal.error 渐回 pal.running）。 ──
  const prevIndexRef = useRef<number>(currentIndex);
  useEffect(() => {
    if (prevIndexRef.current === currentIndex) return;
    prevIndexRef.current = currentIndex;
    flashTargetRef.current.p = 1;
    setFlashMix(1);
    tl.flash.resetItems();
    tl.flash.add(flashTargetRef.current, {
      p: 0,
      duration: FLASH_MS,
      ease: "outQuad",
      onUpdate: (anim) => {
        const v = Math.round((anim.targets[0]?.p ?? 0) * 16) / 16;
        setFlashMix(v);
      },
    });
    tl.flash.play();
  }, [currentIndex, tl]);

  // ── 当前档条形 / 档位名字符属性 ──────────────────────────────────
  const currentAttr = ((): number => {
    if (autoOn) return TextAttributes.BOLD; // disabled 态：BOLD + dim
    return TextAttributes.BOLD | TextAttributes.UNDERLINE;
  })();

  // 当前档条形字符颜色：flash 期间在 pal.error → pal.running 间插值；
  // Auto on 时降为 pal.dim（disabled 视觉）。
  const currentBarColor = autoOn
    ? pal.dim
    : mixHex(pal.running, pal.error, flashMix);

  // ── 扫描线行渲染 ─────────────────────────────────────────────────
  const renderScanline = (): ReactNode[] => {
    const chars: ReactNode[] = [];
    for (let i = 0; i < SCAN_POSITIONS; i++) {
      const lit = i === scanPos;
      chars.push(
        <span
          key={`scan-${i}`}
          fg={lit ? pal.running : pal.dim}
          attributes={lit ? TextAttributes.BOLD : TextAttributes.DIM}
        >
          {"─"}
        </span>
      );
    }
    return chars;
  };

  // ── 当前档指针 ▶ 居当前档条形正下方（Auto off 时） ─────────────
  // 条形行字符宽度 1，间距 1 空格 → 索引 i 之前累计偏移 = i*2。
  const renderCurrentPointer = (): ReactNode | null => {
    if (autoOn) return null;
    const safeIndex = Math.max(0, Math.min(levels.length - 1, currentIndex));
    const leftPad = " ".repeat(safeIndex * 2);
    const trail = " ".repeat(Math.max(0, (levels.length - 1 - safeIndex) * 2));
    return (
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {`${leftPad}▶${trail}`}
        </span>
      </text>
    );
  };

  // ── 焦点游标 ▸ 居 focusIndex 档位名之前（仅 picker open 且
  //  autoOn=false 时）。档位名宽度 = 1（中文 1 字），间距 2 空格，
  //  故索引 i 之前累计偏移 = i * 3。 ──
  const renderFocusCursor = (): ReactNode | null => {
    if (!focused || autoOn) return null;
    const safeIndex = Math.max(0, Math.min(levels.length - 1, focusIndex));
    const leftPad = " ".repeat(safeIndex * 3);
    const totalWidth = levels.length * 3 - 2; // 5×3 - 2 = 13 字符（最后无尾随空格）
    const trail = " ".repeat(Math.max(0, totalWidth - safeIndex * 3 - 1));
    return (
      <text>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          {`${leftPad}▸${trail}`}
        </span>
      </text>
    );
  };

  // ── 5 档条形字符 ──────────────────────────────────────────────────
  const barOf = (i: number): string => FIVE_BARS[i] ?? "▅";

  // ── 档位名（中英对照显示） ───────────────────────────────────────
  const nameOf = (i: number): string =>
    LEVEL_NAMES_CN[i] ?? EFFORT_LEVELS[i] ?? "";

  // ── 键位提示 ─────────────────────────────────────────────────────
  const hint = autoOn
    ? "[Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消"
    : "[←/→] 切档 · [Tab/Space] 切 Auto · [Enter] 确认 · [Esc] 取消";

  // ── 标题装饰 ─────────────────────────────────────────────────────
  const titlePrefix = "▓▒░ THINKING ░▒▓";

  return (
    <box
      flexDirection="column"
      borderStyle="double"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
    >
      {/* 标题行：块字符包裹 + UNDERLINE 横贯 */}
      <text>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {titlePrefix}
        </span>
        <span fg={pal.running} attributes={TextAttributes.UNDERLINE}>
          {"  "}
        </span>
      </text>

      {/* 扫描线行（24 段 `─`，常驻 lit 位置循环） */}
      <text>{renderScanline()}</text>

      {/* Auto 行：●/○（开时 BLINK + fg 脉冲，关时 ○ dim） */}
      <text>
        {autoOn ? (
          <>
            <span fg={dotColor} attributes={TextAttributes.BLINK}>
              {"●"}
            </span>
            <span fg={pal.text}>{"  AUTO  · "}</span>
            <span fg={pal.running}>{"adaptive"}</span>
            <span fg={pal.dim}>{"（跟随 env/provider 默认）"}</span>
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

      {/* 5 档可视化条（递增）+ 当前档 UNDERLINE + 切档 flash */}
      <text>
        {levels.map((level, i) => {
          const isCurrent = i === currentIndex;
          const color = autoOn
            ? pal.dim
            : isCurrent
              ? currentBarColor
              : pal.dim;
          const attr = isCurrent ? currentAttr : TextAttributes.BOLD;
          return (
            <span key={`bar-${level}`} fg={color} attributes={attr}>
              {`${barOf(i)}${i < levels.length - 1 ? " " : ""}`}
            </span>
          );
        })}
      </text>

      {/* 当前档指针 ▶（Auto off 时） */}
      {renderCurrentPointer()}

      {/* 档位名（中文）—— 当前档 UNDERLINE + BOLD + running */}
      <text>
        {levels.map((level, i) => {
          const isCurrent = i === currentIndex;
          const color = autoOn ? pal.dim : isCurrent ? pal.running : pal.dim;
          const attr = isCurrent ? currentAttr : TextAttributes.NONE;
          return (
            <span key={`lbl-${level}`} fg={color} attributes={attr}>
              {`${nameOf(i)}${i < levels.length - 1 ? "  " : ""}`}
            </span>
          );
        })}
      </text>

      {/* 焦点游标 ▸（仅 picker open 且 autoOn=false 时，白色） */}
      {renderFocusCursor()}

      {/* 键位提示 */}
      <text fg={pal.dim}>{hint}</text>
    </box>
  );
}

// ── 导出 ──────────────────────────────────────────────────────────────
export const design14: ThinkingDesign = {
  meta: {
    id: "design-14-scan",
    name: "扫描线霓虹",
    tag: "Scan Neon",
    summary:
      "double 双线呼吸边框 + 顶部扫描线光带位置循环 + Auto 圆点 BLINK + 当前档 UNDERLINE + 切档 flash 红闪 + 焦点游标与当前档指针独立分离。",
  },
  render: ({ model, cols }) =>
    (<Design14Scan model={model} cols={cols} />) as ReactElement,
};
