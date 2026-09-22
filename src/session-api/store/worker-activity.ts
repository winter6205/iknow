/**
 * Read-only activity projection over a worker transcript (specs/subagent-card-title.md).
 *
 * Question answered: "which tool is this worker executing right now?" — the
 * latest `tool_use` in that worker's own ledger with no matching `tool_result`
 * later in the same ledger. This is observable because the loop commits the
 * assistant turn (with its `tool_use`) *before* the tool phase runs
 * (src/harness/loop-engine.ts), so an unpaired `tool_use` really is the call
 * in flight.
 *
 * Why this is a separate module from `worker-transcript.ts`: that file's load
 * path is a *conversation* projection and deliberately runs
 * `closeoutOrphanToolUses` so every consumer gets an API-valid chain — the
 * synthesis erases exactly the unpaired `tool_use` this reader exists to
 * report. The two reads therefore need different projections of the same
 * append-only ledger; the codec (`parseSessionJsonl` / `projectSessionLog`) is
 * reused, not copied (SSOT is jsonl.ts).
 *
 * Reading has two in-vocabulary empties — the ledger does not exist yet, and
 * every `tool_use` in it is settled — and one class of fault that must not
 * pretend to be either: an unreadable path or a ledger that fails to decode.
 * The caller renders a card slot and must never see a throw, so a fault also
 * resolves to `""`, but it is named on stderr once per ledger (the TUI gates
 * stderr and replays it on exit, so this stays a single line per worker).
 */
import { readFile } from "node:fs/promises";
import type { AnthropicNativeMessage } from "../../harness/index.js";
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
  console.warn(`worker-activity: ${taskId} in-flight read failed — ${cause}`);
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
 * Name of the tool the worker is executing right now, or `""` when the ledger
 * is missing / unreadable / unparsable, or when every `tool_use` it holds is
 * already settled. Never throws, never rejects.
 */
export async function readWorkerInFlightToolName(
  loc: WorkerTranscriptLocation
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(loc.transcriptPath, "utf8");
  } catch (err) {
    // EXIT: no ledger yet — a worker writes its first record only after its
    // loop starts, so absence is the expected reading for a young task.
    const cause = missingLedgerCause(err);
    if (cause === undefined) return "";
    renderFault(loc.taskId, cause);
    return "";
  }
  try {
    return inFlightToolName(projectSessionLog(parseSessionJsonl(raw)).messages);
  } catch (err) {
    renderFault(loc.taskId, jsonlFaultCause(err));
    return "";
  }
}

/**
 * Pure projection: walk the ledger in order and keep the name of the last
 * `tool_use` that no later `tool_result` answers. Pairing is positional, not
 * set membership, so a `tool_result` recorded *before* its `tool_use` (which
 * only a malformed or hand-edited ledger can produce) does not settle it.
 */
function inFlightToolName(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  const settledAt = new Map<string, number>();
  const open: Array<{
    readonly id: string;
    readonly name: string;
    readonly at: number;
  }> = [];
  let cursor = 0;
  for (const message of messages) {
    for (const block of message.content) {
      cursor += 1;
      if (block.type === "tool_use") {
        open.push({ id: block.id, name: block.name, at: cursor });
      } else if (block.type === "tool_result") {
        settledAt.set(block.tool_use_id, cursor);
      }
    }
  }
  let name = "";
  // `open` is already in ledger order, so the last unsettled call wins.
  for (const call of open) {
    const answeredAt = settledAt.get(call.id);
    if (answeredAt === undefined || answeredAt < call.at) name = call.name;
  }
  return name;
}
