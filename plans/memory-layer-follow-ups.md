# Plan: memory-layer-follow-ups

**Goal:** 作废条不进 recall、事实 `type` 封闭枚举、用户级 AGENTS 与 `user.md` 同根并叠项目层。  
**Approach:** 三刀互不阻塞，各一 commit：先把门（recall），再统一 type，再收回用户静态层物理根。不重开抽取/GC/dream。  
**Spec link:** `specs/memory-layer-follow-ups.md`  
**Tracker:** GitHub `winter6205/iknow` — spec #729；T1 #730 · T2 #731 · T3 #732（`ready-for-agent`；三票并行，无 blocking 边）  
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

```
bounded-context-guardian: yes — 改动留在 harness/memory（recall/save/ingest/discovery/assembly）；不新建顶层模块；ask opt-out 不动
defensive-contract-validator: yes — SC 覆盖 empty（无 AGENTS 文件 / 空库）、negative（非法 type → note）、overflow（recall limit 仍封顶）、concurrent（save 与 recall 仍原子文件）、exception（缺文件跳过不抛）
error-handling-enforcer: yes — 非法 type 不 throw；缺全局 AGENTS 视为该层空，不 fail 会话；无空 catch
complexity-anti-drift: yes — 三刀分文件：recall 过滤、type 规范化、discovery userRoot；不把抽取 prompt 塞进 loop-engine
minimal-change-verifier: yes — 一个契约；落地按三 commit（recall / type / user-AGENTS 根）分任务，禁止与 dream 或 BM25 中文切词混提
```

## 待写入

清单已清空（CONTEXT `user-level AGENTS.md` / `memory_type` 已落；不新开 ADR）。

## Out of scope

dream 合并、中文 BM25、默认 TTL、硬删、跨项目事实库、改 cap、改 `autoExtract` 默认、改 `user.md` 落点。

## Tasks (ordered by dependency)

1. **[parallel] Recall skips disabled entries** — tag: `[implementation]` (#730)
   - **Inherits:** spec SC1；`memory_gc` 只软禁；ingest 近邻已跳过 disabled
   - **Surface:** `src/harness/memory` recall 读侧
   - **Acceptance:** 库中现行条与 `disabled: true` 条并存时，`memory_recall` 返回不含废条 title/body；`npx vitest run tests/harness/memory/` 相关套件 EXIT 0
   - Status: [x] done

2. **[parallel] Closed memory_type enum** — tag: `[implementation]` (#731)
   - **Inherits:** spec SC2；CONTEXT `memory_type` 五值；非法/空 → `note` 且写入成功
   - **Surface:** `src/harness/memory` save + ingest persist（同一规范化）
   - **Acceptance:** `memory_save` 与自动 persist 对非法或省略 type 落盘 `note` 且成功；合法五值原样保留
   - Status: [ ] pending

3. **[parallel] User-level AGENTS.md at userHome** — tag: `[implementation]` (#732)
   - **Inherits:** spec SC3；ADR-0009 用户层路径；CONTEXT `user-level AGENTS.md`；项目层仍 `<cwd>/AGENTS.md`
   - **Surface:** `src/harness/memory` discovery/assembly（用户静态层根 = `userHome`，不是 workspaceRoot）
   - **Acceptance:** userHome 全局 AGENTS + cwd 项目 AGENTS 同时出现在装配结果且含项目优先声明；workspace 下 `.iknow/AGENTS.md` 不进入用户级层；缺全局文件不 fail 会话
   - Status: [ ] pending
