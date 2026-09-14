/** @jsxImportSource @opentui/react */
/**
 * src/tui/model-picker.tsx
 *
 * /model 模型选择面板（provider 注册表版）：每项一行 `${provider}/${model}`
 * （有 name 时附显示名），复用 design-25 视觉语言（圆角流光框 + ◆─ 标题 + ▸
 * 焦点游标 + 键位提示）。
 *
 * 交互语义（与 thinking-picker / memory-picker 同款 SSOT）：
 *  - ↑/↓ → 移焦点（clamp 在**可见窗口**内，面板保持打开）；
 *  - Enter → fix（选定当前焦点项，宿主据此持久化 + reloadFromEnv + 关闭）；
 *  - Esc → commit（**直接关闭，不持久化**）—— 见下方 cancel 语义说明；
 *  - Space/Tab 与 ←/→ → ignore（无 toggle / 无横移语义）；
 *  - ctrl/meta 组合键 → ignore（让给 app 层既有路由，Ctrl+C/O 不被吞）。
 *
 * ## Esc 为什么不构成 cancel 路径
 *
 * thinking-picker 的 Esc = 「保存退出」：面板内持有**未提交的暂存态**
 * （switchPreview / effortFocusIndex），Esc 才写真实 state。本面板没有暂存态
 * —— 焦点移动（↑/↓）只改 focusedIndex，不写任何持久化字段；唯一的写操作是
 * Enter 提交。因此 Esc 关闭时**没有东西需要保存**，也**没有东西需要回滚**：
 * 它既不是「保存退出」也不是「放弃修改」（无 staged 状态可放弃）。用户再次
 * 打开面板时焦点回到当前 model 对应的 entry（app.tsx 的 seed 逻辑），观感与
 * 关闭前一致 —— 关闭动作本身对配置零副作用。
 *
 * 行账：`modelPickerRows(entryCount)` = 边框 2 + 内容行（hard cap 12，超出显示
 * 「…N more」）+ 键位提示 1；**不含 marginBottom=1**（与 thinkingPickerRows 同
 * 约定，由 chromeReserveRows 的 +1 入账）。
 */
import { useEffect, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import type { ModalKeyEvent } from "./modal.js";
import { PICKER_WIDTH } from "./thinking-picker.js";
import { tuiPalette } from "./theme.js";
import { BORDER_CYCLE_MS, flowBorderColor } from "./designs/_color.js";

/** 可见内容行上限：超出部分折叠为一行「…N more」，面板行数不随注册表增长
 *  （V1 不滚屏，与 thinking-picker 的恒定行数纪律一致）。 */
export const MODEL_PICKER_MAX_ROWS = 12;

/** picker 内一项（provider 注册表扁平投影；调用方负责展开 provider × models）。 */
export interface ModelPickerEntry {
  readonly providerId: string;
  readonly modelId: string;
  /** provider.models[i].name（显示名）。缺省 → 只渲染路由 ID。 */
  readonly label?: string;
}

export interface ModelPickerState {
  readonly entries: ReadonlyArray<ModelPickerEntry>;
  readonly focusedIndex: number;
}

/** 路由 ID 串（持久化值 + 列表主标签）：`${provider}/${model}`。 */
export function modelRouteId(entry: ModelPickerEntry): string {
  return `${entry.providerId}/${entry.modelId}`;
}

export type ModelPickerAction =
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "fix" }
  | { readonly kind: "commit" }
  | { readonly kind: "ignore" };

/**
 * 焦点 clamp 上界（与渲染行账同源）：焦点只能落在**可见窗口**内，即
 * `min(entryCount, MODEL_PICKER_MAX_ROWS) - 1`。
 *
 * V1「不滚屏」的既定取舍：面板恒渲染前 MODEL_PICKER_MAX_ROWS 项，超出的条目
 * 只在「…N more」里计数、永远不可见。若 clamp 到 `entryCount-1`，注册表 ≥13 条
 * 时按 ↓ 会让游标 `▸` 移出渲染区 —— 焦点看不见却能 Enter 提交隐藏条目。
 * 代价：隐藏条目要**精简注册表**（删掉前 12 条之外的多余 model）才能选到，
 * 本面板不提供滚动窗口（与 thinking-picker 的恒定行数纪律一致）。
 */
function maxFocusedIndex(entryCount: number): number {
  return Math.max(0, Math.min(entryCount, MODEL_PICKER_MAX_ROWS) - 1);
}

/**
 * 键路由纯函数（宿主 useKeyboard 消费）：
 *  - ctrl/meta → ignore（Ctrl+C/O 不被吞）；
 *  - Esc → commit（关闭，不持久化）；
 *  - ↑/↓ → move，clamp [0, maxFocusedIndex]（可见窗口内；空列表 → 恒 0）；
 *  - Enter → fix（选定焦点项）；
 *  - Space / Tab / ←/→ / 其余 → ignore（无 toggle，无横移）。
 */
export function reduceModelPickerKey(
  event: ModalKeyEvent,
  opts: { readonly focusedIndex: number; readonly entryCount: number }
): ModelPickerAction {
  const { focusedIndex, entryCount } = opts;
  const { key } = event;
  if (key.ctrl || key.meta) return { kind: "ignore" };
  if (key.escape) return { kind: "commit" };
  // 两个方向都 clamp 到可见窗口：焦点 seed（app 层按当前 model 查下标）可能落在
  // 窗口外，任一方向键都会把焦点拉回可见区。
  const max = maxFocusedIndex(entryCount);
  if (key.upArrow) {
    return {
      kind: "move",
      index: Math.max(0, Math.min(max, focusedIndex - 1)),
    };
  }
  if (key.downArrow) {
    return {
      kind: "move",
      index: Math.max(0, Math.min(max, focusedIndex + 1)),
    };
  }
  if (key.return) return { kind: "fix" };
  return { kind: "ignore" };
}

/**
 * 面板总终端行数（行账 SSOT，纯函数）：边框 2 + 标题 1 + 内容行 + 键位提示 1
 * （与 memoryPickerRows「边框 2 + 标题 + 两行开关 + 键位提示」同款逐项列账）。
 * 内容行 = min(entryCount, MODEL_PICKER_MAX_ROWS)，entryCount 超过上限时
 * 多出的部分由「…N more」一行代表（面板行数因此封顶，不随注册表增长）。
 * entryCount = 0 → 1 行占位（空注册表路径由 app 层 notice 拦下，不打开面板；
 * 此处仍给确定性行数，避免渲染盒高度为 0）。
 * **不含 marginBottom=1** —— 与 modalRows / thinkingPickerRows 同约定，由
 * chromeReserveRows 的 +1 入账。
 */
export function modelPickerRows(entryCount: number): number {
  const overflow = entryCount > MODEL_PICKER_MAX_ROWS ? 1 : 0;
  const content = Math.max(1, Math.min(entryCount, MODEL_PICKER_MAX_ROWS));
  return 2 + 1 + content + overflow + 1;
}

/** 可见条目窗口：[0, max) —— V1 不滚屏（面板恒显示前 MODEL_PICKER_MAX_ROWS
 *  项，与 reduceModelPickerKey 的焦点上界同源）。 */
function visibleEntries(
  entries: ReadonlyArray<ModelPickerEntry>
): ReadonlyArray<ModelPickerEntry> {
  return entries.slice(0, MODEL_PICKER_MAX_ROWS);
}

/** 单行渲染文本：`▸ provider/model  ·  name`（焦点行带游标，非焦点两空格，
 *  与 memory-picker 的游标模式同宽——各 2 列，不破坏行账）。 */
function entryRow(
  key: string,
  entry: ModelPickerEntry,
  focused: boolean
): ReactNode {
  const pal = tuiPalette;
  const label = entry.label;
  return (
    <text key={key}>
      <span fg={focused ? pal.running : pal.dim}>{focused ? "▸ " : "  "}</span>
      <span
        fg={focused ? pal.running : pal.text}
        attributes={focused ? TextAttributes.BOLD : TextAttributes.NONE}
      >
        {modelRouteId(entry)}
      </span>
      {label !== undefined && label.length > 0 && (
        <span fg={pal.dim}>{`  ·  ${label}`}</span>
      )}
    </text>
  );
}

/**
 * ModelPicker —— design-25 风格模型选择面板。常驻 overlay：无入场动画，
 * 宽度固定 PICKER_WIDTH、alignSelf flex-start 靠左（不占满屏宽）；行数由
 * modelPickerRows 预测（边框 2 + 内容 + 键位提示 1）。
 */
export function ModelPicker(props: {
  readonly state: ModelPickerState;
}): ReactNode {
  const pal = tuiPalette;
  const { entries, focusedIndex } = props.state;

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

  const visible = visibleEntries(entries);
  const overflow = entries.length - visible.length;
  const rows: ReactNode[] = visible.map((entry, i) =>
    entryRow(`${entry.providerId}/${entry.modelId}`, entry, i === focusedIndex)
  );
  if (rows.length === 0) {
    // 防御分支：空注册表不打开面板（app 层 notice 拦下）；直接挂载到渲染器
    // 时给一行确定性占位，避免零高盒。
    rows.push(
      <text key="model-empty" fg={pal.dim}>
        （未配置 providers）
      </text>
    );
  }
  if (overflow > 0) {
    rows.push(
      <text key="model-more" fg={pal.dim}>
        {`  …${overflow} more`}
      </text>
    );
  }

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
      {/* 标题 ◆─ 模型（design-25 同款前缀，与同族面板视觉一致） */}
      <text>
        <span fg={pal.running}>{"◆─ "}</span>
        <span fg={pal.text} attributes={TextAttributes.BOLD}>
          模型
        </span>
      </text>
      {rows}
      {/* 键位提示（wrapMode none：窄终端 clip 不折行，保持行账恒定） */}
      <text fg={pal.dim} wrapMode="none">
        [↑↓] 选择 · [Enter] 切换 · [Esc] 关闭
      </text>
    </box>
  );
}
