/**
 * Trace Service bounded context — interface contract.
 *
 * conversationId is deliberately not a record parameter: the loop engine has
 * no conversation concept, and per-record passing would force an extra field
 * onto LoopEngineDeps. Instead the instance binds it — JsonlTraceService
 * takes conversationId at construction and stamps every JSONL record with it
 * (conversation_id is always present in JSONL, ADR-0003).
 *
 * Field-set decisions (Postel's Law):
 *   - TraceErrorType reuses StopReason + ToolExecutionResult.kind + an
 *     "unknown" fallback; no api_error/rate_limit/... — where an ADR text and
 *     the repo's actual unions disagree, the repo values are SSOT;
 *   - supplierStop / toolKind domains mirror the LoopTrace TurnTrace unions;
 *   - decision = StopReason minus maxTurns: the early-stop branch returns
 *     before any recordTurn call, so the value could never be written — dead
 *     union member, removed.
 *
 * No imports from model-adapter / tools: literal unions are redefined with
 * JSDoc pointers to the source files, keeping this bounded context decoupled
 * (same precedent as loop-trace.ts).
 */

export type TraceStatus = "ok" | "error";

export type TraceErrorType =
  | "cancelled"
  | "timeout"
  | "protocolError"
  | "emptyFinalResponse"
  | "validation_failed"
  | "tool_not_found"
  | "execution_failed"
  | "unknown";

export interface TraceError {
  type: TraceErrorType;
  message: string;
}

export interface LlmCallRecord {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  supplierStop?: "success" | "truncation" | "refusal" | "other";
  stream: boolean;
  /**
   * ADR-0014: loop-engine fills `messages` at the model-stage success /
   * error / summary call sites — the semantics are "the messages the model
   * actually saw this step" (effectiveState.messages, post reactive
   * compression; for the summary round, the truncated history + closing
   * prompt).
   *
   * No size cap on the write side: trimming would break the "what the model
   * saw" invariant (the full system text matters). If capacity ever needs
   * control, the trace consumer trims; loop-engine keeps fill-as-seen.
   * messagesCaptured is the independent boolean switch (ADR-0003
   * Postel); the trace service never mutates content.
   */
  messagesCaptured: boolean;
  messages?: ReadonlyArray<unknown>;
  /**
   * ADR-0116: the full `deps.system()` text this step actually sent — the
   * identity prefix the model saw. Separate channel from `messages` (which
   * stays the accumulated conversation, ADR-0036): the read side never finds
   * the identity prefix masquerading as a `role=system` entry in `messages`.
   * The implementation stores the body in the same content-addressed blob
   * pool as messages (write-if-missing) and emits the `{sha, bytes}`
   * reference on the JSONL row. Postel: when this step did not resolve / send
   * a system prompt the key is wholly absent — never an empty string.
   */
  system?: string;
  /**
   * ADR-0116: names of the tools handed to the model this step — the name
   * list only, never JSON schemas. The list is a step-start snapshot:
   * promptTools is static within a step in current assembly (same stability
   * assumption as `system`). Postel: absent when the step sent no
   * tools (loop-engine omits an empty list rather than writing `[]`).
   */
  toolNames?: ReadonlyArray<string>;
  status: TraceStatus;
  error?: TraceError;
  /**
   * ADR-0008: top-level flat token quartet. Shape mirrors the SDK `Usage`
   * and model-adapter `TokenUsage`, but this bounded context does not import
   * those types (header precedent) — loop-engine structurally assigns at
   * recordLlmCall.
   *
   * Postel semantics: the success branch fills all four (SDK guarantees);
   * the error branch writes no *_tokens keys at all — undefined drops out of
   * JSON.stringify, and absence means "no token accounting happened"
   * (never guess).
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  /**
   * Routed-model accounting: modelRequested — the model declared on the
   * request side; modelActual — the supplier model in the response (differs
   * via adapters); provider — supplier name. Postel: filled on success,
   * absent on error.
   */
  modelRequested?: string;
  modelActual?: string;
  provider?: string;
}

export interface ToolCallRecord {
  parentLlmCallId: string | undefined;
  toolName: string;
  toolKind: "ok" | "validation_failed" | "tool_not_found" | "execution_failed";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  argumentsCaptured: boolean;
  arguments?: unknown;
  resultCaptured: boolean;
  result?: unknown;
  status: TraceStatus;
  error?: TraceError;
}

export interface TurnRecord {
  /**
   * Optional caller-pregen turn id; absent → the implementation generates a
   * UUID. It exists for one reason: subagents spawned mid-turn must point
   * parentTurnId back at this turn, but recordTurn only fires at turn end —
   * so loop-engine generates the id at turn entry, gives one copy to the
   * tool ctx (traveling to spawn_subagent) and hands the other to recordTurn.
   */
  id?: string;
  turnIndex: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  llmCallIds: ReadonlyArray<string>;
  toolCallIds: ReadonlyArray<string>;
  decision:
    | "completed"
    | "nonSuccessStop"
    | "protocolError"
    | "emptyFinalResponse"
    | "cancelled"
    | "timeout";
  status: TraceStatus;
  error?: TraceError;
}

/**
 * Session-level L1 root record: one complete run; all turn/llm/tool records
 * attach to it via conversation_id.
 */
export interface SessionRecord {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /**
   * Injected by the writer/CLI side at construction — the harness layer does
   * not import cli/usage.ts (no reverse dependency on the write side),
   * per the file-header precedent (ADR-0003).
   */
  agentVersion: string;
  status: TraceStatus;
  error?: TraceError;
}

/**
 * Sandbox command-execution record. Schema is in place but the emitter stays
 * pendingRuntime (the sandbox currently records violations only, not
 * standalone command records) — no JSONL lines of this kind are produced yet.
 */
export interface SandboxCmdRecord {
  /** Single-valued parent (new records uniformly use one parent_*_id). */
  parentTurnId: string;
  command: string;
  exitCode: number;
  /** Postel: boolean switch; content persisted only when true. */
  stdoutCaptured: boolean;
  /** Length-capped (IKNOW_TRACE_MAX_CONTENT_BYTES). */
  stdout?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: TraceStatus;
  error?: TraceError;
}

/**
 * One classifier (subagent LLM judge) evidence item: what the judge ran and
 * what it produced. Semantics mirror the verify-domain ClassifierCheck; this
 * bounded context does not import verify types — shape redefined with a JSDoc
 * pointer, verify-loop structurally assigns. A check without a command counts
 * as skip, not pass.
 */
export interface VerificationCheck {
  readonly command: string;
  readonly output?: string;
  readonly result: "pass" | "fail";
}

/**
 * Verification verdict record (auto-fix loop observability).
 * Key difference from the other records: id/sessionId/ts are caller-provided;
 * it does not hang off the turn tree — its own id links the whole
 * verification trail. sessionId links the session root; round is the loop
 * iteration; verdict is the three-state call; action the policy step.
 * Postel: failedCount / signature / finalOutcome persisted only when present.
 */
export interface VerificationRecord {
  /** Own id; new records uniformly carry a single parent_*_id, while this one links via its own id. */
  readonly id: string;
  readonly sessionId: string;
  readonly round: number;
  readonly verdict: VerificationVerdict;
  readonly exitCode: number;
  /** Postel: persisted only when present. */
  readonly failedCount?: number;
  readonly signature?: string;
  readonly action: VerificationAction;
  readonly finalOutcome?: string;
  readonly ts: string;
  /** Classifier branch fields: semantics identical to the verify-domain record. */
  readonly reason?: string;
  readonly evidence?: ReadonlyArray<VerificationCheck>;
  readonly missing?: ReadonlyArray<string>;
  /**
   * Evidence-first upstream fields, mirroring the verify-domain
   * VerificationRecord.evidenceVerdict / .gamingSignals. No import of verify
   * types (header precedent) — same-valued literal unions keep the
   * decoupling; verify-loop structurally assigns in buildRecord.
   * Postel: optional, persisted only when present.
   */
  readonly evidenceVerdict?:
    "EVIDENCE_SUFFICIENT" | "EVIDENCE_CONTRADICTED" | "EVIDENCE_INSUFFICIENT";
  readonly gamingSignals?: ReadonlyArray<string>;
}

export type VerificationVerdict = "pass" | "true-failure" | "unstable";
export type VerificationAction = "continue" | "stop" | "escalate";

/**
 * Subagent lifecycle state machine — isomorphic with the manager-internal
 * TaskState. The trace domain stays decoupled (header note): no import of
 * manager.ts; the literal union is redefined to keep descriptions aligned.
 */
export type SubagentState = "starting" | "running" | "completed" | "failed";

/**
 * Subagent spawn trace record — lifecycle events persisted.
 *
 * Same shape as VerificationRecord: id is caller-provided (= the manager
 * taskId); the implementation never generates ids — success returns
 * record.id, failure undefined.
 *
 * Postel (ADR-0003): optional fields persist only when present
 * (JSON.stringify drops undefined). Optional model / taskPreview / maxTurns /
 * timeoutMs / error exist only when the caller has a real source.
 * `parentTurnId` comes from SubAgentDefinition.parentTurnId —
 * `spawn_subagent` copies it from `ctx.turnId`, the graph node-executor from
 * its dispatcher; dispatchers outside a turn (e.g. `/graph run`) leave it absent.
 *
 * Origin is reserved; v1 is always "parent" (the whole lifecycle state
 * machine lives in the parent manager; workers only write the stdout
 * envelope, and the schema can grow a "child" value unchanged).
 */
export interface SubagentSpawnRecord {
  readonly id: string;
  readonly taskId: string;
  readonly parentTurnId?: string;
  readonly origin: "parent" | "child";
  readonly startedAt: string;
  readonly status: TraceStatus;
  readonly ts: string;
  readonly taskPreview?: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly error?: TraceError;
}

/**
 * SubagentStopRecord — persisted once at terminal state (completed / failed).
 * durationMs = endedAt − startedAt; finalState ∈ {"completed","failed"};
 * reason aligns with the envelope reason union plus "cancelled" (waitFor
 * abort path); ADR-0111 added modelTransient to that union — mirrored here.
 */
export interface SubagentStopRecord {
  readonly id: string;
  readonly taskId: string;
  readonly parentTurnId?: string;
  readonly origin: "parent" | "child";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly finalState: "completed" | "failed";
  readonly status: TraceStatus;
  readonly ts: string;
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals | string;
  readonly reason?:
    | "crashed"
    | "maxTurnsExceeded"
    | "timeout"
    | "protocolError"
    | "modelTransient"
    | "cancelled";
  readonly summary?: string;
  readonly error?: TraceError;
  readonly stderrPath?: string;
  readonly stderrBytes?: number;
}

/**
 * SubagentStateChangeRecord — one line per task.state transition (including
 * starting→running, *→completed, *→failed). fromState / toState required;
 * reason only on failed.
 */
export interface SubagentStateChangeRecord {
  readonly id: string;
  readonly taskId: string;
  readonly parentTurnId?: string;
  readonly origin: "parent" | "child";
  readonly startedAt: string;
  readonly status: TraceStatus;
  readonly ts: string;
  readonly fromState: SubagentState;
  readonly toState: SubagentState;
  readonly reason?:
    | "crashed"
    | "maxTurnsExceeded"
    | "timeout"
    | "protocolError"
    | "modelTransient"
    | "cancelled";
  readonly error?: TraceError;
}

/**
 * The two observation points of a subagent step — dispatch (handing one step
 * to the subagent) and settle (that step reaching its final state).
 * Deliberately not named after SubagentState: the state machine says "what
 * state is the subagent instance in", the step says "what is parent-side step
 * N doing"; multi-step orchestration has no 1:1 mapping between them.
 */
export type SubagentStepPhase = "dispatch" | "settle";

/**
 * SubagentStepRecord — one subagent execution step.
 *
 * Same shape as spawn / stop / state_change (caller-provided id, Postel
 * optionals, @throws never); the one structural difference is that its id
 * carrier is `subagent_step_id`, not `subagent_id`: for the other three
 * `id === taskId` (one subagent instance), while step ids are per-step —
 * reusing `subagent_id` would make that column mean "step id" on step rows
 * and clash with "subagent id" elsewhere. Pairing still goes through
 * `taskId`, so `?taskId=` filters keep step and spawn/stop rows together.
 *
 * dispatch rows carry only startedAt; settle rows add endedAt / durationMs,
 * plus error on failure.
 */
export interface SubagentStepRecord {
  readonly id: string;
  readonly taskId: string;
  readonly parentTurnId?: string;
  readonly origin: "parent" | "child";
  /** 0-based, monotonically increasing per task on the parent side. */
  readonly stepIndex: number;
  readonly phase: SubagentStepPhase;
  /** Human-readable step name (e.g. an orchestration node id); absent without a source. */
  readonly label?: string;
  readonly startedAt: string;
  /** Postel: final time exists only on settle. */
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly status: TraceStatus;
  readonly ts: string;
  readonly error?: TraceError;
}

/**
 * Goal lifecycle trace action. Self-contained literal union — no import of
 * the session-api GoalAction (header precedent); redefined with a JSDoc
 * pointer to keep the trace domain decoupled.
 */
export type GoalAction = "seed" | "pin" | "clear" | "writeback";

/**
 * Goal lifecycle trace status. Deliberately excludes the removed
 * model-proposal slot (that channel never landed; dropping the literal
 * avoids a dead value). `cleared` is the terminal state of the /goal clear
 * command — distinct from the applyTransition state machine: clearing does
 * not go through transitions, it just leaves a trace. Self-contained union —
 * no session-api imports.
 */
export type GoalTraceStatus =
  "active" | "achieved" | "aborted" | "superseded" | "cleared";

/**
 * Goal lifecycle trace record.
 *
 * Same shape as VerificationRecord: id/sessionId/ts/conversationId are
 * caller-provided; no ID generation — success returns record.id, failure
 * undefined. sessionId links the session root; action distinguishes lifecycle
 * nodes (seed/pin/clear/writeback); status optional (clear and seed may omit
 * it); text vs textLen is either/or — the seed path carries only textLen to
 * keep logs lean. Postel: optionals persisted only when present.
 */
export interface GoalRecord {
  /** Own id (caller-provided; implementation generates nothing). */
  readonly id: string;
  readonly sessionId: string;
  readonly action: GoalAction;
  /** Postel: optional (clear/seed may omit). */
  readonly status?: GoalTraceStatus;
  /** Postel: optional (seed path carries only textLen). */
  readonly text?: string;
  /** Postel: optional (pin/writeback usually omit). */
  readonly textLen?: number;
  readonly ts: string;
  readonly conversationId: string;
}

export interface TraceService {
  /**
   * Record one LLM call; the implementation generates llmCallId.
   * @throws never — implementations must catch IO errors and return undefined.
   */
  recordLlmCall(record: LlmCallRecord): Promise<string | undefined>;
  /**
   * Record one tool call; parentLlmCallId is a mandatory slot
   * (undefined → orphan record).
   * @throws never.
   */
  recordToolCall(record: ToolCallRecord): Promise<string | undefined>;
  /** Record one turn; the implementation generates turnId. @throws never. */
  recordTurn(record: TurnRecord): Promise<string | undefined>;
  /** Record one session root; the implementation generates sessionId. @throws never. */
  recordSession(record: SessionRecord): Promise<string | undefined>;
  /** Record one sandbox command execution (schema ready, emitter pendingRuntime). @throws never. */
  recordSandboxCmd(record: SandboxCmdRecord): Promise<string | undefined>;
  /**
   * Record one verification verdict. Unlike the others, id/sessionId/ts come
   * from the caller; success returns record.id, failure undefined.
   * @throws never.
   */
  recordVerification(record: VerificationRecord): Promise<string | undefined>;
  /**
   * Record one goal lifecycle event. Caller-provided ids like
   * recordVerification. record.conversationId is redundant (the factory binds
   * one at construction); the implementation strips it from the snake-case
   * copy so the factory binding always wins.
   * @throws never.
   */
  recordGoal(record: GoalRecord): Promise<string | undefined>;
  /**
   * Record one subagent spawn — caller-provided id (= manager taskId).
   * @throws never — callers wrap in safeTrace; failure returns undefined.
   */
  recordSubagentSpawn(record: SubagentSpawnRecord): Promise<string | undefined>;
  /**
   * Record one subagent terminal state (completed / failed) — single-emit;
   * the parent manager's stoppedEmitted flag prevents duplicates.
   * @throws never.
   */
  recordSubagentStop(record: SubagentStopRecord): Promise<string | undefined>;
  /**
   * Record one subagent state transition — fromState/toState required;
   * reason only on failed.
   * @throws never.
   */
  recordSubagentStateChange(
    record: SubagentStateChangeRecord
  ): Promise<string | undefined>;
  /**
   * Record one subagent execution step — caller-provided id (unique per
   * step); dispatch / settle each emit a row.
   * @throws never.
   */
  recordSubagentStep(record: SubagentStepRecord): Promise<string | undefined>;
}
