/**
 * In-process multi-conversation host over harness foundation runtime.
 * 022 T4: load → run(priorMessages) → conditional save → wire projection.
 * Messages single-source is the session file; hub holds no messages copy.
 * 064 T5: per-session JSONL trace when traceOut is configured (ADR-0003 D4).
 *
 * 162: askUser is required at engine construction. Hub accepts `askUser`
 * via SessionHubOptions (tests inject createNoAskUser()); production callers
 * (serve.ts) supply the SPA-channel implementation or a v0 stub.
 */
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  run,
  createRealAnthropicAdapter,
  buildThinkingParams,
  createRegistry,
  createExecutor,
  createEchoTool,
  createGetTimeTool,
  createJsonlTraceService,
  type AnthropicContentBlock,
  type AnthropicNativeMessage,
  type LoopEngineDeps,
  type RunResult,
} from "../harness/index.js";
import { createPermissionExecutor } from "../harness/permission/index.js";
import { createPermissionPolicy } from "../harness/permission/policy.js";
import type { AskUser } from "../harness/permission/types.js";
import { createViolationCounter } from "../harness/sandbox/violation-handling.js";
import { wrapWithViolationHook } from "../harness/sandbox/violation-executor.js";
import {
  createOutputMask,
  currentSecretValues,
} from "../harness/sandbox/index.js";
import { loadIknowEnv, type LlmEnv } from "../config/env.js";
import { ValidationError } from "../shared/errors.js";
import { appendFileSync } from "node:fs";
import { SessionStore, type SessionListEntry } from "./store/index.js";
import type { SessionStoreError } from "./store/index.js";
import type { SessionFileV1 } from "./store/index.js";
import { CURRENT_SCHEMA_VERSION, extractSummary } from "./store/index.js";
import type {
  ApiErrorBody,
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  PostMessageResponse,
  ResetSessionResponse,
  SessionSummary,
  TurnDto,
} from "./contract.js";
import { MAX_MESSAGE_CHARS } from "./contract.js";
import { projectThinkingView, projectToolCalls } from "./turn-projection.js";
import {
  withThinkingOverride,
  type ThinkingOverride,
} from "./thinking-override.js";

/** Best-effort JSON parse: returns the parsed value or the raw string. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// -- error mapping (裁决#10: pure function, http.ts T5 consumes) ---------------

/**
 * Status + message per SessionStoreError kind. Data table replaces the prior
 * 6-case switch so mapStoreError stays a flat lookup (SC24 >60 hard-split gate).
 * retryable is implicit via 5xx status (D1.2: not in wire).
 */
type StoreErrorEntry = {
  status: number;
  message: (err: SessionStoreError) => string;
};

const STORE_ERROR_MAP: Record<SessionStoreError["kind"], StoreErrorEntry> = {
  not_found: {
    status: 404,
    message: (e) => `session not found: ${e.conversation_id}`,
  },
  parse_failed: {
    status: 422,
    message: (e) => `session file is not valid JSON: ${e.conversation_id}`,
  },
  schema_invalid: {
    status: 422,
    // schema_invalid carries `field`; narrow via `in` since the param is the
    // full union (the entry is only invoked for its own kind at runtime).
    message: (e) =>
      `session file schema invalid at field: ${"field" in e ? e.field : e.conversation_id}`,
  },
  write_failed: {
    status: 500,
    message: (e) => `failed to write session file: ${e.conversation_id}`,
  },
  concurrent_write: {
    status: 409,
    message: (e) => `concurrent write conflict: ${e.conversation_id}`,
  },
  io_error: {
    status: 500,
    message: (e) => `IO error on session file: ${e.conversation_id}`,
  },
};

/**
 * Map typed SessionStoreError → HTTP status + wire ApiErrorBody.
 */
export function mapStoreError(err: SessionStoreError): {
  status: number;
  body: ApiErrorBody;
} {
  const entry = STORE_ERROR_MAP[err.kind];
  return {
    status: entry.status,
    body: {
      error: {
        kind: err.kind,
        message: entry.message(err),
        conversation_id: err.conversation_id,
      },
    },
  };
}

// -- history projection (裁决#11: getSession turns) -----------------------------

/** Extract joined text from text blocks of a native message. */
function textOf(msg: AnthropicNativeMessage): string {
  return msg.content
    .filter(
      (b): b is Extract<AnthropicContentBlock, { type: "text" }> =>
        b.type === "text"
    )
    .map((b) => b.text)
    .join(" ");
}

/**
 * Project raw AnthropicNativeMessage[] → display-form TurnDto[] for wire.
 * Pairs each user message with its subsequent assistant message.
 * Projection is non-authoritative: stopReason/turnCount are lossy (裁决#11).
 *
 * T1: also projects thinking/toolCalls per turn (messages between this user
 * query and the next non-tool_result user message). Mask = SC20 boundary.
 */
export function projectMessagesToTurns(
  messages: ReadonlyArray<AnthropicNativeMessage>
): TurnDto[] {
  const mask = createOutputMask(currentSecretValues()).mask;
  const turns: TurnDto[] = [];
  let turnIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    // Skip tool_result user messages (they are continuation, not queries).
    if (msg.content.some((b) => b.type === "tool_result")) continue;
    const query = textOf(msg);
    // Turn slice: from this query until the next non-tool_result user message.
    const end = findTurnSliceEnd(messages, i);
    const turnMessages = messages.slice(i, end);
    const finalText = findFinalTextInSlice(turnMessages);
    turnIndex++;
    const thinking = projectThinkingView(turnMessages, mask);
    const toolCalls = projectToolCalls(turnMessages, mask);
    turns.push({
      query,
      answer: {
        finalText,
        stopReason: "completed",
        turnCount: turnIndex,
        ...(thinking !== undefined ? { thinking } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
      },
    });
  }
  return turns;
}

/**
 * End index of the turn slice that starts at `messages[i]` (the query): the
 * index of the next non-tool_result user message, or `messages.length` when
 * the turn runs to the end of history. Pulled out to keep
 * `projectMessagesToTurns` ≤10 cyclomatic and the slice-bounds logic in one
 * place (M2 / ACR complexity anti-drift).
 */
function findTurnSliceEnd(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  i: number
): number {
  for (let j = i + 1; j < messages.length; j++) {
    const next = messages[j]!;
    if (
      next.role === "user" &&
      !next.content.some((b) => b.type === "tool_result")
    ) {
      return j;
    }
  }
  return messages.length;
}

/**
 * first assistant message within the slice whose text blocks are non-empty
 * — empty assistant replies (e.g. tool-call-only turns) project as "" so
 * the wire keeps the field but the display path can still render the
 * thinking/toolCalls trail.
 */
function findFinalTextInSlice(
  turnMessages: ReadonlyArray<AnthropicNativeMessage>
): string {
  for (const m of turnMessages) {
    if (m.role !== "assistant") continue;
    const t = textOf(m);
    if (t) return t;
  }
  return "";
}

// -- hub options ---------------------------------------------------------------

export type SessionHubOptions = {
  /** Filesystem-backed session store (required). */
  store: SessionStore;
  /** Injected harness deps (tests). When omitted, lazily constructed once. */
  deps?: LoopEngineDeps;
  defaultJsonMode?: boolean;
  /** JSONL trace file path; when set, postMessage creates a per-session
   * JsonlTraceService bound to session.conversation_id (ADR-0003 D4).
   * Per-session instance -> cachedDeps does not cache the trace. */
  traceOut?: string;
  /** askUser inlet (#162). Required when not injecting `deps`; the
   * construction-time check below throws otherwise (#162 / SC18).
   * Tests injecting `deps` are unaffected. */
  askUser?: AskUser;
  /** T2: env source for per-turn thinking override (test seam; production
   * omits it → withThinkingOverride falls back to loadIknowEnv()). */
  overrideEnv?: { readonly llm: LlmEnv };
};

// -- stop reasons that must NOT persist to file (裁决#8) -----------------------

/** cancelled → no-op (spec L237); protocolError/emptyFinalResponse → drop context (chat-session.ts:84-89). */
const DROP_REASONS: ReadonlySet<string> = new Set([
  "cancelled",
  "protocolError",
  "emptyFinalResponse",
]);

// -- SessionHub ----------------------------------------------------------------

export class SessionHub {
  private readonly store: SessionStore;
  private cachedDeps: LoopEngineDeps | undefined;
  private readonly defaults: {
    jsonMode: boolean;
  };
  /** JSONL trace output path; when set, postMessage creates a per-session trace. */
  private readonly traceOut: string | undefined;
  /** askUser inlet (#162); required unless deps are pre-built. */
  private readonly askUser: AskUser | undefined;
  /** T2: env source for the per-turn thinking override (test seam). */
  private readonly overrideEnv: { readonly llm: LlmEnv } | undefined;
  /** Per-conversation serialization (spec A15). */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(opts: SessionHubOptions) {
    if (!opts.askUser && !opts.deps) {
      throw new Error(
        "ask_inlet_missing: SessionHub requires AskUser or pre-built deps (#162 / SC18)"
      );
    }
    this.store = opts.store;
    this.cachedDeps = opts.deps;
    this.traceOut = opts.traceOut;
    this.askUser = opts.askUser;
    this.overrideEnv = opts.overrideEnv;
    this.defaults = {
      jsonMode: opts.defaultJsonMode ?? false,
    };
  }

  // -- public API --------------------------------------------------------------

  async createSession(
    req?: CreateSessionRequest
  ): Promise<CreateSessionResponse> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const file: SessionFileV1 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: [],
      jsonMode: req?.json_mode ?? this.defaults.jsonMode,
      turnCount: 0,
      updatedAt: now,
      summary: "",
      cwd: process.cwd(),
      sanitized_at: now,
    };
    await this.store.save({ id, file });
    return {
      session: this.summarize({ file }),
      turns: [],
    };
  }

  async getSession(conversationId: string): Promise<GetSessionResponse> {
    const file = await this.store.load(conversationId);
    return {
      session: this.summarize({ file }),
      turns: projectMessagesToTurns(file.messages),
    };
  }

  async postMessage(opts: {
    readonly conversationId: string;
    readonly text: string;
    readonly signal?: AbortSignal;
    readonly thinking?: ThinkingOverride;
  }): Promise<PostMessageResponse> {
    const { conversationId, text } = opts;
    this.validateText(text);
    const query = text.trim();
    return this.serialize({
      conversationId,
      work: async () => {
        const session = await this.store.load(conversationId);
        const priorCount = session.messages.length;
        const baseDeps = await this.ensureDeps();
        // T2: per-turn override — rebuild deps with a one-shot adapter only;
        // executor / registry / maxTurns / timeoutMs are reused from the
        // cached deps. When absent, the cached path is unchanged.
        const deps =
          opts.thinking !== undefined
            ? withThinkingOverride({
                deps: baseDeps,
                override: opts.thinking,
                env: this.overrideEnv,
              })
            : baseDeps;
        // T6: wrap the executor with the violation kill-session hook. Serve is
        // long-running and multi-conversation, so on kill we (a) write the
        // violation event to the JSONL trace and (b) report `protocolError`
        // as the turn stop reason — we do NOT touch process.exitCode.
        let killed = false;
        const counter = createViolationCounter();
        const onKill = (reason: string): void => {
          // Latch: the counter fires on every record past threshold; the trace
          // line is one-shot (mirrors wireKillSessionNotification's latch).
          if (killed) return;
          killed = true;
          this.recordViolationTrace(conversationId, reason);
        };
        const wrappedExecutor = wrapWithViolationHook({
          inner: deps.executor,
          counter,
          onKill,
        });
        // Per-session trace: new JsonlTraceService each postMessage (not cached
        // in cachedDeps) because conversationId differs per session (ADR-0003 D4).
        const runDeps: LoopEngineDeps = {
          ...deps,
          executor: wrappedExecutor,
          ...(this.traceOut
            ? {
                trace: createJsonlTraceService({
                  filePath: this.traceOut,
                  conversationId,
                }),
              }
            : {}),
        };
        const { result } = await run(query, runDeps, opts.signal, {
          priorMessages: session.messages,
        });
        // Violation kill → surface protocolError so the SPA client can
        // attribute the stop; DROP_REASONS already drops protocolError
        // context on save (mirrors the chat-session drop semantics).
        const finalResult: RunResult = killed
          ? { ...result, stopReason: "protocolError" }
          : result;
        // trace is destructured away → immediate GC (not logged/persisted/wired).
        await this.conditionalSave({
          conversationId,
          session,
          result: finalResult,
        });
        return {
          session: this.summarize({
            file: await this.store.load(conversationId),
          }),
          turn: this.toTurnDto({
            query,
            result: finalResult,
            turnMessages: finalResult.messages.slice(priorCount),
          }),
        };
      },
    });
  }

  async resetSession(
    conversationId: string,
    _opts?: { new_id?: boolean }
  ): Promise<ResetSessionResponse> {
    return this.serialize({
      conversationId,
      work: async () => {
        const session = await this.store.load(conversationId);
        const reset: SessionFileV1 = {
          ...session,
          messages: [],
          turnCount: 0,
          updatedAt: new Date().toISOString(),
          schemaVersion: CURRENT_SCHEMA_VERSION,
          summary: "",
        };
        await this.store.save({ id: conversationId, file: reset });
        return {
          session: this.summarize({ file: reset }),
          turns: [],
        };
      },
    });
  }

  async listSessions(): Promise<SessionListEntry[]> {
    return this.store.list();
  }

  /**
   * T6: write a violation kill event to the JSONL trace (serve entry).
   * Best-effort — a trace write failure must not break the served turn; any
   * error is swallowed (mirrors JsonlTraceService warn-once semantics).
   * `reason` is already a JSON string produced by createKillSessionHook.
   */
  private recordViolationTrace(conversationId: string, reason: string): void {
    if (!this.traceOut) return;
    try {
      const line = JSON.stringify({
        conversation_id: conversationId,
        record_type: "violation",
        ts: new Date().toISOString(),
        detail: safeParse(reason),
      });
      appendFileSync(this.traceOut, line + "\n", "utf8");
    } catch {
      // Best-effort observability; never let trace I/O break the served turn.
    }
  }

  // -- private helpers ---------------------------------------------------------

  private validateText(text: string): void {
    const query = text.trim();
    if (!query) {
      throw new ValidationError("message text must be non-empty", {
        field: "text",
      });
    }
    if (query.length > MAX_MESSAGE_CHARS) {
      throw new ValidationError(
        `message text exceeds max length ${MAX_MESSAGE_CHARS}`,
        { field: "text", max: MAX_MESSAGE_CHARS, length: query.length }
      );
    }
  }

  /**
   * Serialize operations on the same conversation_id (spec A15).
   * Different ids run in parallel; same id chains sequentially.
   */
  private serialize<T>(opts: {
    readonly conversationId: string;
    readonly work: () => Promise<T>;
  }): Promise<T> {
    const { conversationId, work } = opts;
    const prev = this.inflight.get(conversationId) ?? Promise.resolve();
    const next = prev.then(() => work());
    // Swallow rejection in the chain sentinel so subsequent ops still run.
    this.inflight.set(
      conversationId,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  /** 裁决#8: save condition based on stopReason. */
  private async conditionalSave(opts: {
    readonly conversationId: string;
    readonly session: SessionFileV1;
    readonly result: RunResult;
  }): Promise<void> {
    const { conversationId, session, result } = opts;
    if (DROP_REASONS.has(result.stopReason)) return;
    const updated: SessionFileV1 = {
      ...session,
      messages: result.messages,
      turnCount: session.turnCount + result.turnCount,
      updatedAt: new Date().toISOString(),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      summary: extractSummary(result.messages),
    };
    await this.store.save({ id: conversationId, file: updated });
  }

  /** Lazy deps construction (mirrors buildHarnessEngine, no agent-loop import). */
  private async ensureDeps(): Promise<LoopEngineDeps> {
    if (this.cachedDeps) return this.cachedDeps;
    if (!this.askUser) {
      throw new Error(
        "ask_inlet_missing: SessionHub lazy deps require AskUser (#162)"
      );
    }
    const env = loadIknowEnv();
    if (!env.llm.apiKey) {
      throw new ValidationError(
        `LLM mode needs the env var named by IKNOW_LLM_API_KEY_ENV (${env.llm.apiKeyEnv}); set the key.`
      );
    }
    const client = new Anthropic({
      apiKey: env.llm.apiKey,
      baseURL: env.llm.baseUrl,
    });
    const adapter = createRealAnthropicAdapter({
      client,
      model: env.llm.model,
      maxTokens: env.llm.maxOutputTokens,
      temperature: env.llm.temperature,
      // #151 T4 / #156 Low:env → adapter params(去重 single source)。
      thinking: buildThinkingParams(env.llm),
    });
    const registry = createRegistry([createEchoTool(), createGetTimeTool()]);
    const inner = createExecutor(registry);
    // 5-step permission middleware: askUser is guaranteed by the constructor
    // contract when the hub must build deps lazily.
    const policy = createPermissionPolicy();
    const executor = createPermissionExecutor({
      inner,
      registry,
      policy,
      askUser: this.askUser,
    });
    this.cachedDeps = {
      adapter,
      executor,
      registry,
      maxTurns: 6,
      timeoutMs: env.llm.timeoutMs,
    };
    return this.cachedDeps;
  }

  private summarize(opts: { readonly file: SessionFileV1 }): SessionSummary {
    const { file } = opts;
    return {
      conversation_id: file.conversation_id,
      json_mode: file.jsonMode,
      turn_count: file.turnCount,
      prior_count: 0,
    };
  }

  private toTurnDto(opts: {
    readonly query: string;
    readonly result: RunResult;
    /** T1: this run's own messages (priorMessages sliced away); used for
     * the per-turn thinking/toolCalls projection. */
    readonly turnMessages?: ReadonlyArray<AnthropicNativeMessage>;
  }): TurnDto {
    const { query, result } = opts;
    // SC20: serve SPA output boundary — mask known secret values in the
    // final text before it leaves the hub. The mask is rebuilt per call so
    // it sees the env snapshot at serve-time (cheap; a few short regexes).
    const mask = createOutputMask(currentSecretValues()).mask;
    const rawFinalText = result.finalText ?? "";
    const maskedFinalText = mask(rawFinalText);
    const turnMessages = opts.turnMessages ?? result.messages;
    const thinking = projectThinkingView(turnMessages, mask);
    const toolCalls = projectToolCalls(turnMessages, mask);
    return {
      query,
      answer: {
        finalText: maskedFinalText,
        stopReason: result.stopReason,
        turnCount: result.turnCount,
        // T1: optional fields — omitted entirely when undefined (byte-stable
        // for turns without thinking or tool use).
        ...(thinking !== undefined ? { thinking } : {}),
        ...(toolCalls !== undefined ? { toolCalls } : {}),
      },
    };
  }
}
