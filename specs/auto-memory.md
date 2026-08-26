# Spec: auto-memory（自动记忆抽取 + 清理）

> 兑现 ADR-0009 Decision 5 延期项：在现有 FS 记忆库 + BM25 + `memory_save`/`memory_recall` + promote 之上，落地可开关的自动写入与清理。

## Objective

chat / tui / serve 在 **opt-in** 下，于成功 run 结束后异步抽出跨会话事实，经门禁写入既有记忆库；并具备可重复执行的清理（TTL / 容量 / supersede）。ask 保持记忆层 opt-out（ADR-0010 D3）。

成功标准：

1. `settings.memory.autoExtract !== true` 时行为与现网逐字节一致。
2. 开启后：一次「可记忆」对话结束后，库中出现 `source: auto` 条目（或 UPDATE/NOOP 可观测结果）；失败不改变用户 turn 成功语义。
3. 清理：过期 TTL → disabled；超 cap → 按效用分数驱逐；supersede 链软禁用；可单测复现。
4. 自动条目永不自动 promote 进 system 段（仍走既有 ≥2 session recall 门槛）。

## Inherits（已决）

- ADR-0009：三层落盘、双通道信任、肯定句纪律、BM25-lite、promote 门槛、**auto-extract 曾延期**。
- ADR-0010：`memory_layer` 单 slot；ask 记忆全 opt-out。
- 现有 `MemoryEntryV1` 已含 `importance` / `ttl_days` / `disabled` / `supersedes`；promote 已跳过过期。

## Decisions（本 spec 定稿，写进 ADR-0030）

| ID  | 决策                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **触发**：成功 `StopReason=completed` 之后异步（host 侧）；默认 **session 收尾或 N≥2 完成 turn 闸**，禁止每 turn 强制巩固。                                        |
| D2  | **写入算法**：LLM 抽原子候选 → BM25 近邻 → 裁定 `ADD \| UPDATE \| SUPERSEDE \| NOOP` → 共用 `memory_save` 原子写路径；frontmatter `source: auto`；肯定句门禁复用。 |
| D3  | **清理算法**：机械 GC 优先——TTL disable、store cap 效用驱逐（`importance × recency × recall_count`）、supersede 软禁；LLM 离线合并 **本轨不做**。                  |
| D4  | **信任**：`source:auto` 只走 tool_result 通道；不自动 promote；抽取失败 typed + host `// EXIT:` 吞掉，不 fail turn。                                               |
| D5  | **范围外**：向量/图、ask、记忆浏览器 UI、per-turn 同步抽取。                                                                                                       |

## Boundaries

- Always：复用 `src/harness/memory/`；五类边界测试（空 / 负向句 / overflow cap / 并发 vs `memory_save` / LLM·IO 异常）。
- Never：改 ADR-0009 双通道；默认开启；向 system 盲注自动记忆。

## Commands

```bash
npm test
npx vitest run tests/harness/memory/
```
