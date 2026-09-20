/**
 * Graph assembly snapshot — the "when does the overlay take effect" half
 * (ADR-0030).
 *
 * `GraphModeContext` is a session-level mutable holder: Shift+Tab and
 * `/graph` flip it at any time. But the tool surface and system text must
 * not jitter along — swapping the model-visible tool set mid-`run()` is
 * changing the contract inside one conversation (KV-cache prefix invalidation,
 * plus the model could reference a tool that vanishes next turn). So every
 * overlay read side goes through this module:
 *
 * - `beginRound()`: the host takes one snapshot before each `run()`;
 * - `enabled()`: the assembly layer (promptTools filtering + orchestration
 *   segment gate) reads only the snapshot.
 *
 * "Toggling mid-run is unblocked, never re-assembles mid-flight, no
 * debouncing" thus becomes one verifiable sentence: a keypress flips the
 * holder immediately, but only the next `run()` changes the assembly face.
 *
 * Absent holder → permanently off. Entry points without the overlay (ask /
 * worker / legacy callers) therefore see zero behaviour change.
 */

import type { GraphModeContext } from "./mode.js";

export interface GraphAssembly {
  /** Take a fresh snapshot (host calls before each run()); returns this round's toggle. */
  readonly beginRound: () => boolean;
  /** This round's snapshot value. The assembly layer reads only this, never the holder. */
  readonly enabled: () => boolean;
}

export function createGraphAssembly(
  mode: GraphModeContext | undefined
): GraphAssembly {
  let snapshot = mode?.get().enabled ?? false;
  return Object.freeze({
    beginRound: (): boolean => {
      snapshot = mode?.get().enabled ?? false;
      return snapshot;
    },
    enabled: (): boolean => snapshot,
  });
}
