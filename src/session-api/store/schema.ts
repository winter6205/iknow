/**
 * SessionFileV1 schema + sanitize.
 *
 * Why a separate validator: JSON.parse success != schema success. parse_failed
 * is for malformed JSON; schema_invalid is for well-formed but wrong-shape
 * data. Hub maps these to different wire kinds (422 + 422, but distinct).
 *
 * v2 adds: schemaVersion range check (≤ CURRENT accepted → sanitize, >
 * CURRENT rejected); sanitizeSessionFile (pure, backfills title/cwd/sanitized_at
 * for v1 inputs and validates message element shape); extractTitle (first
 * user message's first text block, trimmed, truncated to 80 chars).
 *
 * v3: SessionFileV1 gains the optional `checkpoints` array of per-turn
 * interrupt snapshots, shared by the checkpoint (interrupt persist) and TUI
 * rewind (rollback) paths. v1/v2 files sanitize to `checkpoints: []`
 * (spread-preserve forward-compat discipline intact — the field is a derived
 * add-on, not a mutation of authoritative history).
 *
 * v4 (additive): the `system` role joins the validate-time whitelist so
 * Ctrl+C interrupts can persist as transcript-resident
 * {role:"system", content:[{type:"text", text:"Interrupted by user."}]}
 * entries. No new fields, no migration: v3 files re-sanitize unchanged (the
 * additive change only lifts the bar for `system`). System messages never
 * reach the provider — buildMessageParams filters them before the SDK call.
 * System messages are not a turn for checkpoint rewind (splitTurns stays
 * `role === "user"`-anchored and skips tool_result-only user messages); v3
 * rewind semantics are byte-identical with a system entry present.
 *
 * v5 (additive): optional `goal?: GoalState` field carries the session-level
 * goal (user's intent for the whole session). Additive: v4 files sanitize to
 * `goal: undefined` (absent) and the field round-trips byte-identical for v5
 * files. Source union is `user_initial | user_pin`; status union is
 * `active | achieved | aborted | superseded`. The hub owns the only write
 * path; `goal.text` is the verify-loop's task field when present.
 *
 * Later revision: `GoalSource` was shrunk to `user_initial | user_pin` — the
 * removed model-propose slot has no writer. Legacy disk values that carried
 * the removed slot now fail `isValidGoal` → sanitize throws `schema_invalid`
 * (an executable migrate — never silently dropped). `MAX_GOAL_CHARS` +
 * `validateGoalText` gate the /goal and `## GOAL:` write paths at 2000 chars.
 *
 * Later revision: `session.taskFocus` retired. Old disk files carrying the
 * optional `taskFocus?: TaskFocusState` field are sanitized by stripping the
 * key on load (sanitize-drop; no migration, no validation — unknown /
 * deprecated field, deleted unconditionally). v5 files without the key
 * round-trip byte-identical. The greeting filter that fed the old seed path
 * (`shouldSeedTaskFocus` + `TASK_FOCUS_GREETING_RE`) moves to
 * turn-projection.ts — its only remaining consumer is
 * `extractRecentUserTasks` (compact-boundary recent-tasks excerpt).
 */
import path from "node:path";
import type {
  AnthropicNativeMessage,
  TokenUsage,
} from "../../harness/index.js";
import { MAX_WORKSPACE_ROOT_CHARS } from "../../config/workspace-root.js";

/** Why a turn ended in an interrupt state — the checkpoint's discriminating
 *  label. Mirrors the harness StopReason interruption subset (cancelled /
 *  maxTurns / protocolError / timeout) plus `process` (reserved for a
 *  process-level closeout the hub may record later). */
export type InterruptReason =
  "cancelled" | "maxTurns" | "protocolError" | "process" | "timeout";

/** One interrupt snapshot: how far a session had progressed when an
 *  interrupting stop happened (turnCount / messagesCount) plus the label.
 *  `lastUsage` carries the last successful model-call usage when known
 *  (mirrors RunResult.lastUsage; absent → the interrupt saw no usage).
 *
 *  `anchorEventId` is the authoritative anchor — the id of the JSONL event
 *  at chain position `messagesCount - 1` (the last message of the
 *  checkpointed turn). `messagesCount` stays as the derived view the picker
 *  joins on. The store resolves the anchor at save (against the final chain)
 *  and at load (migrating legacy messagesCount-only records); unresolvable
 *  records (messagesCount beyond the chain) keep whatever anchor they
 *  carried. */
export interface CheckpointRecord {
  readonly turnIndex: number;
  readonly messagesCount: number;
  readonly interruptedAt: string;
  readonly interruptReason: InterruptReason;
  readonly lastUsage?: unknown;
  /** Authoritative event-id anchor (derived from messagesCount at
   *  save/load; absent when the position is beyond the head chain). */
  readonly anchorEventId?: string;
}

/** v5: session-level goal — the user's intent for the whole session.
 *  Carries the active goal (the verify-loop's task field binds here when
 *  present, falling back to the current-turn query otherwise) plus a history
 *  of superseded goals from prior re-pins. The hub owns the only write path;
 *  `goal.text` is read-only to all other code. The source union is
 *  `user_initial | user_pin`; legacy disk values carrying a removed slot
 *  fail validation and sanitize throws `schema_invalid`. */
export type GoalSource = "user_initial" | "user_pin";
export type GoalStatus = "active" | "achieved" | "aborted" | "superseded";

export interface GoalHistoryEntry {
  readonly text: string;
  readonly source: GoalSource;
  readonly status: GoalStatus;
  readonly updatedAt: string;
}

export interface GoalState {
  readonly text: string;
  readonly source: GoalSource;
  readonly status: GoalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history?: ReadonlyArray<GoalHistoryEntry>;
  /**
   * Optional host auto-loop cap from `/goal --max-turns N`.
   * Omit = no hard cap. Shared by slash, hub, and chat.
   */
  readonly maxTurns?: number;
  /** Host auto-turns completed under this pin (absent = 0). */
  readonly autoTurnsRan?: number;
  /** Consecutive completed rounds with no tool_use (absent = 0). */
  readonly idleCompletedStreak?: number;
}

/** The deterministic task focus (`taskFocus?: TaskFocusState`) is RETIRED.
 *  It used to be carried on the file and seeded/cleared by the hub via the
 *  pure `seedTaskFocus` helper. Per ADR-0026 the compact-boundary payload was
 *  replaced by a recent-tasks excerpt (`extractRecentUserTasks` over
 *  session.messages) — the taskFocus lifecycle is gone. Sanitize drops any
 *  pre-existing `taskFocus` key from legacy disk; runtime never reads or
 *  writes the field. The greeting filter that once guarded `seedTaskFocus`
 *  is preserved as `shouldSeedTaskFocus` in turn-projection.ts (only
 *  consumer is `extractRecentUserTasks`). */

/** Session file shape (v2 baseline, v3 = +checkpoints). Loaders sanitize
 *  legacy v1 files. */
export interface SessionFileV1 {
  readonly schemaVersion: number;
  readonly conversation_id: string;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly jsonMode: boolean;
  readonly turnCount: number;
  readonly updatedAt: string;
  /** v2: first user message text, trimmed, truncated to 80 chars.
   *  (Renamed from `summary` — it is a UI title excerpt, not an LLM
   *  summary.) */
  readonly title: string;
  /** v2: working directory the session was created in. */
  readonly cwd: string;
  /** v2: ISO timestamp of when sanitize last normalized this file. */
  readonly sanitized_at: string;
  /** v3: interrupt snapshots for checkpoint / TUI rewind ([] until a save). */
  readonly checkpoints?: ReadonlyArray<CheckpointRecord>;
  /** v5: session-level goal. Absent on legacy files (loads as
   *  `undefined`); the hub is the only writer and re-pins via `## GOAL:` /
   *  `/goal`. Legacy `user_initial` source now passes sanitize verbatim
   *  (the retired `user_initial → taskFocus` migration is gone with the
   *  field); both `user_pin` and `user_initial` survive load — see
   *  `sanitizeSessionFile`. */
  readonly goal?: GoalState;
  /** Additive (CURRENT stays 5): serve/session bind root. Absent = unbound;
   *  sanitize never backfills cwd or process.cwd(). Illegal present values
   *  fail validate with field `"workspaceRoot"` (not silently dropped). */
  readonly workspaceRoot?: string;
  /** Parallel array (index-aligned with messages) of event ingest times
   *  (ISO). An undefined element = that event carries no createdAt (legacy
   *  file written before appendEvents stamping / an old fork branch). Whole
   *  key absent = no event on the chain has a timestamp (conditional output
   *  so a legacy file does not round-trip into an all-undefined array; see
   *  the spread-discipline in jsonl.ts projectSessionLog). Events written
   *  after appendEvents stamping carry createdAt, which is when
   *  projectSessionLog attaches this array. The consumer
   *  (rewind-picker anchoredAtFor) falls back with ?? "" — undefined and
   *  absent mean the same. */
  readonly messageCreatedAt?: ReadonlyArray<string | null>;
  /** Parallel array (index-aligned with messages) of assistant-turn
   *  thinking duration in ms. Element = `number | null`; null = that event
   *  has no thinkingMs (non-assistant / streamed turn without thinking /
   *  legacy file). Whole key absent = no thinkingMs anywhere on the chain
   *  (conditional output, same spread-discipline as messageCreatedAt).
   *  Measured by the anthropic-adapter streaming arm (stepStreamArm) from
   *  the first thinking_delta to the first non-thinking delta;
   *  non-streaming or boundary shapes (thinkingMs <= 0 / non-finite) →
   *  field absent, appendEvents does not attach the key. Additive (CURRENT
   *  stays 5). Array length is not enforced (consumers fall back with
   *  ?? undefined, as today for messageCreatedAt). */
  readonly thinkingMs?: ReadonlyArray<number | null>;
  /** Additive (CURRENT stays 5): usage of the latest successful model call,
   *  mirroring `RunResult.lastUsage`. Display-only replay source for the
   *  context-usage bar (TUI attach / web load) so a session that ever had a
   *  successful usage never reopens at 0% (#1079). Absent = no successful
   *  usage ever persisted (legacy files load unchanged → 0% posture); the
   *  writers omit the key when usage is null and validate the shape when
   *  present (never silently coerce). */
  readonly lastUsage?: TokenUsage;
  /** ADR-0136: positive identification of a new-format session. Written ONLY
   *  by the new creation path (the hub's session bootstrap); absent on every
   *  pre-existing file, and `schemaVersion` is deliberately NOT bumped for it
   *  (a bumped constant would relabel every old session as new format and make
   *  a save rewrite its bytes, which the existing-session transition contract
   *  forbids). Absence = old format, and the field is preserved verbatim by
   *  the header spread, so one save cannot silently drop it.
   *  `sanitizeSessionFile` rewrites `schemaVersion` but never this key. */
  readonly nativeStateFormat?: number;
}

/** ADR-0136: the native-state format a new-format session declares. Kept
 *  separate from `CURRENT_SCHEMA_VERSION` — this identifies the recovery
 *  contract, not the transcript schema. */
export const NATIVE_STATE_FORMAT_VERSION = 1 as const;

/**
 * Whether a session file (or its header) is a new-format session — the
 * positive identification the new recovery path gates on. Deliberately a plain
 * boolean over the field's presence: absence means old format, and a future
 * format version is a host-layer admission decision, not this predicate's
 * business. Takes the narrow structural shape so both `SessionFileV1` and a
 * parsed JSONL header answer it.
 */
export function isNewFormatSession(file: {
  readonly nativeStateFormat?: number;
}): boolean {
  return typeof file.nativeStateFormat === "number";
}

export const CURRENT_SCHEMA_VERSION = 5 as const;

/**
 * Validate parsed JSON against the session-file shape.
 * schemaVersion uses a range check (≤ CURRENT accepted → sanitize, > CURRENT
 * rejected) so old files load and future files fail loudly.
 * Returns the failed field name, or null when valid.
 */
export function validateSessionFile(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return "root";
  }
  const obj = value as Record<string, unknown>;
  if (
    typeof obj["schemaVersion"] !== "number" ||
    obj["schemaVersion"] > CURRENT_SCHEMA_VERSION
  ) {
    return "schemaVersion";
  }
  if (typeof obj["conversation_id"] !== "string") {
    return "conversation_id";
  }
  if (!Array.isArray(obj["messages"])) {
    return "messages";
  }
  if (typeof obj["jsonMode"] !== "boolean") {
    return "jsonMode";
  }
  if (typeof obj["turnCount"] !== "number") {
    return "turnCount";
  }
  if (typeof obj["updatedAt"] !== "string") {
    return "updatedAt";
  }
  return firstInvalidOptionalField(obj);
}

/** The optional-field half of `validateSessionFile`, split out to keep the
 *  parent inside the complexity budget. Every entry is absent-valid and
 *  never-coerced: a present value that does not match its shape fails with that
 *  field name rather than being repaired into something the downstream readers
 *  would trust. Order is unchanged from the inline form. */
function firstInvalidOptionalField(
  obj: Record<string, unknown>
): string | null {
  // v3: optional `checkpoints` array — validate shape if present, never
  // silently coerce (a malformed checkpoints field would break downstream
  // rewind computation).
  if (
    obj["checkpoints"] !== undefined &&
    !isValidCheckpointList(obj["checkpoints"])
  ) {
    return "checkpoints";
  }
  // v5: optional `goal` object — validate shape if present, never silently
  // coerce (a malformed goal would break downstream verify-loop binding).
  if (obj["goal"] !== undefined && !isValidGoal(obj["goal"])) {
    return "goal";
  }
  // Additive optional string: absent is valid (unbound). Present values must
  // be absolute, non-empty, and ≤ MAX_WORKSPACE_ROOT_CHARS — never coerce.
  if (
    obj["workspaceRoot"] !== undefined &&
    !isValidWorkspaceRoot(obj["workspaceRoot"])
  ) {
    return "workspaceRoot";
  }
  // Optional parallel array over messages: validate shape if present, never
  // silently coerce (a misaligned / malformed messageCreatedAt would feed the
  // rewind picker wrong timestamps index-by-index). Elements are ISO strings
  // or null — JSON round-trip serializes the runtime `undefined` holes to
  // null, so both spellings mean "no stamp at this position".
  if (
    obj["messageCreatedAt"] !== undefined &&
    !isValidMessageCreatedAt(obj["messageCreatedAt"])
  ) {
    return "messageCreatedAt";
  }
  // Optional parallel array over messages for assistant-turn thinking
  // duration (ms). Elements must be number or null — runtime `undefined`
  // serializes to null via JSON.stringify, so only null holes are accepted
  // (same posture as messageCreatedAt). No value-bound checks here:
  // appendEvents already filters thinkingMs <= 0 / non-finite, so 0/NaN/
  // Infinity never reach disk. Array length is not enforced; short arrays
  // fall back to ?? undefined on the consumer side (as with
  // messageCreatedAt).
  if (
    obj["thinkingMs"] !== undefined &&
    !isValidThinkingMs(obj["thinkingMs"])
  ) {
    return "thinkingMs";
  }
  // Additive optional TokenUsage: absent is valid (no usage ever recorded —
  // legacy files and never-successful sessions). Present values must match
  // the harness TokenUsage shape; a malformed object fails validate with
  // field "lastUsage" instead of poisoning the display readers with NaN
  // arithmetic (never silently coerce — same posture as goal / workspaceRoot).
  // Whole-field null is rejected: the writers omit the key on null usage, and
  // JSON round-trip only spells inner cache holes as null, never the record.
  if (obj["lastUsage"] !== undefined && !isValidUsageRecord(obj["lastUsage"])) {
    return "lastUsage";
  }
  // ADR-0136: optional new-format marker — absent is valid (every
  // pre-existing file), a present value must be a positive integer.
  if (!isValidNativeStateFormat(obj)) return "nativeStateFormat";
  return null;
}

/** The new-format marker gate. Never coerced: a malformed marker would let the
 *  recovery path guess whether this file carries restorable state. */
function isValidNativeStateFormat(obj: Record<string, unknown>): boolean {
  const value = obj["nativeStateFormat"];
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value > 0)
  );
}

/** Type guard companion to validateSessionFile for callers that want a boolean. */
export function isSessionFileV1(value: unknown): value is SessionFileV1 {
  return validateSessionFile(value) === null;
}

/**
 * Extract a one-line UI title (renamed from the `summary` helper — it is a
 * title excerpt for the session list, not an LLM summary): the first
 * text block of the first user message that has one, trimmed then truncated to
 * 80 chars. Markdown is NOT stripped — the storage layer stays format-agnostic.
 * "" if no user message has a text block (skips pure tool_result user messages).
 */
export function extractTitle(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const firstText = msg.content.find((b) => b.type === "text");
    if (firstText && firstText.type === "text") {
      return firstText.text.trim().slice(0, 80);
    }
  }
  return "";
}

/**
 * Extract the full first user message text — no truncation, just trimmed.
 * Used to seed the session-level goal where the full intent matters;
 * `extractTitle` truncates to 80 chars and would lose the tail. "" if no user
 * message has a text block (skips pure tool_result user messages, mirrors
 * extractTitle's skip rule).
 */
export function extractGoal(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const firstText = msg.content.find((b) => b.type === "text");
    if (firstText && firstText.type === "text") {
      return firstText.text.trim();
    }
  }
  return "";
}

/**
 * Re-pin the session-level goal.
 *
 * Pure — given the current `GoalState` (or `undefined` for a fresh session)
 * and the new `text`, build the new active goal and prepend the prior goal
 * (if any) to `history[0]` with `status: "superseded"`.
 *
 * - Source is `"user_pin"` for the re-pinned goal; the prior entry preserves
 *   its own source label (typically `"user_initial"`).
 * - `createdAt` is preserved on the existing goal (or stamped from `now` on
 *   a fresh re-pin); `updatedAt` advances to `now`.
 * - `history` accumulates monotonically: `history = [priorGoal, ...prevHistory]`
 *   (capped naturally by the file; sanitize validates shape on load).
 *
 * The empty `text` no-op case is the caller's responsibility — this helper
 * always produces a valid new goal and is meant to be invoked only when a
 * re-pin is intentional (see `parseGoalCommand` in hub.ts and the `/goal`
 * slash command's empty-args rejection).
 */
export function pinGoal(opts: {
  readonly current: GoalState | undefined;
  readonly text: string;
  readonly now: string;
  /** Optional host-loop cap; omit = no hard cap. Re-pin resets counters. */
  readonly maxTurns?: number;
}): GoalState {
  const { current, text, now, maxTurns } = opts;
  const priorHistory = current?.history ?? [];
  const newHistory = current
    ? [
        {
          text: current.text,
          source: current.source,
          status: "superseded" as const,
          updatedAt: now,
        },
        ...priorHistory,
      ]
    : priorHistory;
  return {
    text,
    source: "user_pin",
    status: "active",
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    history: newHistory,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

/** Goal text is capped at 2000 chars on both write entries
 *  (`/goal <text>` in cli and the `## GOAL:` directive path in the hub). */
export const MAX_GOAL_CHARS = 2000;

/** Validate a goal text string. Returns `null` when valid,
 *  or an error-description string when not. Invalid = empty after trim, or
 *  raw length > MAX_GOAL_CHARS. The caller passes the raw (untrimmed) text —
 *  `## GOAL:` directives feed the original body here — so trim is applied
 *  internally for the empty check only; the returned/retained text is the
 *  caller's responsibility. */
export function validateGoalText(text: string): string | null {
  if (text.trim().length === 0) {
    return `goal text must be non-empty (got ${text.length} chars)`;
  }
  if (text.length > MAX_GOAL_CHARS) {
    return `goal text exceeds ${MAX_GOAL_CHARS} chars (got ${text.length})`;
  }
  return null;
}

/**
 * Sanitize a parsed session file of any ≤ CURRENT version into the current shape.
 *
 * Pure, no IO, no reads, no writes — load-time normalize.
 *
 * Reject-first: schemaVersion > CURRENT fails immediately, never entering the
 * field-preservation branch (so unknown future-version fields can not leak
 * past a too-new schema check).
 *
 * Backfills v2 fields (title/cwd/sanitized_at) for v1 inputs; preserves
 * unknown top-level fields on ≤ CURRENT files so future versions round-trip
 * (future fields must be preserved, not dropped).
 *
 * Throws { kind: "schema_invalid", field } (same style as the
 * `satisfies SessionStoreError` object literals in session-store.ts —
 * structured object literal, not a bare Error) so the caller can attach
 * `conversation_id` and rethrow a full SessionStoreError.
 *
 * Why sanitize never repairs `messages`: authoritative history is immutable.
 * A malformed message element is a hard reject.
 */
export function sanitizeSessionFile(raw: unknown): SessionFileV1 {
  const field = validateSessionFile(raw);
  if (field !== null) throw invalid(field);
  const obj = raw as Record<string, unknown>;
  const messagesRaw = obj["messages"] as ReadonlyArray<unknown>;
  if (!isValidMessagesList(messagesRaw)) throw invalid("messages");
  const messages = messagesRaw as ReadonlyArray<AnthropicNativeMessage>;
  // v3 backfill: v1/v2 files carry no `checkpoints` → normalize to [] (a
  // derived add-on, not a mutation of authoritative history — spread-preserve
  // discipline intact). When present, `checkpoints` is already validated by
  // validateSessionFile above.
  const checkpoints = Array.isArray(obj["checkpoints"])
    ? (obj["checkpoints"] as ReadonlyArray<CheckpointRecord>)
    : [];
  // v5 `goal` is optional and additive — preserved verbatim via `...obj`
  // when present (validated by validateSessionFile above), omitted when
  // absent, keeping v4 → v5 round-trip byte-identical. The hub owns the
  // only write path. The retired `user_initial → taskFocus` migration is
  // gone with the field's retirement; legacy `user_initial` goals now pass
  // sanitize verbatim alongside `user_pin`.
  // Build the result with the conditional goal key to preserve
  // byte-identical round-trip for v4/v5 files that lack the field
  // (spread-discipline: never emit `field: undefined` keys).
  // Title-field migration: the legacy name `summary` was a UI title excerpt
  // of the first user text (not an LLM summary), now renamed `title`.
  // Precedence: legacy `summary` (old disk) > already-written `title` >
  // recompute from the first user text (extractTitle — identical semantics
  // to the calculation used back when the old name was current). The output
  // key is always `title`: the legacy `summary` key is deleted after
  // migration and never survives into a new file (spread-preserve: unknown
  // fields are kept, but `summary` is a known-deprecated field).
  const title: string =
    typeof obj["summary"] === "string"
      ? (obj["summary"] as string)
      : typeof obj["title"] === "string"
        ? (obj["title"] as string)
        : extractTitle(messages);
  const result: Record<string, unknown> = {
    ...obj,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    title,
    cwd: typeof obj["cwd"] === "string" ? obj["cwd"] : "",
    sanitized_at:
      typeof obj["sanitized_at"] === "string"
        ? obj["sanitized_at"]
        : (obj["updatedAt"] as string),
    checkpoints,
  };
  if ("summary" in obj) {
    // Delete regardless of value type (string / null / number / object):
    // legacy `summary` is a deprecated field and must never survive into a
    // new file after migration.
    delete result["summary"];
  }
  // Sanitize-drop the retired `taskFocus` key. Any value (object /
  // string / number / null) on a legacy file is silently dropped — the field
  // no longer exists in the runtime SessionFileV1 shape and the hub does not
  // write it. This keeps existing-session files loadable without a schema
  // bump (loading old fields sanitizes away without throwing).
  // Unconditional delete — same spread-discipline posture as legacy `summary`.
  delete result["taskFocus"];
  return result as unknown as SessionFileV1;
}

// -- module-level helpers ----------------------------------------------------

/**
 * Structured `schema_invalid` throw payload (subset of SessionStoreError —
 * the `conversation_id` is filled by the caller from the load path, since
 * sanitize is a pure function on the raw object and doesn't carry store state).
 */
function invalid(field: string): { kind: "schema_invalid"; field: string } {
  return { kind: "schema_invalid", field };
}

/** Deep-validate every element of `messages` (role ∈ {user, assistant}; each
 *  content block matches an AnthropicContentBlock shape). Returns true on OK. */
function isValidMessagesList(messages: ReadonlyArray<unknown>): boolean {
  for (const m of messages) {
    if (!isValidMessage(m)) return false;
  }
  return true;
}

function isValidMessage(m: unknown): boolean {
  if (m === null || typeof m !== "object") return false;
  const msg = m as Record<string, unknown>;
  // schema v4: the `system` role joins the whitelist — Ctrl+C interrupts
  // persist as transcript events (display layer only, never fed to the
  // provider). `system` messages are orthogonal to turn slicing: splitTurns
  // follows turn-projection.ts `isTurnQuery` (`role === "user"`, no
  // tool_result block, not a subagent drain summary — same SSOT as
  // checkpoint.ts / hub.ts), so system entries fall into the gaps between
  // adjacent turns and never move rewind anchors.
  if (
    msg["role"] !== "user" &&
    msg["role"] !== "assistant" &&
    msg["role"] !== "system"
  ) {
    return false;
  }
  if (!Array.isArray(msg["content"])) return false;
  return (msg["content"] as ReadonlyArray<unknown>).every(isValidContentBlock);
}

function isValidContentBlock(b: unknown): boolean {
  if (b === null || typeof b !== "object") return false;
  const block = b as Record<string, unknown>;
  switch (block["type"]) {
    case "text":
      return typeof block["text"] === "string";
    case "tool_use":
      return (
        typeof block["id"] === "string" &&
        typeof block["name"] === "string" &&
        "input" in block
      );
    case "tool_result":
      return typeof block["tool_use_id"] === "string" && "content" in block;
    // thinking / redacted_thinking: the harness retains thinking blocks
    // (with signature) in the authoritative history. The session store must
    // accept them on save and replay them verbatim — otherwise the wire
    // thinking view has nothing to project after a real thinking turn.
    case "thinking":
      return (
        typeof block["thinking"] === "string" &&
        typeof block["signature"] === "string"
      );
    case "redacted_thinking":
      // `data` is the encrypted blob — kept verbatim so replays stay byte-
      // identical with the LLM-emitted history (mirror of `thinking`).
      return typeof block["data"] === "string";
    default:
      return false;
  }
}

/** Deep-validate a `checkpoints` array (v3). Each element must carry the
 *  InterruptReason union, two numeric anchors, and an ISO string. `lastUsage`
 *  is intentionally NOT shape-validated — it is a passthrough container for
 *  RunResult.lastUsage (TokenUsage | null), and downstream consumers know how
 *  to interpret absent vs null. */
function isValidCheckpointList(records: unknown): boolean {
  if (!Array.isArray(records)) return false;
  for (const r of records) {
    if (!isValidCheckpoint(r)) return false;
  }
  return true;
}

const VALID_INTERRUPT_REASONS: ReadonlySet<InterruptReason> = new Set([
  "cancelled",
  "maxTurns",
  "protocolError",
  "process",
  "timeout",
]);

function isValidCheckpoint(c: unknown): boolean {
  if (c === null || typeof c !== "object") return false;
  const r = c as Record<string, unknown>;
  return (
    typeof r["turnIndex"] === "number" &&
    typeof r["messagesCount"] === "number" &&
    typeof r["interruptedAt"] === "string" &&
    typeof r["interruptReason"] === "string" &&
    VALID_INTERRUPT_REASONS.has(r["interruptReason"] as InterruptReason) &&
    // Optional event-id anchor — present values must be strings.
    (r["anchorEventId"] === undefined || typeof r["anchorEventId"] === "string")
  );
}

const VALID_GOAL_SOURCES: ReadonlySet<GoalSource> = new Set([
  "user_initial",
  "user_pin",
]);

const VALID_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "active",
  "achieved",
  "aborted",
  "superseded",
]);

/** Optional integer ≥ min (0 for streaks, 1 for maxTurns). undefined = absent.
 *  Consolidates the maxTurns / autoTurnsRan / idleCompletedStreak validator —
 *  three near-identical checks that all reduce to "integer at or above min". */
function isOptionalPositiveIntField(value: unknown, min: number): boolean {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isInteger(value) && value >= min;
}

/** Deep-validate the v5 `goal` object (all five required fields + optional
 *  history array). Reject-first: a malformed goal would silently break the
 *  verify-loop's `goal.text` binding, so it must fail loudly like checkpoints. */
function isValidGoal(g: unknown): boolean {
  if (g === null || typeof g !== "object") return false;
  const goal = g as Record<string, unknown>;
  if (
    typeof goal["text"] !== "string" ||
    typeof goal["source"] !== "string" ||
    !VALID_GOAL_SOURCES.has(goal["source"] as GoalSource) ||
    typeof goal["status"] !== "string" ||
    !VALID_GOAL_STATUSES.has(goal["status"] as GoalStatus) ||
    typeof goal["createdAt"] !== "string" ||
    typeof goal["updatedAt"] !== "string"
  ) {
    return false;
  }
  if (!isOptionalPositiveIntField(goal["maxTurns"], 1)) return false;
  if (!isOptionalPositiveIntField(goal["autoTurnsRan"], 0)) return false;
  if (!isOptionalPositiveIntField(goal["idleCompletedStreak"], 0)) return false;
  if (goal["history"] === undefined) return true;
  if (!Array.isArray(goal["history"])) return false;
  return (goal["history"] as ReadonlyArray<unknown>).every(isValidGoalHistory);
}

function isValidGoalHistory(h: unknown): boolean {
  if (h === null || typeof h !== "object") return false;
  const entry = h as Record<string, unknown>;
  return (
    typeof entry["text"] === "string" &&
    typeof entry["source"] === "string" &&
    VALID_GOAL_SOURCES.has(entry["source"] as GoalSource) &&
    typeof entry["status"] === "string" &&
    VALID_GOAL_STATUSES.has(entry["status"] as GoalStatus) &&
    typeof entry["updatedAt"] === "string"
  );
}

/** Optional SessionFile workspaceRoot: string, absolute, length-capped. */
function isValidWorkspaceRoot(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_WORKSPACE_ROOT_CHARS) {
    return false;
  }
  return path.isAbsolute(value);
}

/** Optional `messageCreatedAt` parallel array (rewind prompt timestamps):
 *  elements are ISO strings or `null`. `null` marks a hole — the parallel
 *  position in `messages[]` carries no timestamp (legacy / pre-stamping fork
 *  branch). `projectSessionLog` coerces in-memory `undefined` to `null` to
 *  match the JSON-on-disk shape; the validator accepts `null` holes only,
 *  never `undefined`. The array length is NOT enforced here — a malformed
 *  length surfaces downstream as `undefined` reads in the picker and breaks
 *  loudly without ambiguity. */
function isValidMessageCreatedAt(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const el of value) {
    if (el === null) continue;
    if (typeof el !== "string") return false;
  }
  return true;
}

/** Optional `thinkingMs` parallel array over messages. Elements are
 *  `number | null` — appendEvents already filters `thinkingMs <= 0` /
 *  non-finite, so 0/NaN/Infinity never reach disk; this validator does not
 *  repeat boundary checks, it only checks element types (any positive
 *  number accepted, null holes allowed). Array length is not enforced, same
 *  posture as messageCreatedAt. Runtime `undefined` serializes to null via
 *  JSON.stringify, so the validator accepts null but never undefined. */
function isValidThinkingMs(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const el of value) {
    if (el === null) continue;
    if (typeof el !== "number") return false;
  }
  return true;
}

/** File-level lastUsage shape check (mirrors harness TokenUsage): all four
 *  members required — input/output token counts finite numbers, cache counts
 *  number | null (JSON round-trips the null holes). No value-bound checks:
 *  the only writers persist complete RunResult.lastUsage readings. A partial
 *  or non-finite object can only come from a broken writer, so it fails
 *  validate loudly instead of reaching the bar's arithmetic. */
function isValidUsageRecord(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (
    typeof o["inputTokens"] !== "number" ||
    !Number.isFinite(o["inputTokens"]) ||
    typeof o["outputTokens"] !== "number" ||
    !Number.isFinite(o["outputTokens"])
  ) {
    return false;
  }
  return (
    isNullishNumber(o["cacheCreationInputTokens"]) &&
    isNullishNumber(o["cacheReadInputTokens"])
  );
}

function isNullishNumber(value: unknown): boolean {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

/** Single persistence rule for lastUsage (#1079): a non-null reading persists
 *  as `{ lastUsage }`; null omits the key so an earlier persisted reading
 *  survives reopen (a session that ever had a successful usage never regresses
 *  to 0%). Every writer of a persisted lastUsage spread calls this — the
 *  invariant stays in one place instead of scattered inline conditionals.
 *  Internal to the module tree: not re-exported through store/index.js. */
export function persistedLastUsage(usage: TokenUsage | null): {
  readonly lastUsage?: TokenUsage;
} {
  return usage !== null ? { lastUsage: usage } : {};
}
