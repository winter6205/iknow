/**
 * Real-user-message discrimination predicate (harness-layer SSOT) for the
 * agent-status instruction echo.
 *
 * Boundaries:
 *   - `extractLatestRealUserInstruction` scans `messages` backwards for the
 *     first **real** user message: it excludes every host injection in the
 *     `isHostInjectedUserText` roster and strips the memory prefetch overlay
 *     (when a marker is present, take the segment after the **last** marker
 *     — prefer under-extraction to over-extraction); a skill-load envelope
 *     counts as a real user message but the instruction is taken from the
 *     remainder after `\n\n` (the first line is the assembled envelope, not
 *     the user's words; empty remainder → keep scanning);
 *   - extraction = first line (before `\n`), trim trailing whitespace,
 *     truncate to 100 **codepoints** (Array.from count, not UTF-16 units),
 *     no ellipsis when over the cap (verbatim discipline); an empty first
 *     line → this message offers no valid instruction source, keep scanning;
 *   - pure reading, zero throws; no LLM / adapter involvement (pinned by a
 *     grep-lock seam test in tests/harness/);
 *   - the line-prefix roster (MCP reconnect / LOOP_DETECTED / the three
 *     compact seams / drain / the two verify envelopes) lands here as the
 *     exported SSOT `HOST_INJECTION_LINE_ANCHORS`: prefix constants are
 *     taken from their producers so drift is excluded structurally; the
 *     seam-completeness lock verifies each entry against the real producer
 *     constants (loop-engine / tool-loop-detect / full-compact), and a new
 *     injection seam missing from the roster turns the test red; the
 *     outbound projection consumes this same roster (no hand-copied twin);
 *   - does not import loop-engine (it will consume this module; avoids a
 *     cycle) and does not import the TUI (harness must not depend upward).
 */
import type { AnthropicNativeMessage } from "./model-adapter/types.js";
import { isAgentStatusText } from "./agent-status.js";
import { isGraphModeText } from "./graph/notification.js";
import { SUBAGENT_DRAIN_PREFIX } from "./subagent/host-drain.js";
import {
  EVIDENCE_RERUN_PREFIX,
  NOT_RUN_PREFIX,
  VALIDATION_FAILED_PREFIX,
} from "./verify/inject.js";
import { isSkillIndexDeltaText } from "./skill/index-delta.js";
import { isSkillLoadText } from "./skill/body.js";
import { MEMORY_PREFETCH_END } from "./memory/prefetch.js";

/** Instruction echo cap (codepoints). */
export const INSTRUCTION_MAX_CODEPOINTS = 100;

// Roster prefix anchors (each producer noted below; the seam-lock test catches drift).

/** = fixed start of loop-engine's `MCP_RECONNECT_NOTIFICATION_TEMPLATE`. */
export const MCP_RECONNECT_INJECTION_PREFIX = "MCP server '";
/** = fixed start of tool-loop-detect's `LOOP_DETECTED_TEXT`. */
export const LOOP_DETECTED_INJECTION_PREFIX = "LOOP_DETECTED:";
/** = fixed start of compress/full-compact `buildCompactPrompt()` (NO_TOOLS_PREAMBLE). */
export const COMPACT_REQUEST_INJECTION_PREFIX =
  "CRITICAL: Respond with TEXT ONLY.";
/** = fixed start of loop-engine's private `SUMMARY_PROMPT` (kept in the roster conservatively even if unpersisted — filter one too many rather than one too few). */
export const STOP_SUMMARY_INJECTION_PREFIX =
  "Briefly summarize in a few sentences";
/** = full-compact `SUMMARY_PREAMBLE` (the compact summary artifact, persisted into prior history as a user message). */
export const COMPACT_SUMMARY_INJECTION_PREFIX =
  "This session is being continued from a previous conversation";

const PREFIX_ANCHORS: ReadonlyArray<string> = [
  MCP_RECONNECT_INJECTION_PREFIX,
  LOOP_DETECTED_INJECTION_PREFIX,
  COMPACT_REQUEST_INJECTION_PREFIX,
  STOP_SUMMARY_INJECTION_PREFIX,
  COMPACT_SUMMARY_INJECTION_PREFIX,
];

/**
 * The single authoritative roster of line-prefix host-injection anchors:
 *
 // (ADR-0112)
 * both the discrimination predicate and the outbound projection
 * (`HOST_LINE_ANCHORS` in outbound-projection) consume this array,
 * eliminating hand-maintained parallel copies; roster-to-predicate
 * consistency is walked entry-by-entry by the projection drift-lock test.
 * Tag-framed forms (`<agent_status>` / `<graph_mode>` /
 * `<available_skills>`) are not listed here — they are escaped by the
 * projection's TAG rules (constants likewise sourced from the producers).
 */
export const HOST_INJECTION_LINE_ANCHORS: ReadonlyArray<string> = Object.freeze(
  [
    ...PREFIX_ANCHORS,
    SUBAGENT_DRAIN_PREFIX,
    VALIDATION_FAILED_PREFIX,
    EVIDENCE_RERUN_PREFIX,
    NOT_RUN_PREFIX,
  ]
);

/**
 * Discrimination roster (current full set): matching any entry means host
 * injection, not operator keystrokes. The skill-load envelope is **not** in
 * the roster — it counts as a real user message and the extraction rules
 * handle it separately.
 */
export function isHostInjectedUserText(text: string): boolean {
  if (
    isAgentStatusText(text) ||
    isGraphModeText(text) ||
    isSkillIndexDeltaText(text)
  ) {
    return true;
  }
  const trimmed = text.trimStart();
  return HOST_INJECTION_LINE_ANCHORS.some((p) => trimmed.startsWith(p));
}

/**
 * Strip the memory prefetch overlay: when a marker is present, take the
 * segment after the **last** marker as the original text (the user may have
 * pasted the marker into their own message; prefer under-extraction). No
 * marker → the whole text. Deliberately does not reuse `stripPrefetchOverlay`
 * from memory/prefetch.ts (that one takes the first marker and also strips
 * the legacy advisory — different semantics from this face).
 */
export function stripMemoryPrefetchOverlay(text: string): string {
  const idx = text.lastIndexOf(MEMORY_PREFETCH_END);
  return idx >= 0 ? text.slice(idx + MEMORY_PREFETCH_END.length) : text;
}

/** Concatenate a user message's text blocks (same joinedUserText shape as the TUI side, without importing it). */
function joinedUserText(message: AnthropicNativeMessage): string {
  return message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n");
}

/** Truncate to 100 codepoints: never split a character, never add an ellipsis (verbatim discipline). */
function truncateCodePoints(line: string): string {
  const cps = Array.from(line);
  return cps.length <= INSTRUCTION_MAX_CODEPOINTS
    ? line
    : cps.slice(0, INSTRUCTION_MAX_CODEPOINTS).join("");
}

/**
 * skill-load envelope → the remainder after `\n\n`; no `\n\n` or a
 * whitespace-only remainder → null (this message offers no instruction
 * source; keep scanning).
 */
function skillLoadRemainder(source: string): string | null {
  const idx = source.indexOf("\n\n");
  if (idx < 0) return null;
  const remainder = source.slice(idx + 2);
  return remainder.trim().length === 0 ? null : remainder;
}

/** One overlay-stripped, roster-checked source → the effective instruction line (first line) or null. */
function instructionLine(source: string): string | null {
  const text = isSkillLoadText(source) ? skillLoadRemainder(source) : source;
  if (text === null) return null;
  const firstLine = text.split("\n", 1)[0]!.trimEnd();
  return firstLine.length === 0 ? null : truncateCodePoints(firstLine);
}

/** Extraction result: the matched message's object reference (for reconcile correlation) + the verbatim instruction line. */
export interface RealUserInstruction {
  readonly message: AnthropicNativeMessage;
  readonly instruction: string;
}

/**
 * SSOT predicate: scan `messages` backwards for the first real user message
 * and extract its instruction. No real user message / all first lines empty
 * → null. Pure function, never throws.
 */
export function extractLatestRealUserInstruction(
  messages: ReadonlyArray<AnthropicNativeMessage>
): RealUserInstruction | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const joined = joinedUserText(m);
    if (joined.length === 0) continue; // tool_result-only message, no text blocks
    const source = stripMemoryPrefetchOverlay(joined);
    if (isHostInjectedUserText(source)) continue;
    const line = instructionLine(source);
    if (line === null) continue;
    return Object.freeze({ message: m, instruction: line });
  }
  return null;
}
