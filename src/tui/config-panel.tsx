/** @jsxImportSource @opentui/react */
/**
 * src/tui/config-panel.tsx
 *
 * `/config` 设置面板（ADR-0096，T1+T2）：无参 `/config` 打开与 `/model` 同族的浮层
 * 面板，三行（FS 隔离档 / worktree 门禁 / 子代理并发上限）；有参 `/config …`
 * 仍走既有 `applyFsModeCommand` 路径不变。
 *
 * 交互语义（与 model-picker / memory-picker 同款 SSOT —— picker family 三件套：
 *  State + reducer + rows 函数 + 组件）：
 *  - ↑/↓ → 移焦点（clamp [0, ROW_COUNT-1]，三行恒定）；
 *  - Enter → fix（FS 行：翻 holder 后落盘；cap 行：循环 cap holder 后落盘；
 *    worktree 行：翻 worktree holder 后落盘 —— 三行均已激活）；
 *  - Esc → commit（**直接关闭**，无 save-staged 语义）—— Enter 翻转即落盘，
 *    没有「未提交的暂存态」可保存，与 model-picker 的 cancel 语义同款；
 *  - ctrl/meta → ignore（让给 app 层既有路由）。
 *
 * 行账：`configPickerRows()` = 边框 2 + 标题 1 + 3 行内容 + 键位提示 1 = 7，
 * **不含 marginBottom=1**（与 modelPickerRows / thinkingPickerRows / memoryPickerRows
 * 同约定，由 chromeReserveRows 的 +1 入账）。
 *
 * 三行（值域闭集，非法态不可达 —— 面板键入路径无自由输入）：
 *  - FS 隔离档 `global | workspace`（活动行，可改）；经 `props.fsMode?.set()`
 *    翻 holder 后 fire-and-forget `props.onPersistFsMode`，失败 → notice。
 *  - worktree 门禁 `ON | OFF`（T3 活动行）：经 `props.worktreeOnMutateHolder`
 *    `set(...)` 翻 holder 后 fire-and-forget `onPersistWorktreeOnMutate`，失败
 *    → notice（与 FS / cap 行同款：holder 已生效不撤回）。
 *  - 子代理并发上限 `3 | 5 | 9 | 15 | unlimited`（T2 活动行）：经
 *    `nextSubagentCap` 循环调 cap holder `set(...)` 后 fire-and-forget
 *    `onPersistSubagentCap`，失败 → notice（与 FS 行同形态）。
 */
import { useEffect, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import type { ModalKeyEvent } from "./modal.js";
import type {
  FsIsolationMode,
  FsModeContext,
} from "../harness/sandbox/fs-mode.js";
import { tuiPalette } from "./theme.js";
import { BORDER_CYCLE_MS, flowBorderColor } from "./designs/_color.js";

/**
 * config 面板宽度（与 picker family 同族但**独立取值**，不复用 PICKER_WIDTH）。
 * 三行带右侧「Enter 切换为 …」hint，最宽内容行 = 51 列（`▸ 文件系统隔离档
 * global  ·  Enter 切换为 workspace`，CJK=2；cap 行最宽 47）—— 50 宽的
 * PICKER_WIDTH 内宽只有 46 列，会把行 wrap 成两行、顶破 `configPickerRows()`
 * 的行账挤 transcript（code-review High 修复：宽度预算 = 内宽 ≥ 最宽行）。
 * 56 − 边框 2 − paddingX 2 = 52 ≥ 51。行账不受宽度影响（行数不变）。
 */
export const CONFIG_PICKER_WIDTH = 56;

/** T1 三行：恒 3（FS / worktree / cap）。后续 T2/T3 只加行，不增列。 */
export const CONFIG_PICKER_ROW_COUNT = 3;

/** 子代理并发上限 display-only 取值（值域闭集；undefined = 未接线显示「—」）。 */
export type SubagentCapDisplay = number | "unlimited" | undefined;

/**
 * 子代理并发上限显示串（display-only；T2 由 holder.get() 替换）。undefined →
 * "—"（未接线 / 启动装配缺失的占位）。
 */
export function formatSubagentCapDisplay(cap: SubagentCapDisplay): string {
  if (cap === undefined) return "—";
  if (cap === "unlimited") return "unlimited";
  return String(cap);
}

/** ADR-0096 T2 ── 子代理并发上限闭集（面板 Enter 循环唯一源）。3→5→9→15→unlimited→3。 */
export const SUBAGENT_CAP_CYCLE: ReadonlyArray<number | "unlimited"> = [
  3,
  5,
  9,
  15,
  "unlimited",
];

/**
 * 闭集内下一个 cap（pure）。`3 → 5 → 9 → 15 → "unlimited" → 3` 循环。非法
 * 入参（含 undefined）→ 默认 3 起步（与 T1 显示「—」后首次 Enter 一致：
 * 不预设初值，先回退到闭集最小元素，避免把 holder 拍到意外大值）。调用方
 * 已经过面板 Enter 路径不会传非法值；本函数是 fail-closed 兜底。
 */
export function nextSubagentCap(
  current: number | "unlimited" | undefined
): number | "unlimited" {
  if (current === undefined) return SUBAGENT_CAP_CYCLE[0]!;
  const idx = SUBAGENT_CAP_CYCLE.indexOf(current as number | "unlimited");
  if (idx < 0) return SUBAGENT_CAP_CYCLE[0]!;
  return SUBAGENT_CAP_CYCLE[(idx + 1) % SUBAGENT_CAP_CYCLE.length]!;
}

/**
 * worktree 门禁显示串（T1 display-only；T3 起由 holder 现值驱动）。
 * `undefined`（未接线 / 启动装配缺失）→ "OFF"（与 `resolveWorktreeOnMutate`
 * 的 fail-closed 缺省同向）。
 */
export function formatWorktreeOnMutateDisplay(on: boolean | undefined): string {
  return on === true ? "ON" : "OFF";
}

/**
 * ADR-0096 T3 ── worktree 门禁翻转（pure）：`ON ↔ OFF` 闭集切换。
 * 面板内只产这两个值；holder 内部 `set` 还会过 typeof boolean 兜底
 * （fail-closed，与 `createFsModeContext` 的 set 同形态）。
 */
export function toggleWorktreeOnMutate(on: boolean): boolean {
  return !on;
}

/**
 * 面板状态（reducer + 组件共用）。`focusedIndex` 是面板内唯一暂存态（clamp
 * 到 [0, CONFIG_PICKER_ROW_COUNT-1]）；其余字段都是渲染期 snapshot（来自
 * props / fsMode.get()，不存本组件内 —— 避免与 holder 不同步）。
 */
export interface ConfigPickerState {
  readonly focusedIndex: 0 | 1 | 2;
}

export type ConfigPickerAction =
  | { readonly kind: "move"; readonly index: 0 | 1 | 2 }
  | { readonly kind: "fix" }
  | { readonly kind: "commit" }
  | { readonly kind: "ignore" };

/**
 * 键路由纯函数（宿主 useKeyboard 消费）：
 *  - ctrl/meta → ignore（Ctrl+C/O 不被吞）；
 *  - Esc → commit（直接关闭，无 staged 状态可保存 —— Enter 即落盘）；
 *  - ↑/↓ → move，clamp [0, ROW_COUNT-1]；
 *  - Enter → fix（按 focusedIndex 决定改哪个值；非 FS 行 no-op，组件层判行
 *    后落到 onSelect 上，由宿主决定是否真改）；
 *  - 其余 → ignore。
 */
export function reduceConfigPickerKey(
  event: ModalKeyEvent,
  opts: { readonly focusedIndex: 0 | 1 | 2 }
): ConfigPickerAction {
  const { key } = event;
  if (key.ctrl || key.meta) return { kind: "ignore" };
  if (key.escape) return { kind: "commit" };
  if (key.upArrow) {
    return {
      kind: "move",
      index: Math.max(
        0,
        Math.min(CONFIG_PICKER_ROW_COUNT - 1, opts.focusedIndex - 1)
      ) as 0 | 1 | 2,
    };
  }
  if (key.downArrow) {
    return {
      kind: "move",
      index: Math.max(
        0,
        Math.min(CONFIG_PICKER_ROW_COUNT - 1, opts.focusedIndex + 1)
      ) as 0 | 1 | 2,
    };
  }
  if (key.return) return { kind: "fix" };
  return { kind: "ignore" };
}

/**
 * FS 档翻转（pure）：`global ↔ workspace` 闭集切换。面板内只产这两个值；
 * holder 内部 `set` 还会过 `parseFsModeFlag` 兜底（fail-closed）。
 */
export function toggleFsMode(mode: FsIsolationMode): FsIsolationMode {
  return mode === "global" ? "workspace" : "global";
}

/**
 * 面板总终端行数（行账 SSOT，纯函数）：边框 2 + 标题 1 + 内容 3 行 +
 * 键位提示 1 = 7。**不含 marginBottom=1** —— 由 chromeReserveRows 的 +1
 * 入账（与 modelPickerRows / thinkingPickerRows / memoryPickerRows 同约定）。
 */
export function configPickerRows(): number {
  return 7;
}

/**
 * 把面板的 fix action 翻译成「要写哪一行」。宿主据此派发到 FS holder / worktree
 * holder / cap holder。本函数只是 pure 路由：focusedIndex → row kind，
 * 不接触 holder 也不写文件 —— 真正的 set + persist 在 app.tsx 内联（S5：
 * 行为体留在宿主；本叶子只做判别，避免组件内联触发引擎写）。
 */
export type ConfigRowKind = "fsMode" | "worktreeOnMutate" | "subagentCap";

export function configRowKindFor(focusedIndex: 0 | 1 | 2): ConfigRowKind {
  if (focusedIndex === 0) return "fsMode";
  if (focusedIndex === 1) return "worktreeOnMutate";
  return "subagentCap";
}

/**
 * worktree 行的三件展示值（value / hint / readOnly），按「holder 是否在场」
 * 两分支收口。抽到模块级的理由：`ConfigPicker` 是既有超线组件（面板每加一个
 * 分支都会顶到 S5 ratchet），且本投影与 `capValue` / `fsValue` 同族 ——
 * 渲染期 snapshot，不写任何字段。
 *
 * holder 在场 → 现值 `holder.get()` 现读 + hint 展示「按 Enter 会切到哪」
 * （与 FS / cap 行同口径）+ 可改；缺席 → 退回 `worktreeOn` 静态快照 +
 * 无 hint + read-only（T1 形态，`row()` 渲染「(仅显示)」）。
 */
function worktreeRowDisplay(props: {
  readonly worktreeOnMutateHolder?: { readonly get: () => boolean };
  readonly worktreeOn?: boolean;
}): {
  readonly value: string;
  readonly hint: string;
  readonly readOnly: boolean;
} {
  const holder = props.worktreeOnMutateHolder;
  if (holder === undefined) {
    return {
      value: formatWorktreeOnMutateDisplay(props.worktreeOn),
      hint: "",
      readOnly: true,
    };
  }
  const current = holder.get();
  return {
    value: formatWorktreeOnMutateDisplay(current),
    hint: `Enter 切换为 ${formatWorktreeOnMutateDisplay(toggleWorktreeOnMutate(current))}`,
    readOnly: false,
  };
}

/**
 * ConfigPicker —— design-25 风格设置面板。常驻 overlay：无入场动画，宽度固定
 * CONFIG_PICKER_WIDTH（56，独立于 PICKER_WIDTH —— 行带右侧 hint 更宽）、
 * alignSelf flex-start 靠左（与 model-picker 同款）；行数由 configPickerRows
 * 预测（7 行）。
 *
 * 三行 Enter 同款：翻各自 holder 后 fire-and-forget 落盘（失败由宿主经
 * notice 兜底，holder 不撤回）；对应 holder 缺席 → no-op + 仅显示。
 */
export function ConfigPicker(props: {
  readonly state: ConfigPickerState;
  readonly fsMode: FsModeContext | undefined;
  /**
   * ADR-0096 T3：worktree 门禁运行时 holder（与 `subagentCapHolder` 同形态）。
   * 在场时该行读 `holder.get()` 现值（每次 render 现读）且 Enter 激活；缺席
   * 时退回 `worktreeOn` 静态快照（T1 形态，仍为 read-only）。
   */
  readonly worktreeOnMutateHolder?: {
    readonly get: () => boolean;
  };
  /**
   * worktree 门禁启动期快照（T1 display-only；T3 由 holder 在场时覆盖）。
   * undefined → "OFF" 占位。
   */
  readonly worktreeOn?: boolean;
  /**
   * ADR-0096 T2：子代理并发上限运行时 holder。在场时面板 cap 行读 `holder.get()`
   * 现值（每次 render 现读，与 fsMode 同形态）；缺席时退回
   * `subagentCapDisplay`（T1 启动期快照）。
   */
  readonly subagentCapHolder?: {
    readonly get: () => number | "unlimited";
  };
  /**
   * 子代理并发上限启动期快照（T1 display-only；T2 在场时被 subagentCapHolder
   * 覆盖，保留作为测试 fixture / 旧宿主兼容）。undefined → "—" 占位。
   */
  readonly subagentCapDisplay?: SubagentCapDisplay;
  /**
   * cap 行是否有 holder 接进（决定 cap 行 Enter 是否激活）；宿主（TuiApp）传
   * undefined 时 cap 行回退为 read-only（与 T1 行为一致）。
   */
  readonly capRowInteractive?: boolean;
  /**
   * 重渲染触发器（Enter 翻 holder 后由宿主递增）。holder 是普通对象，
   * `get()` 不订阅 —— 不传这个 prop 的话父组件重渲染时本组件仍会重新执行，
   * 但显式带上它能让「为什么这里会刷新」在类型上自解释，也防未来把组件
   * memo 化时静默失效。
   */
  readonly renderTick?: number;
}): ReactNode {
  const pal = tuiPalette;
  const { focusedIndex } = props.state;

  const tl = useTimeline();
  const [borderPhase, setBorderPhase] = useState(0);
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

  // FS 行现值：调用期读 holder（面板打开期间快照语义 —— 与 envDisplay.get()
  // 同款；holder 缺席 → 默认 "global" 显示）。避免宿主经 props 传 snapshot
  // 给 TuiApp 增分支（S5 硬门）。
  const fsValue = props.fsMode?.get() ?? "global";
  const fsOther = toggleFsMode(fsValue);
  // FS 行的可改值预览（不是 staged 态 —— 只是给用户看「按 Enter 会翻到哪」），
  // 与 memory-picker 的 `descOn` / `descOff` 投影同口径；不改任何持久化字段。
  const fsNextHint = `Enter 切换为 ${fsOther}`;
  // worktree 行现值 + 可改值预览：holder 在场按 holder.get() 现读（Enter 翻
  // holder → 下次 render 即见新值，与 fsMode / cap 行一致）；缺席退回
  // props.worktreeOn（T1 启动期快照）+ 无 hint（read-only）。两分支收口在
  // 模块级 helper（S5：ConfigPicker 是既有 god component）。
  const worktreeRow = worktreeRowDisplay(props);
  // cap 行现值：holder 在场时按 holder.get() 现读（TUI /config 面板 Enter 翻
  // holder → 下次 render 即看到新值，与 fsMode 形态一致）；holder 缺席退回
  // props.subagentCapDisplay（T1 启动期快照）。
  const capValue = formatSubagentCapDisplay(
    props.subagentCapHolder !== undefined
      ? props.subagentCapHolder.get()
      : props.subagentCapDisplay
  );
  // cap 行可改值预览：显示「按 Enter 切到哪」—— 与 FS 行 fsNextHint 同款
  // 口径。capRowInteractive=false → 不显示 hint（降级到 read-only）。
  const capCurrentValue =
    props.subagentCapHolder !== undefined
      ? props.subagentCapHolder.get()
      : props.subagentCapDisplay;
  const capNextHint =
    props.capRowInteractive === true
      ? `Enter 切换为 ${formatSubagentCapDisplay(nextSubagentCap(capCurrentValue))}`
      : "";

  function row(
    index: 0 | 1 | 2,
    label: string,
    value: string,
    hint: string,
    readOnly: boolean
  ): ReactNode {
    const focused = focusedIndex === index;
    const fg = focused ? pal.running : pal.text;
    const prefix = focused ? "▸ " : "  ";
    return (
      <text>
        <span fg={focused ? pal.running : pal.dim}>{prefix}</span>
        <span
          fg={fg}
          attributes={focused ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {`${label}  ${value}`}
        </span>
        {!readOnly && <span fg={pal.dim}>{`  ·  ${hint}`}</span>}
        {readOnly && <span fg={pal.dim}>{`  ·  (仅显示)`}</span>}
      </text>
    );
  }

  // 三行 panelSlot 是无自由文本渲染（label + value + hint 都闭合到 const），
  // 因此按行号夹 const 到 inline 字面，避免 JSX 字符串拼接的隐式 escape。
  return (
    <box
      flexDirection="column"
      borderStyle="rounded"
      borderColor={flowBorderColor(borderPhase)}
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      width={CONFIG_PICKER_WIDTH}
      alignSelf="flex-start"
    >
      {/* 标题 ◆─ 设置（design-25 同款前缀） */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          设置
        </span>
      </text>
      {row(0, "文件系统隔离档", fsValue, fsNextHint, false)}
      {row(
        1,
        "worktree 门禁",
        worktreeRow.value,
        worktreeRow.hint,
        worktreeRow.readOnly
      )}
      {row(
        2,
        "子代理并发上限",
        capValue,
        capNextHint,
        props.capRowInteractive !== true
      )}
      <text fg={pal.dim} wrapMode="none">
        [↑↓] 选择 · [Enter] 切换 · [Esc] 关闭
      </text>
    </box>
  );
}
