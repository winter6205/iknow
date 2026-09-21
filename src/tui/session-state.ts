/**
 * TUI session state machine. Pure TS: no ink / OpenTUI dependencies.
 *
 * Business constraints:
 *  - run tri-state `idle` / `running-fg` / `running-bg` (time-sliced
 *    active-one; switching away mid-turn keeps the turn running in background);
 *  - view tri-state `chat` / `list` / `mcp`;
 *  - message discipline: `ReadonlyArray` + `Object.freeze`, whole-array
 *    replacement, never mutate.
 *
 * All transitions are pure functions (discriminated state in -> new state
 * out); the UI layer (app.tsx hook) only orchestrates.
 */

import type {
  AnthropicNativeMessage,
  StopReason,
  TokenUsage,
} from "../harness/model-adapter/types.js";
import { isAgentStatusText } from "../harness/agent-status.js";
import { isGraphModeText } from "../harness/graph/notification.js";
import { isSubagentDrainText } from "../harness/subagent/host-drain.js";
import { isVerifyInjectedText } from "../harness/verify/inject.js";
import { stripPrefetchOverlay } from "../harness/memory/prefetch.js";
import {
  SKILL_LOAD_PREFIX,
  SKILL_LOAD_PREFIX_SHORT,
} from "../harness/skill/body.js";
import { isSkillIndexDeltaText } from "../harness/skill/index-delta.js";
import type { SessionFileV1 } from "../session-api/store/schema.js";

export type SessionRunState = "idle" | "running-fg" | "running-bg";
export type TuiView = "chat" | "list" | "mcp";

/** In-memory placeholder key for an unmaterialized session (lazy create: it enters SessionStore only when the first message is sent). */
export const DRAFT_SESSION_ID = "__draft__";

export interface TuiSessionState {
  /** undefined = lazy draft (createSession not yet called). */
  readonly conversationId: string | undefined;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  /** Cumulative turnCount (from the session file / postMessage receipt; run()'s internal counter starts from 0 and differs). */
  readonly turnCount: number;
  /** ISO timestamp; "" for a draft. */
  readonly updatedAt: string;
  readonly jsonMode: boolean;
  readonly runState: SessionRunState;
  /** Stop reason of the latest turn (display only). */
  readonly lastStopReason: StopReason | undefined;
  /** Token usage of the latest turn (context-usage display; runtime receipts only). */
  readonly lastUsage: TokenUsage | null;
  /**
   * ADR-0037: the session's current working root (the task-worktree path
   * persisted on rebind). undefined = unbound (feature OFF / no mutation
   * yet) -> display layer adds no extra state. Read-only projection: the TUI
   * performs no git operations; the session file is the sole display source.
   */
  readonly workspaceRoot: string | undefined;
  /**
   * Persisted thinking-duration parallel array (one slot per message).
   * Same spread discipline as `SessionFileV1.thinkingMs`: an undefined
   * element = no thinkingMs at that position (non-streaming turn / legacy
   * file / non-assistant); the whole key absent = no thinkingMs anywhere in
   * the chain (legacy session). Consumers (turn-activity
   * sumThinkingMsInRange) count those as 0; the fold line shows "thought for
   * N seconds" only when the total > 0, otherwise tool counts alone.
   */
  readonly thinkingMs?: ReadonlyArray<number | null>;
}

/** Create a draft session (startup lands directly in a new-session chat view; no disk touch). */
export function createDraftSession(): TuiSessionState {
  return Object.freeze({
    conversationId: undefined,
    messages: Object.freeze([]) as ReadonlyArray<AnthropicNativeMessage>,
    turnCount: 0,
    updatedAt: "",
    jsonMode: false,
    runState: "idle",
    lastStopReason: undefined,
    lastUsage: null,
    workspaceRoot: undefined,
    // A draft has no thinkingMs; fold-cluster sums count 0.
    thinkingMs: undefined,
  });
}

/** Restore from a persisted session file (`iknow tui <session-id>` / Enter from the list view). */
export function attachSession(file: SessionFileV1): TuiSessionState {
  return Object.freeze({
    conversationId: file.conversation_id,
    messages: Object.freeze([...file.messages]),
    turnCount: file.turnCount,
    updatedAt: file.updatedAt,
    jsonMode: file.jsonMode,
    runState: "idle",
    lastStopReason: undefined,
    // #1079: reopen replays the file's persisted usage snapshot so a session
    // that ever had a successful usage never reopens at 0%. Missing field
    // (legacy file / never-successful session) → null → 0% (never chars/N).
    lastUsage: file.lastUsage ?? null,
    // ADR-0037: the rebound task-worktree root is restored with the session file (still current after restart).
    workspaceRoot: file.workspaceRoot,
    // Carry the persisted parallel array into session state — fold lines
    // read it from here (replacing the deleted in-memory thinking-seconds side channel).
    thinkingMs: file.thinkingMs,
  });
}

/** Turn start: only idle can start (a double start is a caller bug — keep the state unchanged, never throw). */
export function turnStarted(session: TuiSessionState): TuiSessionState {
  if (session.runState !== "idle") return session;
  return Object.freeze({ ...session, runState: "running-fg" });
}

/**
 * Switching away from this session: running-fg -> running-bg (execution
 * continues in background); an idle session is unchanged; switching away
 * again while running-bg stays running-bg.
 */
export function switchedAwayFrom(session: TuiSessionState): TuiSessionState {
  if (session.runState !== "running-fg") return session;
  return Object.freeze({ ...session, runState: "running-bg" });
}

/** Switching back to this session: running-bg -> running-fg; idle unchanged. */
export function switchedTo(session: TuiSessionState): TuiSessionState {
  if (session.runState !== "running-bg") return session;
  return Object.freeze({ ...session, runState: "running-fg" });
}

export interface TurnFinishedInput {
  readonly conversationId: string;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly turnCount: number;
  readonly updatedAt: string;
  readonly jsonMode: boolean;
  readonly stopReason: StopReason;
  /** This turn's token usage (passed through from the bridge.postMessage
   *  receipt; absent / none -> null). Optional encodes the explicit
   *  "omitted means null" semantics and keeps the existing call surface
   *  compiling without lastUsage. */
  readonly lastUsage?: TokenUsage | null;
  /**
   * ADR-0037: workspaceRoot from the persisted file at turn end (carried by
   * rebind turns). Absent = no rebind this turn (or the file refresh
   * failed) -> keep the existing value, never clear it by mistake.
   */
  readonly workspaceRoot?: string;
  /**
   * thinkingMs parallel array from the persisted file at turn end. Absent =
   * no refreshed view this turn (file IO failure) -> keep the existing
   * value, never clear it by mistake.
   */
  readonly thinkingMs?: ReadonlyArray<number | null>;
}

/** Turn end (natural completion / cancelled / timeout all land here): back to idle + whole frozen replacement. */
export function turnFinished(
  session: TuiSessionState,
  input: TurnFinishedInput
): TuiSessionState {
  return Object.freeze({
    ...session,
    conversationId: input.conversationId,
    messages: Object.freeze([...input.messages]),
    turnCount: input.turnCount,
    updatedAt: input.updatedAt,
    jsonMode: input.jsonMode,
    runState: "idle",
    lastStopReason: input.stopReason,
    lastUsage: input.lastUsage ?? null,
    // ADR-0037: rebind turns carry the new root; normal turns omit it -> keep the existing bound value.
    workspaceRoot: input.workspaceRoot ?? session.workspaceRoot,
    // Refresh thinkingMs from the persisted file; absent -> keep the existing array (partial-recovery case).
    thinkingMs: input.thinkingMs ?? session.thinkingMs,
  });
}

/**
 * #1079 call-beat: replace the usage reading mid-run when a context_usage
 * stream event arrives (pre-call measurement or post-call correction),
 * without touching run state or messages. Whole-replacement freeze discipline
 * as in every other reducer here.
 */
export function withLastUsage(
  session: TuiSessionState,
  usage: TokenUsage
): TuiSessionState {
  return Object.freeze({ ...session, lastUsage: usage });
}

/** Foreground interrupt guard (consumed by Esc): only running-fg can be interrupted. */
export function canInterrupt(session: TuiSessionState): boolean {
  return session.runState === "running-fg";
}

/**
 * Instant user-message echo — right after submit, before any delta arrives,
 * append the user text to messages so the conversation updates immediately
 * (no waiting for turn end + file re-read).
 *
 * Why called after turnStarted: runState stays running-fg (the echo changes
 * no run state) and conversationId / turnCount etc. are untouched. At turn
 * end / abort the persisted messages atomically replace the intermediate
 * state.
 *
 * Empty text (after trim) is not appended and the original state is
 * returned — blank input must never pollute messages.
 *
 * Echo and sent text may differ: this function receives the *display form*
 * (displayText), a temporary stand-in in the user-visible session. For
 * skill-load, the sent text embeds the skill body (into model history) while
 * the display form shows a compact placeholder ("[加载技能 X]") so the body
 * never leaks into the session view. turnFinished still replaces everything
 * with the authoritative persisted messages (body included — an accepted
 * running->complete shape switch).
 */
export function userMessageEchoed(
  session: TuiSessionState,
  displayText: string
): TuiSessionState {
  if (displayText.trim().length === 0) return session;
  const userMessage: AnthropicNativeMessage = Object.freeze({
    role: "user",
    content: Object.freeze([{ type: "text" as const, text: displayText }]),
  });
  return Object.freeze({
    ...session,
    messages: Object.freeze([...session.messages, userMessage]),
  });
}

/**
 * Session refresh after manual compaction (/compact): replace messages /
 * turnCount / updatedAt with the compacted file content, but **keep**
 * lastStopReason / lastUsage (compaction is not a turn; the context-usage
 * reading must not be cleared), runState back to idle. Only idle sessions
 * compact (the command-side guard rejects while running; here, same
 * semantics as turnStarted: non-idle keeps the state unchanged).
 */
export function sessionCompacted(
  session: TuiSessionState,
  input: {
    readonly messages: ReadonlyArray<AnthropicNativeMessage>;
    readonly turnCount: number;
    readonly updatedAt: string;
    readonly jsonMode: boolean;
  }
): TuiSessionState {
  if (session.runState !== "idle") return session;
  return Object.freeze({
    ...session,
    messages: Object.freeze([...input.messages]),
    turnCount: input.turnCount,
    updatedAt: input.updatedAt,
    jsonMode: input.jsonMode,
    runState: "idle",
  });
}

/**
 * Session refresh after rewind (/rewind / double-Esc): mirrors
 * sessionCompacted — wholesale replacement of messages / turnCount /
 * updatedAt / jsonMode with the truncated file, but **keep**
 * lastStopReason / lastUsage (rewind is not a turn; the usage reading must
 * not be cleared), runState back to idle. Only idle sessions rewind (the
 * command-side guard rejects while running; non-idle keeps the state
 * unchanged here, never throws).
 */
export function sessionRewound(
  session: TuiSessionState,
  input: {
    readonly messages: ReadonlyArray<AnthropicNativeMessage>;
    readonly turnCount: number;
    readonly updatedAt: string;
    readonly jsonMode: boolean;
  }
): TuiSessionState {
  if (session.runState !== "idle") return session;
  return Object.freeze({
    ...session,
    messages: Object.freeze([...input.messages]),
    turnCount: input.turnCount,
    updatedAt: input.updatedAt,
    jsonMode: input.jsonMode,
    runState: "idle",
  });
}

/**
 * Join all text blocks of a user message with "\n". Used by the input
 * history seed below and by the hidden-message classifier.
 *
 * Input-history (up-arrow recall) seeding rules: persisted query user
 * messages are projected to history in turn order, so after session restore
 * (`iknow tui <session-id>` / /sessions Enter) up-arrow works immediately
 * — previously history lived only in process memory and was empty after
 * restore.
 *
 * Query discrimination shares its source with checkpoint.ts isQuery
 * (mirroring hub.ts projectMessagesToTurns): `role === "user"` and no
 * tool_result block in content — a tool_result echo continues the turn, it
 * is not a new question.
 *
 * Drop rules (consistent with the submit path app.tsx handleSubmit):
 *  - empty after trim;
 *  - starts with `[skill-load `: the skill-load proxy body is persisted into
 *    the transcript but must not pollute up-arrow history (display uses the
 *    "[加载技能 X]" placeholder convention);
 *  - host-drain / verify / graph_mode envelopes: model-directed injections,
 *    not user keystrokes (same source as isTurnQuery skipping drain; covers
 *    the VALIDATION FAILED / VERIFY rerun / `<graph_mode>` notices).
 * Adjacent-duplicate suppression matches the submit path
 * (`h[h.length-1] === text`); non-adjacent repeats are kept (genuine re-ask).
 */
export function joinedUserText(message: AnthropicNativeMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

/**
 * Host-injected user messages that must not render as typed bubbles
 * (agent_status bar + graph_mode notifications + drain summaries + verify
 * envelopes + skill-index delta listings). Model history still holds them;
 * TUI status/todo footer reads agent_status stream events.
 */
export function isTuiHiddenUserMessage(
  message: AnthropicNativeMessage
): boolean {
  if (message.role !== "user") return false;
  const text = joinedUserText(message).trim();
  if (text.length === 0) return false;
  return (
    isAgentStatusText(text) ||
    isGraphModeText(text) ||
    isSubagentDrainText(text) ||
    isVerifyInjectedText(text) ||
    isSkillIndexDeltaText(text)
  );
}

/**
 * Skill-load chip projection (render-side SSOT).
 *
 * Extracts `{name, remainder}` from user-message text for the TUI user
 * branch; the SKILL body never enters the ❯ bubble. Model history still
 * receives the `buildSkillLoadText` envelope (session-api side unchanged);
 * the TUI simply does not draw the body.
 *
 * Accepted shape (matching `buildSkillLoadText` assembly):
 *   `[skill-load name="<name>"]\n<body>[ + \n\n<remainder>]`
 *
 * Rejected shapes (return null -> plain user-text rendering):
 *   - does not start with `[skill-load ` at all;
 *   - no closing `"` after `[skill-load name="` (short prefix hit, name unclosed);
 *   - no `\n` after `]` (not the buildSkillLoadText shape).
 *
 * Edges:
 *   - huge body: lastIndexOf `\n\n` still locates the single separator that
 *     buildSkillLoadText adds (by convention `createSkillBody` ends with
 *     `</skill_files>` without a trailing `\n\n`, so the body itself never
 *     collides with the separator);
 *   - non-empty remainder -> extracted;
 *   - empty remainder -> still a hit (chip-only path);
 *   - `\n\n` inside the body: only the last one is buildSkillLoadText's separator.
 */
export interface SkillLoadProjection {
  readonly name: string;
  readonly remainder: string;
}

export function projectSkillLoadUserText(
  text: string
): SkillLoadProjection | null {
  // A persisted user turn may carry the memory-prefetch overlay prefix
  // (attachPrefetchOverlay: overlay + MEMORY_PREFETCH_END + envelope).
  // Strip before matching, otherwise the projection fails after reload and
  // the whole body overflows into the rendering.
  const stripped = stripPrefetchOverlay(text);
  if (!stripped.startsWith(SKILL_LOAD_PREFIX_SHORT)) return null;
  // Closed shape: `[skill-load name="..."]` requires `name="` right after the short prefix.
  if (!stripped.startsWith(SKILL_LOAD_PREFIX)) return null;
  const afterPrefix = stripped.slice(SKILL_LOAD_PREFIX.length);
  const closingQuote = afterPrefix.indexOf('"');
  if (closingQuote === -1) return null;
  const name = afterPrefix.slice(0, closingQuote);
  // Between the closing ] and the body there must be a `\n`
  // (buildSkillLoadText assembly convention); otherwise it is not a valid
  // shape -> fall back to plain text.
  const afterName = afterPrefix.slice(closingQuote + 1);
  if (!afterName.startsWith("]\n")) return null;
  const tail = afterName.slice("]\n".length);
  // buildSkillLoadText appends `\n\n<remainder>` only when the remainder is
  // non-empty, exactly once. But the body itself (createSkillBody output)
  // contains multiple `\n\n` separations and ends with `</skill_files>` —
  // relying on lastIndexOf `\n\n` alone would misread the body tail as the
  // remainder. Anchor on the fixed body-ending `</skill_files>` to locate
  // the separator: `</skill_files>\n\n<remainder>` -> split; otherwise the
  // remainder is empty. With an empty body (rare) the tail degrades to the
  // `\n\n<remainder>`-prefixed shape (empty body + non-empty remainder still
  // carries the `\n\n` prefix).
  const marker = "</skill_files>";
  const markerIdx = tail.lastIndexOf(marker);
  if (markerIdx !== -1) {
    const after = tail.slice(markerIdx + marker.length);
    if (after.startsWith("\n\n")) {
      return { name, remainder: after.slice("\n\n".length) };
    }
    return { name, remainder: "" };
  }
  if (tail.startsWith("\n\n") && tail.length > "\n\n".length) {
    return { name, remainder: tail.slice("\n\n".length) };
  }
  // No marker and no empty-body separator -> degrade to lastIndexOf
  // `\n\n` (compatibility with synthetic test text and historical envelope
  // shapes whose body lacks `</skill_files>`). By convention the body never
  // ends with `\n\n`, so a hit is buildSkillLoadText's separator (rare path).
  const fallbackSep = tail.lastIndexOf("\n\n");
  if (fallbackSep !== -1) {
    return { name, remainder: tail.slice(fallbackSep + "\n\n".length) };
  }
  return { name, remainder: "" };
}

export function seedInputHistory(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<string> {
  const history: string[] = [];
  for (const message of messages) {
    if (
      message.role !== "user" ||
      message.content.some((block) => block.type === "tool_result")
    ) {
      continue;
    }
    const text = stripPrefetchOverlay(joinedUserText(message)).trim();
    if (text.length === 0) continue;
    if (text.startsWith(SKILL_LOAD_PREFIX_SHORT)) continue;
    if (isTuiHiddenUserMessage(message)) continue;
    if (history[history.length - 1] === text) continue;
    history.push(text);
  }
  return Object.freeze(history);
}

/**
 * Append one input-history entry (submit path; replaces the inline updater
 * in app.tsx handleSubmit, so the semantics must match point by point):
 *  - blank input (empty after trim) -> not appended, original reference
 *    returned — app.tsx setState relies on reference equality to skip re-render;
 *  - text is not re-trimmed (upstream handleSubmit already did `raw.trim()`),
 *    stored exactly as given;
 *  - adjacent-duplicate suppression: equal to the last entry -> original
 *    reference (same `h[h.length-1] === text` rule as the seed path);
 *    non-adjacent repeats are out of scope here;
 *  - otherwise return a new frozen array (ReadonlyArray discipline: whole
 *    replacement, never mutate).
 */
export function appendInputHistory(
  history: ReadonlyArray<string>,
  text: string
): ReadonlyArray<string> {
  if (text.trim().length === 0) return history;
  if (history[history.length - 1] === text) return history;
  return Object.freeze([...history, text]);
}
