/**
 * src/tui/live-tool-state.ts
 *
 * #343 T4（自 archive/tui-ink/src/live-tool-state.ts 迁移）：
 * 工具调用实时状态 — 纯函数 reducer，推动 `tool_call_start` → "运行中" →
 * postToolUse 完成 → ok/failed 摘要行的两态时序。
 * #578：unmatched `post_tool_use` 不再 append（archive 合同已倒置）；完成态
 * 由 history `tool_result` 渲染，避免幽灵失败行。
 *
 * T5 (tui-render-optimization)：`tool_input_delta` 增量事件消费 — 运行中
 * 条目累积 partialJson 到 `partialInput`（展示层中间态，仅供 running 摘要
 * 行渲染）；`post_tool_use` 完成时用权威完整 input 覆盖并**清除** partialInput，
 * 避免完成态残留 partial。
 *
 * T5 (tui-live-activity-fold)：完成件**不再被 reducer 删除** —— 成功只读
 * 探测的去留由消费侧（live activity group / unit fold 计数）决定，见
 * `liveToolReduce` post_tool_use 分支注释。
 *
 * 设计：
 *  - 状态按 insert 顺序保留（`ReadonlyArray`），便于 ChatView 按序渲染；
 *  - `toolUseId` 是配对的 anchor — 由流式 `tool_call_start` 提供，postToolUse
 *    完成事件必须携带；未匹配 id 时本 reducer return prev（不 append
 *    结构化条目）。字符串 live 行仍由 caller 的 liveToolLines 通道负责；
 *  - 同 conversationId 多个工具按 FIFO 配对（首个未完成 running 被首个完成
 *    事件标记），符合 harness loop 串行特性；
 *  - `tool_input_delta` 按 `id` 精确配对（非 FIFO）：后发增量可属较早条目，
 *    只命中 status === "running" 的条目；未匹配 / 非 running → 忽略（defensive，
 *    展示层事件不应破坏权威状态）。
 *  - 纯函数 + Object.freeze 纪律，与 session-state.ts 同源。
 */
import { formatLiveToolEvent, formatToolStatusLine } from "./tool-summary.js";

export type LiveToolStatus = "running" | "ok" | "failed";

export interface LiveToolRun {
  readonly id: string;
  readonly name: string;
  readonly status: LiveToolStatus;
  readonly input: unknown;
  /** 身份标记：本 turn 已 seal 的草稿段数。缺省（0 / 省略）→ 渲染在
   *  第一段草稿之上；N ≥ 1 → 渲染在第 N 段草稿之下、第 N+1 段之上。
   *  追加时由 caller 按事件顺序打入（#616 身份标记，不再用计数锚点）。 */
  readonly draftEpoch?: number;
  /** T5:运行中 `tool_input_delta` 累积的 partial JSON 文本（展示层中间态）。
   *  运行中且收到增量时有值；完成（post_tool_use）时被完整 input 覆盖并清除。 */
  readonly partialInput?: string;
  /** 完成事件的 detail（formatLiveToolEvent 的中间产物）；运行中无。 */
  readonly detail?: string;
  /** 完成事件的 message（失败原因）；运行中无。 */
  readonly message?: string;
  /** 观测 side-channel — 写盘前旧内容；运行中无。 */
  readonly oldContent?: string;
  /** 观测 side-channel — 写盘后新内容；运行中无。 */
  readonly newContent?: string;
  /** #693 T4 D4:bash 输出 stdout 旁路(ToolResultMeta.stdout),result preview 尾窗数据源。 */
  readonly stdout?: string;
  /** #693 T4 D4:bash 输出 stderr 旁路(ToolResultMeta.stderr),result preview 尾窗数据源。 */
  readonly stderr?: string;
}

export type LiveToolEvent =
  | {
      readonly kind: "tool_call_start";
      readonly id: string;
      readonly name: string;
      /** 该工具开始时已 seal 的草稿段数（展示层交错依据，
       *  见 LiveToolRun.draftEpoch）。缺省 = 0。 */
      readonly draftEpoch?: number;
    }
  | {
      /** T5:工具调用 input 增量（partial_json 逐段，adapter 经
       *  `HarnessStreamEvent` 透传）。只服务展示层 — 权威 input 仍由
       *  `post_tool_use` 一次性交付。 */
      readonly kind: "tool_input_delta";
      readonly id: string;
      readonly partialJson: string;
    }
  | {
      readonly kind: "post_tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly ok: boolean;
      readonly detail?: string;
      readonly message?: string;
      /** 观测 side-channel — 写盘前旧内容。 */
      readonly oldContent?: string;
      /** 观测 side-channel — 写盘后新内容。 */
      readonly newContent?: string;
      /** #693 T4 D4:bash stdout 旁路,完成事件携带,result preview 尾窗数据源。 */
      readonly stdout?: string;
      /** #693 T4 D4:bash stderr 旁路,完成事件携带,result preview 尾窗数据源。 */
      readonly stderr?: string;
    };

/** reducer：append running / set completed → 新冻结 array。 */
export function liveToolReduce(
  prev: ReadonlyArray<LiveToolRun>,
  event: LiveToolEvent
): ReadonlyArray<LiveToolRun> {
  if (event.kind === "tool_call_start") {
    // 不覆盖已存在条目 — 同一 id 重发视为 idempotent（defensive）。
    if (prev.some((r) => r.id === event.id)) return prev;
    return Object.freeze([
      ...prev,
      Object.freeze({
        id: event.id,
        name: event.name,
        status: "running" as const,
        input: undefined,
        draftEpoch:
          typeof event.draftEpoch === "number" && event.draftEpoch > 0
            ? event.draftEpoch
            : undefined,
      }),
    ]);
  }
  // T5: tool_input_delta — 按 id 找 running 条目累积 partialInput（顺序保留）。
  // 未匹配 / 非 running → 忽略（defensive：展示层增量不破坏权威状态）。
  if (event.kind === "tool_input_delta") {
    const target = prev.find(
      (r) => r.id === event.id && r.status === "running"
    );
    if (target === undefined) return prev;
    return Object.freeze(
      prev.map((r) =>
        r === target
          ? Object.freeze({
              ...r,
              partialInput: (r.partialInput ?? "") + event.partialJson,
            })
          : r
      )
    );
  }
  // post_tool_use — 配对找到的条目转 ok/failed。未匹配 id（无
  // tool_call_start / race）与 unmatched tool_input_delta 一样忽略：
  // 完成态由 history tool_result 渲染，append 会产生幽灵失败行（#578）。
  //
  // plans/tui-live-activity-fold.md T5：**一律 in-place 完成，不删除**。
  // 旧 #589 的 `COMPACT_READONLY_TOOLS` 直删与 chat-view 的 history-id
  // 过滤叠加成双删 —— 当该 tool_use id 已在历史里（MessageBlocks 对成功
  // retract 按 slot 隐去标题与预览），live 数组又被抹掉，帧上没有任何一面
  // 接住它。落点由消费侧决定（当前 **live activity group** 计数，或已画
  // **unit fold** 计数），reducer 不再预测渲染面。
  if (event.kind === "post_tool_use") {
    const target = prev.find((r) => r.id === event.id);
    if (target === undefined) return prev;
    return Object.freeze(
      prev.map((r) =>
        r === target
          ? Object.freeze({
              id: r.id,
              name: r.name,
              status: (event.ok ? "ok" : "failed") as LiveToolStatus,
              // draftEpoch 是追加时打入的身份标记，完成重建必须保留。
              draftEpoch: r.draftEpoch,
              input: event.input,
              // T5:完成态用权威完整 input 覆盖并清除 partialInput 残留。
              partialInput: undefined,
              detail: event.detail,
              message: event.message,
              oldContent: event.oldContent,
              newContent: event.newContent,
              stdout: event.stdout,
              stderr: event.stderr,
            })
          : r
      )
    );
  }
  return prev;
}

export type LiveTailSlot =
  | { readonly kind: "tools"; readonly runs: ReadonlyArray<LiveToolRun> }
  | { readonly kind: "draft"; readonly text: string };

/** 按 draftEpoch 交错工具组与草稿段。空草稿跳过；epoch 超出段数的工具挂末尾。 */
export function liveTailSlots(
  runs: ReadonlyArray<LiveToolRun>,
  segments: ReadonlyArray<string>
): ReadonlyArray<LiveTailSlot> {
  const maxEpoch = Math.max(
    0,
    ...runs.map((r) => r.draftEpoch ?? 0),
    Math.max(0, segments.length - 1)
  );
  const slots: LiveTailSlot[] = [];
  for (let i = 0; i <= maxEpoch; i++) {
    const group = runs.filter((r) => (r.draftEpoch ?? 0) === i);
    if (group.length > 0) slots.push({ kind: "tools", runs: group });
    const text = segments[i];
    if (typeof text === "string" && text.length > 0) {
      slots.push({ kind: "draft", text });
    }
  }
  return slots;
}

/** 活动工具名派生：取最后一个 status=running 条目的 name；无运行中条目 →
 *  undefined。纯派生（无新 state），harness loop 串行下末尾 running 即当前
 *  工具。供 app.tsx 状态栏（ContextBar 尾缀）使用。
 *
 *  MCP 工具名特殊处理：`mcp__<server>__<tool>` 在底栏展示意义不大
 *  （server 已在 MCP 看板可见，工具名又含冗余前缀），派生阶段剥为
 *  `<server>/<tool>` 短形态 —— 单一渲染面（ContextBar）通过 activeToolNameOf
 *  取值，不需要让上游知道 MCP 协议形态。 */
export function activeToolNameOf(
  runs: ReadonlyArray<LiveToolRun>
): string | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run !== undefined && run.status === "running") {
      return shortenMcpToolName(run.name);
    }
  }
  return undefined;
}

/**
 * 把 `mcp__<server>__<tool>` 缩为 `<server>/<tool>`；非 MCP 工具名原样返回。
 * 保持纯函数语义（slice/indexOf，O(n)），供单测直驱。
 */
export function shortenMcpToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const body = name.slice("mcp__".length);
  const sep = body.indexOf("__");
  if (sep === -1) return name;
  const server = body.slice(0, sep);
  const tool = body.slice(sep + "__".length);
  return `${server}/${tool}`;
}

/** 运行中条目格式化 —— 委托 `formatToolStatusLine`（tool-summary.ts SSOT，
 *  #693 T1 D7 + specs/tui-human-display.md D1）。普通工具 → 英文过程行
 *  `name`（如 `read_file`；有 input 时带要点）或 bash 的
 *  `Running 1 shell command…`；子代理工具（spawn_subagent /
 *  subagent_result，plans/tui-chrome-interaction.md T7）不再以 `▣ 子代理`
 *  形态出现 —— 子代理状态由 identity strip + SubagentPanel 单独表达，
 *  formatToolStatusLine 内只返 `detail`（如 `explore running` / `general-purpose`），避免
 *  dual render。 */
export function formatRunningToolLine(run: LiveToolRun): string {
  return formatToolStatusLine({
    toolName: run.name,
    input: run.input,
    status: "running",
  });
}

/** 完成条目格式化 —— 委托 `formatLiveToolEvent` → `formatToolStatusLine`
 *  （tool-summary.ts SSOT 单源，#693 T1 D7）。这里必须用 LiveToolRun 的
 *  precomputed detail（run.detail ?? ""），不要传 run.input 重算 — 重算结果
 *  可能与 postToolUse 落入 reducer 的 detail 字节不一致。`cols` 透传给
 *  formatLiveToolEvent；detail 已由 reducer 用同 cols 预算裁过（除非
 *  detail 为空走内部 summarizeToolCall，否则 cols 不再被消费）。 */
export function formatCompletedToolLine(
  run: LiveToolRun,
  cols?: number
): string {
  return formatLiveToolEvent({
    toolName: run.name,
    input: run.input,
    kind: run.status === "ok" ? "ok" : "failed",
    detail: run.detail ?? "",
    cols,
  });
}
