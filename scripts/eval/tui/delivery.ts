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
import type { AcceptanceLedger, AcceptanceRecord } from "./acceptance.js";
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

/**
 * The next stimulus that can still reach the composer, in due order.
 *
 * A REFUSED stimulus is skipped, not offered: a refusal is final, so there is
 * no blind resend and no reason to report a submission the runner will refuse
 * to perform. Offering one produced a `submit` decision for a stimulus whose
 * own `markSent` then refused it — the ledger was the only thing stopping the
 * resend, which is a backstop, not a rule.
 */
function nextUnsent(ledger: AcceptanceLedger): Stimulus | null {
  for (const record of ledger.records()) {
    if (record.sent_at_ms === null && record.verdict !== "refused") {
      return { at: record.due_at_ms ?? 0, tag: record.tag, text: record.text };
    }
  }
  return null;
}

/**
 * The last SENT stimulus whose submission is still UNRESOLVED, or null.
 *
 * WHY unresolved and not `busy`: `busy` is the persisted lifecycle's last
 * boundary, and a stimulus that was TYPED but not yet ACCEPTED has published
 * none — it is not busy while it sits in the composer. Gating on `busy` alone
 * therefore typed the next stimulus into a composer that already held the
 * previous one, and #1221's measured run persisted S1 and S2 as ONE user event.
 * A record is resolved only when BOTH halves are proven: the independently
 * persisted acceptance AND the correlated round's settlement.
 */
function outstandingSubmission(
  ledger: AcceptanceLedger
): AcceptanceRecord | null {
  let outstanding: AcceptanceRecord | null = null;
  for (const record of ledger.records()) {
    if (record.sent_at_ms === null) continue;
    const resolved =
      record.verdict === "accepted" && record.settled_at_ms !== null;
    if (!resolved) outstanding = record;
  }
  return outstanding;
}

/** Which bounded wait is running, and the instant it started. */
interface OutstandingGate {
  readonly phase: "acceptance" | "settlement";
  readonly waitedMs: number;
  readonly budgetMs: number;
}

/**
 * The outstanding record's own clock, so the gate needs no caller state beyond
 * (protocol, ledger, clock). Acceptance is bounded by the per-stimulus
 * `acceptTimeoutMs` from the submission; settlement is bounded by
 * `settleWaitMs` from the acceptance that proved the round started.
 */
function outstandingGate(
  protocol: Protocol,
  outstanding: AcceptanceRecord,
  nowMs: number
): OutstandingGate {
  const acceptedAtMs = outstanding.accepted_at_ms;
  const waitedFromMs = acceptedAtMs ?? outstanding.sent_at_ms ?? 0;
  return {
    phase: acceptedAtMs === null ? "acceptance" : "settlement",
    waitedMs: nowMs - waitedFromMs,
    budgetMs:
      acceptedAtMs === null
        ? protocol.delivery.acceptTimeoutMs
        : protocol.delivery.settleWaitMs,
  };
}

/** Hold the pending stimulus, or refuse it once the bounded wait has expired. */
function outstandingDecision(
  pending: Stimulus,
  outstanding: AcceptanceRecord,
  gate: OutstandingGate
): DeliveryDecision {
  if (gate.waitedMs > gate.budgetMs) {
    return {
      action: "refused",
      tag: pending.tag,
      text: null,
      dueAtMs: pending.at,
      reason:
        `${pending.tag} refused: ${outstanding.tag} was sent at ${outstanding.sent_at_ms}ms and its ` +
        `${gate.phase} is still unproven after ${gate.waitedMs}ms, past the ${gate.budgetMs}ms bounded ` +
        `${gate.phase} wait; typing it now would land in the same composer`,
    };
  }
  return {
    action: "wait_settle",
    tag: pending.tag,
    text: null,
    dueAtMs: pending.at,
    reason:
      `${pending.tag} held: ${outstanding.tag} is sent but its ${gate.phase} is unproven ` +
      `(${gate.waitedMs}ms waited of ${gate.budgetMs}ms); at most one stimulus may be outstanding`,
  };
}

/**
 * Classify an EXHAUSTED sequence — nothing further can ever be typed.
 *
 * WHY separate: this outcome is a precondition on the ledger alone. With no
 * deliverable stimulus left there is no due time to wait for and no active
 * round to defer to, so neither `nowMs` nor `busy` can change the answer; the
 * only thing left to separate is "everything settled" (the run may close) from
 * "an accepted round has not settled, or a stimulus was refused" (it may not).
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
  const refused = ledger
    .records()
    .filter((r) => r.verdict === "refused")
    .map((r) => r.tag);
  const settledOrRefused = ledger
    .records()
    .every(
      (r) =>
        r.verdict === "refused" ||
        (r.verdict === "accepted" && r.settled_at_ms !== null)
    );
  if (refused.length > 0 && settledOrRefused) {
    return {
      action: "wait_settle",
      tag: null,
      text: null,
      dueAtMs: null,
      reason: `${refused.join(", ")} refused; a refusal is final, so nothing further will ever be typed`,
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
 * lifecycle (see `AcceptanceLedger.busy`) — never from terminal silence. It is
 * NOT sufficient on its own: a stimulus that was written but not yet accepted
 * publishes no boundary, so it is not busy while it is still in the composer.
 * When `delivery.settleBeforeSubmit` is on, the UNRESOLVED SUBMISSION STATE is
 * therefore checked too, and `submit` is reachable only when no sent stimulus
 * is outstanding.
 *
 * A stimulus that was already written is never returned for submission again, so
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
  if (busy) return busyDecision(pending, args, nowMs);
  // The host is idle, so the persisted lifecycle can no longer vouch for the
  // previous submission: only the ledger's own unresolved state can.
  if (args.protocol.delivery.settleBeforeSubmit) {
    const outstanding = outstandingSubmission(ledger);
    if (outstanding !== null) {
      return outstandingDecision(
        pending,
        outstanding,
        outstandingGate(args.protocol, outstanding, nowMs)
      );
    }
  }
  return {
    action: "submit",
    tag: pending.tag,
    text: pending.text,
    dueAtMs: pending.at,
    reason: `${pending.tag} is due, the persisted lifecycle reports no active round, and no earlier stimulus is outstanding`,
  };
}

/**
 * The host's OWN refusal condition, bounded by `settleWaitMs`.
 *
 * Kept separate because it answers a different question from the outstanding
 * gate: this one asks whether the host is busy right now, and it therefore
 * wins whenever it says "wait" or "refuse" — neither of which can lead to a
 * submission, so nothing here reopens the gate below it.
 */
function busyDecision(
  pending: Stimulus,
  args: { readonly protocol: Protocol; readonly busySinceMs?: number | null },
  nowMs: number
): DeliveryDecision {
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

/** The Enter keystroke a submit performs — one per stimulus, ever. */
export const SUBMIT_KEYSTROKE = "\r";
