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
  opts?: { readonly flags?: SystemResolverFlags }
): SystemResolver {
  // ADR-0019 (T2): per-root memory store — 装配期 eager mkdir
  // `<workspaceRoot>/.iknow/memory`(递归;project namespace 子目录由
  // memory_save / memory_recall 按需 mkdir)。幂等 + 失败静默,
  // 不阻塞装配(降级契约对齐 createSystemResolver 的 catch-all)。
  void mkdir(ctx.memoryDir, { recursive: true }).catch(() => {});
  // per-flag-value 快照：flags 在场时最多两个槽位（true/false）各冻结一份，
  // 无 flags 时就是原有单快照。装配失败不毒化对应槽位。
  const snapshots = new Map<boolean, Promise<string | undefined>>();

  const assembleFor = (flag: boolean): Promise<string | undefined> =>
    flag === ctx.autoExtract
      ? assembleSystemPrompt(ctx)
      : assembleSystemPrompt({ ...ctx, autoExtract: flag });

  const resolver = (() => {
    const flag = opts?.flags
      ? opts.flags.autoExtract === true
      : ctx.autoExtract === true;
    if (!snapshots.has(flag)) {
      // 快照只在成功取值后建立：装配抛错 → 清空缓存位，下次调用重试
      // （原「装配失败不毒化缓存」契约，ADR-0009 T7）。并发调用共享同一次
      // 装配（in-flight dedupe），全体收到同一 rejection。
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
  };
  return resolver;
}
