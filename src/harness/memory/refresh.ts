import { mkdir } from "node:fs/promises";
import { assembleSystemPrompt, type AssemblyContext } from "./assembly.js";

/**
 * Resolve the memory_layer system segment as a session-level snapshot
 * (ADR-0042): the first *successful* call assembles and freezes the string;
 * every later call returns it verbatim — no stat, no reassembly. A resolver's
 * lifetime is a session's, so newly written memories (catalog / promote) and
 * static-layer edits only enter the next session's resolver. This keeps the
 * `tools` + `system` prefix byte-stable within a session (prefix eligibility
 * line, specs/model-prefix-layering.md D9).
 */
export function createSystemResolver(
  ctx: AssemblyContext
): () => Promise<string | undefined> {
  // ADR-0019 (T2): per-root memory store — 装配期 eager mkdir
  // `<workspaceRoot>/.iknow/memory`(递归;project namespace 子目录由
  // memory_save / memory_recall 按需 mkdir)。幂等 + 失败静默,
  // 不阻塞装配(降级契约对齐 createSystemResolver 的 catch-all)。
  void mkdir(ctx.memoryDir, { recursive: true }).catch(() => {});
  let snapshot: Promise<string | undefined> | undefined;

  return () => {
    if (!snapshot) {
      // 快照只在成功取值后建立：装配抛错 → 清空缓存位，下次调用重试
      // （原「装配失败不毒化缓存」契约，ADR-0009 T7）。并发调用共享同一次
      // 装配（in-flight dedupe），全体收到同一 rejection。
      snapshot = assembleSystemPrompt(ctx).catch((err: unknown) => {
        snapshot = undefined;
        throw err;
      });
    }
    return snapshot;
  };
}
