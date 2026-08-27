# Plan: auto-memory（自动记忆模块）

**Goal:** 在 iknow 现有记忆层上落地可开关的自动写入 + 机械清理，兑现 ADR-0009 D5 延期项。  
**Approach:** 先 ADR+薄 spec 定触发/写入算法/清理；再机械 GC；再写时四态 ingest（ADD/UPDATE/SUPERSEDE/NOOP）；最后 host 异步接线。默认 OFF；ask 不装。  
**Spec link:** `specs/auto-memory.md`  
**Tracker:** GitHub（`winter6205/iknow`，label `ready-for-agent`）  
**Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → one commit on ticket branch

## ACR

```
bounded-context-guardian: yes — 逻辑落在 harness/memory（+ build-engine/session-api/cli|tui 最小接线）；不新建顶层模块；ask opt-out 保留
defensive-contract-validator: yes — 每实现票含五类：empty（关开关/空候选）/ negative（负向句拒绝）/ overflow（cap 驱逐）/ concurrent（async extract vs memory_save）/ exception（LLM·IO → turn 仍成功）
error-handling-enforcer: yes — 复用/扩展 MemoryError；host 异步 catch 必须 // EXIT: log-and-continue，禁止空 catch、禁止 fail 用户 turn
complexity-anti-drift: yes — extract / gate+ops / gc / host-wire 分票；禁止 loop-engine 内嵌抽取 prompt
minimal-change-verifier: yes — 决策 → GC → ingest → wire → 文档 分 commit；禁止 GC 与 extract 同 commit
```

## 待写入

清单已清空（T5）。

- [x] CONTEXT：`auto_extract`、`memory_op`（ADD\|UPDATE\|SUPERSEDE\|NOOP）、`memory_gc`、`source:auto` —— 四条术语 + `memory_save` vs auto_extract / `memory_gc` vs promote 两条 Relationships 已落 `docs/CONTEXT.md`（T5）
- [x] ADR-0031（T1 产出）；ADR-0009 D5 标注 superseded-by-0031（范围：延期项落地，不改 D1–D4/D6）—— 已落（T1）

## Out of scope

向量检索、知识图谱、ask 面、记忆管理 UI、LLM 离线合并、改 promote 规则公式。

## Tasks (ordered by dependency)

1. **Record auto-memory ADR + thin spec** — tag: `[decision]`
   - **Inherits:** ADR-0009 D5 延期；`specs/auto-memory.md` D1–D5
   - **Surface:** `docs/adr` / `specs/auto-memory.md` / `specs/README.md`
   - **Acceptance:** ADR-0031 accepted（触发闸、四态写入、机械 GC、provenance、默认 OFF）；0009 D5 有 superseded 指针；spec 入活跃索引；无产品代码
   - Status: [x] done

2. **Mechanical memory GC** — tag: `[implementation]`
   - **Inherits:** D3；已有 `ttl_days`/`disabled`/`supersedes`；promote 已跳过期
   - **Surface:** `src/harness/memory`
   - **Acceptance:** 可重复调用的 GC：TTL→disabled；supersede 目标软禁；超 cap 按效用分驱逐；五类边界测绿；`npx vitest run tests/harness/memory/` 相关套件 EXIT 0
   - [blocks: T1]
   - Status: [x] done

3. **Ingest algorithm (extract → ops → persist)** — tag: `[implementation]`
   - **Inherits:** D2/D4；T2 GC 可在写后调用；肯定句门禁与原子写与 `memory_save` 同纪律
   - **Surface:** `src/harness/memory`
   - **Acceptance:** 给定 transcript 片段 + FakeLLM：可观测 ADD/UPDATE/SUPERSEDE/NOOP；落盘含 `source: auto`；负向句/低置信不落盘；与并发 `memory_save` 不半写；库测绿
   - [blocks: T2]
   - Status: [x] done

4. **Host wire + settings opt-in** — tag: `[implementation]`
   - **Inherits:** D1；ADR-0010 ask opt-out；T3 ingest API
   - **Surface:** config / build-engine / session-api / cli|tui
   - **Acceptance:** 默认 OFF 与现网一致；chat/tui/serve 在 completed 闸后异步调用 ingest；LLM/IO 失败 turn 仍成功（EXIT 注释）；ask 无接线；相关回归绿
   - [blocks: T3]
   - Status: [x] done

5. **Align STATUS / architecture / CONTEXT flush** — tag: `[implementation]`
   - **Inherits:** T1–T4 已落地语义
   - **Surface:** `docs/STATUS.md` / `docs/architecture.md` / `docs/CONTEXT.md`
   - **Acceptance:** 文档写明自动记忆默认 OFF、触发闸、GC、与本仓记忆层边界；CONTEXT 待写入项已落或本票清空清单
   - [blocks: T4]
   - Status: [x] done

## Code review phase（整轮结束后）

Standards + Spec 双轴；对照 `specs/auto-memory.md` 与 ADR-0031。

已跑完：无阻塞项，产品代码不改。3 Medium + 6 Low 已落 `docs/STATUS.md` §2.5「自动记忆已知限制 / 遗留」，扩大 opt-in 前逐条处置。
