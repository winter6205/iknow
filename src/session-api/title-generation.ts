/**
 * ADR-0113: lite-model tool-less title generation module.
 *
 * Responsibility boundaries:
 *   - one tool-less text completion (reuses the `CompactAdapter` shape —
 *     same step(state, frozen empty request, signal) posture as full
 *     compact; absent tools key = not sent);
 *   - stays out of the Loop Engine and the harness loop, never blocks
 *     the main turn (fire-and-forget is owned hub-side; this module is
 *     a plain async function);
 *   - any failure (adapter throw / empty response / timeout) returns
 *     undefined, never rejects — callers keep the extractTitle
 *     placeholder.
 *
 * Real assembly entry `buildLiteTitleGenerator`: consumes only
 * `env.llm.liteModel` (invalid config = key absent, so no empty-route
 * check here).
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../harness/model-adapter/types.js";
import type { CompactAdapter } from "../harness/compress/index.js";
import { createRealAnthropicAdapter } from "../harness/model-adapter/anthropic-adapter.js";
import {
  wireModelFromRoute,
  type IknowEnv,
  type LiteModelEnv,
  type LlmEnv,
} from "../config/env.js";
import {
  isTurnQuery,
  messageText,
  shouldSeedTaskFocus,
} from "./turn-projection.js";

/** Title length cap — aligned with `extractTitle`'s 80 (SSOT: store/schema.ts). */
export const MAX_TITLE_CHARS = 80;
/**
 * "Too short" threshold for the first user text: below it, a lite call
 * is only worth spending once assistant text already exists.
 */
export const TOO_SHORT_QUERY_CHARS = 8;
/** Client-side cap for the generation call; timeout = silent abandon (placeholder kept), no retry. */
export const DEFAULT_TITLE_TIMEOUT_MS = 30_000;
/** Max user queries carried in the prompt / per-query truncation length. */
const MAX_QUERIES_IN_PROMPT = 5;
const MAX_QUERY_CHARS_IN_PROMPT = 200;
const MAX_ASSISTANT_CHARS_IN_PROMPT = 500;
/** A title is one-shot short text: max_tokens just covers a single-line label, keeping the overshoot surface small. */
const TITLE_MAX_OUTPUT_TOKENS = 64;

/** Generation input: substantive user queries in the session + latest visible assistant text (may be empty). */
export type TitleSource = {
  readonly userQueries: ReadonlyArray<string>;
  readonly assistantText: string;
};

/**
 * Generator dependency injected by hub (SessionHubOptions.titleGenerator).
 * Contract: resolves to the raw candidate title (hub sanitizes before
 * persisting); failure / timeout / no result → resolves undefined;
 * never rejects (hub still catches defensively, covering unusual test
 * stub implementations).
 */
export type TitleGenerator = (
  source: TitleSource
) => Promise<string | undefined>;

/**
 * Sanitize model output into a single-line list title: collapse
 * newlines/whitespace runs to one space, trim, strip paired quote
 * wrappers (models commonly echo 「」/“”/""), truncate to 80. All
 * whitespace → "" (caller treats as failure, placeholder kept).
 */
export function sanitizeSessionTitle(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  for (const [open, close] of [
    ["「", "」"],
    ["“", "”"],
    ['"', '"'],
    ["《", "》"],
  ]) {
    if (t.length > 2 && t.startsWith(open) && t.endsWith(close)) {
      t = t.slice(open.length, t.length - close.length).trim();
      break;
    }
  }
  return t.slice(0, MAX_TITLE_CHARS).trim();
}

/** Build the single-completion prompt (user queries + optional assistant text + output constraints). */
export function buildTitlePrompt(source: TitleSource): string {
  const queries = source.userQueries
    .slice(0, MAX_QUERIES_IN_PROMPT)
    .map((q) => q.slice(0, MAX_QUERY_CHARS_IN_PROMPT));
  const lines = [
    "根据以下会话内容生成一个简短的主题标签，用于会话列表一行扫读。",
    "要求：单行；不超过 20 个字；名词短语优先；不加标点结尾；不要前缀（如「标题：」）；只输出标签本身。",
    "用户提问：",
    ...queries.map((q, i) => `${i + 1}. ${q}`),
  ];
  const assistant = source.assistantText.trim();
  if (assistant.length > 0) {
    lines.push(
      `助手回复：${assistant.slice(0, MAX_ASSISTANT_CHARS_IN_PROMPT)}`
    );
  }
  return lines.join("\n");
}

/**
 * Trigger gate, pure function: derives generation input from a run's
 * full messages + final assistant text; returns undefined when
 * conditions are unmet (caller skips this turn, re-evaluates on the
 * next completed turn).
 *
 * - Only real user queries (`isTurnQuery` filters out tool_result /
 *   drain / status and other machine-injected user messages);
 * - Greeting filter shares the same gate as `shouldSeedTaskFocus`
 *   (SSOT: turn-projection.ts);
 * - All queries are greetings → undefined (don't burn a lite call);
 * - First substantive query shorter than TOO_SHORT_QUERY_CHARS with no
 *   assistant text → undefined (wait for assistant text before
 *   deciding).
 */
export function collectTitleSource(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  assistantText: string
): TitleSource | undefined {
  const queries: string[] = [];
  for (const msg of messages) {
    if (!isTurnQuery(msg)) continue;
    const text = messageText(msg).trim();
    if (text.length === 0) continue;
    if (!shouldSeedTaskFocus(text)) continue;
    queries.push(text);
  }
  if (queries.length === 0) return undefined;
  if (
    queries[0].length < TOO_SHORT_QUERY_CHARS &&
    assistantText.trim().length === 0
  ) {
    return undefined;
  }
  return { userQueries: queries, assistantText };
}

/**
 * TitleGenerator factory for real lite completion: one
 * `step(frozen single-message state, frozen empty request, signal)`
 * (request carries no tools key — the adapter's conditional spread
 * omits it), with a client-side timeout. All failure branches converge
 * to undefined; never rejects.
 */
export function createLiteTitleGenerator(opts: {
  readonly adapter: CompactAdapter;
  readonly timeoutMs?: number;
}): TitleGenerator {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS;
  return async (source) => {
    const prompt = buildTitlePrompt(source);
    const state: LoopState = Object.freeze({
      messages: Object.freeze([opts.adapter.encodeUserText(prompt)]),
      turnCount: 0,
    });
    const request = Object.freeze({});
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const adapterP = (async (): Promise<string | undefined> => {
      try {
        const result: AssistantTurnResult = await opts.adapter.step(
          state,
          request,
          controller.signal
        );
        const text = (result.projection.texts ?? []).join(" ").trim();
        return text.length > 0 ? text : undefined;
      } catch {
        // EXIT: adapter threw (network / protocol / abort) → same shape as timeout: undefined.
        return undefined;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    const timeoutP = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, timeoutMs);
      // A fire-and-forget call must not pin the process to the event loop.
      timer.unref?.();
    });
    return Promise.race([adapterP, timeoutP]);
  };
}

/**
 * Host assembly seam: `env.llm.liteModel` → real TitleGenerator.
 * Non-streaming single arm, no thinking (a title needs no reasoning
 * chain); the client authenticates like the main model, only the
 * routing triple (baseUrl/apiKey/headers) comes from lite. SDK 0.115
 * has no close API, so the client lives with the generator closure and
 * is released at host exit.
 */
export function buildLiteTitleGenerator(
  lite: LiteModelEnv,
  opts?: { readonly timeoutMs?: number }
): TitleGenerator {
  const client = new Anthropic({
    apiKey: lite.apiKey,
    baseURL: lite.baseUrl,
    // headers absent → don't pass an explicit undefined key (same discipline as createAdapterFromEnv).
    ...(lite.headers !== undefined ? { defaultHeaders: lite.headers } : {}),
  });
  const adapter = createRealAnthropicAdapter({
    client,
    model: wireModelFromRoute(lite.model),
    maxTokens: TITLE_MAX_OUTPUT_TOKENS,
    stream: false,
  });
  return createLiteTitleGenerator({ adapter, timeoutMs: opts?.timeoutMs });
}

/**
 * Host assembly seam (shared by serve.ts / tui/hub-bridge.ts): resolves
 * lite via the existing dual-source form "envProvider first, static env
 * fallback" and returns a fragment directly spreadable into
 * SessionHubOptions. lite absent → empty object (`titleGenerator` key
 * never appears, hub never fires). All branching converges here so host
 * assembly functions gain no complexity.
 */
export function liteTitleGeneratorOptions(sources: {
  readonly envProvider?: () => IknowEnv;
  readonly env?: { readonly llm: LlmEnv };
}): { readonly titleGenerator?: TitleGenerator } {
  const env =
    sources.envProvider !== undefined ? sources.envProvider() : sources.env;
  const lite = env?.llm.liteModel;
  return lite !== undefined
    ? { titleGenerator: buildLiteTitleGenerator(lite) }
    : {};
}
