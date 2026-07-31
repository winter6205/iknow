/**
 * In-process multi-conversation host over harness foundation runtime.
 * 022 T4: load → run(priorMessages) → conditional save → wire projection.
 * Messages single-source is the session file; hub holds no messages copy.
 * 064 T5: per-session JSONL trace when traceOut is configured (ADR-0003 D4).
 */
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  run,
  createRealAnthropicAdapter,
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
import { loadIknowEnv, type AgentMode } from "../config/env.js";
import { ValidationError } from "../shared/errors.js";
import { SessionStore, type SessionListEntry } from "./store/index.js";
import type { SessionStoreError } from "./store/index.js";
import type { SessionFileV1 } from "./store/index.js";
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
 */
export function projectMessagesToTurns(
  messages: ReadonlyArray<AnthropicNativeMessage>
): TurnDto[] {
  const turns: TurnDto[] = [];
  let turnIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    // Skip tool_result user messages (they are continuation, not queries).
    if (msg.content.some((b) => b.type === "tool_result")) continue;
    const query = textOf(msg);
    // Find the next assistant message with text blocks.
    let finalText = "";
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]!;
      if (next.role === "assistant") {
        const t = textOf(next);
        if (t) {
          finalText = t;
          break;
        }
      }
    }
    turnIndex++;
    turns.push({
      query,
      answer: { finalText, stopReason: "completed", turnCount: turnIndex },
    });
  }
  return turns;
}

// -- hub options ---------------------------------------------------------------

export type SessionHubOptions = {
  /** Filesystem-backed session store (required). */
  store: SessionStore;
  /** Injected harness deps (tests). When omitted, lazily constructed once. */
  deps?: LoopEngineDeps;
  defaultMode?: AgentMode;
  defaultJsonMode?: boolean;
  defaultEmbeddings?: boolean;
  /** JSONL trace file path; when set, postMessage creates a per-session
   * JsonlTraceService bound to session.conversation_id (ADR-0003 D4).
   * Per-session instance -> cachedDeps does not cache the trace. */
  traceOut?: string;
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
    mode: AgentMode;
    jsonMode: boolean;
    embeddings: boolean;
  };
  /** JSONL trace output path; when set, postMessage creates a per-session trace. */
  private readonly traceOut: string | undefined;
  /** Per-conversation serialization (spec A15). */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(opts: SessionHubOptions) {
    this.store = opts.store;
    this.cachedDeps = opts.deps;
    this.traceOut = opts.traceOut;
    this.defaults = {
      mode: opts.defaultMode ?? "deterministic",
      jsonMode: opts.defaultJsonMode ?? false,
      embeddings: opts.defaultEmbeddings ?? false,
    };
  }

  // -- public API --------------------------------------------------------------

  async createSession(
    req?: CreateSessionRequest
  ): Promise<CreateSessionResponse> {
    const id = randomUUID();
    const file: SessionFileV1 = {
      schemaVersion: 1,
      conversation_id: id,
      messages: [],
      jsonMode: req?.json_mode ?? this.defaults.jsonMode,
      turnCount: 0,
      updatedAt: new Date().toISOString(),
    };
    await this.store.save(id, file);
    return {
      session: this.summarize(file, req?.mode ?? this.defaults.mode),
      turns: [],
    };
  }

  async getSession(conversationId: string): Promise<GetSessionResponse> {
    const file = await this.store.load(conversationId);
    return {
      session: this.summarize(file, this.defaults.mode),
      turns: projectMessagesToTurns(file.messages),
    };
  }

  async postMessage(
    conversationId: string,
    text: string,
    opts?: { signal?: AbortSignal }
  ): Promise<PostMessageResponse> {
    this.validateText(text);
    const query = text.trim();
    return this.serialize(conversationId, async () => {
      const session = await this.store.load(conversationId);
      const deps = await this.ensureDeps();
      // Per-session trace: new JsonlTraceService each postMessage (not cached
      // in cachedDeps) because conversationId differs per session (ADR-0003 D4).
      const runDeps: LoopEngineDeps = this.traceOut
        ? {
            ...deps,
            trace: createJsonlTraceService({
              filePath: this.traceOut,
              conversationId,
            }),
          }
        : deps;
      const { result } = await run(query, runDeps, opts?.signal, {
        priorMessages: session.messages,
      });
      // trace is destructured away → immediate GC (not logged/persisted/wired).
      await this.conditionalSave(conversationId, session, result);
      return {
        session: this.summarize(
          await this.store.load(conversationId),
          this.defaults.mode
        ),
        turn: this.toTurnDto(query, result),
      };
    });
  }

  async resetSession(
    conversationId: string,
    _opts?: { new_id?: boolean }
  ): Promise<ResetSessionResponse> {
    return this.serialize(conversationId, async () => {
      const session = await this.store.load(conversationId);
      const reset: SessionFileV1 = {
        ...session,
        messages: [],
        turnCount: 0,
        updatedAt: new Date().toISOString(),
      };
      await this.store.save(conversationId, reset);
      return { session: this.summarize(reset, this.defaults.mode), turns: [] };
    });
  }

  async listSessions(): Promise<SessionListEntry[]> {
    return this.store.list();
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
  private serialize<T>(
    conversationId: string,
    work: () => Promise<T>
  ): Promise<T> {
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
  private async conditionalSave(
    conversationId: string,
    session: SessionFileV1,
    result: RunResult
  ): Promise<void> {
    if (DROP_REASONS.has(result.stopReason)) return;
    const updated: SessionFileV1 = {
      ...session,
      messages: result.messages,
      turnCount: session.turnCount + result.turnCount,
      updatedAt: new Date().toISOString(),
    };
    await this.store.save(conversationId, updated);
  }

  /** Lazy deps construction (mirrors buildHarnessEngine, no agent-loop import). */
  private async ensureDeps(): Promise<LoopEngineDeps> {
    if (this.cachedDeps) return this.cachedDeps;
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
    });
    const registry = createRegistry([createEchoTool(), createGetTimeTool()]);
    const executor = createExecutor(registry);
    this.cachedDeps = {
      adapter,
      executor,
      registry,
      maxTurns: 6,
      timeoutMs: env.llm.timeoutMs,
    };
    return this.cachedDeps;
  }

  private summarize(file: SessionFileV1, mode: AgentMode): SessionSummary {
    return {
      conversation_id: file.conversation_id,
      mode,
      json_mode: file.jsonMode,
      turn_count: file.turnCount,
      prior_count: 0,
      embeddings: this.defaults.embeddings,
    };
  }

  private toTurnDto(query: string, result: RunResult): TurnDto {
    return {
      query,
      answer: {
        finalText: result.finalText ?? "",
        stopReason: result.stopReason,
        turnCount: result.turnCount,
      },
    };
  }
}
