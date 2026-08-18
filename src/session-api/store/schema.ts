/**
 * SessionFileV1 schema (022 spec L183-192) + sanitize (#120 T1).
 *
 * Why a separate validator: JSON.parse success != schema success. parse_failed
 * is for malformed JSON; schema_invalid is for well-formed but wrong-shape
 * data. Hub maps these to different wire kinds (422 + 422, but distinct).
 *
 * #120 adds: schemaVersion range check (≤ CURRENT accepted → sanitize, >
 * CURRENT rejected); sanitizeSessionFile (pure, backfills title/cwd/sanitized_at
 * for v1 inputs and validates message element shape); extractTitle (first
 * user message's first text block, trimmed, truncated to 80 chars).
 *
 * v3 (T1 checkpoint data layer): SessionFileV1 gains the optional
 * `checkpoints` array of per-turn interrupt snapshots, shared by the
 * checkpoint (interrupt persist) and TUI rewind (rollback) paths. v1/v2 files
 * sanitize to `checkpoints: []` (spread-preserve forward-compat discipline
 * intact — the field is a derived add-on, not a mutation of authoritative
 * history).
 *
 * v4 (#383 B2 / #392, additive): the `system` role joins the validate-time
 * whitelist so Ctrl+C interrupts can persist as transcript-resident
 * {role:"system", content:[{type:"text", text:"Interrupted by user."}]}
 * entries. No new fields, no migration: v3 files re-sanitize unchanged (the
 * additive change only lifts the bar for `system`). System messages never
 * reach the provider — buildMessageParams filters them before the SDK call
 * (T2). System messages are not a turn for checkpoint rewind (splitTurns stays
 * `role === "user"`-anchored and skips tool_result-only user messages); v3
 * rewind semantics are byte-identical with a system entry present.
 *
 * v5 (#408, additive): optional `goal?: GoalState` field carries the session-
 * level goal (user's intent for the whole session). Additive: v4 files
 * sanitize to `goal: undefined` (absent) and the field round-trips byte-
 * identical for v5 files. Source union is `user_initial | user_pin`; status
 * union is `active | achieved | aborted | superseded`. The hub owns the only
 * write path; `goal.text` is the verify-loop's task field when present.
 *
 * #458 T2 (goal/taskFocus split, SC1/SC2/SC4): `GoalSource` is shrunk to
 * `user_initial | user_pin` — the removed model-propose slot has no writer
 * (T6 model-propose/confirm channel is zero-landing). Legacy disk values
 * that carried the removed slot now fail `isValidGoal` → sanitize throws
 * `schema_invalid` (an executable migrate — never silently dropped). A new
 * optional `taskFocus?: TaskFocusState` field carries the deterministic
 * task focus (#459 term A): on load, a legacy top-level goal with
 * `source === "user_initial"` migrates to `taskFocus` (seeded via
 * `seedTaskFocus`) and the goal field is dropped; `user_pin` goals survive
 * verbatim. `MAX_GOAL_CHARS` + `validateGoalText` gate the /goal and
 * `## GOAL:` write paths at 2000 chars.
 */
import type { AnthropicNativeMessage } from "../../harness/index.js";

/** Why a turn ended in an interrupt state — the checkpoint's discriminating
 *  label. Mirrors the harness StopReason interruption subset (cancelled /
 *  maxTurns / protocolError / timeout) plus `process` (reserved for a
 *  process-level closeout the hub may record later). */
export type InterruptReason =
  "cancelled" | "maxTurns" | "protocolError" | "process" | "timeout";

/** One interrupt snapshot: how far a session had progressed when an
 *  interrupting stop happened (turnCount / messagesCount) plus the label.
 *  `lastUsage` carries the last successful model-call usage when known
 *  (mirrors RunResult.lastUsage; absent → the interrupt saw no usage). */
export interface CheckpointRecord {
  readonly turnIndex: number;
  readonly messagesCount: number;
  readonly interruptedAt: string;
  readonly interruptReason: InterruptReason;
  readonly lastUsage?: unknown;
}

/** v5 (#408): session-level goal — the user's intent for the whole session.
 *  Carries the active goal (the verify-loop's task field binds here when
 *  present, falling back to the current-turn query otherwise) plus a history
 *  of superseded goals from prior re-pins. The hub owns the only write path;
 *  `goal.text` is read-only to all other code. (#458 T2: source union shrunk
 *  to `user_initial | user_pin`; legacy disk values carrying the removed
 *  slot fail validation and sanitize throws `schema_invalid`.) */
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
}

/** v5 (#458 T2): deterministic task focus (#459 term A) — what the current
 *  turn is working on. Distinct from `goal` (the user's pinned intent):
 *  taskFocus is seeded from the first user message, re-pinned via
 *  `## GOAL:` / `/goal`, and cleared via `/goal clear`, all through the
 *  pure `seedTaskFocus` helper (T1 OQ2). The verify-loop binds
 *  `goal.text ?? taskFocus.text ?? query` (SC3). Main-entry text is sliced
 *  to 500 chars on seed; history entries keep the full text (only the main
 *  entry is truncated — T1 OQ2: "历史不截断，仅主条目 text slice 500"). */
export interface TaskFocusHistoryEntry {
  readonly text: string;
  readonly updatedAt: string;
}

export interface TaskFocusState {
  readonly text: string;
  readonly updatedAt: string;
  readonly history?: ReadonlyArray<TaskFocusHistoryEntry>;
}

/** Session file shape (#120 schema v2, v3 = +checkpoints). Loaders sanitize
 *  legacy v1 files. */
export interface SessionFileV1 {
  readonly schemaVersion: number;
  readonly conversation_id: string;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly jsonMode: boolean;
  readonly turnCount: number;
  readonly updatedAt: string;
  /** v2: first user message text, trimmed, truncated to 80 chars.
   *  (#467: renamed from `summary` — it is a UI title excerpt, not an LLM summary.) */
  readonly title: string;
  /** v2: working directory the session was created in. */
  readonly cwd: string;
  /** v2: ISO timestamp of when sanitize last normalized this file. */
  readonly sanitized_at: string;
  /** v3: interrupt snapshots for checkpoint / TUI rewind ([] until a save). */
  readonly checkpoints?: ReadonlyArray<CheckpointRecord>;
  /** v5: session-level goal (#408). Absent on legacy files (loads as
   *  `undefined`); the hub is the only writer and re-pins via `## GOAL:` /
   *  `/goal`. (#458 T2: top-level `user_initial` goals migrate to `taskFocus`
   *  on load — see sanitizeSessionFile — so a goal present after sanitize is
   *  always `user_pin`.) */
  readonly goal?: GoalState;
  /** v5 (#458 T2): deterministic task focus. Optional additive field (SC2) —
   *  absent on files written before #458. Sanitize never repairs a malformed
   *  taskFocus (shape-validated like goal/checkpoints); on load a legacy
   *  `user_initial` goal migrates here via `seedTaskFocus`. */
  readonly taskFocus?: TaskFocusState;
}

export const CURRENT_SCHEMA_VERSION = 5 as const;

/**
 * Validate parsed JSON against the session-file shape.
 * schemaVersion uses a range check (≤ CURRENT accepted → sanitize, > CURRENT
 * rejected) so old files load and future files fail loudly (#120 Boundaries).
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
  // v5 (#458 T2): optional `taskFocus` object — validate shape if present.
  // Mirrors the goal/checkpoints pattern; never silently coerce.
  if (obj["taskFocus"] !== undefined && !isValidTaskFocus(obj["taskFocus"])) {
    return "taskFocus";
  }
  return null;
}

/** Type guard companion to validateSessionFile for callers that want a boolean. */
export function isSessionFileV1(value: unknown): value is SessionFileV1 {
  return validateSessionFile(value) === null;
}

/**
 * Extract a one-line UI title (#467: renamed from the pre-#467 summary helper —
 * it is a title excerpt for the session list, not an LLM summary): the first
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
 * Used to seed the session-level goal (#408 T2) where the full intent matters;
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
 * #408 T3: re-pin the session-level goal.
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
}): GoalState {
  const { current, text, now } = opts;
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
  };
}

/** #458 T2 (SC5): goal text is capped at 2000 chars on both write entries
 *  (`/goal <text>` in cli and the `## GOAL:` directive path in the hub). */
export const MAX_GOAL_CHARS = 2000;

/** #458 T2 (SC5): validate a goal text string. Returns `null` when valid,
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

/** #458 T2 (T1 OQ2): main-entry text cap. `seedTaskFocus` slices the new
 *  primary `text` to this many chars. */
export const MAX_TASK_FOCUS_CHARS = 500;

/** #458 T2 (T1 OQ2 algorithm): deterministic task-focus seed/re-pin.
 *
 *  Switch condition: `(current === undefined) || normalize(nextText) !==
 *  normalize(current.text)` where `normalize = text.trim().toLowerCase()`.
 *  On switch the new `nextText` becomes the primary entry (text sliced to
 *  MAX_TASK_FOCUS_CHARS, updatedAt = `now`) and is prepended to `history[0]`
 *  (capped at 5, deduped by normalized text — a text already present in
 *  history is not re-entered). History entries keep the full untruncated
 *  text (T1 OQ2: 历史不截断，仅主条目 text slice 500).
 *
 *  No-op (same focus re-seeded): returns `current` by reference — idempotent,
 *  `now` is NOT applied (a repeated seed must not stamp a new timestamp).
 *
 *  Used by the hub to seed taskFocus from the first user message and by
 *  sanitize to migrate legacy `user_initial` goals on load.
 */
export function seedTaskFocus(opts: {
  readonly current: TaskFocusState | undefined;
  readonly nextText: string;
  readonly now: string;
}): TaskFocusState {
  const { current, nextText, now } = opts;
  const normalize = (s: string) => s.trim().toLowerCase();
  if (
    current !== undefined &&
    normalize(nextText) === normalize(current.text)
  ) {
    return current;
  }
  const priorHistory = current?.history ?? [];
  // #458 去重规则: 新文本进入 history[0] 时, 若既有 history 已有相同
  // normalize 文本条目则跳过(不重复入 history) — 判定基于插入前的既有
  // history, 重复时不追加新条目。cap 5: 追加后超限挤掉最旧。
  const alreadyPresent = priorHistory.some(
    (entry) => normalize(entry.text) === normalize(nextText)
  );
  const history = alreadyPresent
    ? priorHistory
    : ([{ text: nextText, updatedAt: now }] as TaskFocusHistoryEntry[]).concat(
        priorHistory
      );
  return {
    text: nextText.slice(0, MAX_TASK_FOCUS_CHARS),
    updatedAt: now,
    history: history.slice(0, 5),
  };
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
 * (#120 Boundaries Never: future fields must be preserved, not dropped).
 *
 * Throws { kind: "schema_invalid", field } (matches session-store.ts:49-53
 * `satisfies SessionStoreError` style — structured object literal, not a bare
 * Error) so the caller can attach `conversation_id` and rethrow a full
 * SessionStoreError.
 *
 * Why sanitize never repairs `messages`: authoritative history is immutable
 * (#120 Boundaries Never). A malformed message element is a hard reject.
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
  // only write path. (#458 T2: a legacy `user_initial` goal migrates to
  // `taskFocus` and is dropped — see below.)
  //
  // #458 T2 migration: legacy `user_initial` top-level goals only exist on
  // pre-#459 disk. The deterministic task-focus seed path now replaces the
  // goal-seed path, so on load we upgrade the data forward: build a fresh
  // `taskFocus` via `seedTaskFocus({ current: undefined, nextText: goal.text,
  // now: sanitized_at })` and drop the `goal` field. `user_pin` goals are
  // preserved verbatim (the spread below keeps them). Values from the
  // removed model-propose slot never reach here — validateSessionFile
  // rejects them with `schema_invalid` (an executable migrate, not a
  // silent drop — SC1).
  const rawGoal = obj["goal"] as GoalState | undefined;
  const migratedTaskFocus =
    rawGoal !== undefined && rawGoal.source === "user_initial"
      ? seedTaskFocus({
          current: undefined,
          nextText: rawGoal.text,
          now:
            typeof obj["sanitized_at"] === "string"
              ? (obj["sanitized_at"] as string)
              : (obj["updatedAt"] as string),
        })
      : undefined;
  // Build the result with conditional goal/taskFocus keys to preserve
  // byte-identical round-trip for v4/v5 files that lack these fields
  // (spread-discipline: never emit `field: undefined` keys). The migration
  // case explicitly drops the old goal key (no stale goal persists).
  // #467 T3: title 字段迁移。legacy 命名 `summary` 是首条 user 文本的 UI
  // 标题摘录(非 LLM 摘要),现改名 `title`。迁移规则:优先取遗留 `summary`
  // (旧盘文件),其次取已写的 `title`,都没有则从
  // 首条 user 文本重算(extractTitle,语义与旧命名时代的计算完全一致)。
  // 输出 key 恒为 `title` —— 遗留 `summary` key 在迁移后删除,绝不存活进
  // 新文件(spread-preserve 纪律:未知字段保留,但旧名字是已知过期字段)。
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
    // 不管 value 类型(string / null / number / object)都删除:
    // legacy `summary` 是过期字段,迁移后绝不存活进新文件
    // (#467 review-fix Medium:之前用 typeof === 'string' 判,非 string 值会漏过)。
    delete result["summary"];
  }
  if (migratedTaskFocus !== undefined) {
    delete result["goal"];
    result["taskFocus"] = migratedTaskFocus;
  }
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
  // schema v4 (#383 B2): `system` role 进入白名单 —— Ctrl+C 打断作为
  // transcript 事件持久化（仅展示层，绝不喂 provider）。`system` 消息与
  // turn 切片正交：splitTurns 按 turn-projection.ts `isTurnQuery` 规则切片
  // （`role === "user"` 且无 tool_result 块且非 subagent drain summary，
  // 与 checkpoint.ts / hub.ts 同一 SSOT），system 项自然落在相邻 turn 的
  // 间隙，不影响 rewind 锚点。
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
    // thinking / redacted_thinking：harness 权威消息可含（#151 thinking
    // 启用后 anthropic-adapter 原样保留）；形状对齐 AnthropicContentBlock。
    // T1: harness retains thinking blocks (with signature) in the
    // authoritative history. The session store must accept them on save
    // and replay them verbatim — otherwise the wire thinking view has
    // nothing to project after a real thinking turn.
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
    VALID_INTERRUPT_REASONS.has(r["interruptReason"] as InterruptReason)
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

/** Deep-validate the #458 `taskFocus` object (text + updatedAt required,
 *  optional history array). Reject-first like goal/checkpoints: a malformed
 *  taskFocus would silently break the verify-loop's task-field binding
 *  (`goal.text ?? taskFocus.text ?? query`), so it must fail loudly. */
function isValidTaskFocus(t: unknown): boolean {
  if (t === null || typeof t !== "object") return false;
  const focus = t as Record<string, unknown>;
  if (typeof focus["text"] !== "string") return false;
  if (typeof focus["updatedAt"] !== "string") return false;
  if (focus["history"] === undefined) return true;
  if (!Array.isArray(focus["history"])) return false;
  return (focus["history"] as ReadonlyArray<unknown>).every(
    isValidTaskFocusHistory
  );
}

function isValidTaskFocusHistory(h: unknown): boolean {
  if (h === null || typeof h !== "object") return false;
  const entry = h as Record<string, unknown>;
  return (
    typeof entry["text"] === "string" && typeof entry["updatedAt"] === "string"
  );
}
