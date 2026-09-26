/**
 * Session HTTP API DTOs (host surface; not tool schema).
 *
 * TurnDto.answer is the harness RunResult projection (TurnAnswerDto);
 * ApiErrorBody is nested under { error: { kind, message, ... } }.
 */
import type {
  StopReason,
  SupplierStopDetail,
  TokenUsage,
} from "../harness/index.js";
import type { FsIsolationMode } from "../harness/sandbox/fs-mode.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
import type { CompactReason } from "../harness/compress/index.js";
import type { CodeRestoreSkip } from "./store/code-preimage.js";
import type { SessionStoreErrorKind } from "./store/errors.js";

/** Max user message length (code units). */
export const MAX_MESSAGE_CHARS = 8000;

/** Session API message-return shell: projection of harness RunResult;
 *  messages/trace are never exposed on the wire. */
export interface TurnAnswerDto {
  readonly finalText: string; // maps RunResult.finalText
  /** Reuses the harness StopReason union (incl. fused). Present on every live
   *  turn answer and on a reopened turn whose terminal outcome record exists;
   *  absent when a reopened turn has no terminal record — that state is
   *  carried by `outcome: { terminal: "unknown" }` (ADR-0126), so history
   *  never claims a completion it cannot prove. */
  readonly stopReason?: StopReason;
  /** ADR-0126: durable terminal-outcome projection of this turn. `known`
   *  mirrors the persisted outcome record's StopReason; `unknown` = no record
   *  (legacy history, or a crash before the terminal event). Clients must
   *  render incompleteness notices from this field, never from the presence of
   *  assistant text. Absent = the projection had no outcome evidence to
   *  consult (live turn before persist; pre-ADR-0126 producers). */
  readonly outcome?: TurnOutcomeView;
  readonly turnCount: number; // maps RunResult.turnCount (starts at 0 per run())
  /** All non-empty assistant thinking texts within the turn, in block order.
   *  Empty thinking skipped; whole field omitted when there is none. */
  readonly thinking?: ThinkingView;
  /** All tool_use in the turn, paired with tool_result by tool_use_id.
   *  Whole field omitted when there is no tool_use. */
  readonly toolCalls?: readonly ToolCallView[];
  /** Ordered assistant content used by clients that need text/tool placement. */
  readonly activity?: readonly ActivityItem[];
  /** Context-usage display: token usage of the turn's last successful model
   *  call. Maps RunResult.lastUsage (ADR-0008); null → field absent
   *  (byte-stable, same pattern as thinking/toolCalls). contextWindow ships
   *  via HealthResponse. */
  readonly lastUsage?: TokenUsage;
  /**
   * Best-effort wrap-up summary after an abnormal stop (maxTurns, etc.) —
   * ADR-0011. Filled only when the hub catches MaxTurnsExceeded; no summary /
   * normal stop → field absent (byte-stable, same pattern as
   * thinking/toolCalls/lastUsage).
   */
  readonly stopSummary?: string;
  /**
   * Ctrl+C interrupt feedback — present only when stopReason === "cancelled":
   * true = checkpoint saved (cancelled + delta>0); false = nothing new to
   * persist (cancelled + delta=0). Other stopReasons → field absent
   * (byte-stable).
   */
  readonly interrupted?: boolean;
  /**
   * Automatic failure-repair loop: present when verify is configured and the
   * final verdict is true failure / unstable / still failing after
   * escalation / passed. disabled / aborted → field absent (byte-stable,
   * same pattern as stopSummary / interrupted).
   */
  readonly verify?: VerifyAnswerView;
  /**
   * Wire surface for the turn's total assistant thinking time (ms). The hub
   * (projectMessagesToTurns / toTurnDto) sums the persisted per-message
   * thinkingMs (index → parallel array) across this turn's slice; attached
   * when sum > 0 (byte-stable, same pattern as
   * thinking/toolCalls/lastUsage). Old sessions without thinkingMs /
   * non-assistant turns / sum = 0 → field absent.
   * UI: the web AgentCard thinking block renders the "thought for N seconds"
   * label from this.
   */
  readonly thinkingMs?: number;
  /**
   * ADR-0094 (viewport API error): gateway-side summary of a transport
   * failure (HTTP status + message text). The hub passes it through when
   * `result.apiError` exists (TransportRetryExhaustedError catch path);
   * non-transport failure / no cause → field absent (byte-stable, same
   * pattern as thinking/toolCalls/lastUsage/thinkingMs).
   *
   * UI: chat-flow viewport surfaces (TUI notice / web AgentCard error state)
   * render "API error (status): message", or "API error: message" when
   * status is absent.
   */
  readonly apiError?: {
    readonly status?: number;
    readonly message: string;
  };
}

/** ADR-0126: turn-outcome projection. `known` carries the persisted terminal
 *  StopReason; `unknown` is the absence of terminal evidence (legacy history /
 *  crash before the terminal event) and is deliberately NOT a StopReason
 *  member — `unknown` must never be confused with a stop decision. */
export type TurnOutcomeView =
  | {
      readonly terminal: "known";
      readonly stopReason: StopReason;
      /** ADR-0126: supplier-stop detail behind `nonSuccessStop`; absent when the
       *  record carries none (including every outcome written before it). */
      readonly supplierDetail?: SupplierStopDetail;
    }
  | { readonly terminal: "unknown" };

/** Wire view of the verification loop's final verdict (rounds + outcome)
 *  for UI surfaces. "passed" is a success state; abort / disabled never
 *  enter the wire. */
export interface VerifyAnswerView {
  readonly outcome: "failed" | "unstable" | "escalated" | "passed";
  readonly rounds: number;
}

/** Single thinking text view (redacted_thinking is counted only; its data
 *  never goes on the wire). */
export interface ThinkingEntryView {
  readonly text: string;
}

export interface ThinkingView {
  readonly entries: readonly ThinkingEntryView[]; // block order; empty thinking texts skipped
  readonly redactedCount: number; // count of redacted_thinking blocks
}

/** Tool-call view (input/output are previews with truncation; raw input is never exposed). */
export interface ToolCallView {
  readonly id: string; // tool_use.id
  readonly name: string;
  readonly inputPreview: string; // JSON.stringify(input), truncated at MAX_TOOL_INPUT_PREVIEW_CHARS
  readonly outputPreview: string; // concatenated tool_result text, truncated at MAX_TOOL_OUTPUT_PREVIEW_CHARS
  readonly isError: boolean; // tool_result.is_error === true
  readonly truncated: boolean; // whether the output was truncated
}

/** Ordered assistant content used by clients that need text/tool placement. */
export type ActivityItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly tool: ToolCallView };

/** Wire shape of a single message round-trip. */
export interface TurnDto {
  readonly query: string; // user input text
  readonly answer: TurnAnswerDto; // harness projection, no messages/trace
  readonly human_text?: string; // host projection (filled when jsonMode=false)
}

/** caller_role was retired on the harness path and removed from this DTO. */
export interface SessionSummary {
  readonly conversation_id: string;
  readonly json_mode: boolean;
  readonly turn_count: number;
  readonly prior_count: number;
}

export interface CreateSessionRequest {
  // caller_role retired on the harness path; no longer accepted on the wire
  json_mode?: boolean;
}

export type CreateSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

export type GetSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

/** Per-request thinking effort value range (SSOT). */
export const THINKING_EFFORT_VALUES = [
  "",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingEffortWire = (typeof THINKING_EFFORT_VALUES)[number];

/** Per-request thinking override (mode + optional effort). */
export interface WireThinkingOverride {
  readonly mode: "off" | "adaptive";
  readonly effort?: ThinkingEffortWire;
}

export type PostMessageRequest = {
  text: string;
  /** Per-turn override of the harness thinking control arm. Default → reuse
   *  the cached ensureDeps configuration (behavior unchanged). */
  readonly thinking?: WireThinkingOverride;
};

export type PostMessageResponse = {
  session: SessionSummary;
  turn: TurnDto;
};

export type ResetSessionRequest = {
  new_id?: boolean;
};

export type ResetSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
};

/**
 * Manual compaction response (wire shape shared by the web button and TUI
 * /compact). The session keeps the same conversation_id; turns are the
 * post-compaction message projection.
 * `compacted`: true = messages were actually trimmed; false = nothing to
 * compact (empty-session idempotency or overall compaction failure; manual
 * paths no longer have a token-gate no-op).
 * `cancelled`: true only when opts.signal aborted mid-compaction and it did
 * not finish; the session stays untouched (messages/turnCount/updatedAt all
 * kept), distinct from `compacted=false`'s "below threshold" semantics (the
 * web/TUI render them differently).
 * `reason`: trigger-verdict classification; SSOT is `evaluateCompactTrigger`
 * in `src/harness/compress/index.ts`. Clients pick copy from it
 * (`below_token_threshold` / `messages_too_few` / `windowed` /
 * `full_summary`).
 */
export type CompactSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
  compacted: boolean;
  /** signal abort → true, session untouched; absent at other times = false. */
  cancelled?: boolean;
  /** Trigger-verdict classification (1 of 4); consumers branch copy on it. */
  readonly reason: CompactReason;
  /** Message count before compaction (basis of the DEFAULT_KEEP_RECENT tail-window decision). */
  beforeCount: number;
  /** Message count after compaction (=== beforeCount on no-op). */
  afterCount: number;
};

/**
 * Caller opts for manual compaction — hub.compactSession and
 * TuiBridge.compactSession share this shape; exported from this file to
 * avoid drift between independent declarations.
 */
export type CompactCallerOpts = {
  readonly signal?: AbortSignal;
  readonly onStream?: (event: HarnessStreamEvent) => void;
};

/** POST /api/v1/sessions/:id/rewind — mirrors TUI rewindSession (head-based).
 *  `codeRestore` is present only when the request asked to restore workspace
 *  code; it reports what the rewind wrote back and what it refused to touch. */
export type RewindSessionResponse = {
  session: SessionSummary;
  turns: TurnDto[];
  head: string | null;
  codeRestore?: RewindCodeRestoreResult;
};

/** Workspace paths the rewind restored / skipped, carried on a rewind that
 *  requested `restoreCode`. `cross_transcript` = the path was written by more
 *  than one transcript in the abandoned segment, so no order exists to replay
 *  (ADR-0121); `drift` / `root_identity` = the live-file guards refused it. */
export type RewindCodeRestoreSkip = {
  readonly relPath: string;
  readonly reason: "drift" | "root_identity" | "cross_transcript";
};

/** Compile-time alignment assertion (no runtime effect): the wire DTO above
 *  and the store's `CodeRestoreSkip` (store/code-preimage.ts, the authority)
 *  keep parallel literals for the skip reason — this is the only coupling
 *  that stops either side drifting: renaming or adding a reason on one side
 *  breaks typecheck (missing key or excess property) before hub/http can
 *  serve a receipt the picker has no label for. `void` keeps the const used
 *  (same pattern as `compress/constant.ts`). */
const _rewindSkipReasonAlignment = {
  drift: "drift",
  root_identity: "root_identity",
  cross_transcript: "cross_transcript",
} as const satisfies Record<
  RewindCodeRestoreSkip["reason"],
  CodeRestoreSkip["reason"]
> &
  Record<CodeRestoreSkip["reason"], RewindCodeRestoreSkip["reason"]>;
void _rewindSkipReasonAlignment;

export type RewindCodeRestoreResult = {
  readonly restored: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<RewindCodeRestoreSkip>;
};

/** GET /api/v1/sessions/:id/rewind-targets — user-message anchors on the
 *  current head chain. `head` = that message's parent (rewind to just before
 *  it was sent). `fillInput` is always true for listed rows; skipped-branch
 *  messages do not enter the default picker. */
export type RewindTargetDto = {
  readonly head: string | null;
  readonly userMessageText: string;
  readonly fullText: string;
  readonly anchoredAt: string;
  readonly fillInput: boolean;
  readonly anchorTurnIndex: number;
};

export type RewindTargetsResponse = {
  readonly targets: ReadonlyArray<RewindTargetDto>;
};

/**
 * GET /api/v1/skills — projection of TUI `skillCatalog.loadable()` (the
 * loadable-skills surface). `description` may be absent: a human-side skill
 * can lack one, and coercing it to `""` would conflate "no description" with
 * "empty description", leaving the host unable to render the former as a
 * distinct "no description" form.
 */
export type SkillSummaryDto = {
  readonly name: string;
  readonly description?: string;
};

export type SkillsResponse = {
  readonly skills: readonly SkillSummaryDto[];
};

export type SkillBodyResponse = {
  readonly name: string;
  readonly body: string;
};

/** GET /api/v1/mcp — projection of TUI mcp.status(). */
export type McpServerStatusDto = {
  readonly name: string;
  readonly state: string;
  readonly source: string;
  readonly error?: string;
};

export type McpStatusResponse = {
  readonly servers: readonly McpServerStatusDto[];
};

export type McpToolDto = {
  readonly server: string;
  readonly name: string;
  readonly description: string;
};

export type McpToolsResponse = {
  readonly tools: readonly McpToolDto[];
};

export type HealthResponse = {
  ok: true;
  service: "iknow-session-api";
  version: string;
  /** Strategy context-window size in tokens. Source:
   *  env.compress.contextWindow (IKNOW_MODEL_CONTEXT_WINDOW), default 256000
   *  (ADR-0100). Denominator for the context-usage percentage, the same
   *  number the auto-compact gate uses. */
  contextWindow: number;
  /** Model routing ID (settings.llm.model). Unconfigured → field absent
   *  (byte-stable, same pattern as lastUsage). Shown in the web status bar
   *  under the input box. */
  model?: string;
  /** Trace write-failure count; the HTTP layer reads the live counter from
   *  the write-side instance. */
  traceWriteFailures: number;
};

/** GET/POST /api/v1/permission-mode response (web Shift+Tab mode cycling). */
export type PermissionModeResponse = {
  mode: "default" | "plan" | "full_auto";
};

/**
 * ADR-0030: GET/POST /api/v1/graph-mode response — the serve-side counterpart
 * of `/graph`. `message` is the single status line shared by all three entry
 * points (chat prints to stdout, TUI shows a notice, web renders it directly).
 */
export type GraphModeResponse = {
  enabled: boolean;
  message: string;
};

/** POST /api/v1/graph-mode body: tokenized `/graph` args. Default = query. */
export interface GraphModeRequest {
  readonly args?: ReadonlyArray<string>;
}

/**
 * ADR-0092: GET/POST /api/v1/fs-mode response — the serve-side counterpart
 * of `/config`. `message` is the single status line shared by all three
 * entry points (chat prints to stdout, TUI shows a notice, web renders it
 * directly).
 *
 * `mode` reuses `FsIsolationMode` from `harness/sandbox/fs-mode.ts` (SSOT) —
 * no literal copy here, so widening the closed set cannot drift between two
 * places.
 */
export type FsModeResponse = {
  mode: FsIsolationMode;
  message: string;
};

/** POST /api/v1/fs-mode body: tokenized `/config` args. Default = query. */
export interface FsModeRequest {
  readonly args?: ReadonlyArray<string>;
}

/**
 * Wire error response, nested form: `error.kind` is SessionStoreErrorKind or
 * `validation` / `internal`; the old flat form
 * (`{ error: string; message; details? }`) is retired.
 */
export interface ApiErrorBody {
  readonly error: {
    readonly kind: SessionStoreErrorKind | "validation" | "internal";
    readonly message: string;
    readonly conversation_id?: string;
    readonly field?: string;
  };
}

/** GET /api/v1/workspace response. */
export type WorkspaceResponse = {
  readonly bound: boolean;
  readonly root?: string;
};

/** PUT /api/v1/workspace request body. */
export interface PutWorkspaceRequest {
  readonly path: string;
  readonly confirmTrust?: boolean;
}

/** PUT /api/v1/workspace response body. */
export type PutWorkspaceResponse = WorkspaceResponse;

/** GET /api/v1/workspaces response (recents / trusted). */
export type WorkspacesResponse = {
  readonly workspaces: readonly { readonly root: string }[];
};

/** Reserved routes (UI may probe; server may return 501). */
export const RESERVED_PATHS = {
  eventsSse: "/api/v1/sessions/:id/events",
} as const;
