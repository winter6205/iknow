# Plan: GraphRAG 记忆后端 阶段 1 — 向量检索地基

> **Spec**: `specs/graphrag-memory-stage1.md`（ACR 5-verdict ALL PASS）
> **Base branch**: `worktree-spec-graphrag-stage1`
> **Tracker**: GitHub issues（label `ready-for-agent`）
> **执行模式**: 主脑编排 + 子代理实施；按编译耦合层级分波；波内并行、波间串行

## 编译耦合拓扑

```
Wave 1: T1 (types + errors)          ← 所有模块的叶依赖
Wave 2: T2 (cosine + chunker) ∥ T3 (embedder)   ← 只依赖 T1
Wave 3: T4 (storage interface + memory backend) ← 依赖 T1 + T2(cosine)
Wave 4: T5 (ingest) ∥ T6 (retrieve)  ← 依赖 T2+T3+T4
Wave 5: T7 (config + index wiring)   ← 依赖 T5+T6
Wave 6: T8 (host-smoke + pgvector)   ← 依赖 T7（全量）
```

## Tracer Bullets

#### T1. `[implementation]` Foundation types + typed errors

- **Affects**: `graphrag-memory/src/core/types.ts`, `graphrag-memory/src/core/errors.ts`
- **Acceptance**: `npm run typecheck --workspace graphrag-memory` exit 0；`types.ts` 导出 ChunkRecord / IngestInput / RetrieveInput / RetrieveResult / StorageBackend 接口；`errors.ts` 导出 GraphragError + 5 codes
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T2. `[implementation]` Pure functions: cosine + chunker

- **Affects**: `graphrag-memory/src/core/cosine.ts`, `graphrag-memory/src/core/chunker.ts`, `graphrag-memory/tests/cosine.test.ts`, `graphrag-memory/tests/chunker.test.ts`
- **Acceptance**: `npm test --workspace graphrag-memory` 含 cosine + chunker 测试全绿；cosine([1,0],[1,0])=1, cosine([1,0],[0,1])=0；chunker 空输入返回空数组、多 chunk 重叠正确
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **[parallel]**: 与 T3 并行（无编译耦合）

#### T3. `[implementation]` Embedder: interface + FakeEmbedder + NineRouterEmbedder

- **Affects**: `graphrag-memory/src/core/embedder.ts`, `graphrag-memory/tests/embedder.test.ts`
- **Acceptance**: FakeEmbedder 返回固定 1536 维向量（确定性）；NineRouterEmbedder 用 fetch 调 /v1/embeddings；维度不匹配 throw EMBEDDING_DIM_MISMATCH
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **[parallel]**: 与 T2 并行（无编译耦合）

#### T4. `[implementation]` StorageBackend interface + MemoryBackend

- **Affects**: `graphrag-memory/src/core/storage/backend.ts`, `graphrag-memory/src/core/storage/memory-backend.ts`, `graphrag-memory/tests/memory-backend.test.ts`
- **Acceptance**: MemoryBackend upsert/search/close 通过；valid_window 过滤正确（过期 chunk 不返回）；filters 精确匹配；并发双写不丢数据；向量维度不匹配拒绝
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **[blocks: T5, T6]**

#### T5. `[implementation]` Ingest tool (Zod schema + handler)

- **Affects**: `graphrag-memory/src/tools/ingest.ts`, `graphrag-memory/tests/ingest.test.ts`
- **Acceptance**: ingest handler 正常写入返回 chunk_ids；空 content 拒绝；valid_from > valid_until throw INVALID_INPUT；content >1MB throw CONTENT_TOO_LARGE；metadata 透传
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **[parallel]**: 与 T6 并行（无编译耦合）

#### T6. `[implementation]` Retrieve tool (Zod schema + handler)

- **Affects**: `graphrag-memory/src/tools/retrieve.ts`, `graphrag-memory/tests/retrieve.test.ts`
- **Acceptance**: retrieve handler 正常检索返回 chunks + score；valid_at 过滤；filters 精确匹配；空库返回空；limit 覆盖；并发双查不干扰
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **[parallel]**: 与 T5 并行（无编译耦合）

#### T7. `[implementation]` Config + index wiring

- **Affects**: `graphrag-memory/src/config.ts`, `graphrag-memory/src/index.ts`, `graphrag-memory/tests/index.test.ts`
- **Acceptance**: config 新增 STORAGE/DB_URL/EMBED_BASE_URL/EMBED_MODEL env；BAD_CONFIG=2 exit code；tools/list 返回 echo+ingest+retrieve；tools/call round-trip 通过
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **[blocks: T8]**

#### T8. `[implementation]` Host-smoke a4 + pgvector backend

- **Affects**: `graphrag-memory/tests/host-smoke.test.ts`, `graphrag-memory/src/core/storage/pgvector-backend.ts`, `graphrag-memory/package.json`
- **Acceptance**: host-smoke ingest→retrieve 端到端通过（a4 invariant）；pgvector backend 编译通过（typecheck）；package.json 新增 pg 依赖；根 iknow npm test 全绿（无回归）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

## 执行策略

- **波内并行**：T2∥T3、T5∥T6 各派独立子代理，写不同文件，无 git 冲突
- **波间串行**：Wave N 全部完成 + typecheck 绿后才启动 Wave N+1
- **最终验证**：T8 完成后跑全量 `npm test --workspace graphrag-memory` + 根 `npm test` + grep 零 iknow import + grep 无 snapshot_id
- **Code review**：全量实施完成后派 code-review 子代理审全 diff
- **Push**：review 通过后 push + 更新 PR #74

## ACR Cross-check

| Verdict                      | Plan compliance                                                           |
| ---------------------------- | ------------------------------------------------------------------------- |
| bounded-context-guardian     | ✅ 所有文件在 graphrag-memory/ workspace 内；T7 验证零 iknow import       |
| defensive-contract-validator | ✅ T4 含 concurrent + overflow；T5 含 CONTENT_TOO_LARGE；T6 含 concurrent |
| error-handling-enforcer      | ✅ T1 定义 GraphragError + 5 codes；T7 恢复 BAD_CONFIG=2                  |
| complexity-anti-drift        | ✅ 纯函数独立文件；handler thin adapter；每文件 <300 行                   |
| minimal-change-verifier      | ✅ 8 bullets = 8 commits；每 bullet 1 logical task                        |
