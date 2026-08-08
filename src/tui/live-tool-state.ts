/**
 * src/tui/live-tool-state.ts
 *
 * T4 (#175): 工具调用实时状态 — 纯函数 reducer,推动 `tool_call_start` →
 * "运行中" → postToolUse 完成 → ok/failed 摘要行的两态时序。
 *
 * 设计:
 *  - 状态按 insert 顺序保留(`ReadonlyArray`),便于 ChatView 按序渲染;
 *  - `toolUseId` 是配对的 anchor — 由流式 `tool_call_start` 提供,postToolUse
 *    完成事件必须携带(向后兼容:缺则落回 caller 自行 append 字符串行,
 *    本 reducer 不知道"字符串行"形态,只关心结构化条目);
 *  - 同 conversationId 多个工具按 FIFO 配对(首个未完成 running 被首个完成
 *    事件标记),符合 harness loop 串行特性。
 *  - 纯函数 + Object.freeze 纪律,与 session-state.ts 同源。
 */
import { formatLiveToolEvent } from "./tool-summary.js";

export type LiveToolStatus = "running" | "ok" | "failed";

export interface LiveToolRun {
  readonly id: string;
  readonly name: string;
  readonly status: LiveToolStatus;
  readonly input: unknown;
  /** 完成事件的 detail(formatLiveToolEvent 的中间产物);运行中无。 */
  readonly detail?: string;
  /** 完成事件的 message(失败原因);运行中无。 */
  readonly message?: string;
}

export type LiveToolEvent =
  | {
      readonly kind: "tool_call_start";
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly kind: "post_tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly ok: boolean;
      readonly detail?: string;
      readonly message?: string;
    };

/** reducer: append running / set completed → 新冻结 array。 */
export function liveToolReduce(
  prev: ReadonlyArray<LiveToolRun>,
  event: LiveToolEvent
): ReadonlyArray<LiveToolRun> {
  if (event.kind === "tool_call_start") {
    // 不覆盖已存在条目 — 同一 id 重发视为 idempotent (defensive)。
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
  // post_tool_use — 配对找到的 running 转 ok/failed;未匹配(legacy id)落回 append
  // ok 摘要。新条目同样 appended(顺序语义: 完成事件追加末尾)。
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
                detail: event.detail,
                message: event.message,
              })
            : r
        )
      );
    }
    // 未匹配 id (legacy / 异步 race) → append 新条目。
    return Object.freeze([
      ...prev,
      Object.freeze({
        id: event.id,
        name: event.name,
        status: (event.ok ? "ok" : "failed") as LiveToolStatus,
        input: event.input,
        detail: event.detail,
        message: event.message,
      }),
    ]);
  }
  return prev;
}

/** 活动工具名派生（#279 项 4）：取最后一个 status=running 条目的 name；
 *  无运行中条目 → undefined。纯派生（无新 state），harness loop 串行下
 *  末尾 running 即当前工具。供 app.tsx 状态栏（ContextBar 尾缀）使用。 */
export function activeToolNameOf(
  runs: ReadonlyArray<LiveToolRun>
): string | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run !== undefined && run.status === "running") return run.name;
  }
  return undefined;
}

/** 运行中条目格式化 —— `[运行中] name`。 */
export function formatRunningToolLine(run: LiveToolRun): string {
  return `[运行中] ${run.name}`;
}

/** 完成条目格式化 —— 委托 formatLiveToolEvent (tool-summary.ts) 单源。
 *  模板文本统一在 formatLiveToolEvent 内, chat-view 调此处只为语义化别名。
 *  这里必须用 LiveToolRun 的 precomputed detail (run.detail ?? ""), 不要
 *  传 run.input 重算 — 重算结果可能与 postToolUse 落入 reducer 的 detail
 *  字节不一致 (legacy summarizeToolCall 走过 clip/JSON.stringify 等变换)。 */
export function formatCompletedToolLine(run: LiveToolRun): string {
  return formatLiveToolEvent({
    toolName: run.name,
    input: run.input,
    kind: run.status === "ok" ? "ok" : "failed",
    detail: run.detail ?? "",
  });
}
