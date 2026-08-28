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
 *  - 视图三态 `chat` / `list` / `mcp`；
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
import { isAgentStatusText } from "../harness/agent-status.js";
import { isSubagentDrainText } from "../harness/subagent/host-drain.js";
import { isVerifyInjectedText } from "../harness/verify/inject.js";
import { stripPrefetchOverlay } from "../harness/memory/prefetch.js";
import type { SessionFileV1 } from "../session-api/store/schema.js";

export type SessionRunState = "idle" | "running-fg" | "running-bg";
export type TuiView = "chat" | "list" | "mcp";

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
 *
 * #377 项 D（#337 Phase C 决定撤销）：echo 与发送文本可分离 —— 本函数接收
 * **显示形态**（displayText），它是用户可见会话中的临时代理。skill-load
 * 场景发送文本含技能正文（进模型历史），显示形态用精简占位「[加载技能 X]」
 * 避免正文泄漏进会话。turn 结束 turnFinished 仍用落盘权威消息原子替换中间态
 * （含正文 —— 这是用户接受的 running→complete 形态切换）。
 */
export function userMessageEchoed(
  session: TuiSessionState,
  displayText: string
): TuiSessionState {
  if (displayText.trim().length === 0) return session;
  const userMessage: AnthropicNativeMessage = Object.freeze({
    role: "user",
    content: Object.freeze([{ type: "text" as const, text: displayText }]),
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

/**
 * 回退（/rewind / 双 Esc）落盘后的会话刷新：镜像 sessionCompacted —— 以
 * rewindFile 截断后的文件内容整体替换 messages / turnCount / updatedAt /
 * jsonMode，但**保留** lastStopReason / lastUsage（回退不是 turn，不应清掉
 * 上下文用量读数），runState 归 idle。仅 idle 会话可回退（running 时由命令
 * 侧护栏拒绝，这里同 turnStarted 语义：非 idle 保持原状态，不抛错）。
 */
export function sessionRewound(
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

/**
 * 输入历史（↑ recall）种子：把已落盘会话的 query user 消息按 turn 顺序
 * 投影为输入历史。会话恢复（`iknow tui <session-id>` / /sessions Enter
 * openSessionAt）后 ↑ 立即可用，不必先提交一条新输入 —— 此前历史仅存
 * process 内存、只在提交时追加，恢复/切换会话后 ↑ 为空。
 *
 * query 判别与 checkpoint.ts isQuery 同源（镜像 hub.ts
 * projectMessagesToTurns）：`role === "user"` 且 content 不含 tool_result
 * block；tool_result 回显是 turn 的延续，不是新提问。
 *
 * 文本提取：全部 text block 的 `.text` 用 "\n" 连接后 trim（用户实际键入
 * 全文；与 rewind-picker firstUserFullText 只取首个 text block 不同 —— 输入
 * 历史要完整文本，而实际消息几乎都恰好一个 text block）。
 *
 * 丢弃规则（与提交路径 app.tsx handleSubmit 一致）：
 *  - trim 后为空；
 *  - `[skill-load ` 开头：skill-load 代理正文会持久化进 transcript（见
 *    app.tsx sendTurn displayText 注释），但不得污染 ↑ 历史（显示占位
 *    约定「[加载技能 X]」）；
 *  - host-drain / verify 信封：给模型的注入，不是用户键入（与 isTurnQuery
 *    跳过 drain 同源，并覆盖 VALIDATION FAILED / VERIFY rerun）。
 *  - 相邻重复抑制：与上一条保留项相同则跳过（同提交路径
 *    `h[h.length-1] === text` 语义）；非相邻重复保留（真实重提同一问题）。
 */
export function joinedUserText(message: AnthropicNativeMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

/**
 * Host-injected user messages that must not render as typed bubbles
 * (agent_status bar + drain summaries + verify envelopes). Model history
 * still holds them; TUI status/todo footer reads agent_status stream events.
 */
export function isTuiHiddenUserMessage(
  message: AnthropicNativeMessage
): boolean {
  if (message.role !== "user") return false;
  const text = joinedUserText(message).trim();
  if (text.length === 0) return false;
  return (
    isAgentStatusText(text) ||
    isSubagentDrainText(text) ||
    isVerifyInjectedText(text)
  );
}

export function seedInputHistory(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<string> {
  const history: string[] = [];
  for (const message of messages) {
    if (
      message.role !== "user" ||
      message.content.some((block) => block.type === "tool_result")
    ) {
      continue;
    }
    const text = stripPrefetchOverlay(joinedUserText(message)).trim();
    if (text.length === 0) continue;
    if (text.startsWith("[skill-load ")) continue;
    if (isTuiHiddenUserMessage(message)) continue;
    if (history[history.length - 1] === text) continue;
    history.push(text);
  }
  return Object.freeze(history);
}

/**
 * 追加一条输入历史（提交路径；将替换 app.tsx handleSubmit 的内联
 * updater，语义必须逐点一致）：
 *  - 空白输入（trim 后空）不追加，返回原引用 —— app.tsx setState 依赖
 *    引用相等跳过重渲染；
 *  - text 不 trim（上游 handleSubmit 已 `raw.trim()`），按传入原样入列；
 *  - 相邻重复抑制：与末条相同返回原引用（同 seedInputHistory /
 *    `h[h.length-1] === text`）；非相邻重复不属于本函数职责；
 *  - 其余返回新冻结数组（ReadonlyArray 纪律：整体替换、永不 mutate）。
 */
export function appendInputHistory(
  history: ReadonlyArray<string>,
  text: string
): ReadonlyArray<string> {
  if (text.trim().length === 0) return history;
  if (history[history.length - 1] === text) return history;
  return Object.freeze([...history, text]);
}
