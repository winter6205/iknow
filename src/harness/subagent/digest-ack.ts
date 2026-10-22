/**
 * The one predicate that decides whether a host write carries this run's
 * claimed sub-agent digest, plus the once-only latch that settles the claim
 * (ADR-0150).
 *
 * Identity cannot be used: `freezeMessage` rebuilds every appended message, so
 * the `drainedMsg` reference is gone before any commit/publication sees it.
 * Text survives, and only host-injected messages are considered, so within one
 * run at most the drain message can match.
 *
 * Substring (not equality) because chat joins the claimed text with the
 * closeout text into one block.
 */
import type { DeliveryClaims } from "./host-drain.js";

/**
 * The minimal structural shape the predicate reads. Declared structurally
 * (not as `AnthropicNativeMessage`) so the persistence mirror's
 * `NativeStateMessage` and the engine's message type can both be observed
 * without a cast.
 */
export interface DigestCarrierMessage {
  readonly hostInjected?: true;
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
  }>;
}

function textBlocks(message: DigestCarrierMessage): string[] {
  const texts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts;
}

/** Does this array of messages carry the claimed digest text in a
 *  host-injected message? */
export function writeCarriesDigest(
  messages: ReadonlyArray<DigestCarrierMessage>,
  digestText: string
): boolean {
  if (digestText.length === 0) return false;
  for (const message of messages) {
    if (message.hostInjected !== true) continue;
    for (const text of textBlocks(message)) {
      if (text.includes(digestText)) return true;
    }
  }
  return false;
}

export interface DigestAck {
  /** Observe one successful write; acks once when it carries the digest. */
  readonly observe: (written: ReadonlyArray<DigestCarrierMessage>) => void;
  /** Settle at the end of the run: no durable carrier wired → ack (the
   *  injected-deps fallback); otherwise release so the next run retries. */
  readonly settle: (resolved: boolean) => void;
}

export interface CreateDigestAckOptions {
  readonly claims: DeliveryClaims | null;
  readonly digestText: string;
  /** False only for injected-deps hosts that wire no persistence hook at all. */
  readonly hasDurableCarrier: boolean;
}

export function createDigestAck(opts: CreateDigestAckOptions): DigestAck {
  let settled = false;
  const claims = opts.claims;

  const acknowledge = (): void => {
    if (settled) return;
    settled = true;
    claims?.acknowledge();
  };

  const release = (): void => {
    if (settled) return;
    settled = true;
    claims?.release();
  };

  return {
    observe: (written) => {
      if (settled) return;
      if (writeCarriesDigest(written, opts.digestText)) acknowledge();
    },
    settle: (resolved) => {
      if (settled) return;
      if (!resolved) {
        release();
        return;
      }
      if (opts.hasDurableCarrier) {
        // A production run that never wrote the digest leaves it claimable.
        release();
        return;
      }
      // EXIT: no hook will ever carry it (injected-deps / ask surface); the
      // documented test-only fallback is resolve-time acknowledgement.
      acknowledge();
    },
  };
}

/**
 * ADR-0150: tell the delivery latch what a write actually persisted. The
 * predicate decides whether that write carried the claimed digest.
 *
 * Shared by both hosts so neither can drift into observing a different write
 * shape than the other.
 */
export function notifyPersisted<M>(
  observer: ((written: ReadonlyArray<M>) => void) | undefined,
  written: ReadonlyArray<M>
): void {
  observer?.(written);
}

/**
 * The per-turn delivery latch set (ADR-0150 §5): one latch per run or
 * auto-loop iteration, plus the cursor pointing at the latch of the run that
 * is currently writing. Both hosts used to build this inline, which is how
 * their carrier predicates drifted apart; the host supplies only the carrier
 * source, through `begin`.
 */
export interface DeliveryLatchSet {
  /** Open the latch for one run/iteration and make it the active one. */
  readonly begin: (opts: CreateDigestAckOptions) => void;
  /** Feed one write to the active latch; a no-op when no run is open. */
  readonly observe: (written: ReadonlyArray<DigestCarrierMessage>) => void;
  /** Settle the active latch at the end of its run. */
  readonly settle: (resolved: boolean) => void;
  /** Release every latch this turn opened (its run threw before a carrier). */
  readonly releaseAll: () => void;
}

export function createDeliveryLatchSet(): DeliveryLatchSet {
  const latches: DigestAck[] = [];
  let active: DigestAck | undefined;
  return {
    begin: (opts) => {
      active = createDigestAck(opts);
      latches.push(active);
    },
    observe: (written) => {
      active?.observe(written);
    },
    settle: (resolved) => {
      active?.settle(resolved);
    },
    releaseAll: () => {
      for (const latch of latches) latch.settle(false);
    },
  };
}
