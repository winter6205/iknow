/**
 * src/tui/live-tool-state.ts
 *
 * #343 T4（自 archive/tui-ink/src/live-tool-state.ts 迁移，语义不变）：
 * 工具调用实时状态 — 纯函数 reducer，推动 `tool_call_start` → "运行中" →
 * postToolUse 完成 → ok/failed 摘要行的两态时序。
 *
 * T5 (tui-render-optimization)：`tool_input_delta` 增量事件消费 — 运行中
 * 条目累积 partialJson 到 `partialInput`（展示层中间态，仅供 running 摘要
 * 行渲染）；`post_tool_use` 完成时用权威完整 input 覆盖并**清除** partialInput，
 * 避免完成态残留 partial。
 *
 * 设计：
 *  - 状态按 insert 顺序保留（`ReadonlyArray`），便于 ChatView 按序渲染；
 *  - `toolUseId` 是配对的 anchor — 由流式 `tool_call_start` 提供，postToolUse
 *    完成事件必须携带（向后兼容：缺则落回 caller 自行 append 字符串行，
 *    本 reducer 不知道"字符串行"形态，只关心结构化条目）；
 *  - 同 conversationId 多个工具按 FIFO 配对（首个未完成 running 被首个完成
 *    事件标记），符合 harness loop 串行特性；
 *  - `tool_input_delta` 按 `id` 精确配对（非 FIFO）：后发增量可属较早条目，
 *    只命中 status === "running" 的条目；未匹配 / 非 running → 忽略（defensive，
 *    展示层事件不应破坏权威状态）。
 *  - 纯函数 + Object.freeze 纪律，与 session-state.ts 同源。
 */
import { formatLiveToolEvent } from "./tool-summary.js";

export type LiveToolStatus = "running" | "ok" | "failed";

export interface LiveToolRun {
  readonly id: string;
  readonly name: string;
  readonly status: LiveToolStatus;
  readonly input: unknown;
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
}

export type LiveToolEvent =
  | {
      readonly kind: "tool_call_start";
      readonly id: string;
      readonly name: string;
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
  // post_tool_use — 配对找到的 running 转 ok/failed；未匹配（legacy id）落回
  // append 摘要条目。新条目同样追加末尾（顺序语义：完成事件追加末尾）。
  if (event.kind === "post_tool_use") {
    const target = prev.find((r) => r.id === event.id);
    if (target !== undefined) {
      return Object.freeze(
        prev.map((r) =>
          r === target
            ? Object.freeze({
                id: r.id,
                name: r.name,
                status: (event.ok ? "ok" : "failed") as LiveToolStatus,
                input: event.input,
                // T5:完成态用权威完整 input 覆盖并清除 partialInput 残留。
                partialInput: undefined,
                detail: event.detail,
                message: event.message,
                oldContent: event.oldContent,
                newContent: event.newContent,
              })
            : r
        )
      );
    }
    // 未匹配 id（legacy / 异步 race）→ append 新条目。
    return Object.freeze([
      ...prev,
      Object.freeze({
        id: event.id,
        name: event.name,
        status: (event.ok ? "ok" : "failed") as LiveToolStatus,
        input: event.input,
        detail: event.detail,
        message: event.message,
        oldContent: event.oldContent,
        newContent: event.newContent,
      }),
    ]);
  }
  return prev;
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

/** 运行中条目格式化 —— `[运行中] name`。 */
export function formatRunningToolLine(run: LiveToolRun): string {
  return `[运行中] ${run.name}`;
}

/** 完成条目格式化 —— 委托 formatLiveToolEvent（tool-summary.ts）单源。
 *  模板文本统一在 formatLiveToolEvent 内。这里必须用 LiveToolRun 的
 *  precomputed detail（run.detail ?? ""），不要传 run.input 重算 — 重算结果
 *  可能与 postToolUse 落入 reducer 的 detail 字节不一致。 */
export function formatCompletedToolLine(run: LiveToolRun): string {
  return formatLiveToolEvent({
    toolName: run.name,
    input: run.input,
    kind: run.status === "ok" ? "ok" : "failed",
    detail: run.detail ?? "",
  });
}
