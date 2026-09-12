# Spec: auto-memory-layering — 抽取收窄 · 梦境点名落盘 · `dream.json`

> 2026-08-29 LogicSync：整理归梦境、抽取为第一层；`autoExtract` 开则梦境一起开；闸文件 SSOT 为 `dream.json`（无旧名兼容）。操作员授权本讨论结论直接成文。
>
> **Amended 2026-09-05** by `specs/promote-bodies-never-enter-system.md`：promote 资格只给 `memory_gc` 效用、`system` 不再拼 promote 正文；本 spec 的 promote 装配闸段、SC7/SC8、auto_extract 的 promote 装配提法、Assumption 4 的 promote 段描述、Objective 的 promote-in-system 提法、Changes 的 promote 装配条目让位给彼 spec。本 spec 余下范围（抽取收窄、梦境 `replaces` 落盘、`dream.json`、热目录归档）仍有效。
>
> **Amended 2026-09-11** by `specs/runtime-capability-memory-gate.md`：完成回合闸与双关钩子以 CONTEXT / ADR-0031 现行条为准（N≥3、机械-only 钩子可在场）。本文件 Glossary 里旧「N≥2 / 双关钩子缺席」不再是 SSOT。

## Glossary（exact copy from docs/CONTEXT.md）

- **auto_extract**（`settings.memory.autoExtract`）: 自动记忆抽取的产品总闸，boolean-only、**默认 OFF**——段缺失或非 `true` 一律关抽取与 **memory_catalog** 装配。`true` 时 host 仍按 N≥2 抽，且梦境双闸满足时必跑梦境 LLM（即使 `settings.memory.dream === false`）。仅当 extract 与 dream 均关时 `BuiltEngine.autoMemory` 缺席。ADR-0031 D1/D5；分层 `specs/auto-memory-layering.md`；钩子见 ADR-0033。
  _Avoid_: 把默认改成 ON；开抽取却不要梦境；把抽取 prompt 内嵌进 loop-engine；给 `ask` 接线；让 ingest 失败冒泡成用户 turn 失败；开抽取却不注 memory_catalog
- **memory_op**（`ADD` | `UPDATE` | `SUPERSEDE` | `NOOP`）: persist 仍认四态；**抽取** `decide ops` 只用 ADD / 保守 UPDATE / NOOP（无 CONTRADICTION_FLOOR SUPERSEDE）。`SUPERSEDE` 由梦境 `replaces` 点名后 persist 写出 `supersedes`，旧条仍经 **memory_gc** 软禁。三段函数分离不变。ADR-0031 D2 修订；`specs/auto-memory-layering.md`。
  _Avoid_: 抽取再用低词重叠当矛盾作废；把四态压成 upsert；绕开 `memory_save` 写纪律；把三段合成一个函数
- **memory_gc**: 可重复、幂等的机械清理，三条规则、**零 LLM**——`ttl_days > 0` 且已过期 → `disabled: true`；被别的条目 `supersedes` 指名 → `disabled: true`；活跃条目超 store cap → 按效用分 `importance × recency × (1 + recall_count)`（recall 次数取自既有 `usage.json` sidecar）从低到高软禁。GC **只软禁不删文件**，误驱逐改一行 frontmatter 就能收回。ADR-0031 D4。
  _Avoid_: 硬删文件；把 LLM 离线合并 / 摘要塞进 GC（合并走 **dream**，ADR-0033）；让 GC 依赖 frontmatter + usage sidecar 之外的运行时状态
- **dream**（`settings.memory.dream`）: LLM 离线合并开关，boolean-only、**默认 OFF**。闸仍 24h ∧ 5 session。`autoExtract === true` 时闸到后仍跑梦境（不必 `dream === true`）；输出可带 `replaces`，persist SUPERSEDE，不经 CONTRADICTION_FLOOR。闸文件 **dream.json**。其余（skip 推进时间闸、`source: dream`、不进 `gc.ts`）仍见 ADR-0033。
  _Avoid_: 把合并塞进 GC；每 turn 强制 dream；与抽取共用 N≥2；默认 ON；dream 条 auto-promote；用 CONTRADICTION 代替 `replaces`；闸文件名含 cursor
- **dream.json**: 每个 `memoryDir` 下梦境双闸状态（上次成功或 skip 时间 + session 集合）。实施读写此文件名；不读、不迁 `dream-cursor.json`。
  _Avoid_: 文件名含 cursor / Cursor；旧名兼容层
- **memory archive**: 热目录外的软禁归档（`memoryDir/archive/<slug>.md`）。召回 / 预取 / 抽取近邻 / 梦境输入 / cap **不扫** archive；不是硬删。
  _Avoid_: 把归档当硬删；热扫描仍遍历 archive
- **source: auto** / **source: dream**: 定义以 CONTEXT 为准（本 spec 不改 provenance 字段名）。
- **memory_catalog** / **memory_prefetch**: 定义以 CONTEXT 为准；本 spec 不改目录/预取契约。promote 资格只给 `memory_gc` 效用、`system` 不再拼 promote 正文，见 `specs/promote-bodies-never-enter-system.md` / ADR-0044。
- **surface split (identity vs memory)**: 定义以 CONTEXT 为准。`ask` 仍全 opt-out。

## Assumptions（2026-08-29 操作员讨论锁定）

1. 抽取不做 CONTRADICTION_FLOOR SUPERSEDE；作废只来自梦境点名的 slug。
2. `autoExtract === true` 时钩子跑梦境（闸仍 24h ∧ 5 session），即使 `settings.memory.dream === false`。仅梦境、关抽取仍允许（`dream === true` 且 `autoExtract !== true`）。
3. 无 `dream: false` 逃生口去「只要抽取不要梦境」。
4. catalog 段：仅 `autoExtract === true` 且库非空时拼进 `system`（沿用 `auto-memory-low-trust-read.md`）。AGENTS / EXISTENCE_POINTER / `recall`/`save` 不跟抽取关。`system` 拼 promote 正文按 `specs/promote-bodies-never-enter-system.md` / ADR-0044 全部废止。
5. `MEMORY.md` 永不注入。`usage.json` 在 recall 时仍更新（与抽取开关无关）。
6. 梦境提案当场 persist + 同一趟 GC；不是排队等稍后执行。不硬删。
7. 废条热目录膨胀：本 spec **包含**归档（见 Does）。MCP 冷库 / 外置记忆 server **不在**本 spec。
8. 闸文件实施名 `dream.json`；无 `dream-cursor.json` 兼容。
9. Tech stack / 测试：既有 TypeScript + vitest；无新运行时依赖。
10. UPDATE 保留邻居 `ttl_days`（抽取候选无独立 TTL 字段时）。

→ 以上视为已确认。纠正则改本文件。

## Objective

chat / tui / serve 上自动记忆分成两层：**抽取**只从本段对话往库里添或轻改；**梦境**看有界整库，点名替换并落盘，再机械 **memory_gc** 软禁旧 `<slug>.md`。`autoExtract` 是产品总闸（带梦境 + 触发 catalog 装配；promote 资格只给 GC，详见 `specs/promote-bodies-never-enter-system.md` / ADR-0044）。默认仍 OFF。成功 = Success Criteria 全绿。

## Boundaries

- **Does:**
  - **抽取 `decideMemoryOps` 子集**：无近邻 → ADD；近邻且 `covered >= RESTATEMENT_FLOOR` → NOOP；近邻且同一 subject（既有 SAME_SUBJECT_FLOOR / NEAR_DUPLICATE_FLOOR）且尚未复述 → UPDATE；**删除** `agreement < CONTRADICTION_FLOOR → SUPERSEDE` 分支。BM25 仍只负责近邻。
  - **梦境落盘**：LLM 一次输出 JSON 数组，元素为 `{ title, body, type, importance, replaces?: string[] }`。`replaces` 缺席或空 → 不得用包含比作废邻居；可走抽取同款保守 ADD/UPDATE/NOOP。`replaces` 为已存在 slug 时 persist **SUPERSEDE**（新条 `supersedes` 指向它们，每条最多 8 个 id；未知 slug 跳过该 id 并 `// EXIT: log-and-continue`）。**禁止**把梦境输出再送进 CONTRADICTION_FLOOR。
  - **顺序**：抽取与梦境同一轮时仍先抽取（`gc: false`）再梦境再 GC（现行 auto-hook 形态）。
  - **闸文件**：读写 `dream.json`；删/停用 `dream-cursor.json` 代码路径。
  - **promote 装配**：本 spec 原「`assembleSystemPrompt` 仅当 `ctx.autoExtract === true` 且有资格条时 `formatPromote`」条款已让位给 `specs/promote-bodies-never-enter-system.md` / ADR-0044：任何 provenance、任何 `autoExtract` 值下都不输出 `formatPromote` 形态正文。本 spec 不再单列 promote 装配口径。
  - **归档**：`disabled === true` 且（`updated_at` 距今 ≥ 30 天 **或** 热目录内 disabled 条数 > store cap）→ 将该 `<slug>.md` 移到 `memoryDir/archive/`。`listStoreEntries` / recall / prefetch / 梦境 prompt 输入不打开 `archive/`。不硬删。`MEMORY.md` 对应行删除或忽略失效链（实施钉一种，测例锁）。
- **Confirms with human:** （无。2026-08-29 操作员确认分层、同闸、A 落盘、归档进本张、`dream.json`、不做兼容。）
- **Out of this spec:** 默认 ON；向量/图；记忆 MCP / 冷库；硬删归档后的文件；任务中 `memory_update` / `memory_save` 按 id；ES；改 BM25 公式；改梦境 24h∧5；改 catalog/prefetch 数值；STATUS §2.5 Low（drain / 错误类型）除非挡住本契约；`ask` 接线。抽取完成回合闸 **amended by** `runtime-capability-memory-gate.md`（原「不改 N≥2」让位）。

## Success Criteria

1. 抽取夹具：两正文词重叠低的「同一主题不同侧面」候选 → op 为 ADD 或 UPDATE，**不为** SUPERSEDE（vitest，FakeLLM）。
2. 抽取夹具：`covered >= RESTATEMENT_FLOOR` → NOOP（既有复述测仍绿或等价断言）。
3. 梦境 FakeLLM 返回带 `replaces: ["old"]` 的一条 → 磁盘有新 slug、`supersedes` 含 old；随后 GC 后 `old.md` 为 `disabled: true`（vitest）。
4. 梦境 FakeLLM 返回无 `replaces`、正文与邻居词重叠很低 → **不** SUPERSEDE 该邻居（vitest）。
5. `autoExtract === true` 且 `settings.memory.dream === false`：钩子在闸满足时仍调用梦境 LLM（vitest，计 complete 次数）。
6. `autoExtract !== true` 且 `dream !== true`：零梦境 LLM、零抽取 LLM（既有关闸测绿）。
7. `autoExtract !== true`：`assembleSystemPrompt` **不含** catalog 段与目录行；可含 AGENTS 与 EXISTENCE_POINTER（库非空时）（vitest）。promote 装配口径让位给 `specs/promote-bodies-never-enter-system.md` SC1—SC3。
8. `autoExtract === true` 且有现行条：装配含 catalog 纪律句全文与该条 title；不含该条 body 全文（vitest）。promote 资格条不进入装配（让位给 `specs/promote-bodies-never-enter-system.md`）。
9. 实施后闸状态文件名为 `dream.json`；测试夹具与生产路径均不创建 `dream-cursor.json`（vitest / grep 或路径断言）。
10. 夹具：一条 disabled 且 `updated_at` 为 31 天前 → `runMemoryGc` 或本 spec 归档函数后热目录无该 slug、`archive/<slug>.md` 存在；随后 `listStoreEntries` 不含该条（vitest）。
11. 梦境 `replaces` 含未知 slug 与一个已知 slug → 未知 id 跳过（`// EXIT: log-and-continue`）、已知 id 仍 SUPERSEDE；turn 不失败（vitest）。
12. 梦境 `replaces` 超过 8 个已存在 slug → 至多 8 个写入 `supersedes`（vitest）。
13. 热目录 disabled 条数 > store cap（且未满 30 天）→ 超额 disabled 条进入 `archive/`，热扫描不再列出（vitest）。
14. 同一 `memoryDir` 上交错两次归档/GC（夹具串行调用即可代表 per-dir 互斥；禁止跨目录共享可变闸）→ 第二次幂等、无半文件（vitest）。
15. `dream.json` 或归档 rename 失败 → typed MemoryError（或既有 IO 子类）+ host `// EXIT: log-and-continue`，用户 turn 仍 completed（vitest）。
16. `npx vitest run tests/harness/memory/` 加本票新增测 EXIT 0。
17. `ask` 仍无记忆层（既有 build-engine ask 测绿）。

## Open Questions

(none)

## Inherits / Changes

- Inherits：ADR-0009 D3 双通道（未 promote body 不得当指令）；ADR-0010 `ask` opt-out；ADR-0031 D1 抽取闸 N≥2、D4 GC 软禁、D5 默认 OFF；ADR-0033 tokenize + 梦境 24h∧5 + per-root 钩子；ADR-0034 catalog/prefetch。
- Inherits：`persistMemoryOps` 仍只在新条上写 `supersedes`，旧条由 **memory_gc** 改 `disabled`。
- Changes：抽取 `memory_op` 判决去掉矛盾 SUPERSEDE；梦境以 `replaces` 驱动 SUPERSEDE；`autoExtract` 蕴含梦境；闸文件 `dream.json`；热目录归档。promote 装配口径（与 SC7/SC8、auto_extract 提法、Assumption 4、Objective 中相关条目）已让位给 `specs/promote-bodies-never-enter-system.md` / ADR-0044。
- Test command: `npx vitest run tests/harness/memory/`
- Surfaces: chat / tui / serve；`ask` 除外。

## ACR

```
bounded-context-guardian: yes — 判决/落盘/归档/闸文件留在 src/harness/memory；host 只通知；loop-engine 不嵌整理 prompt
defensive-contract-validator: yes — empty SC6/replaces 空走 ADD·UPDATE·NOOP；negative SC11 未知 slug；overflow SC12/SC13；concurrent SC14 per memoryDir；exception SC15
error-handling-enforcer: yes — SC11/SC15 钉 EXIT + typed MemoryError；闸/归档 IO 不 fail turn
complexity-anti-drift: yes — 抽取判决、梦境 parse、归档 分函数；禁止把 CONTRADICTION 搬回抽取
minimal-change-verifier: yes — 一个逻辑任务「自动记忆分层」；禁止混 trace 投影 / MCP
```

## 待写入

已 flush（`plans/auto-memory-layering.md` T1）。
