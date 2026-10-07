/**
 * Stimulus delivery: paced writes, a composer clear, and the earliest-due
 * scheduler (#1219).
 *
 * WHY the scheduler is pure: the historical timetable fired unconditionally and
 * then, after 45 s without proof, wrote ANOTHER `\r` — up to four attempts per
 * stimulus (run3 sent six in total). `src/tui/app.tsx` REFUSES input while a
 * round is active ("当前会话正在运行；导航命令仍可用，消息请等本轮结束。") and
 * returns before `ensureSession`, so a refused stimulus produces zero store
 * events: the retries were lost work that also destroyed the evidence. Here the
 * decision is a pure function of (protocol, ledger, clock, busy) so the rules
 * are testable without a terminal, and a stimulus that cannot be submitted gets
 * an explicit `refused` verdict instead of a silent discard.
 */
import type { AcceptanceLedger } from "./acceptance.js";
import type { Protocol, Stimulus } from "./protocol.js";

/** One paced write. `delayMs` is the pause BEFORE this chunk. */
export interface Chunk {
  readonly text: string;
  readonly delayMs: number;
}

/** Split text into bounded chunks without cutting a character in half. */
export function planChunks(
  text: string,
  opts: { readonly chunkBytes: number; readonly chunkDelayMs: number }
): Chunk[] {
  const { chunkBytes, chunkDelayMs } = opts;
  if (!Number.isFinite(chunkBytes) || chunkBytes < 1) {
    throw new Error(`chunkBytes must be >= 1; got: ${chunkBytes}`);
  }
  if (!Number.isFinite(chunkDelayMs) || chunkDelayMs < 0) {
    throw new Error(`chunkDelayMs must be >= 0; got: ${chunkDelayMs}`);
  }
  const chunks: Chunk[] = [];
  let buffer = "";
  let bytes = 0;
  const flush = (): void => {
    if (buffer === "") return;
    chunks.push({
      text: buffer,
      delayMs: chunks.length === 0 ? 0 : chunkDelayMs,
    });
    buffer = "";
    bytes = 0;
  };
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > chunkBytes) flush();
    buffer += char;
    bytes += size;
  }
  flush();
  return chunks;
}

/** The composer-clear keystroke plan: one backspace per typed character. */
export function composerClear(characters: number): string[] {
  if (!Number.isFinite(characters) || characters < 0) {
    throw new Error(`clear length must be >= 0; got: ${characters}`);
  }
  return Array.from({ length: Math.floor(characters) }, () => "\u007f");
}

/** What the scheduler wants the runner to do next. */
export type DeliveryAction =
  "submit" | "wait_due" | "wait_settle" | "refused" | "done";

export interface DeliveryDecision {
  readonly action: DeliveryAction;
  readonly tag: string | null;
  readonly text: string | null;
  readonly dueAtMs: number | null;
  readonly reason: string;
}

/** The next unsent stimulus in due order, or null when the sequence is sent. */
function nextUnsent(ledger: AcceptanceLedger): Stimulus | null {
  for (const record of ledger.records()) {
    if (record.sent_at_ms === null) {
      return { at: record.due_at_ms ?? 0, tag: record.tag, text: record.text };
    }
  }
  return null;
}

/**
 * Classify an EXHAUSTED sequence — every stimulus already written.
 *
 * WHY separate: this outcome is a precondition on the ledger alone. With no
 * unsent stimulus left there is no due time to wait for and no active round to
 * defer to, so neither `nowMs` nor `busy` can change the answer; the only thing
 * left to separate is "everything settled" (the run may close) from "an
 * accepted round has not settled" (it may not).
 */
function exhaustedDecision(ledger: AcceptanceLedger): DeliveryDecision {
  if (ledger.allSettled()) {
    return {
      action: "done",
      tag: null,
      text: null,
      dueAtMs: null,
      reason: "every stimulus is accepted and settled",
    };
  }
  return {
    action: "wait_settle",
    tag: null,
    text: null,
    dueAtMs: null,
    reason: "all stimuli sent; an accepted round has not settled yet",
  };
}

/**
 * Decide one delivery step.
 *
 * `busy` is the product's own refusal condition, taken from the persisted
 * lifecycle (see `AcceptanceLedger.busy`) — never from terminal silence. A
 * stimulus that was already written is never returned for submission again, so
 * no caller can resend an input that might already have been accepted.
 */
export function decideDelivery(args: {
  readonly protocol: Protocol;
  readonly ledger: AcceptanceLedger;
  readonly nowMs: number;
  readonly busy: boolean;
  /** When the current round started running, for the bounded settle wait. */
  readonly busySinceMs?: number | null;
}): DeliveryDecision {
  const { ledger, nowMs, busy } = args;
  const pending = nextUnsent(ledger);
  if (pending === null) {
    return exhaustedDecision(ledger);
  }
  if (nowMs < pending.at) {
    return {
      action: "wait_due",
      tag: pending.tag,
      text: null,
      dueAtMs: pending.at,
      reason: `${pending.tag} is due at ${pending.at}ms; a due time is an EARLIEST, not a slot`,
    };
  }
  if (busy) {
    const waitedFrom = Math.max(pending.at, args.busySinceMs ?? pending.at);
    const waitedMs = nowMs - waitedFrom;
    if (waitedMs > args.protocol.delivery.settleWaitMs) {
      return {
        action: "refused",
        tag: pending.tag,
        text: null,
        dueAtMs: pending.at,
        reason:
          `${pending.tag} refused: still no settled round after ${waitedMs}ms, ` +
          `past the ${args.protocol.delivery.settleWaitMs}ms bounded settle wait`,
      };
    }
    return {
      action: "wait_settle",
      tag: pending.tag,
      text: null,
      dueAtMs: pending.at,
      reason: `${pending.tag} deferred: the active round must settle first (${waitedMs}ms waited)`,
    };
  }
  return {
    action: "submit",
    tag: pending.tag,
    text: pending.text,
    dueAtMs: pending.at,
    reason: `${pending.tag} is due and the persisted lifecycle reports no active round`,
  };
}

/** The Enter keystroke a submit performs — one per stimulus, ever. */
export const SUBMIT_KEYSTROKE = "\r";
