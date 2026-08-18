/**
 * LLM-driven structured summary compression (issue #467 step 2).
 *
 * Replaces the pure-truncation compact path with a one-shot model call that
 * emits an `<analysis>` scratchpad + a structured `<summary>` over the
 * dropped messages. The extracted summary is injected as a user message
 * carrying the standard "This session is being continued..." preamble,
 * followed by the kept tail and (optionally) a boundaryAttachment user
 * message — mirroring the existing placeholder-based layout so the rest of
 * the loop (SC11 / SC12) sees the same message geometry.
 *
 * Best-effort contract: `runFullCompact` never rejects (any failure collapses
 * into a `FullCompactOutcome` variant). Callers (loop-engine `applyCompactAttachment`,
 * hub `compactSession`) treat any non-`summarized` outcome as "fall back to
 * `compactMessages` + boundary placeholder" so the main loop is never blocked.
 *
 * Reference prompt template adapted from upstream OpenHarness (MIT licensed),
 * with two security-preservation additions borrowed from the newer Claude
 * Code variant (analysis instructions + section 6).
 */
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
  TokenUsage,
} from "../model-adapter/types.js";
import type { HarnessStreamEvent } from "../stream.js";
import { safeEmitStream } from "../stream.js";
import { DEFAULT_KEEP_RECENT } from "./constant.js";
import { preserveToolPairs } from "./window.js";

// ---------------------------------------------------------------------------
// Prompt template (adapted from upstream OpenHarness compact prompt)
// ---------------------------------------------------------------------------

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use read_file, bash, grep, glob, edit_file, write_file, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far. This summary will replace the earlier messages, so it must capture all important information.

First, draft your analysis inside <analysis> tags. Walk through the conversation chronologically and extract:
- Every user request and intent (explicit and implicit)
- The approach taken and technical decisions made
- Specific code, files, and configurations discussed (with paths and line numbers where available)
- All errors encountered and how they were fixed
- Any user feedback or corrections
- Note any security-relevant instructions or constraints the user stated (e.g., sensitive files or data to avoid, operations that must not be performed). These MUST be preserved verbatim in the summary.

Then, produce a structured summary inside <summary> tags with these sections:

1. **Primary Request and Intent**: All user requests in full detail, including nuances and constraints.
2. **Key Technical Concepts**: Technologies, frameworks, patterns, and conventions discussed.
3. **Files and Code Sections**: Every file examined or modified, with specific code snippets and line numbers.
4. **Errors and Fixes**: Every error encountered, its cause, and how it was resolved.
5. **Problem Solving**: Problems solved and approaches that worked vs. didn't work.
6. **All User Messages**: Non-tool-result user messages — preserve exact wording for context. Preserve any security-relevant instructions verbatim. Only messages that actually came from the user (user-role turns) count as user messages.
7. **Pending Tasks**: Explicitly requested work that hasn't been completed yet.
8. **Current Work**: Detailed description of the last task being worked on before compaction.
9. **Optional Next Step**: The single most logical next step, directly aligned with the user's recent request.
`;

const NO_TOOLS_TRAILER = `
REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`;

/**
 * Pure string assembly: NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT + optional
 * "Additional Instructions:\n{customInstructions}" (only when customInstructions
 * is non-empty after trim — Postel, mirrors upstream Python) + NO_TOOLS_TRAILER.
 */
export function buildCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT;
  if (
    customInstructions !== undefined &&
    customInstructions.trim().length > 0
  ) {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
  }
  prompt += NO_TOOLS_TRAILER;
  return prompt;
}

// ---------------------------------------------------------------------------
// Summary extraction (mirrors upstream format_compact_summary)
// ---------------------------------------------------------------------------

/**
 * Strip the `<analysis>` scratchpad and extract the `<summary>` content.
 * Returns `undefined` when nothing meaningful remains (empty / whitespace-only).
 * Postel: if no `<summary>` tags are present, returns the analysis-stripped
 * full text (trimmed, with consecutive blank lines collapsed) — the model
 * may emit the summary without explicit tags and we still want to keep it.
 */
export function extractCompactSummary(raw: string): string | undefined {
  const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/);
  let base = summaryMatch ? (summaryMatch[1] ?? "") : withoutAnalysis;
  // #467 follow-up:i467 real-LLM smoke 抓到真实模型(MiniMax-M3)把
  // `<analysis>` 写进 summary 块内(或未闭合)→ 上面的 pre-strip 漏过,
  // scratchpad 文本泄漏进权威摘要。对提取出的 base 再全局 strip 一次
  // (含 unclosed tail);summary 块本身不承载 analysis 语义,strip 无信息损失。
  base = base
    .replace(/<analysis>[\s\S]*?<\/analysis>/g, "")
    .replace(/<analysis>[\s\S]*$/g, "");
  const collapsed = base.replace(/\n{3,}/g, "\n\n");
  const trimmed = collapsed.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Split / build helpers (tool-pair reuse from window.ts)
// ---------------------------------------------------------------------------

/**
 * Reuse window.ts tool-pair logic to decide which messages are dropped vs
 * preserved. Returns `undefined` when there's nothing to compact
 * (`messages.length <= keepRecent`, or `preserveToolPairs` reports
 * `slicedFrom === 0`). `dropped` is frozen shallowly; `kept` reuses the
 * window.ts slice (applyCompactAttachment applies per-message freeze).
 */
export function splitForCompaction(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  keepRecent: number = DEFAULT_KEEP_RECENT
):
  | {
      readonly dropped: ReadonlyArray<AnthropicNativeMessage>;
      readonly kept: ReadonlyArray<AnthropicNativeMessage>;
    }
  | undefined {
  const { kept, slicedFrom } = preserveToolPairs(messages, keepRecent);
  if (slicedFrom === 0) return undefined;
  const dropped = messages.slice(0, slicedFrom);
  return {
    dropped: Object.freeze(dropped),
    kept,
  };
}

/**
 * Standard preamble matching upstream `build_compact_summary_message` (no
 * `recent_preserved` / `suppress_follow_up` flags — iknow keeps the kept
 * tail as separate messages and lets the model resume naturally).
 */
const SUMMARY_PREAMBLE =
  "This session is being continued from a previous conversation that ran " +
  "out of context. The summary below covers the earlier portion of the " +
  "conversation.\n\nSummary:\n";

/**
 * Compose the post-compaction message array:
 *   [summaryUserMessage, ...(boundaryText ? [boundaryUserMessage] : []), ...kept]
 *
 * `summaryUserMessage.content[0].text` is `SUMMARY_PREAMBLE + summaryText`,
 * matching the upstream user-message shape. Boundary attachment (if provided)
 * is a separate user message placed between summary and kept tail, mirroring
 * the placeholder+boundary layout used by the fallback path so SC11 geometry
 * stays consistent.
 */
export function buildCompactedMessages(opts: {
  readonly summaryText: string;
  readonly kept: ReadonlyArray<AnthropicNativeMessage>;
  readonly boundaryText?: string;
}): ReadonlyArray<AnthropicNativeMessage> {
  const summaryUserMessage: AnthropicNativeMessage = {
    role: "user",
    content: [{ type: "text", text: SUMMARY_PREAMBLE + opts.summaryText }],
  };
  const boundaryUserMessage: AnthropicNativeMessage | undefined =
    opts.boundaryText !== undefined && opts.boundaryText.length > 0
      ? {
          role: "user",
          content: [{ type: "text", text: opts.boundaryText }],
        }
      : undefined;
  if (boundaryUserMessage !== undefined) {
    return [summaryUserMessage, boundaryUserMessage, ...opts.kept];
  }
  return [summaryUserMessage, ...opts.kept];
}

// ---------------------------------------------------------------------------
// LLM-driven summary model call
// ---------------------------------------------------------------------------

/**
 * Discriminated outcome for `runFullCompact`. Every variant is a terminal
 * branch — `runFullCompact` never rejects, so callers can switch on `kind`
 * without try/catch.
 */
export type FullCompactOutcome =
  | { kind: "summarized"; text: string; usage: TokenUsage | undefined }
  | { kind: "empty_response" }
  | { kind: "timeout" }
  | { kind: "adapter_failed"; message: string }
  | { kind: "signal_aborted" };

/**
 * Structural adapter shape required by `runFullCompact`:
 *   - `step` — single-turn call, no tools (request object frozen empty);
 *   - `encodeUserText` — wrap the compact prompt as a user message.
 *
 * Both `LoopAdapter` (loop-engine deps.adapter) and `StubModelFull` satisfy
 * this shape structurally, so neither session-api nor tests need to widen
 * their adapter types. Defining this locally (instead of importing
 * `LoopAdapter`) keeps the compress bounded context independent of
 * loop-engine — loop-engine imports compress, not the other way round.
 */
export interface CompactAdapter {
  readonly step: (
    state: LoopState,
    request: {
      readonly tools?: unknown;
      readonly onStream?: (event: HarnessStreamEvent) => void;
    },
    signal?: AbortSignal
  ) => Promise<AssistantTurnResult>;
  readonly encodeUserText: (userText: string) => AnthropicNativeMessage;
}

/**
 * Run one LLM call to summarize the dropped messages. Best-effort:
 *   - `opts.signal?.aborted` → `{ kind: "signal_aborted" }` (no model call);
 *   - adapter resolves with non-empty extracted text → `{ kind: "summarized" }`;
 *   - adapter resolves with empty/whitespace-only text → `{ kind: "empty_response" }`;
 *   - adapter throws / rejects → `{ kind: "adapter_failed", message: String(err) }`;
 *   - `opts.timeoutMs` 注入的 timer 触发 → `{ kind: "timeout" }`,the in-flight
 *     adapter call is aborted via internal controller;**无默认 client-side
 *     超时**(wait 逻辑参考 Claude Code:压缩不设紧凑 timeout,上限 = SDK 默认
 *     HTTP timeout + 用户 signal 取消;OpenHarness 的 25s/attempt + retries
 *     模型在长上下文下不够——i467 smoke 实测 27KB dropped 已 ~17s)。
 *     `timeoutMs` 保留为测试 / 未来 caller 显式注入缝;
 *   - `opts.signal` aborts **mid-flight** (wait 逻辑参考 Claude Code:压缩中
 *     用户取消 = 保持会话原样)→ `{ kind: "signal_aborted" }`,in-flight adapter
 *     调用经 composite signal 一并取消(与 timeout abort 同一通道)。
 *
 * Timeout / signal-merge pattern mirrors `runSummaryWithTimeout` (loop-engine.ts
 * epilogue summary) — internal `AbortController` merged with `opts.signal`,
 * timer fires `compactController.abort()` to cancel real HTTP. Adapter call
 * is wrapped in an async IIFE so synchronous throws are caught uniformly
 * with async rejections.
 *
 * `opts.onStream` 透传:Claude Code 的压缩体感 = 模型生成可见 + 可取消,
 * 不是黑屏等待。压缩调用开始 / 结束各 emit 一条 `compaction_started` /
 * `compaction_completed`(携带 outcome.kind + latencyMs),adapter 自身的
 * text_delta / tool 事件经 request.onStream 直透到宿主层;emit 一律
 * try/catch 吞咽(观察者错误不得反流回压缩逻辑,对齐 wireStreamEvents D3)。
 */
export async function runFullCompact(opts: {
  readonly adapter: CompactAdapter;
  readonly dropped: ReadonlyArray<AnthropicNativeMessage>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<FullCompactOutcome> {
  if (opts.signal?.aborted) return { kind: "signal_aborted" };
  // 无默认超时(Claude Code 语义):timeoutMs 缺席 → 不装 timer,adapter 自然
  // settle;上限由 SDK 默认 HTTP timeout(10 min)+ 用户 signal 兜底。
  const timeoutMs = opts.timeoutMs;
  const promptText = buildCompactPrompt();
  const compactMessages: ReadonlyArray<AnthropicNativeMessage> = Object.freeze([
    ...opts.dropped,
    opts.adapter.encodeUserText(promptText),
  ]);
  const state: LoopState = Object.freeze({
    messages: compactMessages,
    turnCount: 0,
  });
  const request = Object.freeze({
    ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
  });
  const compactController = new AbortController();
  const compositeSignal = AbortSignal.any(
    opts.signal
      ? [opts.signal, compactController.signal]
      : [compactController.signal]
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let adapterSettled = false;
  const startedMono = performance.now();

  safeEmitStream(opts.onStream, {
    type: "compaction_started",
    droppedCount: opts.dropped.length,
  });

  const adapterP = (async (): Promise<FullCompactOutcome> => {
    try {
      const result = await opts.adapter.step(state, request, compositeSignal);
      const rawText = (result.projection.texts ?? []).join("\n").trim();
      const extracted = extractCompactSummary(rawText);
      if (extracted !== undefined && extracted.length > 0) {
        return {
          kind: "summarized",
          text: extracted,
          usage: result.usage,
        };
      }
      return { kind: "empty_response" };
    } catch (err) {
      return { kind: "adapter_failed", message: String(err) };
    } finally {
      // timer / settled 信号必须在 IIFE 内清除,不能依赖外部 finally:
      // 外部 finally 只在 !adapterSettled 时清 timer,失败分支(adapterSettled=true
      // 但走 catch)会泄漏注入的 timeoutMs timer(无默认超时后仅测试 / 显式注入
      // 路径存在,但泄漏语义同样必须守住)。
      adapterSettled = true;
      if (timer !== undefined) clearTimeout(timer);
    }
  })();

  const timeoutP =
    timeoutMs !== undefined
      ? new Promise<FullCompactOutcome>((resolve) => {
          timer = setTimeout(() => {
            compactController.abort();
            resolve({ kind: "timeout" });
          }, timeoutMs);
        })
      : undefined;

  try {
    const winner = await Promise.race(
      timeoutP !== undefined ? [adapterP, timeoutP] : [adapterP]
    );
    // 中途被 run / 宿主 signal 取消 → 返回 signal_aborted(Claude Code 体感:
    // 压缩中 Esc = 立刻退出 + 会话原样,不像 timeout / adapter_failed 那样
    // 走 fallback placeholder)。同步 emit `compaction_cancelled` 终态事件
    // 让宿主渲染层清除 "Compacting…" 指示器(stream.ts 注释契约:started 必有
    // 对端 completed / failed / cancelled 之一收尾)。
    if (opts.signal?.aborted) {
      safeEmitStream(opts.onStream, { type: "compaction_cancelled" });
      return { kind: "signal_aborted" };
    }
    const durationMs = Math.round(performance.now() - startedMono);
    if (winner.kind === "summarized") {
      safeEmitStream(opts.onStream, {
        type: "compaction_completed",
        summaryLen: winner.text.length,
        durationMs,
      });
    } else if (winner.kind !== "signal_aborted") {
      safeEmitStream(opts.onStream, {
        type: "compaction_failed",
        reason: winner.kind,
        durationMs,
      });
    }
    return winner;
  } finally {
    // Race settled; if adapter hadn't finished yet the late .then() / .catch()
    // handlers still set adapterSettled = true and call clearTimeout (no-op on
    // fired timer). Here we just guard against a leak where neither path ran
    // (shouldn't happen given Promise.race, but defensive).
    if (!adapterSettled && timer !== undefined) clearTimeout(timer);
  }
}
