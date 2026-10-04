/**
 * Operator-visible recovery status vocabulary (ADR-0136 §4).
 *
 * One module owns the words a host may show, so the TUI, HTTP, and CLI paths
 * cannot invent three different spellings of the same state. Every variant
 * carries the facts a host needs to render one line — the affected operations
 * and paths for `needs handling`, the distinct reason for `blocked` — but this
 * module renders nothing: presentation belongs to the host surface.
 *
 * `recovery in progress` is deliberately NOT a variant of `RecoveryStatus`.
 * It is a transient a host shows WHILE the call is in flight; a recovery call
 * resolves to exactly one of the five variants below and never to this string,
 * so a host cannot mistake a progress display for an outcome.
 */

/** The host's in-flight transient. Exported so a host renders the same string
 *  before `recoverSession` resolves; never returned by it. */
export const RECOVERY_IN_PROGRESS_LABEL = "recovery in progress" as const;
export type RecoveryInProgressLabel = typeof RECOVERY_IN_PROGRESS_LABEL;

/**
 * Why the selected published state could not be restored. The four
 * body/head cases stay distinct because collapsing them would let a host
 * report "nothing was saved" for a state whose bytes are merely damaged.
 *
 * `session_log_corrupt` and `selected_head_invalid` come from the two codec
 * fields the head-chain walk itself raises (`root`/`type` and anything else
 * is a damaged record); the split is the reader's only honest way to tell
 * "the log is damaged" from "the selected chain is unusable".
 */
export type RecoveryBlockedReason =
  | "published_state_body_missing"
  | "published_state_body_corrupt"
  | "published_state_body_schema_invalid"
  | "session_log_corrupt"
  | "selected_head_invalid";

/**
 * Why one target of one file operation needs an operator. Each code is a case
 * recovery must NOT paper over by writing, deleting, or inferring a
 * chronology:
 *
 * - `capture_disabled` — `codeRestore.enabled` suppressed the evidence, so the
 *   effect is UNVERIFIED; bytes matching something proves nothing.
 * - `root_identity_mismatch` — the live write root is not the recorded root
 *   (ADR-0121), so even matching bytes are somebody else's file.
 * - `body_missing` — a referenced pre/post blob cannot be read; the evidence
 *   itself is gone, so the comparison cannot be made.
 * - `bytes_match_neither` — live drift; reported and left untouched.
 * - `target_missing` — the path existed before the operation and is gone now.
 *   Not a byte match with either image, and never a licence to delete.
 * - `ambiguous_ordering` — one path recorded by writers the selected chain
 *   cannot order; no chronology may be invented.
 * - `writer_not_on_chain` — the recording `toolUseId` is not an assistant
 *   tool_use on the selected chain, so this transcript cannot own the write
 *   (a worker-owned intent) and cannot order it against its own events.
 * - `unresolvable_path` — the recorded relative path is absolute or climbs out
 *   of the live root; it is not read at all.
 * - `tool_outcome_unknown` — the call never settled, so its per-file verdicts
 *   are sound but the call as a whole is unresolved. Reported per target
 *   because the operator decides about paths: file agreement alone never
 *   proves whole-operation success (SC11).
 */
export type FileHandlingReason =
  | "capture_disabled"
  | "root_identity_mismatch"
  | "body_missing"
  | "bytes_match_neither"
  | "target_missing"
  | "ambiguous_ordering"
  | "writer_not_on_chain"
  | "unresolvable_path"
  | "tool_outcome_unknown";

/** One target an operator must act on. `relPath` is relative to the live
 *  write root the recovery was given, never an absolute path — a host renders
 *  it next to the root it already shows for the session. */
export interface RecoveryHandlingItem {
  readonly toolUseId: string;
  readonly relPath: string;
  readonly reason: FileHandlingReason;
}

/**
 * The classification of one session-entry recovery. Discriminated on `status`
 * so a host's switch is exhaustive and a `blocked` reason can never be read
 * off a `needs handling` result.
 */
export type RecoveryStatus =
  /** The selected published state loaded and validated, and every recorded
   *  file operation resolved — verified, or cleanly not-replaced, or settled
   *  as an error — with nothing left for a human. */
  | { readonly status: "recovered" }
  /** At least one recorded operation still needs an explicit operator
   *  decision. `handling` lists every affected target. */
  | {
      readonly status: "needs handling";
      readonly handling: ReadonlyArray<RecoveryHandlingItem>;
      /**
       * Owned workers whose stop could not be proved, by task id (SC17).
       * Present only when there is at least one: a worker that might still be
       * running is the same visible outcome as a file nobody can reconcile,
       * and it must never be read as stopped. The per-worker proof is on the
       * report's `operationFacts.workers`.
       */
      readonly workers?: ReadonlyArray<string>;
    }
  /** Failed closed. No state was restored and no fallback to transcript
   *  reconstruction or to an older checkpoint was taken. */
  | {
      readonly status: "blocked";
      readonly reason: RecoveryBlockedReason;
      /** Human-readable detail for the specific instance; never parsed. */
      readonly detail: string;
    }
  /** An old-format session (no `nativeStateFormat`). Its bytes are left
   *  completely untouched; the host offers the new-session path. */
  | { readonly status: "unsupported_format" }
  /** A new-format session that has published nothing yet. Not an error. */
  | { readonly status: "no_published_state" };
