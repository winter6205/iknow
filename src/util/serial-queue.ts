/**
 * Serial queue — the in-process sole lock layer for session-data file write
 * paths (a neutral low-level utility).
 *
 * Why: appends to session-data files (transcript, skill-index ledger) are
 * read-modify-write (read full file -> compute next state -> write back),
 * while the store layer is deliberately lock-free — the architectural rule
 * is "locks at the assembly boundary" (see the hub serialize queue on
 * `appendEvents` in session-store.ts and the single-writer contract in
 * ADR-0110). Assembly points had hand-rolled byte-identical Promise chains;
 * converged here as the single source.
 *
 * Semantics:
 *  - strict FIFO: tasks start in enqueue order and never overlap;
 *  - a prior rejection reaches only its own caller and never stalls the
 *    chain: `then(task, task)` lets later tasks run even when the prior one
 *    failed (failure does not poison the queue).
 *
 * Note: the queue guarantees non-overlap, not reentrancy — awaiting a later
 * task of the same queue from inside a task deadlocks; fire-and-forget
 * enqueue is safe (it serializes after the current task).
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
}
