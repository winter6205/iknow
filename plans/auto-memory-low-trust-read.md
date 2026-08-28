# Plan: auto-memory-low-trust-read

**Goal:** 开抽取时 system 有短目录 + 英文纪律；每轮最多 5 条预取叠在用户消息；召回仍 10 条原文；全程低信任。  
**Approach:** 先在 memory 模块生成目录与预取（可单测）；再接线 host 用户载荷；最后 recall 包装与 STATUS。底是完整升级 + dream 双闸（#774），本计划不改抽取 N≥2、不改 dream 闸。  
**Spec link:** `specs/auto-memory-low-trust-read.md`  
**Tracker:** 文档进本 PR；不另发 per-bullet GitHub issue（与完整升级文档轨相同）。实施按本文件分 commit。  
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

```
bounded-context-guardian: yes — 目录生成/打分/包装在 harness/memory；loop-engine 不嵌记忆 prompt；host 只把 overlay 接到 user 载荷；ask opt-out 不动
defensive-contract-validator: yes — SC 覆盖 empty（关抽取/空库/空 query）、negative（零词命中高 importance）、overflow（目录 200 行/25KB、预取 5 条+字符帽）、concurrent（per-root memoryDir 仍隔离）、exception（装配/预取失败不 fail turn）
error-handling-enforcer: yes — IO 失败 typed 或 EXIT: log-and-continue；无空 catch；缺预取不得冒泡成 turn 失败
complexity-anti-drift: yes — 目录装配、预取函数、host 接线分 commit；禁止把预取打分塞进 loop-engine
minimal-change-verifier: yes — 一个读路径契约；落地按 plan 分 commit；禁止与向量、默认 ON、dream 闸混提
```

## 待写入

清单已清空（spec 同期 flush）。

## Out of scope

向量、默认 ON、auto-promote、预取进 system、改 dream 闸、改抽取 N≥2、记忆 UI、ask 接线、§2.5 Low。

## Tasks (ordered by dependency)

1. **memory_catalog + English discipline in assembly** — tag: `[implementation]`
   - **Inherits:** spec Does catalog；纪律句全文锁定；ADR-0034 D1；关抽取不加目录
   - **Surface:** `src/harness/memory` 装配
   - **Acceptance:** SC1–SC3：关抽取无纪律句/目录；开抽取且有现行条则含纪律句与 title、不含 body 全文；超 200 行或 25KB 截断；`npx vitest run tests/harness/memory/` 相关套件 EXIT 0
   - Status: [ ] pending

2. **[parallel] Prefetch helper (same scorer, max 5, zero-hit drop)** — tag: `[implementation]`
   - **Inherits:** spec Does prefetch；包装首行锁定；与 `scoreMemoryEntries` 同源；零词命中剔除
   - **Surface:** `src/harness/memory`
   - **Acceptance:** SC4–SC5：相关条入选、高 importance 零重叠不入选、空 query 0 条、条数 ≤ 5 且有字符帽
   - Status: [ ] pending

3. **Host attaches prefetch to the user turn** — tag: `[implementation]`
   - **Inherits:** spec Does「预取进用户消息、禁止 system」；ADR-0034 D2；`autoExtract !== true` 时零 overlay
   - **Surface:** chat / session-api（及 TUI 若走独立 run 入口）
   - **Acceptance:** SC6、SC8：overlay 不进 system 字符串；ask 无预取；装配/预取失败不 fail turn
   - [blocks: T2]
   - Status: [ ] pending

4. **Recall output advisory prefix; keep default 10 full bodies** — tag: `[implementation]`
   - **Inherits:** spec Does recall；默认 10 条原文；同一包装首行
   - **Surface:** `src/harness/memory` recall 工具
   - **Acceptance:** SC7：默认仍最多 10 条原文块且以包装首行开头；既有 BM25 测绿
   - [parallel]
   - Status: [ ] pending

5. **STATUS / architecture 对齐** — tag: `[implementation]`
   - **Inherits:** T1–T4 落地语义；spec Out of this spec 仍为未做项
   - **Surface:** `docs/STATUS.md` / `docs/architecture.md`
   - **Acceptance:** 能力表写明 catalog 进 system、prefetch 进用户消息、低信任英文标注、召回 10 条原文；默认仍 OFF
   - [blocks: T1, T3, T4]
   - Status: [ ] pending

## End of round

全部 bullet 合入后做一轮 code-review（Standards + Spec），再 verification-before-completion。实施顺序 T1∥T2∥T4 → T3 → T5；T3 必须含 T2。
