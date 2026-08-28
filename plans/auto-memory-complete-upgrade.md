# Plan: auto-memory-complete-upgrade

**Goal:** 中文近邻让四态生效；dream 可开关合并；serve 多 root 钩子与 chat/serve 共用 notify。  
**Approach:** 先共用 CJK 切分（dream 也吃近邻）；Medium 两条接线与切分并行；再接线 dream；最后 STATUS/architecture。决策已落 ADR-0033 + spec，本计划无 `[decision]` 票。  
**Spec link:** `specs/auto-memory-complete-upgrade.md`  
**Tracker:** 无 GitHub issue（操作员 2026-08-28：文档进 PR，云端按本文件实施；不发 spec/ready-for-agent 票）。  
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

```
bounded-context-guardian: yes — 切分/ingest/dream/GC 留在 harness/memory；host 只接线；不新建顶层模块；ask opt-out 不动
defensive-contract-validator: yes — SC 覆盖 empty（关开关/空 token/空 transcript）、negative（非 true 开关）、overflow（dream 输入条数/字符封顶由实现自选但必须有上限）、concurrent（per-root 钩子串行仍在）、exception（LLM·IO → turn 成功）
error-handling-enforcer: yes — dream/extract 失败 typed MemoryError；host 共用辅助必须 // EXIT: log-and-continue；gc 零 LLM；无空 catch
complexity-anti-drift: yes — 切分、per-root notify、dream 分 commit；禁止把 merge prompt 塞进 loop-engine 或 gc.ts
minimal-change-verifier: yes — 一个契约；落地按本 plan 分 commit，禁止与向量检索或默认 ON 混提
```

## 待写入

清单已清空（与 spec 同期 flush）。

## Out of scope

向量/图、记忆 UI、改默认 ON、硬删、改 cap、默认 TTL、跨项目库、§2.5 Low、#114 压缩/持久化。

## Tasks (ordered by dependency)

1. **[parallel] Shared CJK tokenize + empty-token neighbor** — tag: `[implementation]`
   - **Inherits:** spec Does 切分与空 token；ADR-0033 D1；ASCII 长度 ≥ 2 不变；SC1–SC3
   - **Surface:** `src/harness/memory`（BM25 与 ingest 近邻）
   - **Acceptance:** 纯中文近重复候选不是全 ADD；英文既有测绿；双空 token 无近邻命中；`npx vitest run tests/harness/memory/` 相关套件 EXIT 0
   - Status: [x] done

2. **[parallel] Per-root auto-memory hook on SessionHub** — tag: `[implementation]`
   - **Inherits:** spec Does SessionHub；ADR-0033 D3；SC6；`engineByRoot` 已按根缓存 engine
   - **Surface:** `session-api`
   - **Acceptance:** 同一进程两个 workspaceRoot 均开 extract 时，B 的 completed turn 不写入 A 的 memoryDir
   - Status: [x] done

3. **[parallel] Single notifyAutoMemory helper** — tag: `[implementation]`
   - **Inherits:** spec Does notify；ADR-0033 D3；SC7
   - **Surface:** harness 自动记忆接线 + `cli` chat + `session-api` hub
   - **Acceptance:** 两宿主调用同一导出辅助；钩子缺席与抛错都不把用户 turn 打成失败
   - Status: [x] done

4. **dream settings + merge pass** — tag: `[implementation]`
   - **Inherits:** spec Does dream；CONTEXT `dream`；ADR-0033 D2–D3；SC4–SC5、SC8；先 ingest 再 dream 再 GC；`gc.ts` 无 LLM
   - **Surface:** `src/config` settings、`src/harness`（memory + build-engine）
   - **Acceptance:** dream 关时无额外 merge LLM；开时 FakeLLM 可观测 SUPERSEDE/UPDATE 且 `source: dream`；仅 dream 开也会装配钩子；ask 仍无记忆工具
   - [blocks: T1]
   - Status: [x] done

5. **STATUS / architecture 对齐** — tag: `[implementation]`
   - **Inherits:** T1–T4 已落地语义；spec Out of this spec 仍写进 STATUS 未做项
   - **Surface:** `docs/STATUS.md` / `docs/architecture.md`
   - **Acceptance:** 能力表写明 CJK 近邻、dream 默认 OFF、per-root 钩子、共用 notify；§2.5 三条 Medium 标已处置或删除；Low 仍列为遗留
   - [blocks: T2, T3, T4]
   - Status: [x] done

## End of round

全部 bullet 合入后做一轮 code-review（Standards + Spec），再 verification-before-completion。云端按 T1→（T2∥T3）→T4→T5 开 PR 即可；T1/T2/T3 可三分支并行，T4 必须含 T1。
