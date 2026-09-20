/**
 * Status-bar current snapshot — pure constructor + IO reader.
 *
 // (ADR-0028)
 *
 * Boundaries:
 *   - `buildAgentStatusText` is pure (no IO / time / randomness); the TUI
 *     reads the latest snapshot and reuses the same computation to emit
 *     events, without coupling to message-encoding internals;
 *   - `readOpenTodoLines` only projects unfinished items (pending +
 *     in_progress, never completed) from `<projectDir>/<conversationId>/todos.md`,
 *     normalized through the ledger-syntax SSOT into id-bearing lines
 *     (`- [ ] [tN] subject` / `- [~] [tN] subject`); missing file / empty
 *     file / all completed / read failure → empty list, and a read failure
 *     is never thrown into a model turn (silently treated as "no todo
 *     section"); `projectDir` is the session-folder root
 *     (`resolveProjectSessionDir(baseDir, projectIdentityRoot)`), derived by
 *     the chat / serve / TUI entries from the same `(baseDir,
 *     projectIdentityRoot)` pair so one conversation always resolves to the
 *     same projectDir;
 *   - the bar text carries only computed current state (last_tool + open
 *     todo section), no policy prose / read rules / skip conditions (those
 *     belong to the system prefix and the tool description). Empty slots
 *     are not advertised: with nothing open, the section is absent entirely.
 *
 * This module does not change todo_write's read/add/update/replace semantics
 * (ADR-0085's three operations plus the whole-table replace escape hatch;
 * `check` folded into update) — it only reads the files.
 */
import { readFile } from "node:fs/promises";
import type { AnthropicNativeMessage } from "./model-adapter/types.js";
import { formatLedgerLine, parseLedger } from "./aci/tools/todo-ledger.js";
import { resolveConversationTodoPath } from "./aci/tools/todo-write.js";

// Projection anchor: the ledger-syntax SSOT is parseLedger / formatLedgerLine
// in todo-ledger.ts — projection rebuilds canonical lines (correct id and
// status marks) instead of passing raw line prefixes through, so the writer
// side and the projection side share one grammar and malformed / legacy
// lines take the same parse path.

/** last_tool value when no tool has run yet in this turn. */
// (ADR-0028)
export const AGENT_STATUS_IDLE_TOOL = "idle";

/**
 * Fixed text of the reconcile line: it is a line inside the bar, not system
 * text, byte-constant across turns and sessions. Exported as a constant for
 * tests and the injection-roster completeness lock.
 */
export const AGENT_STATUS_RECONCILE_LINE =
  "reconcile: A new user instruction has arrived; if it conflicts with the current todo ledger, reconcile the ledger via todo_write first, then continue.";

/** Snapshot data: single source of truth for the bar text; the TUI emits events from the same data. */
export interface AgentStatusSnapshot {
  /** Tool that just completed on the previous hop (run-scoped); "idle" before the first tool this turn. */
  readonly lastTool: string;
  /** Canonical ledger lines of open items (pending + in_progress, with ids); empty when none. */
  readonly openTodoLines: ReadonlyArray<string>;
  /**
   * Verbatim first line of the latest real user instruction; null / absent
   *
   // (ADR-0103)
   * → the whole line is absent (empty slots are not advertised). Optional
   * so assembly points predating the wiring compile unchanged; the parse
   * side always gives null explicitly.
   */
  readonly instruction?: string | null;
  /**
   * Whether this bar carries the one-shot pivot reconcile marker after a
   * new instruction; false / absent → line absent. The settlement algorithm
   * lives in the loop engine; this only carries the field.
   */
  readonly reconcile?: boolean;
}

/**
 * Pure constructor: snapshot data → bar text.
 *
 * Shape (minimal machine-readable `<agent_status>` wrapper):
 *
 * ```
 * <agent_status>
 * last_tool: <name>
 * instruction: <first line of the latest real user instruction, verbatim> (null / absent → line absent)
 * reconcile: <fixed marker sentence> (false / absent → line absent)
 * todos:
 * - [ ] <item>
 * </agent_status>
 * ```
 *
 * instruction / reconcile / todo sections all follow "empty slots are not
 * advertised"; scalar sections always precede the `todos:` header (ordering
 * discipline).
 */
/** Official frame open/close tag literals: the outbound projection's
 * (ADR-0112)
 *  TAG-escape roster is assembled from these constants, so producer and
 *  escaper share one source and hand-copied literals cannot drift. */
export const AGENT_STATUS_OPEN_TAG = "<agent_status>";
export const AGENT_STATUS_CLOSE_TAG = "</agent_status>";

/** Bar-text shape detector (shared by TUI injected-bubble hiding, turn boundaries, test fixtures). */
export function isAgentStatusText(text: string): boolean {
  return text.trimStart().startsWith(AGENT_STATUS_OPEN_TAG);
}

export function buildAgentStatusText(snapshot: AgentStatusSnapshot): string {
  // Ordering discipline: all scalar field lines come before the `todos:`
  // header and todo lines always occupy the bar tail — this is what lets an
  // older parser eat a newer bar and still get the correct subset (rollback
  // safety).
  const lines: string[] = [
    AGENT_STATUS_OPEN_TAG,
    `last_tool: ${snapshot.lastTool}`,
  ];
  if (snapshot.instruction !== null && snapshot.instruction !== undefined) {
    lines.push(`instruction: ${snapshot.instruction}`);
  }
  if (snapshot.reconcile === true) {
    lines.push(AGENT_STATUS_RECONCILE_LINE);
  }
  if (snapshot.openTodoLines.length > 0) {
    lines.push("todos:");
    lines.push(...snapshot.openTodoLines);
  }
  lines.push(AGENT_STATUS_CLOSE_TAG);
  return lines.join("\n");
}

const LAST_TOOL_PREFIX = "last_tool: ";
const INSTRUCTION_PREFIX = "instruction: ";
const RECONCILE_PREFIX = "reconcile: ";

/**
 * Bar text → snapshot (TUI resume hydrate / direct tests). Malformed input →
 * null, no throw. Older-format bars (no instruction / reconcile lines) are
 * valid input → explicit defaults `instruction: null, reconcile: false`
 * (not treated as malformed).
 */
export function parseAgentStatusText(text: string): AgentStatusSnapshot | null {
  if (!isAgentStatusText(text)) return null;
  const lines = text.split("\n");
  if (lines.length < 2) return null;
  if (lines[0] !== AGENT_STATUS_OPEN_TAG) return null;
  if (lines[lines.length - 1] !== AGENT_STATUS_CLOSE_TAG) return null;
  const body = lines.slice(1, -1);
  const lastToolLine = body.find((l) => l.startsWith(LAST_TOOL_PREFIX));
  if (lastToolLine === undefined) return null;
  const instructionLine = body.find((l) => l.startsWith(INSTRUCTION_PREFIX));
  const reconcile = body.some((l) => l.startsWith(RECONCILE_PREFIX));
  const todoHeaderIndex = body.findIndex((l) => l === "todos:");
  // Unknown scalar lines before the `todos:` header (forward compat) never enter the todo list: only after the header is the todo section.
  const openTodoLines =
    todoHeaderIndex >= 0 ? body.slice(todoHeaderIndex + 1) : [];
  return Object.freeze({
    lastTool: lastToolLine.slice(LAST_TOOL_PREFIX.length),
    openTodoLines: Object.freeze([...openTodoLines]),
    instruction:
      instructionLine === undefined
        ? null
        : instructionLine.slice(INSTRUCTION_PREFIX.length),
    reconcile,
  });
}

/**
 * Last agent_status user message in `messages` → snapshot (cold-start hydrate
 * SSOT). No bar / malformed last bar → null; does not read todos.md.
 */
export function agentStatusFromMessages(
  messages: ReadonlyArray<AnthropicNativeMessage>
): AgentStatusSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text = m.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n");
    if (!isAgentStatusText(text)) continue;
    return parseAgentStatusText(text);
  }
  return null;
}

/** Open items → canonical ledger lines (order kept). Completed items are never projected — the bar only reports what is not done. */
function projectUnfinishedItems(content: string): ReadonlyArray<string> {
  return parseLedger(content)
    .filter((i) => i.status !== "completed")
    .map((i) => formatLedgerLine(i).trimEnd());
}

/**
 * IO reader: reads `<todoDir>/[<conversationId>/]todos.md` and projects only
 * the open items (pending + in_progress, order kept), normalized through the
 * ledger-syntax SSOT into id-bearing lines. With a conversationId → that
 * conversation's own ledger (same SSOT as the todo_write writer); without →
 * root todos.md (backward compat). Missing file / empty file / all completed
 * / any read failure → empty list; never throws (the caller is about to make
 * a model turn; read failures are treated as "no todo section", with no
 * fallback noise).
 */
export async function readOpenTodoLines(
  todoDir: string,
  conversationId?: string
): Promise<ReadonlyArray<string>> {
  const filePath = resolveConversationTodoPath({
    projectDir: todoDir,
    conversationId,
  });
  try {
    const content = await readFile(filePath, "utf8");
    return projectUnfinishedItems(content);
  } catch {
    // EXIT: any read failure (ENOENT / EACCES / ENOTDIR included) → empty
    // list, silently converged as "no todo section"; never thrown into a
    // (ADR-0028)
    // model turn.
    return [];
  }
}

/**
 * SSOT for projecting the instruction / reconcile slots' "present only if
 * provided → otherwise key absent": a slot of undefined = not provided →
 * key absent; any other value (including null / false) stays verbatim —
 * absent ≠ null/false is the contract. Shared by the three consumers
 * (snapshot assembly in compute, stream-event emission in loop-engine, TUI
 * event mapping) so the spread guards cannot drift by hand-copying. The
 * instruction null-normalization enforcing "empty slots are not advertised"
 * is caller-side field semantics done at the compute entry; event / TUI
 * pass-through keeps the event's actual value.
 */
export function pickPresentAgentStatusSlots(slots: {
  readonly instruction?: string | null;
  readonly reconcile?: boolean;
}): { instruction?: string | null; reconcile?: boolean } {
  const present: { instruction?: string | null; reconcile?: boolean } = {};
  if (slots.instruction !== undefined) present.instruction = slots.instruction;
  if (slots.reconcile !== undefined) present.reconcile = slots.reconcile;
  return present;
}

/**
 * Combined computation: read todos.md open lines + last_tool (+ instruction
 * pass-through + reconcile settlement field) → snapshot data and bar text.
 * The TUI derives its view from the same data / text without building a
 * second ledger. `instruction` comes from the caller (loop-engine via the
 * extractor); null / absent → the field key is dropped (the event surface
 * keeps the old field-set shape). `reconcile` comes from the caller after
 * run-scoped settlement; absent (nothing to settle) → key dropped too,
 * false → line absent but event key present (settlement happened). Never
 * throws (read failures are converged to empty lists by
 * readOpenTodoLines).
 */
export async function computeAgentStatusSnapshot(opts: {
  readonly lastTool: string;
  readonly todoDir: string;
  /** When present, projects that conversation's own ledger (SSOT shared with the todo_write writer). */
  readonly conversationId?: string;
  /** First line of the latest real user instruction (extractor product); null → section absent. */
  readonly instruction?: string | null;
  /**
   * Reconcile-marker settlement for this bar (computed by the loop engine's
   * run-scoped box); absent = nothing to settle, key dropped (the event
   * surface falls back to the old field set).
   */
  readonly reconcile?: boolean;
}): Promise<AgentStatusSnapshot & { readonly text: string }> {
  const snapshot: AgentStatusSnapshot = {
    lastTool: opts.lastTool,
    openTodoLines: await readOpenTodoLines(opts.todoDir, opts.conversationId),
    // instruction null = "empty slots are not advertised" → normalized to
    // not-provided; the key-projection rule itself lives in
    // pickPresentAgentStatusSlots.
    ...pickPresentAgentStatusSlots({
      instruction: opts.instruction ?? undefined,
      reconcile: opts.reconcile,
    }),
  };
  return { ...snapshot, text: buildAgentStatusText(snapshot) };
}
