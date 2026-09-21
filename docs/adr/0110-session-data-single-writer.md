# 0110. Session data file single-writer contract: one file, one host-process writer; the in-process serial queue is the only lock layer

Date: 2026-09-20
Status: accepted

## Context

Session data files (main-session `session.jsonl` / worker `transcript`, `skill-index.json` and other ledgers) all append via read-modify-write: read the whole file → compute the next state (event id / name set) → write back. The store layer deliberately offers no file lock (architecture discipline: "locking lives at the assembly boundary"; the JSDoc on `appendEvents` in `session-store.ts` already requires callers to sit under the hub serialize queue).

The worker transcript once lacked this assembly-point serialization: when the worker loop's concurrent `flushPrefix` re-entered, two batches read the same head → duplicate event ids → `schema_invalid` → worker exit 2. The fix inlined a serialize inside `src/cli/worker-transcript.ts`, byte-for-byte isomorphic with the private `createSerialQueue` in `src/harness/skill/index-ledger.ts` — the same discipline hand-written in two places; drift is only a matter of time.

The cautionary counterpart is the general shape: writing global state and multiple sessions into one shared file and relying on OS-level retries to dodge `EBUSY` — exactly the "same file, many host-process writers" trap; OS file locks are not a substitute layer for this contract.

## Decision

**Session data file single-writer contract:**

1. **Every session data file has exactly one host-process writer.** A transcript/ledger/session file belongs to one host process (main session = session-api hub; worker transcript = that worker process); there is no supported surface of a second process writing it concurrently.
2. **The in-process serial queue is the only lock layer.** Write paths must converge at the assembly boundary through one `createSerialQueue()` (`src/util/serial-queue.ts`, SSOT): strict FIFO; a prior task's reject goes back only to its own caller and never clogs the chain. The store layer introduces no file lock / advisory lock / retry.
3. **Cross-process concurrent open of the same session is out of support.** No detection, no recovery, no behavioral promise (two processes each holding their own in-memory truth would overwrite each other with whole-file writes). Supporting it in the future requires a separate ADR; this contract must not be extended silently.
4. **Converge duplicate implementations.** Assembly points must not hand-write Promise-chain serializers again; `worker-transcript` (cli) and `index-ledger` (harness) share `src/util/serial-queue.ts`. harness→util is a neutral low-level dependency and does not touch Gate B (Gate B only bans the harness executable surface from importing session-api).

## Why not

- **File lock in the store layer:** conflicts with the "stateless store, locking at the assembly boundary" discipline; cross-process locking needs OS lock primitives, back into the EBUSY-retry swamp. Rejected.
- **Keep private implementations per site:** two isomorphic copies already existed; a third would drift into semantic differences (e.g. reject clogging the chain) even sooner. Rejected.
- **Support cross-process same open:** would need locks + conflict merging + an in-memory-truth invalidation protocol; the product has no such demand. Rejected (registered as unsupported, not undefined).

## Consequences

- `src/util/serial-queue.ts` is the single entry for new consumers; any new session-data-file write path must explicitly route through an assembly-point queue.
- The queue only guarantees non-interleaving: awaiting a later task on the same queue from within a task self-deadlocks; the file-header comment and the unit test (`tests/util/serial-queue.test.ts`) pin that boundary.
- Existing tests `tests/cli/worker-transcript.test.ts` and `tests/skill/index-ledger.test.ts` continue as the behavioral-equivalence proof.

## Evidence pointers

- The worker-transcript race fix (the assembly-point serialize on the `fix-worker-transcript-race` branch).
- `src/session-api/store/session-store.ts` `appendEvents` JSDoc (the hub serialize queue discipline).
- ADR-0102 (subagent continue-after-complete, the worker-transcript IO injection seam).
- The OS-level `EBUSY`-retry lesson of one-file-multi-writer setups (operator-reported counterpart; no product named).
