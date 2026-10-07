import { mkdir } from "node:fs/promises";
import { assembleSystemPrompt, type AssemblyContext } from "./assembly.js";

/**
 * Live autoExtract flag box — the same mutable object the TUI /memory panel
 * writes through (MemoryLiveFlags consumer contract). When present it
 * **overrides** `ctx.autoExtract` on every resolve, so a mid-session toggle
 * is honored by the next turn instead of living inside the frozen snapshot.
 */
export interface SystemResolverFlags {
  readonly autoExtract: boolean;
}

/** Resolver returned by createSystemResolver: callable + explicit invalidation. */
export interface SystemResolver {
  (): Promise<string | undefined>;
  /**
   * Drop the snapshot so the next call reassembles. Explicit host action only
   * (TUI /memory commit); callers must tolerate a one-off prefix change (the
   * KV-cache break is the point — the toggle takes effect this session).
   */
  invalidate(): void;
}

/**
 * Resolve the memory_layer system segment as a session-level snapshot
 * (ADR-0042): the first *successful* call assembles and freezes the string;
 * every later call returns it verbatim — no stat, no reassembly. A resolver's
 * lifetime is a session's, so newly written memories (catalog / promote) and
 * static-layer edits only enter the next session's resolver. This keeps the
 * `tools` + `system` prefix byte-stable within a session (prefix eligibility
 * line, specs/model-prefix-layering.md D9).
 *
 * memory-toggle-live amendment: the snapshot contract holds only while the
 * autoExtract input is construction-stable. When `opts.flags` is present the
 * resolver re-reads it on every resolve (flags **override** `ctx.autoExtract`)
 * and snapshots **per flag value** — an unchanged flag keeps returning its
 * frozen snapshot byte-identically; a flip resolves into the other value's
 * snapshot (assembled at most once per value per session). Without flags the
 * behavior is byte-identical to the pre-amendment resolver. `invalidate()`
 * additionally lets an explicit host action (TUI /memory commit) drop the
 * snapshot so the toggle lands on the very next turn even when the flip has
 * not happened yet.
 */
export function createSystemResolver(
  ctx: AssemblyContext,
  opts?: {
    readonly flags?: SystemResolverFlags;
    /**
     * Live memory-capability gate (ADR-0042 amendment 2026-10-07): absent =
     * always on. False resolves to `undefined` before any snapshot slot is
     * touched, so a total-OFF turn carries no `memory_layer` at all — no
     * existence pointer, no catalog — instead of re-resolving another
     * per-flag-value frozen copy.
     */
    readonly isEnabled?: () => boolean;
  }
): SystemResolver {
  // Project memory lives in the home project tree at
  // `projects/<slug>/memory` (ADR-0099) (eager mkdir at assembly; failures
  // stay silent and never block assembly).
  void mkdir(ctx.memoryDir, { recursive: true }).catch(() => {});
  // Per-flag-value snapshots: with flags present, up to two slots (true/false)
  // each freeze one snapshot; without flags it is the original single
  // snapshot. Assembly failure does not poison the corresponding slot.
  const snapshots = new Map<boolean, Promise<string | undefined>>();
  // Total memory OFF gets its own tier: the static layer (AGENTS.md + the
  // rules manifest) still assembles, the memory index (existence pointer +
  // catalog) does not. Assembled at most once per session.
  let offSnapshot: Promise<string | undefined> | undefined;

  const assembleFor = (flag: boolean): Promise<string | undefined> =>
    flag === ctx.autoExtract
      ? assembleSystemPrompt(ctx)
      : assembleSystemPrompt({ ...ctx, autoExtract: flag });

  const resolver = (() => {
    // Total memory OFF: assemble the index-free tier rather than re-resolving
    // another per-flag-value frozen copy. Assembly failure must not poison it.
    // EXIT: an absent gate reads as always-on, so only an explicit `false`
    // selects the index-free tier.
    if (opts?.isEnabled?.() === false) {
      if (offSnapshot === undefined) {
        const snap = assembleSystemPrompt({
          ...ctx,
          autoExtract: false,
          memoryIndex: false,
        }).catch((err: unknown) => {
          // EXIT: a fault drops the tier so the next call retries (same
          // contract as the per-flag tiers).
          if (offSnapshot === snap) offSnapshot = undefined;
          throw err;
        });
        offSnapshot = snap;
      }
      return offSnapshot;
    }
    const flag = opts?.flags
      ? opts.flags.autoExtract === true
      : ctx.autoExtract === true;
    if (!snapshots.has(flag)) {
      // The snapshot is only established after a successful read: an assembly
      // throw clears the cache slot so the next call retries (the "assembly
      // failure does not poison the cache" contract, ADR-0009). Concurrent
      // calls share one assembly (in-flight dedupe) and all receive the same
      // rejection.
      const snap = assembleFor(flag).catch((err: unknown) => {
        if (snapshots.get(flag) === snap) snapshots.delete(flag);
        throw err;
      });
      snapshots.set(flag, snap);
    }
    return snapshots.get(flag)!;
  }) as SystemResolver;
  resolver.invalidate = (): void => {
    snapshots.clear();
    offSnapshot = undefined;
  };
  return resolver;
}
