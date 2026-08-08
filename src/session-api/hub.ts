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
import {
  run,
  createJsonlTraceService,
  type AnthropicContentBlock,
  type AnthropicNativeMessage,
  type HarnessStreamEvent,
  type LoopEngineDeps,
  type RunResult,
} from "../harness/index.js";
import { buildHarnessEngine } from "../harness/build-engine.js";
import type { AskUser } from "../harness/permission/types.js";
import type {
  ServeAskUserHandle,
  PendingAskView,
} from "../harness/permission/ask-user.js";
import type { SessionGrants } from "../harness/permission/session-grants.js";
import type { PermissionModeContext } from "../harness/permission/modes.js";
import { createViolationCounter } from "../harness/sandbox/violation-handling.js";
import { wrapWithViolationHook } from "../harness/sandbox/violation-executor.js";
import {
  createOutputMask,
  currentSecretValues,
} from "../harness/sandbox/index.js";
import { loadIknowEnv, type LlmEnv } from "../config/env.js";
import { ValidationError } from "../shared/errors.js";
import { MaxTurnsExceeded } from "../harness/errors.js";
import { writeIknowState } from "../harness/identity/index.js";
import type { IknowIdentityError } from "../harness/identity/index.js";
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
/** #196: writeIknowState throw 是 typed union（kind/path + kind 分派字段，
 *  workspace.ts:37-42）——state_parse_failed 用 reason / state_schema_invalid
 *  用 field / write_failed 与 io_error 用 cause。按 kind 分派取详情字段，
 *  避免错误文案落到 String(err) = "[object Object]"。 */
function isIknowIdentityError(err: unknown): err is IknowIdentityError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { kind?: unknown; path?: unknown };
  return typeof e.kind === "string" && typeof e.path === "string";
}

/** 展开 IknowIdentityError 到可读详情（按 kind 分派不同详情字段）。 */
function iknowIdentityDetail(err: IknowIdentityError): string {
  switch (err.kind) {
    case "state_parse_failed":
      return `${err.kind}@${err.path}: ${err.reason}`;
    case "state_schema_invalid":
      return `${err.kind}@${err.path}: field ${err.field}`;
    case "write_failed":
    case "io_error":
      return `${err.kind}@${err.path}: ${err.cause}`;
  }
}

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
  /** Full serve AskUser handle (ask + resolveAsk + pendingAll). When provided,
   * the web SPA can list + resolve pending permission requests. */
  askHandle?: ServeAskUserHandle;
  /** Session allow-list source. "always-allow" decisions from the web UI land
   * here so subsequent identical tool calls are not re-confirmed. Memory-only. */
  sessionGrants?: SessionGrants;
  /** W2: permission mode context (default / plan / full_auto). Absent →
   *  buildHarnessEngine defaults to "default". */
  permissionMode?: PermissionModeContext;
  /** T2: env source for per-turn thinking override (test seam; production
   * omits it → withThinkingOverride falls back to loadIknowEnv()). */
  overrideEnv?: { readonly llm: LlmEnv };
  /**
   * Sandbox root for fs-tool access (code-review 2026-08-05). When omitted,
   * `buildHarnessEngine` defaults to `process.cwd()` — see that module's
   * sandboxRoot note (CLI: project root; serve: server-launch dir, which
   * is NOT equivalent to user project root). Production callers should pass
   * an explicit sandboxRoot when the server's cwd is not the intended
   * workspace; CLI flag wiring is tracked in the backlog.
   */
  sandboxRoot?: string;
  /**
   * #196 IKNOW T5:入口 surface — 决定 BOOTSTRAP 是否激活。serve 路径固定传
   * "serve"（skip BOOTSTRAP，spec A12 矩阵）；测试可省略 → 默认 "chat"。
   */
  surface?: "chat" | "tui" | "ask" | "serve";
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
  /** Full serve AskUser handle (when provided, SPA can list + resolve asks). */
  private readonly askHandle: ServeAskUserHandle | undefined;
  /** Session allow-list source ("always-allow" from web UI lands here). */
  private readonly sessionGrants: SessionGrants | undefined;
  private readonly permissionMode: PermissionModeContext | undefined;
  /** T2: env source for the per-turn thinking override (test seam). */
  private readonly overrideEnv: { readonly llm: LlmEnv } | undefined;
  /** Sandbox root for fs-tool access (code-review 2026-08-05). Undefined
   *  → `buildHarnessEngine` defaults to `process.cwd()`. Production callers
   *  in serve mode should pass an explicit root (CLI flag wiring tracked). */
  private readonly sandboxRoot: string | undefined;
  /** #196 IKNOW T5: 入口 surface；默认 "chat"（tests 兼容）。serve 路径
   *  由 serve.ts 显式传 "serve"。 */
  private readonly surface: "chat" | "tui" | "ask" | "serve" | undefined;
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
    this.askHandle = opts.askHandle;
    this.sessionGrants = opts.sessionGrants;
    this.permissionMode = opts.permissionMode;
    this.overrideEnv = opts.overrideEnv;
    this.sandboxRoot = opts.sandboxRoot;
    this.surface = opts.surface;
    this.defaults = {
      jsonMode: opts.defaultJsonMode ?? false,
    };
  }

  // -- public API --------------------------------------------------------------

  /**
   * Snapshot of pending ask requests (process-global; v0 serve hosts one
   * turn at a time). Returns an empty list when the full handle was not
   * wired (no SPA capability).
   */
  listPendingAsks(): ReadonlyArray<PendingAskView> {
    return this.askHandle?.pendingAll() ?? [];
  }

  /**
   * Resolve a pending ask with one of three decisions.
   *
   *   - `allow-once`    → release the waiter as approved, no persist.
   *   - `deny`          → release the waiter as denied (matches fail-closed).
   *   - `always-allow`  → release the waiter as approved, AND add a
   *                        per-tool allow rule to the session grants so the
   *                        next identical tool call is auto-approved.
   *
   * Ordering: for `always-allow` the rule is added AFTER settle() succeeds;
   * if the ask already timed out, settle returns false and no rule is added
   * (defensive contract — no orphan rules from a UI click that lost the race).
   *
   * Returns true iff the ask was still pending at resolve time.
   */
  resolveAsk(
    id: string,
    decision: "allow-once" | "always-allow" | "deny"
  ): boolean {
    if (!this.askHandle) return false;
    // Capture the tool name BEFORE settle: settle() empties the pending Map,
    // so pendingAll() after it would find nothing.
    const tool =
      decision === "always-allow"
        ? this.askHandle.pendingAll().find((p) => p.id === id)?.tool
        : undefined;
    if (decision === "deny") return this.askHandle.resolveAsk(id, false);
    const approved = this.askHandle.resolveAsk(id, true);
    if (decision === "always-allow" && approved && tool && this.sessionGrants) {
      this.sessionGrants.add({
        id: `session-allow-${tool}`,
        match: ({ tool: t }) => t === tool,
        decision: "allow",
        reason: `always-allow from session: ${tool}`,
      });
    }
    return approved;
  }

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
    readonly onStream?: (event: HarnessStreamEvent) => void;
  }): Promise<PostMessageResponse> {
    const { conversationId, text } = opts;
    this.validateText(text);
    const query = text.trim();
    // #196 /profile done 首启完成钩子（web 端）：用户在浏览器外填好
    // ~/.iknow/user.md 后输入 /profile done，翻 bootstrap_seeded=true。
    // 与 CLI / TUI 的 slash 命令同语义。走 serialize 队列保持 per-conversation
    // 序列化契约（A15）；writeIknowState 失败 → 错误文案。不触发模型调用。
    const profileDone = query.toLowerCase() === "/profile done";
    return this.serialize({
      conversationId,
      work: async () => {
        const session = await this.store.load(conversationId);
        if (profileDone) {
          return this.handleProfileDone(session, query);
        }
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
        // plan T6 / ADR-0011:异常停前 loop-engine 通过 onStream emit
        // stop_summary。包一层 wrapper 捕获 stop_summary 文本(无条件 — 即使
        // 宿主没传 onStream,DTO 也要带 stopSummary;byte-stable 有则进、无则缺)
        // 并**原样转发**给宿主 onStream(TUI 用它做 notice 呈现,见 app.tsx)。
        let capturedStopSummary: string | undefined;
        const wrappedOnStream = (event: HarnessStreamEvent): void => {
          if (event.type === "stop_summary") {
            capturedStopSummary = event.text;
          }
          opts.onStream?.(event);
        };
        let finalResult: RunResult;
        try {
          const { result } = await run(query, runDeps, opts.signal, {
            priorMessages: session.messages,
            onStream: wrappedOnStream,
          });
          // Violation kill → surface protocolError so the SPA client can
          // attribute the stop; DROP_REASONS already drops protocolError
          // context on save (mirrors the chat-session drop semantics).
          finalResult = killed
            ? { ...result, stopReason: "protocolError" }
            : result;
        } catch (err) {
          if (err instanceof MaxTurnsExceeded) {
            // ADR-0011:不 save — run 前 session 已在盘上,throw 路径不产出
            // 可落盘的新 messages,故不调 conditionalSave(否则会写空 messages
            // 把已被 disk-SSOT 守门的不变式擦掉)。turnCount 透传 err.turnsRan
            // (已跑轮数);finalText 用空串(没有 completed 文本)。摘要若有则
            // 附 TurnAnswerDto.stopSummary(additive, byte-stable)。
            return {
              session: this.summarize({ file: session }),
              turn: {
                query,
                answer: {
                  finalText: "",
                  stopReason: "maxTurns",
                  turnCount: err.turnsRan,
                  ...(capturedStopSummary !== undefined && capturedStopSummary.length > 0
                    ? { stopSummary: capturedStopSummary }
                    : {}),
                },
              },
            };
          }
          throw err;
        }
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
            ...(capturedStopSummary !== undefined && capturedStopSummary.length > 0
              ? { stopSummary: capturedStopSummary }
              : {}),
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

  /**
   * Lazy deps construction. Delegates to the shared harness assembly
   * (`src/harness/build-engine.ts`) so the serve path picks up the same ACI
   * 8-tool set as the CLI (bash / read_file / grep / glob / edit_file /
   * write_file / web_fetch / web_search). Without this delegation the
   * serve mode was stuck on the echo/get_time stubs and the web SPA could
   * not exercise the new tools.
   */
  private async ensureDeps(): Promise<LoopEngineDeps> {
    if (this.cachedDeps) return this.cachedDeps;
    if (!this.askUser) {
      throw new Error(
        "ask_inlet_missing: SessionHub lazy deps require AskUser (#162)"
      );
    }
    const env = loadIknowEnv();
    // Delegate validation and assembly to the SSOT. `buildHarnessEngine`
    // validates apiKey/askUser through the shared fail-loud path, preserving
    // the same ValidationError → HTTP 400 mapping for serve callers.
    // The returned `engine` is built once (code-review 2026-08-05) and
    // discarded — serve only consumes `deps`, and the cost is a single
    // `createLoopEngine` allocation, not a per-message re-construction.
    const { deps } = await buildHarnessEngine({
      env,
      askUser: this.askUser,
      ...(this.sandboxRoot ? { sandboxRoot: this.sandboxRoot } : {}),
      ...(this.surface ? { surface: this.surface } : {}),
      ...(this.sessionGrants ? { session: this.sessionGrants } : {}),
      ...(this.permissionMode ? { permissionMode: this.permissionMode } : {}),
    });
    this.cachedDeps = deps;
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

  /** #196 /profile done 首启完成钩子：翻 bootstrap_seeded，不触发模型调用。
   *  writeIknowState 失败 → 把 typed union 的 kind/path/cause 格式化后
   *  转 ValidationError（对齐 CLI formatChatError 语义，避免 [object Object]）。 */
  private async handleProfileDone(
    session: SessionFileV1,
    query: string
  ): Promise<PostMessageResponse> {
    try {
      await writeIknowState({ bootstrap_seeded: true });
    } catch (err) {
      const detail = isIknowIdentityError(err)
        ? iknowIdentityDetail(err)
        : err instanceof Error
          ? err.message
          : String(err);
      throw new ValidationError(`无法标记首启完成：${detail}`);
    }
    return {
      session: this.summarize({ file: session }),
      turn: {
        query,
        answer: {
          finalText:
            "已标记首启引导完成。下次对话起，agent 将直接使用你填写的 ~/.iknow/user.md 画像。",
          stopReason: "completed",
          turnCount: 0,
        },
      },
    };
  }

  private toTurnDto(opts: {
    readonly query: string;
    readonly result: RunResult;
    /** T1: this run's own messages (priorMessages sliced away); used for
     * the per-turn thinking/toolCalls projection. */
    readonly turnMessages?: ReadonlyArray<AnthropicNativeMessage>;
    /** T6: best-effort 收尾摘要文本(异常停时由 postMessage 捕获)。 */
    readonly stopSummary?: string;
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
        // 上下文用量显示：result.lastUsage 非 null 时透传；null → 字段缺席
        // (byte-stable；与 thinking/toolCalls 同模式；ADR-0008 D5)。
        ...(result.lastUsage !== null ? { lastUsage: result.lastUsage } : {}),
        // T6: 收尾摘要仅在异常停时挂上;completed 永不 emit stop_summary,
        // 即使宿主传了 stopSummary 也不会误附(byte-stable,正常停缺席)。
        ...(opts.stopSummary !== undefined &&
        opts.stopSummary.length > 0 &&
        result.stopReason !== "completed"
          ? { stopSummary: opts.stopSummary }
          : {}),
      },
    };
  }
}
