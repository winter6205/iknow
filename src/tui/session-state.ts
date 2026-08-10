/**
 * src/tui/session-state.ts
 *
 * #343 T6-A 迁移：从 archive/tui-ink/src/session-state.ts 迁回 src/tui/。
 * 逻辑与原版一致（#146 TUI 会话状态机，Q1/Q1a 裁决）；仅文件头注释更新
 * 为本次迁移说明。纯 TS 模块，无 ink / OpenTUI 依赖。
 *
 * 业务约束（沿用 #146 + #120 纪律）：
 *  - 会话运行三态 `idle` / `running-fg` / `running-bg`（分时切换 active-one；
 *    turn 运行中切走 → 后台继续执行）；
 *  - 视图两态 `chat` / `list`；
 *  - 消息纪律与 #120 Q3 一致：`ReadonlyArray` + `Object.freeze`，整体替换、
 *    永不 mutate。
 *
 * 全部转换为纯函数（discriminated state in → new state out），UI 层
 * （app.tsx 的 hook）只做编排。
 */

import type {
  AnthropicNativeMessage,
  StopReason,
  TokenUsage,
} from "../harness/model-adapter/types.js";
import type { SessionFileV1 } from "../session-api/store/schema.js";

export type SessionRunState = "idle" | "running-fg" | "running-bg";
export type TuiView = "chat" | "list";

/** 未建档会话的内存占位键（lazy create：首条消息发出才进 SessionStore）。 */
export const DRAFT_SESSION_ID = "__draft__";

export interface TuiSessionState {
  /** undefined = lazy draft（尚未 createSession 建档）。 */
  readonly conversationId: string | undefined;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  /** 累计 turnCount（来自会话文件 / postMessage 回执，run() 内部计数从 0 起不同）。 */
  readonly turnCount: number;
  /** ISO 时间；draft 为 ""。 */
  readonly updatedAt: string;
  readonly jsonMode: boolean;
  readonly runState: SessionRunState;
  /** 最近一次 turn 的停止原因（展示用）。 */
  readonly lastStopReason: StopReason | undefined;
  /** T3: 最近一次 turn 的 token usage（上下文用量显示；只来自运行时回执）。 */
  readonly lastUsage: TokenUsage | null;
}

/** 新建 draft 会话（启动直达新会话聊天界面，Q2=C；不触盘）。 */
export function createDraftSession(): TuiSessionState {
  return Object.freeze({
    conversationId: undefined,
    messages: Object.freeze([]) as ReadonlyArray<AnthropicNativeMessage>,
    turnCount: 0,
    updatedAt: "",
    jsonMode: false,
    runState: "idle",
    lastStopReason: undefined,
    lastUsage: null,
  });
}

/** 从已落盘会话文件恢复（`iknow tui <session-id>` / 列表 Enter 路径）。 */
export function attachSession(file: SessionFileV1): TuiSessionState {
  return Object.freeze({
    conversationId: file.conversation_id,
    messages: Object.freeze([...file.messages]),
    turnCount: file.turnCount,
    updatedAt: file.updatedAt,
    jsonMode: file.jsonMode,
    runState: "idle",
    lastStopReason: undefined,
    // lastUsage 只来自运行时回执，不从会话文件携带（初值 null）。
    lastUsage: null,
  });
}

/** turn 起跑：仅 idle 可起跑（重复起跑视为调用方 bug，保持原状态不抛错）。 */
export function turnStarted(session: TuiSessionState): TuiSessionState {
  if (session.runState !== "idle") return session;
  return Object.freeze({ ...session, runState: "running-fg" });
}

/**
 * 从该会话切走（Q1a）：running-fg → running-bg（后台继续执行）；
 * idle 会话切走不变。running-bg 重入切走保持 running-bg。
 */
export function switchedAwayFrom(session: TuiSessionState): TuiSessionState {
  if (session.runState !== "running-fg") return session;
  return Object.freeze({ ...session, runState: "running-bg" });
}

/** 切回该会话：running-bg → running-fg；idle 不变。 */
export function switchedTo(session: TuiSessionState): TuiSessionState {
  if (session.runState !== "running-bg") return session;
  return Object.freeze({ ...session, runState: "running-fg" });
}

export interface TurnFinishedInput {
  readonly conversationId: string;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly turnCount: number;
  readonly updatedAt: string;
  readonly jsonMode: boolean;
  readonly stopReason: StopReason;
  /** T3: 该回合的 token usage（bridge.postMessage 回执透传；缺省/无 → null）。
   *  可选既是「省略即 null」的显式语义，也保留既有调用面（app.tsx 的 T4
   *  接线前不传 lastUsage 也能编译）。 */
  readonly lastUsage?: TokenUsage | null;
}

/** turn 结束（自然完成 / cancelled / timeout 均走此）：落回 idle + 整体冻结替换。 */
export function turnFinished(
  session: TuiSessionState,
  input: TurnFinishedInput
): TuiSessionState {
  return Object.freeze({
    ...session,
    conversationId: input.conversationId,
    messages: Object.freeze([...input.messages]),
    turnCount: input.turnCount,
    updatedAt: input.updatedAt,
    jsonMode: input.jsonMode,
    runState: "idle",
    lastStopReason: input.stopReason,
    lastUsage: input.lastUsage ?? null,
  });
}

/** Ctrl+C 语义护栏（Q1a）：仅 running-fg 可被打断。 */
export function canInterrupt(session: TuiSessionState): boolean {
  return session.runState === "running-fg";
}

/**
 * T2 (#175): 用户消息即时回显 — 提交后、任何 delta 到达前把用户文本追加进
 * messages,让对话立刻可见(不必等 turn 结束重读文件)。
 *
 * 为什么在 turnStarted 之后调用:runState 保持 running-fg(即时回显不改变
 * 会话运行态),且不改变 conversationId / turnCount 等其余字段。turn 结束 /
 * abort 后由落盘 messages 原子替换(中间态自动消失)。
 *
 * 空文本(trim 后)不追加,返回原状态 — 防空白输入污染 messages。
 */
export function userMessageEchoed(
  session: TuiSessionState,
  text: string
): TuiSessionState {
  if (text.trim().length === 0) return session;
  const userMessage: AnthropicNativeMessage = Object.freeze({
    role: "user",
    content: Object.freeze([{ type: "text" as const, text }]),
  });
  return Object.freeze({
    ...session,
    messages: Object.freeze([...session.messages, userMessage]),
  });
}

/**
 * 手动压缩（/compact）落盘后的会话刷新：以压缩后文件内容替换 messages /
 * turnCount / updatedAt，但**保留** lastStopReason / lastUsage（压缩不是 turn，
 * 不应清掉上下文用量读数），runState 归 idle。仅 idle 会话可压缩（running 时
 * 由命令侧护栏拒绝，这里同 turnStarted 语义：非 idle 保持原状态）。
 */
export function sessionCompacted(
  session: TuiSessionState,
  input: {
    readonly messages: ReadonlyArray<AnthropicNativeMessage>;
    readonly turnCount: number;
    readonly updatedAt: string;
    readonly jsonMode: boolean;
  }
): TuiSessionState {
  if (session.runState !== "idle") return session;
  return Object.freeze({
    ...session,
    messages: Object.freeze([...input.messages]),
    turnCount: input.turnCount,
    updatedAt: input.updatedAt,
    jsonMode: input.jsonMode,
    runState: "idle",
  });
}
