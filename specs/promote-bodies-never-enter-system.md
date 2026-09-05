# Spec: 记忆正文不再进入 system — promote 只服务 GC

> Basis: 本会话 destination A + grilling「Promote 还进不进 system」选 A（ADR-0044）。catalog / prefetch 载荷形状 / 告知模型写 `AGENTS.md` **不在本票**。
>
> 假设门（2026-09-05 操作员已确认，不再另开一轮）：
>
> 1. 范围只落地 ADR-0044，不收紧 catalog、不改 prefetch 条数/正文形态。
> 2. 不新增「长期规矩写进 AGENTS.md」的 system / 工具说明。
> 3. 写路径（抽取 N≥2、dream 24h∧5、`source: auto|dream`、机械 GC、默认 OFF）不动。
> 4. Tech stack / 测试：既有 TypeScript + vitest；无新依赖。
> 5. Tracker：本地 markdown（与本努力「不开 map」同一裁定）。

## Objective

chat / tui / serve 在 `autoExtract === true` 时：`system` 不再拼 promote 正文。跨会话召回资格仍记在 `usage.json`，只给 **memory_gc** 效用。撞词预取不得因为「曾经可晋升」把条目丢掉。常驻说明书仍只来自已注入的 `AGENTS.md` / rules 正文，本票不教模型去写那些文件。

成功 = Success Criteria 全绿。

## Boundaries

- **Does:**
  - **装配停 promote 段**：`assembleSystemPrompt`（及 session 快照所用的同一段）在任何 provenance、任何 `autoExtract` 值下都不输出 `formatPromote` 形态的正文（`### <title>` + `updated_at` / `importance` + body）。`promoteEntries` 注入缝若仍存在，也不得把 body 拼进返回的 system 字符串。
  - **prefetch 停止按资格排除**：`eligibleForPromote` / `promotedIds` 不得再从预取命中里丢掉条目。`disabled` 仍丢。零词命中仍丢。最多 5 条正文、用户侧、英文 advisory / 纪律句、会话去重：沿用 `specs/auto-memory-low-trust-read.md` 与 hygiene 修订，本票不改载荷形状。
  - **`recordRecall` 不接到 `memory_recall`**：召回工具保持纯读、零写盘。`usage.json` / `eligibleForPromote` / `listPromotableEntries` 可留着给 GC；本票不删 `promote.ts`。
  - **不告知写 AGENTS.md**：不在 EXISTENCE_POINTER、catalog 纪律句、prefetch 纪律句、`memory_save` / `memory_recall` description 里新增「长期规矩写进 AGENTS.md」。
- **Confirms with human:** （无。destination A、promote 选 A、不告知 AGENTS.md、本票不含 catalog/prefetch 瘦身：本会话已确认。）
- **Out of this spec:** 去掉或改写 **memory_catalog**；prefetch 改成 title+钩子或少于 5 条；向量检索；改默认 `autoExtract` ON；改抽取 N / dream 双闸；把 `recordRecall` 接到召回或预取；host 意图识别；fin 档案 deny list；worktree / isolation；改 `create-task-worktree`。

## Success Criteria

1. `autoExtract === true` 且夹具提供「本可晋升」条目（`promoteEntries` 或磁盘 + `usage.json` 满 2 个 session）：`assembleSystemPrompt` 的返回值 **不含** 该条 body，也 **不含** `### <该条 title>` 后紧跟 `updated_at:` 的 promote 块（vitest）。
2. 同一夹具下：库非空则仍有 `EXISTENCE_POINTER`（`A memory library is available.`）；`autoExtract === true` 且有现行条时 catalog 纪律句仍在；`AGENTS.md` 静态层仍在（vitest；既有装配测除 promote 断言外仍绿）。
3. 预取：query 与一条 `eligibleForPromote === true` 的现行条撞词 → overlay **含** 该条；`disabled` 条仍不含（vitest）。不得再以「already-promoted ids」为由只留下未晋升条。
4. `src/harness/memory/tools/recall.ts` 生产路径不调用 `recordRecall`；工具 description 仍不含下令写 `AGENTS.md` 的句子（vitest 或 ripgrep 契约）。
5. `memory_save` description 仍是跨会话记事实进记忆库，不新增 AGENTS.md 作者指令（与 SC4 同一次检查即可）。
6. `ask` 仍无记忆层、无 memory 工具（既有 build-engine ask 测绿）。
7. `npx vitest run tests/harness/memory/` EXIT 0。

## Open Questions

(none)

## Inherits / Changes

- Inherits CONTEXT（原文）：
  - **promote**: `usage.json` 里一条记忆被 ≥2 个不同 session 召回后的资格。资格只进入 **memory_gc** 效用，**不再**把正文装进 `system`；常驻说明书只在 `AGENTS.md`。ADR-0044。
  - **memory_prefetch**: 每轮按本轮用户原文、用 `scoreMemoryEntries` 选出最多 5 条现行条正文，叠在用户消息侧；零词命中不得入选；包装句英文、标明 advisory；禁止写入 system。不得因 promote 资格排除（system 已无对应段）。
  - **auto_extract**（首句闸）：自动记忆抽取的产品总闸，boolean-only、**默认 OFF**——段缺失或非 `true` 一律关抽取与 **memory_catalog** 装配。
  - **source: auto**（通道句）：自动条目**只经 `memory_recall` 的 tool_result 与 memory_prefetch 用户侧块**到达模型，**body 永不进 `system`**（ADR-0044）。
  - **会话级快照段**: 当前住户：`memory_layer` catalog、git 块；promote 段已撤出，ADR-0044。
- Inherits: ADR-0044；ADR-0009 D3 经 0044 废止 promote-in-system；ADR-0034 D1 catalog 与 D2 prefetch 载荷本票不动、D4 废止；ADR-0042 catalog 快照仍在、promote 不再是住户；`EXISTENCE_POINTER` 与 hygiene 纪律句不动；`ask` opt-out（ADR-0010 / #228 D3）。
- Changes: 装配删除 promote 段；prefetch 删除按 `eligibleForPromote` 排除；下游 `specs/auto-memory-layering.md` SC7/SC8、`specs/auto-memory-low-trust-read.md`「已在 promote 段的条不再预取」、`specs/casual-ask-context-hygiene.md`「promote 不改」让位给本文件；`specs/README.md` 加本条。
- Test command: `npx vitest run tests/harness/memory/`
- Surfaces: `src/harness/memory`；不改 isolation / ACI 建树。

## ACR

planned files: `src/harness/memory/assembly.ts`, `src/harness/memory/prefetch.ts`, `tests/harness/memory/assembly.test.ts`, `tests/harness/memory/prefetch.test.ts`, `tests/harness/memory/integration.test.ts`, `tests/harness/memory/refresh.test.ts`, `specs/auto-memory-layering.md`, `specs/auto-memory-low-trust-read.md`, `specs/casual-ask-context-hygiene.md`, `specs/README.md`.

```
bounded-context-guardian: yes — 装配与预取改动留在 harness/memory；不碰 isolation / identity / ACI 建树；不把 AGENTS.md 作者权做成新工具
defensive-contract-validator: yes — SC 覆盖 empty（无资格条目时 system 仍无 promote 块）、negative（资格条目不得进 system、disabled 仍不预取）、overflow（预取 5 条帽与 catalog 帽本票不放宽）、concurrent（per-root memoryDir / 会话快照仍冻结 catalog）、exception（目录/预取 IO 仍 log-and-continue）
error-handling-enforcer: yes — 不新增空 catch；召回保持纯读失败路径；装配失败不毒化缓存（既有 refresh 合同）
complexity-anti-drift: yes — 删掉 system 拼段与预取排除，不把 GC 资格函数塞进装配
minimal-change-verifier: yes — 一个 destination（ADR-0044）；落地按 plan 分 commit（运行时契约 / 下游 spec 对齐）；禁止与 catalog 去掉、prefetch 瘦身、AGENTS.md 下令混提
```

## 待写入

清单已清空（ADR-0044 与 CONTEXT 已在本会话 persist，并拷入本 worktree）。
