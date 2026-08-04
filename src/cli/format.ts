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
 */
import type {
  AnthropicNativeMessage,
  LoopTrace,
  RunResult,
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
 * Human projection of `RunResult` + `LoopTrace`.
 *
 * Layout:
 *   `<rendered text>
 *
 *   stop=<stopReason> · turns=<turnCount> · tools=<a,b,c> · <totalDurationMs>ms`
 *
 * `result.finalText === null` 或无内容时,文本部分为空字符串,状态行照常输出。
 * `trace.turns` 中无任何工具调用时,`tools=` 显示 `-`。
 *
 * #152 T5:thinking 可见面走 `opts.showThinking`(默认 false)。关闭时与原行为
 * 完全一致(用 `finalText` 派生,thinking 不进答案);开启时改走
 * `renderAssistantAnswer` 把 thinking 文本前置显示。
 *
 * SC20: 最终文本会被 `createOutputMask(currentSecretValues())` 替换已知密钥
 * 值为 `***`(消费层输出边界)。
 */
export function formatRunHuman(opts: FormatRunHumanOpts): string {
  const { result, trace, showThinking = false } = opts;
  const rawText = showThinking
    ? renderAssistantAnswer({
        messages: result.messages,
        showThinking: true,
      })
    : (result.finalText ?? "");
  const text = buildOutputMask().mask(rawText);
  const toolNames = flattenToolNames(trace);
  const tools = toolNames.length > 0 ? toolNames.join(TOOL_LIST_SEP) : NO_TOOLS;
  const status =
    `stop=${result.stopReason} · ` +
    `turns=${result.turnCount} · ` +
    `tools=${tools} · ` +
    `${trace.totals.totalDurationMs}ms`;
  return `${text}\n\n${status}`;
}

/**
 * Machine projection: pretty-printed JSON, deliberately omits `result.messages`.
 *
 * Deliberately excludes `result.messages` (Anthropic-native wire format) because
 * ask / chat oneshot scripts only need `finalText` + `stopReason` + `turnCount` +
 * `trace` for downstream parsing. Native messages stay available via `RunResult`
 * for in-process consumers; not for shell consumers.
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
  return JSON.stringify(
    {
      finalText: maskedFinalText,
      stopReason: result.stopReason,
      turnCount: result.turnCount,
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
