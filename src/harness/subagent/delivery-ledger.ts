/**
 * Delivery ledger: exactly-once bookkeeping for terminal sub-agent results.
 *
 * A key is `(conversationId, taskId, terminalSeq)`. Each key moves
 * `undelivered -> claimed -> delivered`: a claim takes the entry out of the
 * drain window while the host writes it, `acknowledge` marks it delivered, and
 * `release` returns a failed write to the undelivered state. Tokens are
 * per-claim, so a stale claim can never settle a newer claim of the same key.
 *
 * The ledger is memory-only and generic over the entry type: callers decide
 * what an envelope is, and the ledger never re-formats it.
 */

export interface DeliveryKeyParts {
  readonly conversationId?: string;
  readonly taskId: string;
  readonly terminalSeq: number;
}

export interface DeliveryLedgerEntry<E = unknown> extends DeliveryKeyParts {
  readonly envelope: E;
}

/** Opaque per-claim handle; only this ledger can map it back to a key. */
export type DeliveryClaimToken = symbol;

export interface ClaimedDelivery<E = unknown> extends DeliveryLedgerEntry<E> {
  readonly key: string;
  readonly token: DeliveryClaimToken;
}

export interface DeliveryLedger {
  /** Take every key that is neither claimed nor delivered; a second claim of the same key returns nothing. */
  claim<E>(
    entries: ReadonlyArray<DeliveryLedgerEntry<E>>
  ): ClaimedDelivery<E>[];
  /** Mark the claims delivered. Unknown, stale, or already-settled tokens are ignored. */
  acknowledge(claims: ReadonlyArray<ClaimedDelivery<unknown>>): void;
  /** Return the claims to the undelivered state. Unknown or settled tokens are ignored. */
  release(claims: ReadonlyArray<ClaimedDelivery<unknown>>): void;
  isDelivered(key: string): boolean;
  /** Drop all claims and delivered markers; memory-lifetime reset. */
  clear(): void;
  /** Drain-style filter: entries whose key is neither claimed nor delivered. */
  undelivered<E>(
    entries: ReadonlyArray<DeliveryLedgerEntry<E>>
  ): DeliveryLedgerEntry<E>[];
}

/** Pure delivery key. An absent conversation is the empty string. */
export function deliveryKey(parts: DeliveryKeyParts): string {
  return JSON.stringify([
    parts.conversationId ?? "",
    parts.taskId,
    parts.terminalSeq,
  ]);
}

/**
 * Envelope snapshot. The manager replaces `task.envelope` when a timeout
 * fallback lands; the claim must pin the claim-time text regardless of what
 * the source does afterwards. A deep copy (not `{ ...envelope }`) is what
 * shields nested fields such as `fileRefs` / `usage` from later edits.
 */
function snapshotEnvelope<E>(envelope: E): E {
  if (envelope !== null && typeof envelope === "object") {
    return structuredClone(envelope);
  }
  return envelope;
}

export function createDeliveryLedger(): DeliveryLedger {
  const deliveredKeys = new Set<string>();
  const claimedKeys = new Set<string>();
  const claimKeys = new Map<DeliveryClaimToken, string>();

  const claim = <E>(
    entries: ReadonlyArray<DeliveryLedgerEntry<E>>
  ): ClaimedDelivery<E>[] => {
    const claimed: ClaimedDelivery<E>[] = [];
    for (const entry of entries) {
      const key = deliveryKey(entry);
      if (deliveredKeys.has(key) || claimedKeys.has(key)) continue;
      // Snapshot before touching the ledger: `structuredClone` can throw, and
      // a key marked claimed without a returned token would be stranded in
      // `claimed` forever (nothing could release it). An unsnapshottable
      // entry is skipped and stays undelivered instead.
      let envelope: E;
      try {
        envelope = snapshotEnvelope(entry.envelope);
      } catch (cloneError) {
        // EXIT: the ledger has no error channel; the entry stays claimable,
        // so the next round retries it instead of losing the generation.
        void cloneError;
        continue;
      }
      const token = Symbol(key);
      claimedKeys.add(key);
      claimKeys.set(token, key);
      claimed.push({
        key,
        token,
        conversationId: entry.conversationId,
        taskId: entry.taskId,
        terminalSeq: entry.terminalSeq,
        envelope,
      });
    }
    return claimed;
  };

  const acknowledge = (
    claims: ReadonlyArray<ClaimedDelivery<unknown>>
  ): void => {
    for (const claimItem of claims) {
      const key = claimKeys.get(claimItem.token);
      if (key === undefined) continue;
      claimKeys.delete(claimItem.token);
      claimedKeys.delete(key);
      deliveredKeys.add(key);
    }
  };

  const release = (claims: ReadonlyArray<ClaimedDelivery<unknown>>): void => {
    for (const claimItem of claims) {
      const key = claimKeys.get(claimItem.token);
      if (key === undefined) continue;
      claimKeys.delete(claimItem.token);
      claimedKeys.delete(key);
    }
  };

  const isDelivered = (key: string): boolean => deliveredKeys.has(key);

  const clear = (): void => {
    deliveredKeys.clear();
    claimedKeys.clear();
    claimKeys.clear();
  };

  const undelivered = <E>(
    entries: ReadonlyArray<DeliveryLedgerEntry<E>>
  ): DeliveryLedgerEntry<E>[] => {
    const seen = new Set<string>();
    const result: DeliveryLedgerEntry<E>[] = [];
    for (const entry of entries) {
      const key = deliveryKey(entry);
      if (deliveredKeys.has(key) || claimedKeys.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(entry);
    }
    return result;
  };

  return Object.freeze({
    claim,
    acknowledge,
    release,
    isDelivered,
    clear,
    undelivered,
  });
}
