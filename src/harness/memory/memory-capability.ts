/**
 * The memory capability switch (ADR-0031 / ADR-0033 / ADR-0042, amendment
 * 2026-10-07): one predicate every memory seam reads, so tool schemas, the
 * `memory_layer` system segment, executor enforcement, the auto-memory hook
 * and the prefetch overlay move on the same toggle.
 *
 * The TUI `/memory` **Automatic memory** row is that switch, and its OFF
 * transition persists `dream: false` — so dual-off *is* the total-OFF state.
 * ON is either flag on: `autoExtract === true` still implies Dream when its
 * 24h ∧ 5-session gate is due (ADR-0033 D3), and dream-only remains allowed.
 *
 * Leaf module by design: the registry and the tool handlers must be able to
 * read the predicate without importing the hook's ingest / dream / GC graph.
 */

/** The two live booleans the capability is derived from. */
export interface MemoryCapabilityFlags {
  readonly autoExtract: boolean;
  readonly dream: boolean;
}

/**
 * True while any memory capability is on. False (dual-off) = total memory
 * OFF: no memory input reaches the model, no memory call executes, and no
 * memory background job runs.
 */
export function memoryCapabilityOn(flags: MemoryCapabilityFlags): boolean {
  return flags.autoExtract === true || flags.dream === true;
}
