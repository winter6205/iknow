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
import {
  SKILL_LOAD_PREFIX,
  SKILL_LOAD_PREFIX_SHORT,
} from "../harness/skill/body.js";
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
  /**
   * ADR-0037 T5:会话当前工作根（T3 改绑落盘的 task worktree 路径）。
   * undefined = 未绑定（开关 OFF / 尚未 mutate）→ 展示层零多余状态。
   * 只读投影:TUI 不做任何 git 操作,展示值唯一来源是会话文件。
   */
  readonly workspaceRoot: string | undefined;
  /**
   * D3 (tui-display-consistency): 落盘思考时长并行数组（与 messages 一一对应）。
   * 与 `SessionFileV1.thinkingMs` 同 spread-discipline：undefined 元素 = 该位置事件无
   * thinkingMs（非流式回合 / legacy 文件 / 非 assistant），整个 key 缺席 = 整链均无
   * thinkingMs（旧会话）。消费侧（turn-activity sumThinkingMsInRange）按 0 计入；
   * 折叠行仅在总秒数 > 0 时显示「思考了 N 秒」，否则只显示工具计数。
   */
  readonly thinkingMs?: ReadonlyArray<number | null>;
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
    workspaceRoot: undefined,
    // D3:draft 没有 thinkingMs；折叠簇求和按 0 计入。
    thinkingMs: undefined,
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
    // ADR-0037 T5:改绑后的 task worktree 根随会话文件恢复（重启后现势仍在）。
    workspaceRoot: file.workspaceRoot,
    // D3:把落盘的并行数组带到会话状态 —— 折叠行从此读取（取代 in-memory
    // 思考秒数副通道，已整条删除）。
    thinkingMs: file.thinkingMs,
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
  /**
   * ADR-0037 T5:turn 结束时落盘文件里的 workspaceRoot（改绑回合起携带）。
   * 缺省 = 本回合未发生改绑（或文件刷新失败）→ 保留既有值，不误清。
   */
  readonly workspaceRoot?: string;
  /**
   * D3:turn 结束时落盘文件里的 thinkingMs 并行数组。缺省 = 本回合未拿到
   * 刷新视图（文件 IO 失败）→ 保留既有值，不误清。
   */
  readonly thinkingMs?: ReadonlyArray<number | null>;
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
    // ADR-0037 T5:改绑回合携带新根;普通回合缺省 → 保留既有绑定值。
    workspaceRoot: input.workspaceRoot ?? session.workspaceRoot,
    // D3:从落盘文件刷新 thinkingMs;缺省 → 保留既有数组(部分恢复场景)。
    thinkingMs: input.thinkingMs ?? session.thinkingMs,
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

/**
 * plans/tui-chrome-interaction.md Task 5：skill-load chip 投影（render-side SSOT）。
 *
 * 从 user message 文本里抽出 `{name, remainder}`，给 TUI user 分支渲染用；
 * SKILL body 永远不进 ❯ 气泡。模型历史仍收 `buildSkillLoadText` 信封（session-api
 * 侧不动），TUI 不画正文。
 *
 * 命中形态（与 `buildSkillLoadText` 装配一致）：
 *   `[skill-load name="<name>"]\n<body>[ + \n\n<remainder>]`
 *
 * 拒绝形态（返回 null → 落回普通 user 文本渲染）：
 *   - 完全不以 `[skill-load ` 开头；
 *   - `[skill-load name="` 之后没有闭合的 `"`（前缀短命中但 name 没闭合）；
 *   - `]` 之后没有 `\n`（不是 buildSkillLoadText 形态）。
 *
 * 边界：
 *   - body 巨大：lastIndexOf `\n\n` 仍能定位 buildSkillLoadText 唯一添加的
 *     分隔符（约定 `createSkillBody` 末尾是 `</skill_files>` 不带末尾 `\n\n`，
 *     body 自身不会撞上分隔符）；
 *   - remainder 非空 → 抽出；
 *   - remainder 空 → 仍然命中（chip-only 路径）；
 *   - body 内 `\n\n` 段：最后一个才是 buildSkillLoadText 的 separator。
 */
export interface SkillLoadProjection {
  readonly name: string;
  readonly remainder: string;
}

export function projectSkillLoadUserText(
  text: string
): SkillLoadProjection | null {
  if (!text.startsWith(SKILL_LOAD_PREFIX_SHORT)) return null;
  // 闭合形态：`[skill-load name="..."]` 要求短前缀之后紧接 `name="`。
  if (!text.startsWith(SKILL_LOAD_PREFIX)) return null;
  const afterPrefix = text.slice(SKILL_LOAD_PREFIX.length);
  const closingQuote = afterPrefix.indexOf('"');
  if (closingQuote === -1) return null;
  const name = afterPrefix.slice(0, closingQuote);
  // 闭合 ] 与正文之间必须是 `\n`（buildSkillLoadText 装配约定），
  // 否则不是合法形态 → 落回普通文本。
  const afterName = afterPrefix.slice(closingQuote + 1);
  if (!afterName.startsWith("]\n")) return null;
  const tail = afterName.slice("]\n".length);
  // buildSkillLoadText 仅在 remainder 非空时追加 `\n\n<remainder>`，且唯一
  // 一次。但 body 自身（createSkillBody 产物）含多段 `\n\n` 分隔，末段以
  // `</skill_files>` 结尾 —— 仅靠 lastIndexOf `\n\n` 会把 body 末段误判为
  // remainder。借 body 末尾固定 `</skill_files>` 锚定位 separator：
  //   `</skill_files>\n\n<remainder>` 命中 → split；否则 remainder 空。
  // body 为空（罕见）时退化为 tail 开头 `\n\n<remainder>` 形态（empty body
  // + 非空 remainder 仍带 `\n\n` 前缀）。
  const marker = "</skill_files>";
  const markerIdx = tail.lastIndexOf(marker);
  if (markerIdx !== -1) {
    const after = tail.slice(markerIdx + marker.length);
    if (after.startsWith("\n\n")) {
      return { name, remainder: after.slice("\n\n".length) };
    }
    return { name, remainder: "" };
  }
  if (tail.startsWith("\n\n") && tail.length > "\n\n".length) {
    return { name, remainder: tail.slice("\n\n".length) };
  }
  // 无 marker、无空 body 分隔 → 退化为 lastIndexOf `\n\n`（兼容合成测试文本
  // 与历史 envelope 形态，body 自身不带 `</skill_files>`）。约定 body 不以
  // `\n\n` 结尾；命中 `\n\n` 即 buildSkillLoadText 的 separator（罕见路径）。
  const fallbackSep = tail.lastIndexOf("\n\n");
  if (fallbackSep !== -1) {
    return { name, remainder: tail.slice(fallbackSep + "\n\n".length) };
  }
  return { name, remainder: "" };
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
    if (text.startsWith(SKILL_LOAD_PREFIX_SHORT)) continue;
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
