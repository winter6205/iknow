/**
 * CLI 投影层:把 harness `RunResult` + `LoopTrace` 渲成两种形态。
 *
 * 旧版 `formatAnswerHuman` / `formatAnswerJson` 已被 Session API 持续消费;
 * 本文件 fork 自旧实现并切换到 harness Foundation `RunResult` + `LoopTrace`
 * (014 / 017 SSOT 形状),CLI 路径走本投影层。
 *
 * 设计要点:
 * - `formatRunHuman` 总是渲染状态行(即便 finalText 为 null),便于脚本消费者从
 *   stderr 看到 stopReason / turns / 工具链 / 总耗时,而不是空字符串。
 * - `formatRunJson` 故意省略 `result.messages`:Anthropic 原生 messages 在
 *   oneshot ask 路径下太大,脚本消费者用 finalText + trace 已足够。
 * - 工具名扁平去重顺序:`Set` 行为在 ES2015+ 规范保证按插入顺序枚举,所以
 *   用 `Array.from(new Set(...))` 同时拿到去重 + 保首次出现顺序。
 * - #152 T5:thinking 展示开关(`formatRunHuman` 的 `opts.showThinking`,
 *   默认 false)。关闭时输出不含 thinking 文本;开启时前置区隔显示。仅影响
 *   展示通道;`finalText` / `result.messages` / `LoopTrace` 任何字段不动。
 *   设计决定:落 env flag `IKNOW_CHAT_SHOW_THINKING` (走 `src/config/env.ts`
 *   SSOT,默认 off)。
 * - #160 T5:`lastUsage` 显示面接通(ADR-0008 显示路径)。
 *   `formatRunJson` 非 null 时增 `lastUsage` 键(camelCase 四字段,沿用
 *   `TokenUsage` 形状);null = run 无成功模型调用 → 键缺席,与 `messages`
 *   省略同风格。`formatRunHuman` 状态行追加 ` · tokens in/out: <in>/<out>`
 *   (仅 input/output;cache 命中暂不进人类展示面,最小清晰原则)。
 */
import type {
  AnthropicNativeMessage,
  LoopTrace,
  RunResult,
  TokenUsage,
} from "../harness/index.js";
import {
  createOutputMask,
  currentSecretValues,
} from "../harness/sandbox/index.js";

/** Tool-name list separator in status line (CLI script consumers parse this). */
const TOOL_LIST_SEP = ",";
/** Tool-list placeholder when no tool has been called. */
const NO_TOOLS = "-";
/** #152 T5:thinking 区隔前缀(开关开启时显示)。 */
export const THINKING_PREFIX = "思考:";
/** #152 T5:redacted_thinking(加密 blob)在开关开启时也按一条占位显示。 */
export const REDACTED_PLACEHOLDER = "[已加密思考]";

export interface FormatRunOpts {
  readonly result: RunResult;
  readonly trace: LoopTrace;
}

/**
 * #152 T5:thinking 展示开关。默认 false。
 *
 * 选择:env flag (`IKNOW_CHAT_SHOW_THINKING`) 而非 REPL 斜杠命令,理由:
 *   - 与 `IKNOW_LLM_*` 家族 / `src/config/env.ts` SSOT(T4 落地模式)一致;
 *   - 三面(chat / serve / ask)统一可读;
 *   - 实现 = 纯渲染函数,便于 TDD;不引入 session 状态可变性;
 *   - REPL 切换的优势是会话内可切换;此处判断它属于"展示偏好",env 即可。
 * 若后续确有会话内切换需求,可在 REPL 加 `/show-thinking` 子命令(可逆增量)。
 */
export interface FormatRunHumanOpts extends FormatRunOpts {
  /** #152 T5:thinking 展示开关;默认 false。 */
  readonly showThinking?: boolean;
  /** B1: Ctrl+C 打断反馈文案。仅 cancelled 时由调用方(chat-session)算好
   *  传入("已保存"/"未落checkpoint");缺省 → 状态行不加前缀,byte-stable。 */
  readonly interruptNote?: string;
}

/**
 * 倒序找最后一条 assistant 消息;无则返回 undefined。
 *
 * `m &&` 守卫保留:数组元素类型为 `AnthropicNativeMessage | undefined`,
 * 缺守卫会让 TS 在分支内把 `m` 收窄回 undefined,拒绝后续读取。
 */
function findLastAssistantMessage(
  messages: ReadonlyArray<AnthropicNativeMessage>
): AnthropicNativeMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return m;
  }
  return undefined;
}

/**
 * 把一条 assistant 消息的 content blocks 分拣为三组:
 * - `thinkingLines`:thinking 文本(按出现顺序,不做 trim 跳空);
 * - `textLines`:非空 text(trim 后长度 > 0);
 * - `hasRedacted`:是否存在 redacted_thinking 块。
 *
 * tool_use / tool_result / 其他块显式 fall-through(不加 default 吞噬,
 * 便于后续块类型扩展时 TS 能继续穷尽检查)。
 */
function partitionAnswerBlocks(content: AnthropicNativeMessage["content"]): {
  thinkingLines: string[];
  textLines: string[];
  hasRedacted: boolean;
} {
  const thinkingLines: string[] = [];
  const textLines: string[] = [];
  let hasRedacted = false;
  for (const block of content) {
    if (block.type === "thinking") {
      thinkingLines.push(block.thinking);
    } else if (block.type === "redacted_thinking") {
      hasRedacted = true;
    } else if (block.type === "text") {
      if (block.text.trim().length > 0) textLines.push(block.text);
    }
    // tool_use / tool_result / 其他块:不进展示。
  }
  return { thinkingLines, textLines, hasRedacted };
}

/**
 * `showThinking=true` 时的可见组装:thinking 前缀 + thinking 文本 + redacted
 * 占位(任一存在时输出),空行分隔后接 text 块拼接。
 */
function assembleVisibleAnswer(
  thinkingLines: string[],
  textLines: string[],
  hasRedacted: boolean
): string {
  const visible: string[] = [];
  if (thinkingLines.length > 0 || hasRedacted) {
    const pieces: string[] = [];
    if (thinkingLines.length > 0) pieces.push(...thinkingLines);
    if (hasRedacted) pieces.push(REDACTED_PLACEHOLDER);
    visible.push(`${THINKING_PREFIX}${pieces.join("\n")}`);
  }
  if (textLines.length > 0) {
    visible.push(textLines.join("\n"));
  }
  return visible.join("\n\n");
}

/**
 * #152 T5:纯函数 — 从最后成功 assistant 回合抽出可见展示文本。
 *
 * - `showThinking=false`(默认):仅 text block 拼接(thinking 不进
 *   `finalText`,这是 Q3 决议在投影层的落点)。
 * - `showThinking=true`:拼接顺序为
 *   `<THINKING_PREFIX><thinking texts …>\n\n<text blocks …>`;
 *   redacted_thinking 占位一条(加密 blob 无可见内容);
 *   tool_use / tool_result 不进展示通道(投影去关注)。
 *
 * 输入运行结果为权威历史 + trace;不改 messages,不改 trace,不改 finalText。
 */
export function renderAssistantAnswer(opts: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly showThinking: boolean;
}): string {
  const lastAssistant = findLastAssistantMessage(opts.messages);
  if (!lastAssistant) return "";
  const { thinkingLines, textLines, hasRedacted } = partitionAnswerBlocks(
    lastAssistant.content
  );
  if (!opts.showThinking) {
    // thinking / redacted_thinking 在关闭时不输出。
    return textLines.join("\n");
  }
  return assembleVisibleAnswer(thinkingLines, textLines, hasRedacted);
}

/**
 * Human status line (no answer text) for `RunResult` + `LoopTrace`.
 *
 * Layout: `stop=<stopReason> · turns=<turnCount> · tools=<a,b,c> ·
 * <totalDurationMs>ms [ · tokens in/out: <in>/<out>]`
 *
 * #195 (T6 续): extracted from `formatRunHuman` so the streaming chat host
 * can emit JUST this line as the trailing status, without re-printing the
 * answer text (which has already been streamed to stdout as the final
 * output). `formatRunHuman` delegates here to preserve DRY — both the
 * non-streamed and streamed paths build the same status string.
 *
 * `result.finalText === null` 不影响(状态行不读 finalText)。
 * `trace.turns` 中无任何工具调用时,`tools=` 显示 `-`。
 *
 * #160 T5:`lastUsage` 非 null 时追加 `tokens in/out` 读数;null = run 无成功
 * 模型调用,不显示。
 */
export function formatStatusLine(opts: FormatRunHumanOpts): string {
  const { result, trace, interruptNote } = opts;
  const toolNames = flattenToolNames(trace);
  const tools = toolNames.length > 0 ? toolNames.join(TOOL_LIST_SEP) : NO_TOOLS;
  const status =
    `stop=${result.stopReason} · ` +
    `turns=${result.turnCount} · ` +
    `tools=${tools} · ` +
    `${trace.totals.totalDurationMs}ms` +
    tokenSegment(result.lastUsage);
  // B1: 打断反馈作为状态行前缀 —— 流式宿主只 emit statusLine(chat-session.ts
  // 861),note 必须骑在 statusLine 上才不丢;formatRunHuman 委托本函数,
  // 两路径都带。非 cancelled → interruptNote undefined → 无前缀,byte-stable。
  return interruptNote ? `⏹ 已打断，${interruptNote}\n${status}` : status;
}

/**
 * Human projection of `RunResult` + `LoopTrace`.
 *
 * Layout:
 *   `<rendered text>
 *
 *   stop=<stopReason> · turns=<turnCount> · tools=<a,b,c> · <totalDurationMs>ms
 *   [ · tokens in/out: <inputTokens>/<outputTokens>]`
 *
 * `result.finalText === null` 或无内容时,文本部分为空字符串,状态行照常输出。
 *
 * #195: status segment delegates to `formatStatusLine` (DRY with the streaming
 * chat host path which emits only the status line + separator).
 *
 * #152 T5 + #T6 (D5):thinking 可见面走 `opts.showThinking`(默认 false)。关闭时
 * 与原行为完全一致(用 `finalText` 派生,thinking 不进答案);开启时切到
 * `renderThinkingVisible` = 折叠摘要行 + 答案正文(text 块拼接),与 TUI 终稿
 * 默认折叠态一致(chat 端 TTY 无折叠交互,摘要行即折叠态)。
 *
 * SC20: 最终文本会被 `createOutputMask(currentSecretValues())` 替换已知密钥
 * 值为 `***`(消费层输出边界)。
 *
 * T6 (D5): `renderThinkingSummary` / `renderThinkingVisible` 为折叠态组装;
 * 见 `renderThinkingSummary` 文档。
 */
function renderThinkingVisible(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  const summary = renderThinkingSummary(messages);
  const text = renderAssistantAnswer({ messages, showThinking: false });
  if (summary === "") return text;
  return text === "" ? summary : `${summary}\n\n${text}`;
}

export function formatRunHuman(opts: FormatRunHumanOpts): string {
  const { result, showThinking = false } = opts;
  const rawText = showThinking
    ? renderThinkingVisible(result.messages)
    : (result.finalText ?? "");
  const text = buildOutputMask().mask(rawText);
  const status = formatStatusLine(opts);
  return `${text}\n\n${status}`;
}

/**
 * #160 T5: 人类状态行的 token 读数段。
 *
 * `lastUsage` 是 `RunResult` 必填字段;null = run 无成功模型调用,返回空串
 * (状态行保持既有形状)。人类展示面只显示 input/output——cache 两字段暂不
 * 上人类面(最小清晰原则;JSON 投影里仍可完整消费,见 formatRunJson)。
 */
function tokenSegment(lastUsage: TokenUsage | null): string {
  if (lastUsage === null) return "";
  return ` · tokens in/out: ${lastUsage.inputTokens}/${lastUsage.outputTokens}`;
}

/**
 * Machine projection: pretty-printed JSON, deliberately omits `result.messages`.
 *
 * Deliberately excludes `result.messages` (Anthropic-native wire format) because
 * ask / chat oneshot scripts only need `finalText` + `stopReason` + `turnCount` +
 * `trace` for downstream parsing. Native messages stay available via `RunResult`
 * for in-process consumers; not for shell consumers.
 *
 * #160 T5:`lastUsage` 非 null 时新增 `lastUsage` 键(camelCase 四字段,与
 * `RunResult` 域类型 `TokenUsage` 形状一致);null = run 无成功模型调用 → 键
 * 缺席(同 `messages` 省略风格,`JSON.stringify` 自动丢弃 `undefined` 值)。
 * 域类型 `TokenUsage` 的字段名即为 camelCase,无需在投影层重写映射。
 *
 * #152 T5:thinking 展示开关**不影响** JSON 投影(machine readers 自然能从
 * `result.messages` 提取,或留后续票)。
 *
 * SC20: `finalText` 字段会被 `createOutputMask(currentSecretValues())` 替换已知
 * 密钥值为 `***`(消费层输出边界)。
 */
export function formatRunJson(opts: FormatRunOpts): string {
  const { result, trace } = opts;
  const maskedFinalText =
    result.finalText === null ? null : buildOutputMask().mask(result.finalText);
  // null → undefined → JSON.stringify 丢弃(同 messages 省略)。
  const lastUsage = result.lastUsage === null ? undefined : result.lastUsage;
  return JSON.stringify(
    {
      finalText: maskedFinalText,
      stopReason: result.stopReason,
      turnCount: result.turnCount,
      lastUsage,
      trace,
    },
    null,
    2
  );
}

/**
 * SC20: Build a fresh output mask from the currently-known secret values.
 *
 * Constructed per call (cheap enough — regex compilation on a few short
 * strings). Module-level memoization would also work but adds a test seam:
 * a per-call build means each call sees the env snapshot at call time,
 * which is what CLI invocations want (start-of-run snapshot is fine — env
 * does not mutate mid-run for CLI products).
 */
function buildOutputMask() {
  return createOutputMask(currentSecretValues());
}

/**
 * Flatten tool names across all turns, dedupe by first-occurrence order.
 * Returns an empty array when trace has no turns or no tool calls.
 *
 * Set iteration order in JS engines is insertion order; using `Array.from(new Set(...))`
 * preserves first-occurrence semantics without an extra index scan.
 */
function flattenToolNames(trace: LoopTrace): string[] {
  return Array.from(
    new Set(trace.turns.flatMap((t) => t.toolCalls.map((c) => c.toolName)))
  );
}

/**
 * T6 (D5):终稿 thinking 折叠摘要行(chat 端 `showThinking=true` 的折叠态展示)。
 *
 * 返回 `思考（N 段[ · 已加密 ×M]）` 摘要行;无 thinking / redacted → 空串。
 * TTY 无折叠交互,摘要行即"折叠态"——与 TUI 默认折叠语义一致(两个入口的
 * thinking 默认折叠状态统一)。redacted_thinking 计入 `已加密` 计数(加密 blob
 * 无可见内容,只报存在)。
 */
export function renderThinkingSummary(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  const lastAssistant = findLastAssistantMessage(messages);
  if (!lastAssistant) return "";
  return summarizeThinkingContent(lastAssistant.content);
}

/**
 * 单消息级 thinking 折叠摘要（SSOT，chat-view 复用同源）。
 *
 * 返回 `思考（N 段[ · 已加密 ×M]）` 摘要行;无 thinking / redacted → 空串。
 * 供 chat 端 `showThinking=true` 折叠态展示与 TUI 折叠面板共用——两入口的
 * thinking 默认折叠状态与摘要字面保持一致。
 */
export function summarizeThinkingContent(
  content: ReadonlyArray<AnthropicNativeMessage["content"][number]>
): string {
  let thinkingCount = 0;
  let redactedCount = 0;
  for (const block of content) {
    if (block.type === "thinking") thinkingCount += 1;
    else if (block.type === "redacted_thinking") redactedCount += 1;
  }
  if (thinkingCount === 0 && redactedCount === 0) return "";
  const redacted = redactedCount > 0 ? ` · 已加密 ×${redactedCount}` : "";
  return `思考（${thinkingCount} 段${redacted}）`;
}
