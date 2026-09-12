# Plan: runtime-capability-memory-gate

**Goal:** 能力/环境观测不能再当成耐久记忆否决工具；旧条模型看不见并在同闸被软禁；默认抽取闸改为 3 个 `completed`。
**Approach:** 先落词条与 ADR（含 0031 D5 重开），再同一套闸同时罩住拒写、读滤、sweep；钩子降频与错误/EXIT 和五类边界一起验收。不开局同步 GC，不把作废还给主模型。
**Spec link:** `specs/runtime-capability-memory-gate.md`
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

## 待写入

（已刷：CONTEXT 两新词 + `auto_extract` / `memory_gc`；ADR-0086；ADR-0031 2026-09-11 amendment。）

## ACR

> 初评 BLOCKED（未列五类边界、退出路径 EXIT）。合同写入 spec 后重评：

- bounded-context-guardian: yes — 落点仍是 `src/harness/memory/` + `build-engine` 既有钩子装配，无新 bounded context
- defensive-contract-validator: yes — spec SC1–5 分配 empty / negative / overflow / concurrent / exception（含退出 GC 与同目录 save 并发）
- error-handling-enforcer: yes — save 拒写 typed；extract 丢弃不 fail turn；机械钩子与进程退出 GC/sweep 均为 typed + `// EXIT: log-and-continue`，退出路径禁止 throw
- complexity-anti-drift: yes — 共用 persist 闸与 completed 计数；双关只加机械段；不恢复 SUPERSEDE/CONTRADICTION_FLOOR、不加 usefulness 总滤
- minimal-change-verifier: yes — 单一不变量（能力观测不得成耐久记忆）；非目标已写（开局 sync-GC、按 id 作废、默认开抽取）

## Tasks (ordered by dependency)

1. **Record persist-gate and hook-trigger decisions** — tag: `[decision]`
   - **Inherits:** spec Assumptions 1–10；ADR-0031 D5 原文「双关则钩子缺席」须重开
   - **Surface:** `docs/CONTEXT.md`、`docs/adr/`
   - **Acceptance:** CONTEXT 含两新词且 `auto_extract` / `memory_gc` 与闸=3、机械-only 钩子一致；ADR-0086 accepted；ADR-0031 有 dated amendment；本 commit 无行为代码
   - Status: [x] done（本会话 persist）

2. **Reject capability observations at persist** — tag: `[implementation]`
   - **Inherits:** spec Does 拒写；Classifier fixtures；Error 表 save/extract 两行；SC1 / SC6 / empty 肯定句仍先于本闸
   - **Surface:** 既有记忆写路径（`memory_save` 与 ingest persist）
   - **Acceptance:** 夹具能力正文 save 失败且无新文件；政策 `constraint` 仍成功；抽取能力候选不落盘；`tests/harness/memory/` 覆盖 negative + empty 门禁顺序
   - [blocks: T1]
   - Status: [x] done（2b564295）

3. **[parallel] Read path omits capability entries** — tag: `[implementation]`
   - **Inherits:** spec 读侧过滤；ADR-0034 通道；ADR-0042 快照吃过滤列表；SC7
   - **Surface:** 既有 prefetch / recall / catalog 装配
   - **Acceptance:** 热库 988 类现行条不出现在三路模型可见输出；非能力条行为不变
   - [blocks: T1]
   - Status: [x] done（8400ea13）

4. **Sweep + GC share the extract completed-turn gate (default 3)** — tag: `[implementation]`
   - **Inherits:** spec Assumptions 6–8；SC2–5、SC8–9、SC11–12；EXIT 表机械钩子与退出
   - **Surface:** 既有 auto-memory 钩子装配与 `memory_gc`
   - **Acceptance:** 默认第 3 个 `completed` 才跑机械段；双关零 LLM；不满 3 不因本功能写盘；sweep 后能力条 `disabled`；溢出/并发/IO 失败符合 SC3–5；开局路径不 await 全量 GC；`ask` 无钩子；退出 best-effort 失败不 throw
   - [blocks: T1]
   - Status: [x] done（1012aec4）

5. **UPDATE refreshes MEMORY.md index line** — tag: `[implementation]`
   - **Inherits:** spec Does UPDATE 行；SC10
   - **Surface:** 既有 ingest persist / 索引
   - **Acceptance:** UPDATE 邻居后 `MEMORY.md` 该 slug 行 title 为新 title；ADD 行为不回退
   - [blocks: T1]
   - Status: [x] done（58b66361）
