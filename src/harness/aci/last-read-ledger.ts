/**
 * Last-read ledger (ADR-0084).
 *
 * Registry of "canonical paths this conversation has seen". `write_file`
 * consults the table only when the target **already exists and is
 * non-empty**: not in the ledger → typed failure, nothing written. New files
 * and empty files are exempt.
 *
 * Lifecycle is orthogonal to the session store:
 *   - **process memory**, keyed by conversationId, **never persisted**
 *     (resume / process restart → empty table). In the current production
 *     wiring (registry self-builds) the table lives as long as its registry:
 *     no production caller invokes `destroy` — that API is a seam for hosts
 *     / tests to clear the table on session reset or shutdown.
 *   - **no conversationId → no bucket**. `ledgerFor(undefined)` returns
 *     `undefined` and `record` has nowhere to land — an explicit exception
 *     to the anonymous shared-bucket pattern in `graph/ledger.ts`: the spec
 *     requires a non-empty `write_file` without an id to fail closed, and
 *     **forbids an implicit process-wide global table**. read_file and
 *     whitelisted bash still run without an id; they just book nothing.
 *
 * The ledger stores only **canonical paths** (absolute paths resolved by the
 * caller through the same `resolveWithinRoot` used on the write side). This
 * module does no path resolution and imports no loop-engine / build-engine /
 * tool handlers — its single job is bucketing and set membership.
 */

/** One conversation's ledger: a set of canonical paths. */
export interface LastReadLedger {
  /** Whether this canonical path has been booked. */
  readonly has: (canonicalPath: string) => boolean;
  /** Book one canonical path (idempotent). */
  readonly record: (canonicalPath: string) => void;
  /** Test-observable: number of booked entries. */
  readonly size: () => number;
  /** Clear the set. Host seam for clearing at session reset / end; current production assembly does not call it. */
  readonly destroy: () => void;
}

export function createLastReadLedger(): LastReadLedger {
  const paths = new Set<string>();
  const ledger: LastReadLedger = {
    has: (canonicalPath) => paths.has(canonicalPath),
    record: (canonicalPath) => {
      paths.add(canonicalPath);
    },
    size: () => paths.size,
    destroy: () => {
      paths.clear();
    },
  };
  return Object.freeze(ledger);
}

/**
 * Multi-conversation ledger resolver. `ledgerFor` lazily creates a ledger
 * the first time a conversationId is seen; repeated lookups of the same id
 * return the same object.
 *
 * An `undefined` conversationId maps to **`undefined`** (no anonymous
 * bucket): callers use that to fail closed on non-empty `write_file` without
 * an id, while id-less read / bash stay executable. This is the opposite of
 * the anonymous shared bucket in `graph/ledger.ts`, per ADR-0084.
 */
export interface LastReadLedgerHost {
  /** Get a ledger; same id always returns the same object; `undefined` → `undefined`. */
  readonly ledgerFor: (
    conversationId: string | undefined
  ) => LastReadLedger | undefined;
  /** Drop one conversation's ledger. Host reset seam; unknown id → no-op. */
  readonly destroy: (conversationId: string) => void;
  /** Drop all ledgers. Host shutdown seam; process memory dies with the process anyway. */
  readonly destroyAll: () => void;
  /** Test-observable: number of conversation ledgers currently created. */
  readonly size: () => number;
}

export function createLastReadLedgerHost(): LastReadLedgerHost {
  const byConv = new Map<string, LastReadLedger>();
  const host: LastReadLedgerHost = {
    ledgerFor: (conversationId) => {
      if (conversationId === undefined) return undefined;
      let ledger = byConv.get(conversationId);
      if (ledger === undefined) {
        ledger = createLastReadLedger();
        byConv.set(conversationId, ledger);
      }
      return ledger;
    },
    destroy: (conversationId) => {
      const ledger = byConv.get(conversationId);
      if (ledger !== undefined) {
        ledger.destroy();
        byConv.delete(conversationId);
      }
    },
    destroyAll: () => {
      for (const ledger of byConv.values()) {
        ledger.destroy();
      }
      byConv.clear();
    },
    size: () => byConv.size,
  };
  return Object.freeze(host);
}
