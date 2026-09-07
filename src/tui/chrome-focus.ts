/**
 * src/tui/chrome-focus.ts
 *
 * plans/tui-chrome-interaction.md T6 —— chrome-focus reducer（纯函数模块）。
 *
 * 唯一职责：单一抽象拥有焦点状态 `input` | `subagent(row)` | `graph`，
 * 按 Down/Up 在三环之间移动。reducer 只认 down/up（其他键一律 no-op，
 * 不抢 Tab / Enter / Escape / 普通字符 —— 这些仍由 prompt-input /
 * slash / graph-chrome 等其他 reducer / 组件处理）。
 *
 * wiring 不在本文件 —— T7 才把 useKeyboard 接到本 reducer 上；本轮
 * 只交付纯函数 + 单测覆盖 5 类（empty / negative / overflow /
 * concurrent / exception）。
 *
 * 复杂度纪律：每个分支 ≤4 嵌套、函数 ≤60 行、cyclomatic ≤10。
 *
 * 不变量：
 *  - subagent row clamp 到 [0, subagentCount-1]，越界回 input；
 *  - snapshot 缺失（hasSnapshot=false）→ graph 环不可达 / 已占焦点回 input；
 *  - subagentCount=0 → subagent 环不可达 / 已占焦点回 input。
 */
export type ChromeFocus =
  | { readonly kind: "input" }
  | { readonly kind: "subagent"; readonly row: number }
  | { readonly kind: "graph" };

export interface ReduceChromeFocusInput {
  readonly focus: ChromeFocus;
  readonly key: string;
  /** 当前可见的子代理行数（来自 projectSubagentLines 投影）。 */
  readonly subagentCount: number;
  /** run_graph 快照是否存在。 */
  readonly hasSnapshot: boolean;
}

export interface ReduceChromeFocusResult {
  readonly focus: ChromeFocus;
}

/** 防御：负数 / NaN → 0；保留语义清晰，单测钉死。 */
function safeCount(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function clampRow(row: number, count: number): number {
  if (count <= 0) return 0;
  if (row < 0) return 0;
  if (row >= count) return count - 1;
  return row;
}

/**
 * chrome-focus 状态机的纯函数 reducer。
 *
 * 设计要点：
 *  - only `down` / `up` move the cursor；其他键原样返回当前焦点（不抢键）。
 *  - **no-op 语义**：焦点不变的分支返回 `input.focus` 原引用（而非新建
 *    对象）—— 调用方用 `next.focus !== chromeFocus` 身份比较探测变化，
 *    引用相等 → 无 setState / 无多余 re-render；onLeaveToChrome 契约
 *    （无可达环 → 返回 false，PromptInput 保留状态）也依赖这一点。
 *  - subagent 环行数由 caller 投影（projectSubagentLines 同源）；reducer
 *    只看 count，不知道具体 row 是哪个 subagent —— T7 在 app.tsx 拼装。
 *  - graph 环单一节点（无 row 选择 —— graph chrome 一行）。
 *  - 异常 / 边界：snapshot 缺失 / 空 panel / 负 row → 跳过该环，焦点回
 *    上一个可达环（input 兜底）。
 */
export function reduceChromeFocus(
  input: ReduceChromeFocusInput
): ReduceChromeFocusResult {
  const count = safeCount(input.subagentCount);
  const key = input.key;

  if (input.focus.kind === "input") {
    if (key === "down") {
      if (count > 0) return { focus: { kind: "subagent", row: 0 } };
      if (input.hasSnapshot) return { focus: { kind: "graph" } };
      return { focus: input.focus };
    }
    return { focus: input.focus };
  }

  if (input.focus.kind === "subagent") {
    // 异常 / 空 panel：当前 subagent 环不可达 → 回 input。
    if (count === 0) return { focus: { kind: "input" } };
    const row = clampRow(input.focus.row, count);
    if (key === "down") {
      if (row + 1 < count) return { focus: { kind: "subagent", row: row + 1 } };
      if (input.hasSnapshot) return { focus: { kind: "graph" } };
      return { focus: input.focus };
    }
    if (key === "up") {
      if (row === 0) return { focus: { kind: "input" } };
      return { focus: { kind: "subagent", row: row - 1 } };
    }
    return { focus: input.focus };
  }

  // graph
  if (!input.hasSnapshot) return { focus: { kind: "input" } };
  if (key === "up") {
    if (count > 0) return { focus: { kind: "subagent", row: count - 1 } };
    return { focus: { kind: "input" } };
  }
  return { focus: input.focus };
}
