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

/**
 * Typed cause of one tool call's failure, as the engine observed it.
 *
 * Why this is not derived from `error.message`: ADR-0005 makes the message the
 * model-facing surface, and the spec forbids recognizing a failure class by
 * matching an arbitrary message substring. `error.type` alone cannot carry it
 * either — ADR-0091's per-call timeout and ADR-0135's security-interruption
 * cancel are both `execution_failed`, so the two were indistinguishable on the
 * trace until this field existed.
 *
 * `cleanup_unconfirmed` is separate from `timeout` / `cancelled` on purpose: a
 * teardown that was requested but never proven is a fault of its own, and a
 * reader filtering on the cause must be able to find it without parsing the
 * cleanup body. It does not replace the underlying cause — a timed-out call
 * whose teardown was unconfirmed carries both, `cleanup` holding the evidence.
 *
 * Postel: absent means the engine recognized no cause, which is a fact a reader
 * needs (it is why absence must never be defaulted to `"unknown"`).
 */
export type ToolCallCause = "timeout" | "cancelled" | "cleanup_unconfirmed";

/**
 * Process-tree cleanup evidence as it appears on a trace row.
 *
 * Structurally identical to the sandbox bounded-context result
 * (`sandbox/cleanup-result.ts`), redefined here for the same reason every other
 * union in this file is: the trace bounded context imports no sibling domain
 * (file-header precedent), and loop-engine structurally assigns. The three
 * states stay distinct on the wire — a consumer that collapses them to a
 * boolean cannot tell a confirmed stop from a request that was never proven.
 */
export type CleanupTraceEvidence =
  | { readonly state: "not_started" }
  | {
      readonly state: "confirmed_stopped";
      readonly pgid: number;
      readonly task_id?: string;
    }
  | {
      readonly state: "unconfirmed";
      readonly reason: "observation_expired" | "teardown_failed";
      readonly pgid: number;
      readonly detail: string;
      readonly task_id?: string;
    };

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
  /** ADR-0091 / ADR-0134 / ADR-0135 typed cause; absent when none was observed. */
  cause?: ToolCallCause;
  /**
   * Bounded process-tree teardown evidence (ADR-0134). Present only when the
   * execution actually reported one — a spawn failure or a cancel whose
   * cleanup never ran omits it, which is *not* a successful stop.
   */
  cleanup?: CleanupTraceEvidence;
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
 * Security-interruption record (ADR-0135).
 *
 * Written through the shared service rather than by a caller's own
 * `appendFileSync`, so an interruption lands in the same file as the turn and
 * tool rows it interrupted, with the same write-failure accounting. A reviewer
 * rebuilding the interrupted turn reads three things off this row: the cause
 * (`tier` / `tool` / `message` / `confirmedViolations`), which turn it belongs
 * to (`turnId`, bound to the trace `turn` row rather than to file order), and
 * per-item evidence that each cancelled task was actually named and actually
 * stopped — or, where it was not, why not.
 *
 * `tier: "mid-escalation"` is the operator *notification* written at the moment
 * the threshold is reached; it carries no cleanup because none has been
 * collected yet. The structured report arrives separately with the real
 * `tier: "mid" | "high"`. Consumers select the report by the presence of
 * `cleanup` / `confirmedViolations`, never by tier alone.
 *
 * The tool-use id is carried when the executor's result had one, so a single
 * offending call can be named rather than inferred from ordering.
 */
export interface ViolationRecord {
  readonly ts: string;
  /**
   * The tier the producer named. Optional: a payload that named none, or
   * named one this build does not recognize, records the field ABSENT rather
   * than a default. An absent tier says "the producer named no tier", which is
   * a different statement from a row recording one — and a reader that fills
   * it in would be asserting a severity the payload does not carry.
   */
  readonly tier?: "low" | "mid" | "high" | "mid-escalation";
  readonly tool: string;
  readonly message: string;
  /** Engine turn id the violation was observed under, when the host had one. */
  readonly turnId?: string;
  /** The offending call's own id, when the executor's result carried one. */
  readonly toolUseId?: string;
  /** Consecutive confirmed violations that produced this record. */
  readonly confirmedViolations?: number;
  /**
   * Per-item bounded cleanup for the work this turn owned. Absent on the
   * escalation notification (nothing collected yet) and on a host that runs no
   * cleanup pass — absence never means "nothing needed stopping".
   */
  readonly cleanup?: ReadonlyArray<ViolationCleanupItem>;
  /**
   * The producer's own payload, verbatim (the createKillSessionHook JSON).
   * Carried so the trace never becomes a lossy projection of the report: a
   * consumer that needs a field this schema has not grown yet reads it here.
   */
  readonly detail?: unknown;
}

/**
 * One cancelled turn-owned item as the trace records it: the owner identity
 * (`kind` + `id`) and the verdict of its bounded teardown, carried verbatim
 * from the turn-work registry. `state` mirrors the top-level verdict and
 * `cleanup` carries the plane's own evidence, so a consumer need not branch on
 * which plane produced the item. `stop_requested` is deliberately distinct from
 * `confirmed_stopped`: a delivered signal is not an observed exit.
 */
export interface ViolationCleanupItem {
  readonly kind: "subagent" | "background_task";
  readonly id: string;
  readonly state: "stop_requested" | "confirmed_stopped" | "unconfirmed";
  /** Typed cause when `state === "unconfirmed"`. */
  readonly reason?: string;
  readonly cleanup: CleanupTraceEvidence;
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
  /**
   * ADR-0122: no longer written on new records (the per-spawn model field was
   * deleted). The type field stays so previously stored lines that carry
   * `model` still parse.
   */
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
   * Record one security-interruption event (ADR-0135). Written through the
   * shared service so an escalation lands in the same file as the turn and
   * tool rows it interrupted, under the same write-failure accounting.
   * @throws never — returns undefined on write failure.
   */
  recordViolation(record: ViolationRecord): Promise<string | undefined>;
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
