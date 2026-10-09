/**
 * Read-only activity projection over a worker transcript (specs/subagent-card-title.md).
 *
 * Question answered: "which tool did this worker issue most recently?" — the
 * last `tool_use` in that worker's own ledger, kept visible through its
 * `tool_result` until a later `tool_use` replaces it. The slot describes the
 * most recently issued call, not whether it is still running or succeeded.
 *
 * Why this is a separate module from `worker-transcript.ts`: that file's load
 * path is a *conversation* projection and deliberately runs
 * `closeoutOrphanToolUses` so every consumer gets an API-valid chain — the
 * synthesis erases exactly the trailing `tool_use` this reader exists to
 * report. The two reads therefore need different projections of the same
 * append-only ledger; the codec (`parseSessionJsonl` / `projectSessionLog`) is
 * reused, not copied (SSOT is jsonl.ts).
 *
 * Reading has two in-vocabulary empties — the ledger does not exist yet, and it
 * holds no `tool_use` — and one class of fault that must not pretend to be
 * either: an unreadable path or a ledger that fails to decode. The caller
 * renders a card slot and must never see a throw, so a fault also resolves to
 * `null`, but it is named on stderr once per ledger (the TUI gates stderr and
 * replays it on exit, so this stays a single line per worker).
 */
import { readFile } from "node:fs/promises";
import type { AnthropicNativeMessage } from "../../harness/index.js";
import type { SubagentActivity } from "../../harness/subagent/manager.js";
import { parseSessionJsonl, projectSessionLog } from "./jsonl.js";
import type { WorkerTranscriptLocation } from "./worker-transcript.js";

/** Bounded so a long-lived session cannot grow this with its task count. */
const FAULT_LOG_CAP = 64;
const reportedFaults = new Set<string>();

function renderFault(taskId: string, cause: string): void {
  if (reportedFaults.has(taskId)) return;
  if (reportedFaults.size >= FAULT_LOG_CAP) {
    const oldest = reportedFaults.values().next().value;
    if (oldest !== undefined) reportedFaults.delete(oldest);
  }
  reportedFaults.add(taskId);
  console.warn(`worker-activity: ${taskId} activity read failed — ${cause}`);
}

/**
 * `jsonl.ts` throws its errors as plain objects (`{kind:"parse_failed"}`,
 * `SessionJsonlError`), so `String(err)` would read `[object Object]` and hide
 * the only field that identifies the fault. Render `kind` plus its context.
 */
function jsonlFaultCause(err: unknown): string {
  if (typeof err === "object" && err !== null && "kind" in err) {
    const typed = err as {
      readonly kind: string;
      readonly field?: string;
      readonly reason?: string;
    };
    const context = typed.field ?? typed.reason;
    return context === undefined
      ? `ledger undecodable (${typed.kind})`
      : `ledger undecodable (${typed.kind}: ${context})`;
  }
  return `ledger undecodable (${err instanceof Error ? err.name : "unknown"})`;
}

function missingLedgerCause(err: unknown): string | undefined {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { readonly code?: unknown }).code
      : undefined;
  return code === "ENOENT" ? undefined : `ledger unreadable (${String(code)})`;
}

/**
 * The tool the worker issued most recently, with its recorded input, or `null`
 * when the ledger is missing / unreadable / unparsable, or holds no `tool_use`.
 * Never throws, never rejects.
 */
export async function readWorkerActivity(
  loc: WorkerTranscriptLocation
): Promise<SubagentActivity | null> {
  let raw: string;
  try {
    raw = await readFile(loc.transcriptPath, "utf8");
  } catch (err) {
    // EXIT: no ledger yet — a worker writes its first record only after its
    // loop starts, so absence is the expected reading for a young task.
    const cause = missingLedgerCause(err);
    if (cause === undefined) return null;
    renderFault(loc.taskId, cause);
    return null;
  }
  try {
    return latestIssuedToolCall(
      projectSessionLog(parseSessionJsonl(raw)).messages
    );
  } catch (err) {
    renderFault(loc.taskId, jsonlFaultCause(err));
    return null;
  }
}

/**
 * Pure projection: the last `tool_use` block in ledger order, with its recorded
 * input. Settling is not consulted — the slot is the most recently issued call,
 * which survives its `tool_result` until a later `tool_use` replaces it.
 */
function latestIssuedToolCall(
  messages: ReadonlyArray<AnthropicNativeMessage>
): SubagentActivity | null {
  let latest: SubagentActivity | null = null;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      latest = { toolName: block.name, toolInput: coerceInput(block.input) };
    }
  }
  return latest;
}

/** A `tool_use` input is an object; anything else (legacy or malformed) reads
 *  as empty, so the card falls back to the bare tool name and never renders raw
 *  JSON. */
function coerceInput(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}
