/** @jsxImportSource @opentui/react */
/**
 * src/tui/thinking-picker.tsx
 *
 * design-25 思考面板（双面板版）：/thinking 开关面板 + /effort 档位面板。
 *
 * 用户定案交互语义（SSOT，不可改）：
 *  - /thinking → 纯**开关**面板（ON/OFF），只影响 thinkingEnabled，不碰 effort。
 *  - /effort → 纯**档位**面板（low..max 5 档），只影响 thinkingEffort（隐式开
 *    思考），不碰开关。
 *  - Enter = 选定并固定：把当前选择「固定」为面板内已提交值，**面板保持打开**。
 *  - Esc = 保存退出：把面板内「已固定」的值写入真实 thinkingEnabled /
 *    thinkingEffort state，然后关闭。**没有 cancel/放弃路径**。
 *  - computeThinkingOverride（thinking-gate.ts）禁止改动——picker 只是
 *    setThinkingEnabled / setThinkingEffort 的新入口。
 *
 * T1（纯函数 + 数据映射，无 React 依赖）：
 *  - effortToIndex / indexToEffort：ThinkingEffortWire ↔ 档位索引 SSOT 映射
 *    （""=自适应 → -1；low..max → 0..4；越界/自适应 → 反向兜底 ""）。
 *  - THINKING_LEVELS：复用 slash.ts ADJUSTABLE_EFFORT_LEVELS（不重复定义第二份
 *    列表——slash.ts 已从 contract.ts THINKING_EFFORT_VALUES 派生）。
 *  - reduceThinkingSwitchKey：开关面板键路由纯函数（Space/Tab → toggle 翻转
 *    面板内开关预览；Enter → fix 固定当前预览、不翻转；Esc → commit 保存退出；
 *    ctrl/meta 及其余 → ignore）。
 *  - reduceThinkingEffortKey：档位面板键路由纯函数（←/→ clamp [0,4] 移档；
 *    Enter → fix 固定焦点为 committed；Esc → commit 保存退出；Space/Tab →
 *    toggleAuto 切换自适应（面板保持打开）；ctrl/meta 及其余 → ignore）。
 *
 * T2（design-25 渲染组件 + 行账，视觉对标 design-25-flow-edge）：
 *  - ThinkingPickerState：面板判别联合（kind:"thinking" | kind:"effort"，effort
 *    带 autoOn=自适应态，空格/Tab 切换）。
 *  - ThinkingPicker：圆角流光框（4 token 8000ms 边框相位）+ 档位标签 + 键位提
 *    示，按 state.kind 分派两面板，视觉风格一致（design-25：圆角流光边框 + 紫
 *    渐变进度条 + 边界水线）。thinking 开关面板内容 3 行：标题 / 状态行 / 键位
 *    提示（**无进度条**，纯开关）；effort 档位面板内容 5 行：标题 / 状态行 /
 *    进度条 / 档位标签 / 键位提示。无入场动画——常驻 overlay，行数恒定不挤动
 *    行预算。
 *  - thinkingPickerRows(kind)：面板总终端行数 = thinking 5（边框 2 + 内容 3）
 *    / effort 7（边框 2 + 内容 5），不含 marginBottom=1（与 modalRows 同约定，
 *    由 chromeReserveRows +1 入账）。
 *  - 面板宽度固定 PICKER_WIDTH（不占满屏宽），alignSelf="flex-start" 靠左对齐。
 *  - 颜色数学（gradAt / triangleWindow / flowBorderColor / mixHex）与
 *    design-25 逐字一致，保持 inline（design 文件私有声明，T2 不动它）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { TextAttributes, type Timeline } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import type { ThinkingEffortWire } from "../session-api/contract.js";
import type { ModalKeyEvent } from "./modal.js";
import { ADJUSTABLE_EFFORT_LEVELS } from "./slash.js";
import { tuiPalette } from "./theme.js";
import {
  SEG_COUNT,
  floorTo5BarLen,
  labelPad,
  segmentLen,
} from "./designs/_geometry.js";

/** 可调思考强度档位（SSOT 引用 slash.ts，不重复定义）。5 档 concrete 顺序
 *  low..max，索引 0..4；""=自适应不在此列。 */
export const THINKING_LEVELS: ReadonlyArray<Exclude<ThinkingEffortWire, "">> =
  ADJUSTABLE_EFFORT_LEVELS;

/** 档位索引上界（5 档 → 0..4）。 */
const LEVEL_MAX_INDEX = THINKING_LEVELS.length - 1;

/** effort 档位 → picker 聚焦索引（""=自适应 → -1）。 */
export function effortToIndex(effort: ThinkingEffortWire): number {
  if (effort === "") return -1;
  return THINKING_LEVELS.indexOf(effort);
}

/** effort 档位 → picker **展示**索引（""=自适应 → 1=medium，spec §0「档位默认
 *  medium」）。picker 打开时未显式指定档位（thinkingEffort=""）也必须有可感知
 *  的当前档高亮，否则首屏空档、Enter 直接固定歧义（review Medium#1）。 */
export function effortToDisplayIndex(effort: ThinkingEffortWire): number {
  const idx = effortToIndex(effort);
  return idx === -1 ? 1 : idx; // "" → medium（索引 1）
}

/** picker 聚焦索引 → effort 档位（-1 自适应 / 越界 → ""）。 */
export function indexToEffort(index: number): ThinkingEffortWire {
  return index >= 0 && index <= LEVEL_MAX_INDEX
    ? (THINKING_LEVELS[index] as ThinkingEffortWire)
    : "";
}

// ── 开关面板键路由（/thinking） ────────────────────────────────────────

/** reduceThinkingSwitchKey 决策结果。 */
export type ThinkingSwitchAction =
  | { readonly type: "toggle" } // Space/Tab → 翻转面板内开关预览
  | { readonly type: "fix" } // Enter → 固定当前预览（面板保持打开，无翻转）
  | { readonly type: "commit" } // Esc → 保存退出（写真实 thinkingEnabled）
  | { readonly type: "ignore" };

/**
 * 开关面板键路由纯函数（宿主 useKeyboard 消费）：
 *  - ctrl/meta 组合键 → ignore（让给既有路由，Ctrl+C/O 不被吞）；
 *  - Esc → commit（保存退出：面板内已固定值写真实 state，无 cancel 路径）；
 *  - Space / Tab → toggle（翻转面板内开关预览，面板保持打开）；
 *  - Enter → fix（固定当前预览，面板保持打开、不翻转——与档位面板 Enter 固定
 *    语义一致；「回车选定后固定而不是退出」）；
 *  - 其余（↑/↓/可打印字符等）→ ignore（不设 hotkey 直选）。
 */
export function reduceThinkingSwitchKey(
  event: ModalKeyEvent
): ThinkingSwitchAction {
  const { key } = event;
  if (key.ctrl || key.meta) return { type: "ignore" };
  if (key.escape) return { type: "commit" };
  if (key.space || key.tab) return { type: "toggle" };
  if (key.return) return { type: "fix" };
  return { type: "ignore" };
}

// ── 档位面板键路由（/effort） ──────────────────────────────────────────

/** reduceThinkingEffortKey 决策结果。 */
export type ThinkingEffortAction =
  | { readonly type: "move"; readonly index: number } // ←/→ clamp [0,4]
  | { readonly type: "fix" } // Enter → 固定焦点为 committed（面板保持打开）
  | { readonly type: "toggleAuto" } // Space/Tab → 切换自适应（autoOn 取反，面板保持打开）
  | { readonly type: "commit" } // Esc → 保存退出（写真实 thinkingEffort）
  | { readonly type: "ignore" };

/**
 * 档位面板键路由纯函数（宿主 useKeyboard 消费）：
 *  - ctrl/meta 组合键 → ignore（让给既有路由，Ctrl+C/O 不被吞）；
 *  - Esc → commit（保存退出：已固定档写真实 state，无 cancel 路径）；
 *  - ←/→ → move，clamp [0,4]；
 *  - Enter → fix（把焦点档固定为面板内已提交档，面板保持打开）；
 *  - Space / Tab → toggleAuto（切换自适应 auto 态，面板保持打开——auto 开时
 *    面板灰显整轨、Esc 保存退出写 ""=自适应；auto 关回到 concrete 选档）；
 *  - 其余（↑/↓/可打印字符等）→ ignore（不设 hotkey 直选）。
 */
export function reduceThinkingEffortKey(
  event: ModalKeyEvent,
  opts: { readonly focusedIndex: number }
): ThinkingEffortAction {
  const { focusedIndex } = opts;
  const { key } = event;
  if (key.ctrl || key.meta) return { type: "ignore" };
  if (key.escape) return { type: "commit" };
  if (key.leftArrow) {
    return { type: "move", index: Math.max(0, focusedIndex - 1) };
  }
  if (key.rightArrow) {
    return { type: "move", index: Math.min(LEVEL_MAX_INDEX, focusedIndex + 1) };
  }
  if (key.space || key.tab) return { type: "toggleAuto" };
  if (key.return) return { type: "fix" };
  return { type: "ignore" };
}

// ── T2：design-25 渲染组件 + 行账 ─────────────────────────────────────────

/** 面板固定宽度（列）：进度条几何按此推导，不随终端宽变化（不占满屏宽）。 */
export const PICKER_WIDTH = 50;

/**
 * thinking-picker 面板总终端行数（行账 SSOT，纯函数）。
 *
 * 按面板判别 kind 返回：thinking 开关面板 5 行（圆角边框 2 + 内容 3：标题、
 * 状态行、键位提示——**无进度条**）；effort 档位面板 7 行（圆角边框 2 + 内容
 * 5：标题、状态行、进度条、档位标签、键位提示）。两面板位置与行数恒定，宽度
 * 固定（PICKER_WIDTH），故与 cols 无关。
 *
 * **不含 marginBottom=1** —— 与 modalRows 同约定：面板自身的 marginBottom
 * 由 chromeReserveRows 的 +1 入账（app.tsx chromeReserveRows，modalRows 同款）。
 */
export function thinkingPickerRows(kind: ThinkingPickerState["kind"]): number {
  return kind === "thinking" ? 5 : 7;
}

// ── design-25 颜色工具（与 design-25-flow-edge.tsx 逐字一致，inline 私有） ──

/** hex → [r,g,b]（0..1）。非法输入回退 [1,1,1]。 */
function hexToRgb(hex: string): readonly [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1]!, 16);
  return [
    ((v >> 16) & 0xff) / 255,
    ((v >> 8) & 0xff) / 255,
    (v & 0xff) / 255,
  ] as const;
}

/** a/b 按 t∈[0,1] 线性插值（越界 clamp）。 */
function mixHex(a: string, b: string, t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round((ar + (br - ar) * tt) * 255);
  const g = Math.round((ag + (bg - ag) * tt) * 255);
  const bl = Math.round((ab + (bb - ab) * tt) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g
    .toString(16)
    .padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

/** 3-stop 线性渐变 logoInk(0) → running(0.5) → logoGold(1)，design-25 同款。 */
function gradAt(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  if (k <= 0.5) return mixHex(tuiPalette.logoInk, tuiPalette.running, k * 2);
  return mixHex(tuiPalette.running, tuiPalette.logoGold, (k - 0.5) * 2);
}

/** 三角窗：中心 c、半宽 hw → [0,1] 强度（hw 外为 0）。 */
function triangleWindow(i: number, c: number, hw: number): number {
  if (hw <= 0) return 0;
  const d = Math.abs(i - c);
  if (d >= hw) return 0;
  return 1 - d / hw;
}

/** 边框流光：相位 p ∈ [0, 4]，相邻 2 相位 RGB 插值。 */
function flowBorderColor(phase: number): string {
  const n = 4;
  const idx = Math.floor(phase) % n;
  const f = phase - Math.floor(phase);
  const tokens = [
    tuiPalette.logoInk,
    tuiPalette.running,
    tuiPalette.logoGold,
    tuiPalette.running,
  ];
  const a = tokens[idx]!;
  const b = tokens[(idx + 1) % n]!;
  return mixHex(a, b, f);
}

// ── 渲染常量（design-25 同款） ──────────────────────────────────────────

/** 边框流光 4 相位周期（design-5/25 同款）。 */
const BORDER_CYCLE_MS = 8_000;
/** 边界水线左右流动一趟的时长（alternate ping-pong 单程）。 */
const EDGE_FLOW_MS = 2400;
/** 水线晃动幅度（相对 segLen 的半幅，± 0.9 段）。 */
const EDGE_SWAY = 0.9;
/** 水线最亮处向 logoGold 的混合上限。 */
const EDGE_MIX = 1;

/**
 * ThinkingPicker 工作态（宿主 app.tsx 持有，T3 接入）——面板判别联合。
 *
 *  - { kind:"thinking", enabled }：开关面板预览态（/thinking）——enabled =
 *    面板内未提交的开关预览（Enter 固定 / Esc 保存退出写 thinkingEnabled）；
 *  - { kind:"effort", focusedIndex, currentIndex, autoOn }：档位面板（/effort）
 *    ——focusedIndex = 焦点游标（0..4，←/→ 移动中预览）；currentIndex = 已固定档
 *    （Enter 固定 / Esc 保存退出写 thinkingEffort）；autoOn = 自适应态（空格/
 *    Tab 切换，开时面板灰显整轨、Esc 保存退出写 ""=自适应）。
 */
export type ThinkingPickerState =
  | { readonly kind: "thinking"; readonly enabled: boolean }
  | {
      readonly kind: "effort";
      readonly focusedIndex: number;
      readonly currentIndex: number;
      readonly autoOn: boolean;
    };

/** 5 档短名（与 _geometry.ts LEVEL_LABELS / slash.ts 顺序一致）。 */
const LEVEL_LABELS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * ThinkingPicker —— design-25 风格思考面板（圆角流光框 + 紫渐变 + 边界水线）。
 * 按 state.kind 分派：thinking 开关面板（纯 ON/OFF，无进度条）/ effort 档位面板
 * （5 档焦点游标 + 按 currentIndex 填充 + 边界水线）。常驻 overlay：无入场动画，
 * 宽度固定 PICKER_WIDTH、alignSelf flex-start 靠左（不占满屏宽）；行数恒定：
 * thinking 5 行（2 边框 + 3 内容）、effort 7 行（2 边框 + 5 内容）。
 */
export function ThinkingPicker(props: {
  readonly state: ThinkingPickerState;
}): ReactNode {
  const pal = tuiPalette;
  const { state } = props;

  // ── Timeline 引用（useRef 锁首 render 实例，design-25 同款） ──
  const initialTimeline = useTimeline({
    duration: BORDER_CYCLE_MS,
    loop: true,
  });
  const timelineRef = useRef<Timeline | null>(null);
  if (timelineRef.current === null) timelineRef.current = initialTimeline;
  const tl = timelineRef.current;

  const edgeFirst = useTimeline({
    duration: EDGE_FLOW_MS,
    loop: true,
  });
  const edgeRef = useRef<Timeline | null>(null);
  if (edgeRef.current === null) edgeRef.current = edgeFirst;
  const tlEdge = edgeRef.current;

  // ── 常驻动效 state（每帧 setState） ──
  const [borderPhase, setBorderPhase] = useState(0);
  const [edgePhase, setEdgePhase] = useState(0.5); // 水线相位 0..1..0

  // 边框流光相位：8s 线性循环（onComplete 归零避免 reset 陷阱）
  useEffect(() => {
    const target = { phase: 0 };
    tl.add(target, {
      phase: 4,
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

  // 常驻：水线相位 0→1→0（alternate ping-pong），驱动边界左右小幅流动
  useEffect(() => {
    const target = { p: 0 };
    tlEdge.add(target, {
      p: 1,
      duration: EDGE_FLOW_MS,
      ease: "linear",
      loop: true,
      alternate: true,
      onUpdate: () => setEdgePhase(target.p),
    });
  }, [tlEdge]);

  // ── 进度条几何（共享 _geometry.ts，与 design-25 逐列一致） ──
  //   宽度固定 PICKER_WIDTH，不随终端 cols 变：border 左右 2 列 + paddingX
  //   各 1 列 = 4 列固定开销，内宽 = PICKER_WIDTH - 4。
  const innerCols = Math.max(SEG_COUNT, PICKER_WIDTH - 4);
  const barLen = floorTo5BarLen(innerCols);
  const segLen = segmentLen(barLen);

  // ── 开关面板（/thinking）：纯 ON/OFF 开关，无进度条（用户点名：开关面板
  //    不该有进度条，只有档位面板才显示档位进度） ──
  if (state.kind === "thinking") {
    const { enabled } = state;
    // 状态行：enabled → ◐ running + ON；否则 ◑ dim + OFF。描述（思考已开启/
    // 已关闭）恒 dim。
    const dotGlyph = enabled ? "◐" : "◑";
    const dotFg = enabled ? pal.running : pal.dim;
    const modeLabel = enabled ? "ON" : "OFF";
    const modeFg = enabled ? pal.running : pal.dim;
    const desc = enabled ? "思考已开启" : "思考已关闭";

    return (
      <box
        flexDirection="column"
        borderStyle="rounded"
        borderColor={flowBorderColor(borderPhase)}
        paddingX={1}
        paddingY={0}
        marginBottom={1}
        width={PICKER_WIDTH}
        alignSelf="flex-start"
      >
        {/* 标题 ◆─ 思考开关（design-25 同款前缀，与 [思考] 折叠行区分） */}
        <text>
          <span fg={pal.running}>{"◆─ "}</span>
          <span fg={pal.text} attributes={TextAttributes.BOLD}>
            思考开关
          </span>
        </text>

        {/* 状态行：◐/◑ + ON/OFF + 描述（enabled 亮 running，关闭 dim） */}
        <text>
          <span fg={dotFg}>{`${dotGlyph}  `}</span>
          <span fg={modeFg}>{modeLabel}</span>
          <span fg={pal.dim}>{`  ·  ${desc}`}</span>
        </text>

        {/* 键位提示（wrapMode none：窄终端 clip 不折行，保持固定 5 行行账） */}
        <text fg={pal.dim} wrapMode="none">
          [Space] 切换 · [Enter] 固定 · [Esc] 保存退出
        </text>
      </box>
    );
  }

  // ── 档位面板（/effort）：5 档焦点游标 + 按 currentIndex 填充 + 边界水线 ──
  const { focusedIndex, currentIndex, autoOn } = state;

  /** 水线中心列：当前档段最右一列 ± 0.9*segLen 的缓慢晃动。 */
  const edgeCenter =
    currentIndex * segLen + segLen - 1 + (edgePhase - 0.5) * segLen * EDGE_SWAY;

  /**
   * 字符 i 的视觉颜色（design-25 colorAt 逐字移植）：auto 态整条退化暗灰轨
   *  （无水线——自适应交给模型，不展示 concrete 填充）；否则未填充段
   *  （> currentIndex）→ 暗灰轨保持「干」，已填充段 → 紫渐变基色 + 当前档边界
   *  流动水线（三角窗向 logoGold 过渡）。
   */
  function colorAt(i: number): { bg: string; fg: string } {
    if (autoOn) return { bg: pal.border, fg: pal.dim };
    const segIdx = Math.min(SEG_COUNT - 1, Math.floor(i / segLen));
    if (segIdx > currentIndex) {
      // 未填充暗灰轨（水线不越界，保持"干"的观感）
      return { bg: pal.border, fg: pal.dim };
    }
    // 已填充段：3-stop 紫渐变基色
    const filledEnd = (currentIndex + 1) * segLen;
    const base = gradAt(i / Math.max(1, filledEnd));
    // 边界水线：半宽 = segLen 的三角窗，越靠近边界越向 logoGold 过渡
    const glowEdge = triangleWindow(i, edgeCenter, segLen);
    const crest = mixHex(pal.logoInk, pal.logoGold, glowEdge * EDGE_MIX);
    const bg = mixHex(base, crest, glowEdge); // 中心点直接 crest = logoGold
    const fg = mixHex(bg, pal.logoInk, 0.5);
    return { bg, fg };
  }

  // ── 档位标签样式：焦点游标 ▸◂（移动中）/ 已固定档提亮（Enter 固定）/ 其余 dim。
  //    auto 态整行灰显——无 ▸◂ 光标、无 accent 高亮（5 档只是展示，交给模型
  //    自适应）。──
  function labelFor(i: number): { text: string; fg: string; bold: boolean } {
    const text = LEVEL_LABELS[i]!;
    if (autoOn) return { text, fg: pal.dim, bold: false };
    if (i === focusedIndex)
      return { text: `▸ ${text} ◂`, fg: pal.running, bold: true };
    if (i === currentIndex) return { text, fg: pal.accent, bold: true };
    return { text, fg: pal.dim, bold: false };
  }

  // ── 档位标签行节点：labelPad 把标签居中到段中点，逐段拼成 barLen 宽 ──
  const labelNodes: ReactNode[] = [];
  for (let i = 0; i < LEVEL_LABELS.length; i++) {
    const seg = labelFor(i);
    const { lead, pad } = labelPad(segLen, seg.text);
    labelNodes.push(<span key={`p${i}`}>{" ".repeat(lead)}</span>);
    labelNodes.push(
      <span
        key={`l${i}`}
        fg={seg.fg}
        attributes={seg.bold ? TextAttributes.BOLD : TextAttributes.NONE}
      >
        {seg.text}
      </span>
    );
    labelNodes.push(<span key={`t${i}`}>{" ".repeat(pad)}</span>);
  }

  // ── 进度条：按 currentIndex 填充 + 边界水线（铺满内宽） ──
  const barCells: ReactNode[] = [];
  for (let i = 0; i < barLen; i++) {
    const { bg, fg } = colorAt(i);
    barCells.push(
      <span key={i} bg={bg} fg={fg}>
        █
      </span>
    );
  }

  // ── 渲染 ──
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      width={PICKER_WIDTH}
      alignSelf="flex-start"
    >
      {/* 标题 ◆─ 思考强度（design-25 同款前缀，与 [思考] 折叠行区分） */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          思考强度
        </span>
      </text>

      {/* 状态行：◐ 恒 running（effort 面板必开思考）；auto 态 ● running「AUTO ·
        自适应」，否则 ◐「手动档位」 */}
      <text>
        <span fg={pal.running}>{autoOn ? "●  " : "◐  "}</span>
        <span fg={pal.running} attributes={TextAttributes.BOLD}>
          {autoOn ? "AUTO · 自适应" : "手动档位"}
        </span>
      </text>

      {/* 进度条：紫渐变填充 + 当前档边界流动水线（铺满内宽） */}
      <text wrapMode="none">{barCells}</text>

      {/* 档位标签行：5 档各居中到段中点（几何对齐，断点对档位） */}
      <text wrapMode="none">{labelNodes}</text>

      {/* 键位提示（wrapMode none：窄终端 clip 不折行，保持固定 7 行行账）。
          auto 切换经 Tab 披露；实测内宽 46 列必须装下本串——去掉空格/·/←→
          才不 clip（PICKER_WIDTH 50 - 2 border - 2 paddingX = 46）。 */}
      <text fg={pal.dim} wrapMode="none">
        [←→] 选档 [Tab]自动 [Enter]固定 [Esc]保存退出
      </text>
    </box>
  );
}
