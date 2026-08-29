# Plan: auto-memory-layering

**Goal:** 抽取只添或轻改；梦境点名 `replaces` 当场落盘再机械软禁；开 `autoExtract` 即带梦境与 promote 装配；闸文件 `dream.json`；热目录可归档。
**Approach:** 本 PR 只落契约与术语/ADR。实施按抽取判决 → 闸文件改名 → 梦境 `replaces` → 同闸钩子与 promote → 归档 → STATUS。禁止混 `query_trace` / MCP。
**Spec link:** `specs/auto-memory-layering.md`
**Tracker:** 操作员指定不开 GitHub issue；实施按本文件分 commit。
**ACR:** all-yes（2026-08-29，spec SC 补齐后）

```
bounded-context-guardian: yes — 逻辑只落 `src/harness/memory`（ingest/dream/gc/store/assembly/auto-hook）；host 只 `notifyAutoMemory`；loop-engine 不嵌整理 prompt；禁 trace/MCP
defensive-contract-validator: yes — empty SC4/SC6；negative SC11；overflow SC12/SC13；concurrent SC14；exception SC15
error-handling-enforcer: yes — SC11 未知 slug `// EXIT: log-and-continue`；SC15 `dream.json`/archive IO → typed MemoryError + host EXIT，turn 仍 completed
complexity-anti-drift: yes — 抽取判决 / 梦境 parse·replaces persist / 归档 分函数；禁止 CONTRADICTION 回抽取；GC 只软禁
minimal-change-verifier: yes — 单一逻辑任务「自动记忆分层」；禁止混 trace 投影 / MCP；多 tracer commit 仍属同一产品切片
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 待写入

本 plan 落盘后已 flush（CONTEXT 词条 + ADR-0031 D2 / 0033 D2–D3 / 0034 promote 闸）。实施票不再改 glossary，除非实施发现新 one-way door。

## Out of scope

默认 ON；记忆 MCP / 冷库；硬删；任务中 `memory_update`；ES；改 BM25；改 N≥2 或 24h∧5；`ask`；`dream-cursor.json` 兼容。

## Tasks (ordered by dependency)

1. **Persist glossary and ADR amendments** — tag: `[decision]`
   - **Inherits:** spec 待写入：`auto_extract` / `dream` / `memory_op` / `dream.json` / `memory archive`；ADR-0031 D2；0033 D2/D3；0034 promote 与 catalog 同闸
   - **Surface:** `docs/CONTEXT.md`，`docs/adr/`
   - **Acceptance:** CONTEXT 与 ADR 句与 spec Assumptions 1–8 一致；本 commit 无生产代码
   - Status: [x] done（本 docs PR）

2. **Extract decide-ops subset** — tag: `[implementation]`
   - **Inherits:** spec Does：无 CONTRADICTION_FLOOR → SUPERSEDE；ADD / NOOP / 保守 UPDATE；UPDATE 保留邻居 `ttl_days`
   - **Surface:** `src/harness/memory` ingest decide-ops
   - **Acceptance:** SC1、SC2；`npx vitest run tests/harness/memory/` 相关套件 EXIT 0
   - [blocks: T1]
   - Status: [ ] pending

3. **Gate file is `dream.json` only** — tag: `[implementation]`
   - **Inherits:** spec 闸文件读写 `dream.json`；不读、不迁 `dream-cursor.json`
   - **Surface:** `src/harness/memory` 梦境闸
   - **Acceptance:** SC9；夹具与生产路径均不创建旧文件名
   - [blocks: T1]
   - Status: [ ] pending

4. **Dream persist honors `replaces` then GC** — tag: `[implementation]`
   - **Inherits:** spec 梦境 JSON 数组；`replaces` → persist SUPERSEDE；空 `replaces` 不走包含比作废；未知 slug EXIT；每条最多 8 id；同一趟机械 GC；禁止 CONTRADICTION 再判梦境
   - **Surface:** `src/harness/memory` dream persist + `memory_gc`
   - **Acceptance:** SC3、SC4、SC11、SC12
   - [blocks: T2, T3]
   - Status: [ ] pending

5. **`autoExtract === true` implies dream LLM when dual gate holds** — tag: `[implementation]`
   - **Inherits:** spec Assumptions 2–3；闸仍 24h ∧ 5 session；无「只要抽取不要梦境」逃生口；仅梦境仍允许
   - **Surface:** `src/harness/memory` auto-hook
   - **Acceptance:** SC5、SC6
   - [blocks: T3]
   - Status: [ ] pending

6. **[parallel] Promote assembly follows `autoExtract`** — tag: `[implementation]`
   - **Inherits:** spec Does：仅 `ctx.autoExtract === true` 才 `formatPromote`；关抽取无 promote 段；AGENTS / EXISTENCE_POINTER / recall/save 不跟关
   - **Surface:** `src/harness/memory` assembly
   - **Acceptance:** SC7、SC8
   - [blocks: T1]
   - Status: [ ] pending

7. **Archive disabled files out of the hot dir** — tag: `[implementation]`
   - **Inherits:** spec 归档：disabled 且（≥30 天或 disabled 数 > cap）→ `memoryDir/archive/`；热扫描不打开 archive；不硬删
   - **Surface:** `src/harness/memory` GC / store list
   - **Acceptance:** SC10、SC13、SC14、SC15
   - [blocks: T4]
   - Status: [ ] pending

8. **STATUS one sentence** — tag: `[implementation]`
   - **Inherits:** T2–T7 落地语义
   - **Surface:** `docs/STATUS.md` 自动记忆段
   - **Acceptance:** 写明分层、同闸、`dream.json`、归档；默认仍 OFF；`ask` 无记忆层
   - [blocks: T2, T3, T4, T5, T6, T7]
   - Status: [ ] pending

## End of round

T1 已在本 PR。实施：T2∥T3∥T6；T4 在 T2+T3 之后；T5 在 T3 之后；T7 在 T4 之后；T8 最后。全部合入后一轮 code-review + verification-before-completion。
