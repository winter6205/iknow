# 0044. 记忆正文不再进入 system — promote 只服务 GC

Date: 2026-09-05
Status: accepted

## Context

ADR-0009 D3 规定：记忆默认走低信任通道（`memory_recall` / `tool_result`）；跨 ≥2 个不同 session 召回后，正文可以装进 `system` 的 promote 段。ADR-0034 D4 把这段装配与 `autoExtract === true` 同闸。结果是「今天正在做的题」只要被两个会话翻过，就会变成下一场的常驻说明书。高信任位应只留在人写的 `AGENTS.md`。`memory_recall` 合同是纯读，生产路径并未调用 `recordRecall`，所以现网这段多半是空的；留下装配等于以后谁把计数接上，枪就响。

## Decision

1. **任何 provenance 的记忆 body 都不得进入 `system`。** 手写、`source: auto`、`source: dream` 同一条。装配不再拼 promote 段。
2. **`usage.json` / `eligibleForPromote`（≥2 个不同 session）留下，只给 `memory_gc` 效用。** 不把 `recordRecall` 接到 `memory_recall`（保持纯读）。
3. **prefetch 不得再按 promote 资格排除 id。** system 已无对应段，排除会让这些条从用户侧也消失。
4. 本票不决定 catalog 是否仍进 `system`，也不改 prefetch 载荷形状。

## Consequences

- **正面 / Applied:** 召回次数不再买 system 席位；常驻说明书只在 `AGENTS.md`。修订 ADR-0009 D3 的 promote-in-system 条款与 ADR-0034 D4。
- **负面 / Trade-offs:** 记忆库失去「核实后当说明书」的通道。要把某条变成规矩，须写入 `AGENTS.md`。

## Why not

- **只禁 `source: auto|dream`，手写仍可 promote：** `memory_save` 记下的「今天的题」仍能买席位，与 destination 冲突。
- **装配保持现状（现网多半为空）：** 合同仍允许开火；与「不因 recall 进入下一会话 system」冲突。
