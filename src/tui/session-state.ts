/**
 * src/tui/session-state.ts
 *
 * #146 TUI 会话状态机（Q1/Q1a 裁决）：
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
} from "../harness/model-adapter/types.js";
import type { SessionFileV1 } from "../session-api/store/schema.js";
import { extractSummary } from "../session-api/store/schema.js";

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
  });
}

/** 会话列表行 + 状态栏共用的 summary 投影（#120 SSOT：extractSummary）。 */
export function sessionSummary(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  return extractSummary(messages);
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
  });
}

/** Ctrl+C 语义护栏（Q1a）：仅 running-fg 可被打断。 */
export function canInterrupt(session: TuiSessionState): boolean {
  return session.runState === "running-fg";
}
