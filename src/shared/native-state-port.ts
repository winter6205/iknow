/**
 * Neutral persistence seam between the harness and the session host
 * (ADR-0136 / specs/session-checkpoint-architecture.md §1, §3).
 *
 * Why this file lives in `src/shared/`: the harness must request persistence
 * without importing `session-api` or owning any session file format, and the
 * host must implement it without importing harness internals. The native
 * message / content-block shapes are therefore declared STRUCTURALLY here and
 * mirrored from the model adapter's wire types — this layer stays dependency
 * neutral (no harness import), and the store validates the concrete shape on
 * write.
 *
 * Write-only by contract: the harness emits requests; only the host reads the
 * persisted result back. There is deliberately no read method here.
 *
 * Persistence through this port is correctness-critical, so a failure is a
 * typed `NativeStatePortError` the caller must surface — never swallowed, and
 * never retried behind the caller's back. The host maps its own typed store
 * errors onto these two codes.
 *
 * Secret posture: the snapshot carries context, boundary, turn identity, and
 * typed runtime state (assembly, loop position, graph, worker, terminal). It
 * never carries credentials, secret values, live process handles, or
 * permission grants — those live in process memory by contract and are not
 * restored, and the append path rejects a payload that carries one.
 *
 * The typed runtime fields are declared as imports rather than restated: the
 * harness's request vocabulary (src/shared/runtime-persistence.ts) is the one
 * that describes them, so a restore never has to translate between two
 * spellings of the same state. Type-only import — this layer stays free of
 * runtime dependencies.
 */
import type {
  RuntimeAssemblyState,
  RuntimeGraphNodeFact,
  RuntimeSavedStateBoundary,
  RuntimeTerminalState,
  RuntimeToolResultFact,
  RuntimeWorkerFact,
} from "./runtime-persistence.js";

/** Which boundary published a state. Mirrors the record's `boundary` field;
 *  a new member must be added here first so the record layer's keyed guard
 *  fails compilation until it is listed. */
export type NativeStateBoundary =
  "input" | "tool_batch" | "compaction" | "terminal";

/**
 * The ONE place the harness's boundary vocabulary becomes the storage record's.
 * Keyed off BOTH unions, so a member added to either one fails to compile here
 * instead of reaching disk unmapped.
 *
 * WHY this side and not the harness contract: `runtime-persistence.ts` must stay
 * import-free so no project type can reach a payload through it, which
 * `tests/harness/permission/saved-state-excludes-grants.test.ts` enforces by
 * reading that file. A type-only import would satisfy the compiler but spend
 * the guard, so the bridge lives on the side that already depends on the other.
 */
const NATIVE_BOUNDARY_BY_RUNTIME_BOUNDARY: Record<
  RuntimeSavedStateBoundary,
  NativeStateBoundary
> = {
  accepted_input: "input",
  tool_batch_settled: "tool_batch",
  compacted: "compaction",
  terminal_turn: "terminal",
};

/**
 * Map one boundary onto the storage record's vocabulary. Throws on an unmapped
 * value: the record is read without dereferencing its body, so a name no reader
 * recognizes would be an unreadable publication, not a cosmetic mismatch.
 */
export function toNativeStateBoundary(
  boundary: RuntimeSavedStateBoundary
): NativeStateBoundary {
  const mapped = NATIVE_BOUNDARY_BY_RUNTIME_BOUNDARY[boundary];
  if (mapped === undefined) {
    throw new Error(
      `unmapped runtime persistence boundary: ${String(boundary)}`
    );
  }
  return mapped;
}

/** Anthropic native role, declared structurally (adapter SSOT:
 *  `harness/model-adapter/types.ts`). */
export type NativeStateRole = "user" | "assistant" | "system";

/** Anthropic native content block, declared structurally so this layer stays
 *  import-neutral. `input` / `content` stay `unknown` for the same reason the
 *  adapter types them: tool payloads are not this layer's concern. */
export type NativeStateContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: unknown;
      readonly is_error?: boolean;
    }
  | {
      readonly type: "thinking";
      readonly thinking: string;
      readonly signature: string;
    }
  | { readonly type: "redacted_thinking"; readonly data: string };

/** One saved native message: the append-only unit of context. */
export interface NativeStateMessage {
  readonly role: NativeStateRole;
  readonly content: ReadonlyArray<NativeStateContentBlock>;
  /** Host-injection stamp (ADR-0112). NOT model-visible; the outbound
   *  projection strips it, but the saved context must keep it so a resumed
   *  history produces the same wire prefix. */
  readonly hostInjected?: true;
}

/** The complete state one publication restores from: the exact native
 *  message sequence at the boundary plus the identity needed to place it. */
export interface NativeStateSnapshot {
  readonly boundary: NativeStateBoundary;
  readonly messages: ReadonlyArray<NativeStateMessage>;
  /** Stable turn identity when this boundary has one (the ADR-0126 turn id —
   *  the terminal message event id). Absent at boundaries with no settled
   *  turn; never synthesized. */
  readonly turnId?: string;
  /**
   * Frozen session assembly inputs (spec §2.3): the system/prompt prefix the
   * context was assembled against, the skill-index seen set, pending
   * continuation, and the selected execution mode. Prompt provenance rides on
   * each message's `hostInjected` stamp (ADR-0112), which `messages` already
   * carries — a second provenance field would be a second copy of the same
   * stamp. Typed after the harness's own request type so a restore reads one
   * vocabulary instead of translating an opaque bag.
   */
  readonly assembly?: RuntimeAssemblyState;
  /** Loop position (spec §2.2): the batch bookkeeping of the turn in flight. */
  readonly toolResults?: ReadonlyArray<
    RuntimeToolResultFact<NativeStateMessage>
  >;
  /** Live graph state (spec §2.5), one entry per known node. */
  readonly graphNodes?: ReadonlyArray<RuntimeGraphNodeFact>;
  /** Owned-worker state (spec §2.6), one entry per known worker. */
  readonly workers?: ReadonlyArray<RuntimeWorkerFact>;
  /** Terminal outcome (spec §2.8); absent means unknown, never `completed`. */
  readonly terminal?: RuntimeTerminalState;
  /**
   * Opaque, already-JSON-serializable runtime facts owned by the caller. Kept
   * for forward compatibility so a field this version does not name still
   * round-trips; the typed fields above are the readable form of what the spec
   * requires, and this bag is the escape hatch, not the primary carrier. Must
   * not carry credentials, secret values, live process handles, or permission
   * grants — the append path rejects a payload that does.
   */
  readonly runtimeFacts?: Readonly<Record<string, unknown>>;
}

export interface PublishNativeStateRequest {
  readonly conversationId: string;
  /** Message event id this state is anchored to. It must be on the
   *  selected head chain to be selectable. */
  readonly anchorEventId: string;
  readonly boundary: NativeStateBoundary;
  readonly snapshot: NativeStateSnapshot;
}

/** What a successful publication owes the caller: the content address of the
 *  immutable body and the saved message count. */
export interface PublishedNativeStateResult {
  readonly bodySha: string;
  readonly messageCount: number;
}

/** One target of a file operation. A multi-file call carries one entry per
 *  target — the durable per-file association the in-memory preimage ledger
 *  (last-write-wins per `toolUseId`) cannot express. */
export interface FileIntentTarget {
  readonly relPath: string;
  readonly rootIdentity: string;
  /** Capture-time evidence that the path did not exist before the write. */
  readonly absentBefore: boolean;
  /** Absent when `captured === false` (capture was suppressed). */
  readonly preimageSha?: string;
  readonly postimageSha?: string;
}

export interface RecordFileIntentRequest {
  readonly conversationId: string;
  readonly toolUseId: string;
  readonly targets: ReadonlyArray<FileIntentTarget>;
  /** False when the existing `codeRestore.enabled` opt-out suppressed
   *  capture. The request is still made so recovery can report the effect
   *  UNVERIFIED instead of inferring completion. */
  readonly captured: boolean;
}

/**
 * The single persistence seam the harness writes through. The host injects the
 * implementation and routes every call through its existing per-session writer
 * queue — this interface adds no locking of its own and no second journal.
 */
export interface NativeStatePort {
  /** Persist a complete state, then publish its reference. Resolves only
   *  after the reference is durable; rejects with `NativeStatePortError`
   *  otherwise, and the caller must not issue the dependent execution. */
  publishNativeState(
    input: PublishNativeStateRequest
  ): Promise<PublishedNativeStateResult>;
  /** Persist the write intent for every target BEFORE the targets are
   *  mutated. Resolves only once the intent is durable. */
  recordFileIntent(input: RecordFileIntentRequest): Promise<void>;
}

/**
 * Typed port failure. `VALIDATION` = the request was rejected before any
 * write; `PERSIST_FAILED` = a required write did not complete, so dependent
 * execution must not proceed. Both are correctness-critical and must be
 * surfaced, never swallowed.
 *
 * Extends the shared typed-error convention (class + `code` + `details`) but
 * not `IknowError` itself: that family's closed code set is a different
 * concern, and widening it for this seam would leak the port's vocabulary into
 * every consumer of the shared errors module.
 */
export type NativeStatePortErrorCode = "VALIDATION" | "PERSIST_FAILED";

export class NativeStatePortError extends Error {
  readonly code: NativeStatePortErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: NativeStatePortErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "NativeStatePortError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Type guard companion for the port failure (a plain `catch` check). */
export function isNativeStatePortError(
  err: unknown
): err is NativeStatePortError {
  return err instanceof NativeStatePortError;
}
