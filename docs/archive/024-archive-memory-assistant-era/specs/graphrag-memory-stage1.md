# Spec: GraphRAG 记忆后端 阶段 1 — 最小可用向量检索地基

> **Lean spec.** wayfinder #36 T-005 的 D1–D8 Resolution 是本 spec 的权威先决决议；本 spec 只补充 Resolution 未钉死的实施层细节（具体数字、文件布局、类型签名、测试矩阵）。未在本 spec 重述的内容，以 #36 Resolution + 父地图 #33 Notes 为准。

## Glossary

> 精确复制自 `docs/CONTEXT.md` §Memory vocabulary（wayfinder #34 / T-001），不重新定义。

- **knowledge memory**: GraphRAG 记忆后端（独立 MCP server）承载的跨会话共享语义事实，无身份归属、不随会话消失。
- **memory unit**: 后端最小语义单元 = D5-style triple（`valid_window tstzrange` + `superseded_by`）；旧 `CompiledFact` / `snapshot_id` / `SourceSpan` 降级为 harness 消费侧投影。
- **context assembly**: harness 运行时把异构源拼装进下一次推理窗口的动作，不是 MCP tool。

**阶段 1 补充**：Chunk 是阶段 1 的 retrieval/evidence unit，**不是** memory unit。语义知识记忆（triples/entities/facts）到阶段 3 才成立。

## Architectural Constraints

- **ADR-0001**（9router-stack-as-code-defaults）：embedding API key 复用 `NINE_ROUTER_KEY`，与 iknow 主项目一致。
- **父地图 #33 Notes**：不复用 iknow 旧地基（`src/kb-retrieve/` / `src/knowledge-store/` / `src/interaction/` 仅参考，不导入）；不复用 `_upstream_gbrain/`（设计参考可，runtime 链接禁）；TS strict ESM · Node ≥20 · Vitest · env 名不写明文。
- **T-001 drift 判据**：后端 schema 不含 `snapshot_id`；Chunk ≠ memory unit；无"上下文装配" MCP tool。
- **T-004 解耦契约**：`graphrag-memory/` 零 import from iknow `src/`；SDK = `@modelcontextprotocol/server@^2.0.0` + `@modelcontextprotocol/client@^2.0.0`（v2 拆包线）+ `zod@^4.2.0`。

## Objective

**What**: 在 T-004 脚手架（`graphrag-memory/`）之上，实现阶段 1 的最小可用向量检索地基：`ingest`（写入）+ `retrieve`（读取）两个 MCP tool，chunks-only 存储，valid_window 时间切片。

**Why**: 父地图 Destination = 独立 MCP MVP 通过 Claude Code 参考 Host 验收。验收票 #49 的 a4 invariant 要求 `ingest → retrieve` 端到端跑通（含 valid_window 切片）。本 spec 是解锁 a4 的实施契约。

**Who**: 实施者（本 spec 的下游 `writing-plans` 消费者）。阶段 1 用 fake embedding client 验证，不真调 9router。

**Success**: `ingest` 写入 → `retrieve` 按语义相似度 + valid_window 过滤返回 chunks；内存模式 + pgvector 模式均通过测试；host-smoke 扩展为 `ingest → retrieve` 端到端。

**不是**：GraphRAG 知识记忆后端（那是阶段 3）。阶段 1 是"带时间切片的向量检索地基"。

## Tech Stack

- **Language**: TypeScript（`tsconfig.json`: ES2022 / NodeNext / strict / verbatimModuleSyntax）。
- **Module**: ESM（`"type": "module"`）；相对导入用 `.js` 后缀。
- **MCP SDK**: `@modelcontextprotocol/server@^2.0.0` + `@modelcontextprotocol/client@^2.0.0`（v2 拆包线，T-004 已落）。
- **Schema validation**: `zod@^4.2.0`（MCP tool input schema，T-004 已落）。
- **Embedding**: 9router `/v1/embeddings`（OpenAI 兼容），模型 `text-embedding-3-small`（1536 维）。HTTP 调用用 Node 内建 `fetch`，不引入独立 SDK。
- **Storage (dev/test)**: TypeScript `Map<string, ChunkRecord>`，暴力 cosine 搜索。
- **Storage (prod)**: PostgreSQL 16 + `pgvector` ≥ 0.7，`vector(1536)` 列，`<=>` cosine 距离。
- **Test runner**: Vitest（T-004 已落）。
- **Runtime**: Node ≥ 20，stdio transport only（阶段 1 不做 HTTP transport）。

> Tech stack 变更需新假设门（spec-driven-development Iron Law）。

## Commands

```bash
# 在 graphrag-memory/ workspace 下执行（或从根用 --workspace）

# Type check
npm run typecheck --workspace graphrag-memory

# Full test suite
npm test --workspace graphrag-memory

# Build
npm run build --workspace graphrag-memory

# Dev (tsx, no build step)
npm run dev --workspace graphrag-memory

# Start (production, requires build first)
npm run start --workspace graphrag-memory
```

> 命令继承 T-004 脚手架 `package.json` scripts，本 spec 不新增 npm script。

## Project Structure

在 T-004 脚手架基础上新增（`+` = 新文件，`~` = 修改）：

```
graphrag-memory/
├── src/
│   ├── index.ts                    # ~ 注册 ingest + retrieve（保留 echo）
│   ├── config.ts                   # ~ 新增 storage / db / embed env 变量
│   ├── logging.ts                  #   不动
│   ├── core/
│   │   ├── types.ts                # + ChunkRecord / IngestInput / RetrieveInput / RetrieveResult
│   │   ├── chunker.ts              # + 固定窗口滑动切块（纯函数）
│   │   ├── embedder.ts             # + EmbeddingClient 接口 + NineRouterEmbedder 实现 + FakeEmbedder
│   │   ├── cosine.ts               # + cosine similarity（纯函数，内存模式用）
│   │   └── storage/
│   │       ├── backend.ts          # + StorageBackend 接口（upsert / search / close）
│   │       ├── memory-backend.ts   # + Map<string, ChunkRecord> 实现
│   │       └── pgvector-backend.ts # + pgvector 实现（node:pg 或 postgres）
│   └── tools/
│       ├── registry.ts             #   不动
│       ├── echo.ts                 #   不动（保留为连通性探针）
│       ├── ingest.ts               # + ingest tool（Zod schema + handler）
│       └── retrieve.ts             # + retrieve tool（Zod schema + handler）
├── tests/
│   ├── echo.test.ts                #   不动
│   ├── index.test.ts               # ~ 扩展：验证 tools/list 含 ingest + retrieve
│   ├── chunker.test.ts             # + 切块纯函数测试
│   ├── cosine.test.ts              # + cosine 纯函数测试
│   ├── embedder.test.ts            # + FakeEmbedder 确定性测试
│   ├── memory-backend.test.ts      # + 内存后端 CRUD + valid_window 过滤
│   ├── ingest.test.ts              # + ingest handler 单元测试
│   ├── retrieve.test.ts            # + retrieve handler 单元测试（含 valid_at 过滤）
│   └── host-smoke.test.ts          # ~ 扩展 a4：ingest → retrieve 端到端
├── package.json                    # ~ 新增 pg 依赖（仅 pgvector 模式）
├── tsconfig.json                   #   不动
└── vitest.config.ts                #   不动
```

## Code Style

沿用 T-004 脚手架既有风格（`config.ts` / `registry.ts` / `echo.ts`）：

- 2-space indent, double quotes, semicolons.
- JSDoc 块注释解释 why / 约束 / 边界，不解释显而易见的代码。
- 纯函数优先：`chunker` / `cosine` 是无副作用纯函数，handler 是 thin adapter。
- Zod schema 是 tool input 的唯一真值；handler 内不重复校验。
- 错误处理：handler 内 throw，`index.ts` 的 `registerOne` 统一 catch → `textResult(msg, true)`。
- 日志：`createLogger` 到 stderr；stdout 保留给 MCP stdio transport。
- env 变量名：`GRAPHRAG_MEMORY_` 前缀，代码只存变量名，不存明文值。

示例（tool handler 风格，沿用 `echo.ts` 模式）：

```typescript
export const IngestInputSchema = z.object({
  content: z.string().min(1, "content must be a non-empty string"),
  source_ref: z.string().min(1, "source_ref must be a non-empty string"),
  metadata: z.record(z.string(), z.unknown()).optional(),
  valid_from: z.string().datetime().optional(),
  valid_until: z.string().datetime().optional(),
});

export type IngestInput = z.infer<typeof IngestInputSchema>;

export async function ingestHandler(
  input: IngestInput,
  deps: IngestDeps
): Promise<ToolResult> {
  const chunks = chunkText(input.content, CHUNK_SIZE, CHUNK_OVERLAP);
  const embeddings = await deps.embedder.embed(chunks.map((c) => c.text));
  const ids = await deps.storage.upsert(chunks, embeddings, input);
  return textResult(JSON.stringify({ chunk_ids: ids }));
}
```

## Testing Strategy

- **Framework**: Vitest（已有）。
- **Embedding**: FakeEmbedder（返回固定 1536 维向量，确定性）。不真调 9router。
- **Storage**: 内存后端（MemoryBackend）。pgvector 集成测试不要求 CI 有 PostgreSQL——用内存后端替代；pgvector 后端通过代码审查 + 本地手动验证。
- **Host-smoke**: 扩展 #49 harness（`host-smoke.test.ts`），用真 SDK `Client` + `StdioClientTransport` spawn `dist/index.js`，跑 `ingest → retrieve` 端到端（a4 invariant）。

测试矩阵：

| 层     | 文件                     | 覆盖                                                                                                                                            |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯函数 | `chunker.test.ts`        | 空输入 / 短于 chunk / 恰好 chunk / 多 chunk + 重叠 / Unicode                                                                                    |
| 纯函数 | `cosine.test.ts`         | 相同向量 = 1 / 正交 = 0 / 反向 = -1 / 零向量                                                                                                    |
| 单元   | `embedder.test.ts`       | FakeEmbedder 确定性 / 维度正确 / 批量 vs 单条一致                                                                                               |
| 单元   | `memory-backend.test.ts` | upsert / search top-K / valid_window 过滤 / filters 精确匹配 / 空库搜索 / **并发双写不丢数据** / **向量维度不匹配拒绝**                         |
| 单元   | `ingest.test.ts`         | 正常写入 / 空 content 拒绝 / valid_from > valid_until 拒绝 / metadata 透传 / **超大 content（>1MB）拒绝** / **embedding 维度错误 → 类型化错误** |
| 单元   | `retrieve.test.ts`       | 正常检索 / valid_at 过滤 / filters / 空库返回空 / limit 覆盖 / **并发双查不干扰**                                                               |
| 集成   | `index.test.ts`          | tools/list 含 echo + ingest + retrieve / tools/call round-trip                                                                                  |
| E2E    | `host-smoke.test.ts`     | a1-a5 invariants + a4 ingest→retrieve 端到端                                                                                                    |

## Error Handling

沿用脚手架 `registerOne` 的 catch → `textResult(msg, true)` 统一兜底，但阶段 1 新增**类型化错误类**，让 handler 内的 throw 携带可机器解析的错误码（而非裸 `Error`）：

```typescript
// src/core/errors.ts
export class GraphragError extends Error {
  constructor(
    message: string,
    readonly code: GraphragErrorCode
  ) {
    super(message);
    this.name = "GraphragError";
  }
}

export type GraphragErrorCode =
  | "INVALID_INPUT" // Zod 通过但语义不合法（valid_from > valid_until）
  | "CONTENT_TOO_LARGE" // content 超过 MAX_CONTENT_BYTES（1MB）
  | "EMBEDDING_FAILED" // 9router /v1/embeddings 调用失败
  | "EMBEDDING_DIM_MISMATCH" // 返回向量维度 ≠ 1536
  | "STORAGE_ERROR"; // 后端 upsert / search 底层异常
```

**错误路径规则**：

- handler 内只 throw `GraphragError`（不 throw 裸 `Error` / `string`）。
- `registerOne` catch 层不变（兜底非预期异常），但日志中记录 `code` 字段。
- 不引入 per-tool 错误码表；5 个 code 覆盖阶段 1 全部失败路径。

**EXIT_CODES 扩展**（`src/index.ts`）：

```typescript
const EXIT_CODES = {
  FATAL_RUNTIME: 1, // 未捕获异常（继承 T-004）
  BAD_CONFIG: 2, // 配置校验失败（DB_URL 缺失 / STORAGE 值非法）— 恢复 T-004 删除的码
} as const;
```

`BAD_CONFIG` 在 `main()` 的 `loadEnv()` 阶段触发：pgvector 模式但 `GRAPHRAG_MEMORY_DB_URL` 未设置 → `process.exit(2)`。

## Boundaries

- **Always do**:
  - TDD：先写失败测试再实现（父地图 Notes: `arthurpower:test-driven-development`）
  - 跑 `npm test --workspace graphrag-memory` + `npm run typecheck --workspace graphrag-memory` 全绿再 commit
  - Zod schema 校验所有 tool input
  - 日志到 stderr，stdout 只给 MCP transport
  - env 变量名 `GRAPHRAG_MEMORY_` 前缀，不写明文值

- **Ask first**:
  - 新增 npm 依赖（pg / postgres driver）
  - 修改 `tsconfig.json` / `vitest.config.ts`
  - 修改根 `package.json` workspaces 配置
  - 修改 `.mcp.json`

- **Never do**:
  - import iknow `src/` 下任何模块（T-004 解耦契约）
  - import / link / symlink `_upstream_gbrain/`（父地图 Notes）
  - 在 schema 中出现 `snapshot_id`（T-001 drift 判据 #2）
  - 在测试 / 日志 / commit 中写入真实 API key
  - 删除或跳过失败测试
  - 引入 HTTP transport（阶段 1 只有 stdio）
  - 引入 triples / entities / facts 表（阶段 3）
  - 引入 BM25 / reranker / PPR / 社区发现（阶段 2/3）
  - 引入 pglite（阶段 4）

## Success Criteria

每条二元可测（yes/no）：

1. `npm run typecheck --workspace graphrag-memory` exit 0。
2. `npm test --workspace graphrag-memory` 全绿（含新增测试）。
3. `tools/list` 返回 `echo` + `ingest` + `retrieve` 三个工具。
4. `ingest({ content: "张三于2024年创办了公司A", source_ref: "test.md" })` 返回 `{ chunk_ids: [非空数组] }`。
5. `retrieve({ query: "张三创办了什么公司" })` 返回含 "公司A" 的 chunk，`score > 0`。
6. `ingest` 写入 `valid_until: "2024-06-01T00:00:00Z"` 的 chunk → `retrieve({ query, valid_at: "2025-01-01T00:00:00Z" })` **不返回**该 chunk。
7. `retrieve({ query, filters: { source_ref: "nonexistent.md" } })` 返回空 chunks 数组。
8. `retrieve({ query, limit: 3 })` 返回 ≤ 3 个 chunks。
9. host-smoke `ingest → retrieve` 端到端通过（a4 invariant）。
10. 根 iknow `npm test` 全绿（无回归）。
11. `graphrag-memory/` 零 import from iknow `src/`（grep 验证）。
12. 后端 schema 无 `snapshot_id` 字段（grep 验证）。

## Open Questions

（无——假设门 18 条已全部确认，D1-D8 已闭环。）
