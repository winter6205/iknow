# Plan: auto-memory-extract-discipline

**Goal:** 开抽取时对照说明书去重、提示词禁止记仓库可推内容、本轮已 save 则跳过抽取。  
**Approach:** 先让 ingest 吃到静态层并改 prompt；再加重叠丢弃纯函数；最后 hook 上 save 跳过。不改读路径、不改 dream 闸。  
**Spec link:** `specs/auto-memory-extract-discipline.md`  
**Tracker:** 文档进本 PR；实施按本文件分 commit。  
**Per-ticket loop:** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

```
bounded-context-guardian: yes — 提示词/重叠闸/skip 在 harness/memory；host 只接线；loop-engine 不嵌抽取纪律
defensive-contract-validator: yes — SC 覆盖 empty / negative / overflow / concurrent / exception
error-handling-enforcer: yes — 静态层失败 EXIT: log-and-continue；不回灌二次 LLM
complexity-anti-drift: yes — 提示词+重叠闸、save 跳过分 commit
minimal-change-verifier: yes — 一个写路径纪律；禁止与目录/预取/dream 闸混提
```

## 待写入

清单空。

## Out of scope

自动 promote；默认 ON；扫仓；回灌抽取模型；改 N≥2；改 dream 闸；改目录/预取；记忆 UI；ask 接线。

## Tasks (ordered by dependency)

1. **Extract prompt includes static layer + discipline sentences** — tag: `[implementation]`
   - **Inherits:** spec Does 静态层进 prompt；三类英文纪律；读失败当空
   - **Surface:** `src/harness/memory` ingest + hook 读 discovery
   - **Acceptance:** SC2、SC5：FakeLLM prompt 含说明书片段与纪律要点；静态层 IO 失败不 fail turn；`npx vitest run tests/harness/memory/` 相关套件 EXIT 0
   - Status: [x] done

2. **Drop candidates that overlap the static layer** — tag: `[implementation]`
   - **Inherits:** spec Does 重叠闸；同一套 tokenize；零词命中不留；门槛测例钉死；不回灌模型
   - **Surface:** `src/harness/memory` ingest（extract 之后、decide 之前）
   - **Acceptance:** SC3–SC4：高重叠不 written；无关可 ADD；空说明书不丢候选
   - [blocks: T1]
   - Status: [x] done

3. **Skip extract when this turn already saved** — tag: `[implementation]`
   - **Inherits:** spec Does 本轮成功 memory_save 不跑 ingest extract；dream 仍独立
   - **Surface:** `src/harness/memory` auto-hook + host 传本轮 save 成功标记
   - **Acceptance:** SC6–SC7：有 save 则 extract complete 次数 0；无 save 为 1；dream 闸到仍可跑
   - [parallel]
   - Status: [x] done

4. **STATUS 一句** — tag: `[implementation]`
   - **Inherits:** T1–T3 落地语义
   - **Surface:** `docs/STATUS.md` 自动记忆段
   - **Acceptance:** 写明对照说明书丢弃、仓库可推只靠 prompt、本轮 save 跳过 extract；默认仍 OFF
   - [blocks: T1, T2, T3]
   - Status: [x] done

## End of round

T1 → T2；T3 可与 T1 并行；T4 最后。全部合入后一轮 code-review + verification-before-completion。
