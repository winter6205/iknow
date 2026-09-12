# Spec: runtime-capability-memory-gate — 能力观测不准进库 · 读侧先挡 · 与抽取同闸软禁

> 操作员 2026-09-11 grilling（#988）：运行时能力不以记忆为权威；persist 前拒写；旧条读侧不可见；落盘软禁与抽取共用 `completed` 计数，默认闸 3。对照调研不进本文件。
>
> Amends `auto-memory.md` / ADR-0031 D1（闸 N）与 D5（双关时钩子可仅为机械段）；amends `auto-memory-extract-discipline.md` / `auto-memory-layering.md` 中「不改 N≥2」；读通道仍遵守 ADR-0034 / ADR-0042 / ADR-0044。

## Glossary（`docs/CONTEXT.md` 现行条）

- **runtime capability persist gate**
- **capability memory sweep**
- **auto_extract**（闸改为默认 3 个 `completed`）
- **memory_gc**
- **memory_type** / **memory_op** / **dream** / **memory_prefetch** / **memory_catalog**

## Assumptions（操作员本轮锁定）

1. 能力/环境观测（出网、DNS、某工具此刻能不能用）不准进跨会话库，尤其不准写成 `constraint`。会话 transcript 可以出现当次失败。
2. `memory_save` 与自动抽取 persist **同一条闸**：拒写（typed），不是静默 NOOP，不是改成 `note` 先塞进去。
3. 不是「有用才存」的品味过滤。产品/政策类 `constraint` 仍可写。
4. 读侧（prefetch / recall / catalog）不得把能力条送给模型。权威是当次工具结果；记忆不得否决试探。
5. 不把 `SUPERSEDE` 还给会话内 `memory_save`，不恢复抽取 CONTRADICTION_FLOOR。作废仍归梦境。
6. 落盘软禁与抽取共用 `StopReason=completed` 计数；默认闸 **3**（原 2）。取消/超时不计。抽取关着到期仍只跑机械段（`memory_gc` + sweep），零 LLM。
7. 不在会话开局同步全量 GC。catalog 仍开局快照（ADR-0042），快照吃过滤后的列表。
8. 进程退出 best-effort 再扫一次；不得当作唯一闸。失败不得抛出退出路径。
9. UPDATE 必须刷新 `MEMORY.md` 对应索引行。
10. `ask` 仍无记忆层。

→ 以上视为已确认。纠正则改本文件。

## Objective

chat / tui / serve 上：新的能力观测进不了库；旧的能力条模型看不见；磁盘在抽取同闸（默认每 3 个 `completed`）及退出尽力时软禁它们。默认抽取变稀（2→3）。成功 = Success Criteria 全绿。

## Boundaries

- **Does:**
  - persist 前闸：title+body（及 type）判定为运行时能力/环境可用性观测 → 拒写。`memory_save` 以 typed 工具失败回模型（原因可读）；抽取候选同样不得 persist（该候选 NOOP/丢弃，不 fail 用户 turn）。
  - 读侧过滤：现行条若属能力观测，不进 prefetch、recall 命中列表、catalog 行。`disabled` 过滤仍先于本闸。
  - **capability memory sweep**：把已有能力条 `disabled: true`（不硬删），可与既有 `memory_gc` 同趟。规则可测、零 LLM。
  - 触发：`DEFAULT_COMPLETED_TURN_GATE = 3`；到期走抽取（若开）然后机械 GC+sweep。`autoExtract` 与 `dream` 均关时仍装配机械-only 钩子（零 LLM）。TUI `/memory` 翻转语义不因机械钩子回退。
  - 进程退出：best-effort `memory_gc` + sweep；`// EXIT: log-and-continue`；不 throw。
  - ingest UPDATE：写条后 `MEMORY.md` 该 slug 行与现行 title 一致。
  - 读侧过滤的英文纪律可沿用 advisory 句；本 spec 不改包装原文，除非验收需要一句「记忆不能替代当次工具结果」。
- **Confirms with human:** （无。闸=3、拒写、读侧先挡、开局不同步 GC 已确认。）
- **Out of this spec:** 默认打开 `autoExtract`/`dream`；`memory_save` 按 id / `supersedes`；抽取矛盾即作废；通用有用性打分；双时态知识图；改梦境 24h∧5；硬删；`ask` 接线；扫仓检测能力；为能力条单开 `memory_type` 枚举值（除非实施证明枚举不够，否则用闸认正文，不扩词表）。

## Classifier fixtures（合同，不是实现菜谱）

必须拒 / 必须扫 / 必须从读通道消失的正文（语义，措辞可变）：

- 沙箱 DNS / SSRF / benchmarking 段导致 `web_search` / `web_fetch` 不可用
- 「本环境没有真实出网，不要调用 web 工具」

必须放行的正文：

- 产品政策：`constraint`「隔离 ON 时 mutate 须先建 worktree」
- 项目约定：`convention` 测试命令、目录习惯
- 当次工具失败只存在于 transcript，不再 `memory_save`

分类器实现（关键词、启发式、或二者）由实施选定，夹具钉死上述语义。

## Error / EXIT

| 路径                                          | 失败时                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| persist 闸拒写（save）                        | typed `MemoryError`（或既有子类）；tool_result 失败；用户 turn 不因此变 `execution_failed` 以外的宿主崩溃 |
| persist 闸丢弃（extract 候选）                | 不写盘；ingest 其余候选继续；用户 turn 成功                                                               |
| 机械钩子 GC/sweep IO                          | typed MemoryError + host `// EXIT: log-and-continue`；用户 turn 仍 `completed`                            |
| 进程退出 GC/sweep                             | 同上 EXIT；**禁止**从退出回调 throw                                                                       |
| 与会话内 `memory_save` 并发写同一 `memoryDir` | 既有原子写纪律；不得半文件；一侧失败 typed + 不损坏另一侧已成功条                                         |

## Success Criteria

1. **negative：** `memory_save` 能力观测（含 `type: constraint` + SSRF/无出网类正文）→ 拒写，磁盘无新 slug；政策类 `constraint` 仍成功。
2. **empty：** 空库上到期机械钩子：零 LLM、零新文件、sweep/GC 幂等成功。空 title/body 仍先走既有肯定句门禁（先于本闸）。
3. **overflow：** 超长能力正文仍拒写；超 cap 时既有 GC 效用软禁仍运行，且能力条优先或至少被 sweep 软禁（夹具钉一种可观察序）。
4. **concurrent：** 同 `memoryDir` 交错 `memory_save`（合法条）与 sweep/GC → 无半文件，第二次幂等。
5. **exception：** 机械钩子与退出路径上 GC/sweep 读盘失败 → typed + EXIT，用户 turn / 进程退出不因该失败崩溃。
6. 抽取 `autoExtract === true` 产出能力候选 → 不落盘；非能力候选仍可 ADD/UPDATE。
7. 热库已有 988 类条：prefetch / recall / catalog 均不含其 title/body；sweep 后 `disabled: true`。
8. `autoExtract !== true` 且 `dream !== true`：攒满 3 个 `completed` 仍调用机械段、`complete` 次数为 0；不满 3 不写盘（除退出尽力）。
9. 默认闸为 3：第 2 个 `completed` 不触发抽取/机械段；第 3 个触发。取消/超时不计数。
10. ingest UPDATE 邻居后 `MEMORY.md` 该行 title 为新 title。
11. 会话开局不因本功能同步扫全库而阻塞首包（无「启动路径 await 全量 GC」）。
12. `ask` 仍无记忆工具、无本钩子。
13. `npx vitest run tests/harness/memory/` 及相关 hook / build-engine 测 EXIT 0。

## Open Questions

(none)

## Inherits / Changes

- Inherits：ADR-0034 低信通道；ADR-0042 catalog 会话快照；ADR-0044 body 不进 system；抽取无 CONTRADICTION SUPERSEDE（layering）；肯定句门禁；GC 只软禁。
- Changes：默认 `completed` 闸 2→3；双关时机械-only 钩子在场；能力观测 persist 拒写 + 读滤 + sweep；UPDATE 刷新索引行。
