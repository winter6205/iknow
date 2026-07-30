# graphrag-memory

独立的 GraphRAG 记忆 MCP server（stdio transport），host-agnostic：零 iknow import，可注册进任何支持 MCP 的 host。

## 前置

- Node.js >= 20
- npm

```bash
npm install
npm run build --workspace graphrag-memory   # 产出 graphrag-memory/dist/index.js
```

## 配置（核心）

**local-scope MCP registration 是 endpoint / model / dimensions / apiKey 的唯一真值源。** graphrag-memory 只校验 + 消费这些值，不内置任何生产默认值；必填项缺失时启动失败（`ConfigError` → exit code `BAD_CONFIG` = 2，transport 不会打开）。

| env 变量名                         | 必填性                                           | 说明                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GRAPHRAG_MEMORY_EMBED_DIMENSIONS` | 必填                                             | int > 0。embedding 向量维度：本地索引大小 + 请求体 `dimensions` 透传 + pgvector DDL 宽度，三处共用这一个值                                       |
| `GRAPHRAG_MEMORY_EMBED_BASE_URL`   | 真实 embedding 时必填（有 `NINE_ROUTER_KEY` 时） | OpenAI-compatible base URL。约定**已含 `/v1`**（如 `http://localhost:20128/v1`），server 仅追加 `/embeddings`                                    |
| `GRAPHRAG_MEMORY_EMBED_MODEL`      | 真实 embedding 时必填（有 `NINE_ROUTER_KEY` 时） | embedding 模型的 route id                                                                                                                        |
| `NINE_ROUTER_KEY`                  | 可选                                             | 9router API key（LLM / embedding 共用，见 iknow ADR-0001）。缺失时回退确定性 FakeEmbedder——仅测试 / 离线开发用，向量无跨文本语义，**非生产路径** |
| `GRAPHRAG_MEMORY_LOG_LEVEL`        | 可选                                             | `debug` \| `info` \| `warn` \| `error`，默认 `info`                                                                                              |
| `GRAPHRAG_MEMORY_STORAGE`          | 可选                                             | `memory`（默认，进程内、无持久化）或 `pgvector`（需 `GRAPHRAG_MEMORY_DB_URL` + 可选 `pg` 依赖）                                                  |
| `GRAPHRAG_MEMORY_DB_URL`           | `pgvector` 时必填                                | Postgres 连接串                                                                                                                                  |

生产路径（有 key）对任何缺失的 endpoint / model / dimensions 都 fail-fast，无静默默认。

## 安装到 Claude Code（主交付路径）

把下面的模板合并进 `~/.claude.json` 的 **local scope**（`projects.<项目路径>.mcpServers`），填入真实值：

```json
{
  "mcpServers": {
    "graphrag-memory": {
      "command": "node",
      "args": ["<repo>/graphrag-memory/dist/index.js"],
      "env": {
        "GRAPHRAG_MEMORY_EMBED_BASE_URL": "http://localhost:20128/v1",
        "GRAPHRAG_MEMORY_EMBED_MODEL": "zhipueb/embedding-3",
        "GRAPHRAG_MEMORY_EMBED_DIMENSIONS": "2048",
        "NINE_ROUTER_KEY": "<your-9router-key>"
      }
    }
  }
}
```

- `zhipueb/embedding-3` 是故意的 9router route id，**非 typo**；`2048` 是该 model 的输出维度，两者必须配套。
- base URL 含 `/v1`（与 iknow 9router 本地栈约定一致），server 只在其后追加 `/embeddings`。
- `<repo>` 替换为本仓库的绝对路径。
- API key 只存 local scope，**不进 Git**。

### 便利备选

`claude mcp add` 一行命令（仅 Claude Code 便利备选，非主交付路径）：

```bash
claude mcp add graphrag-memory \
  --scope local \
  --env GRAPHRAG_MEMORY_EMBED_BASE_URL=http://localhost:20128/v1 \
  --env GRAPHRAG_MEMORY_EMBED_MODEL=zhipueb/embedding-3 \
  --env GRAPHRAG_MEMORY_EMBED_DIMENSIONS=2048 \
  --env NINE_ROUTER_KEY=<your-9router-key> \
  -- node <repo>/graphrag-memory/dist/index.js
```

## 验证

```bash
claude mcp list   # 应出现 graphrag-memory
```

在 Claude Code 的 MCP 面板中应可见三个工具：`echo` · `ingest` · `retrieve`。

## 开发

```bash
npm test --workspace graphrag-memory   # vitest（离线，不调网络）
npm run dev --workspace graphrag-memory # tsx 直跑 src/index.ts
```
