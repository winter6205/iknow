# Project Instructions for Claude Code

## Coding Principles

Use as default bias, not strict checklist.

- Principle of Least Astonishment：代码行为可预测，少意外副作用。
- Follow Existing Conventions：沿用项目既有风格、目录、命名、接口。
- Keep It Simple：优先最短清楚实现，不提前抽象。
- Explicit over Implicit：意图、类型、边界、错误路径显式。
- Single Responsibility Principle：一个函数 / 类 / 模块一个明确职责。
- Single Source of Truth：业务概念、规则、状态、配置单一权威来源。
- Comments Explain Why：注释只解释原因、约束、边界，不解释显而易见的代码。

---

## 上下文读取顺序

每次开始任务时按需读取：

1. `README.md`
2. `docs/architecture.md`
3. `docs/git-workflow.md`
4. `docs/testing.md`
5. 当前任务相关目录下的 `CLAUDE.md`
6. 当前任务相关代码 / 测试 / 配置文件

只读取与当前任务相关的文件

---

## Completion

自动commit

汇报使用中文

完成后简要报告：

- 改了什么；
- 实际运行的验证及结果；
- 未验证内容及原因；
- 存在时报告风险、阻塞项以及 commit、push、release 等 Git/发布操作。

---

## 规范变更流程

修改本文件前必须：

1. 说明修改原因。
2. 说明影响范围。
3. 检查是否与 README / docs 冲突。
4. 单独提交规范变更，不与业务代码混合。

---



### Eval (iknow product + template)

**产品 trajectory（主路径）**:

```bash
npm test          # unit + eval alignment + trajectory unit tests
npm run eval      
```

### Runtime map (iknow)

| 路径 | 角色 |
|------|------|
| `src/kb-*` / `src/agent-loop` / `src/knowledge-store` | 产品实现（可独立运行） |
| `src/interaction/` | 会话袋、slash、人读/JSON 投影（host，非 tool） |
| `src/session-api/` | Session HTTP API + 静态托管（prefer `web/dist`） |
| `src/cli.ts` + `src/cli/*` | **产品 CLI**：TTY chat / 管道 chat / ask oneshot / **serve** |
| `web/` | 产品 SPA（Vite + React + TS）；`npm run web:dev` / `web:build` |
| `src/eval/` | trajectory scorer + suite runner |
| `docs/iknow-spec/` | 协议与评测真值 |
| `docs/design/interaction-surface-v0.md` | 交互设计（协议对齐） |
| `docs/design/session-http-api-v0.md` | Session HTTP 契约 |
| `docs/handoff/i4-smoke/` | I4 真机冒烟证据（无密钥） |
| `docs/STATUS.md` | 已实现 / 未实现 / 展望 |
| `_upstream_gbrain/` | **只读**参考（gitignore，禁止 runtime 链接） |

**Agent mode**: `deterministic`（默认 / CI）或 `llm`（`--mode llm` / `IKNOW_AGENT_MODE`；显式 `--mode` 优先）。  
**Embedding**: 可选 `--embeddings` / `IKNOW_EMBEDDING_MODE=api`（9router 等）；失败回退 overlap。  
**交互主入口**: TTY `chat`；脚本 `ask`；浏览器 `iknow serve` + `web/dist`（开发可 `web:dev` 代理 `/api`）。  
**LLM 客户端**: `stream: false` + `parseLlmResponseJson`（容忍 SSE trailer）。  
**9router key**: 环境变量名 `NINE_ROUTER_API_KEY`；`models` 200 ≠ chat/embeddings 必通；探针 `scripts/i4-probe-nine-endpoints.ts`。  
**I4**: 已归档三模式 + HTTP 冒烟；I5 多轮 eval / 会话持久化仍开。  
**下阶段焦点**: 多轮质量、消息模型、真实语料 — 不重开 4 tool 协议。  
**Git**: 无用户明确 `push` 授权则不执行。

### Domain docs (auto-load on session start)

- docs/CONTEXT.md — 项目领域语言 + Flagged ambiguities
- docs/STATUS.md — 功能现状与展望
- docs/architecture.md — 独立 runtime 能力切分
- docs/design/interaction-surface-v0.md — 交互方案
- docs/iknow-spec/HANDOFF.md — 协议/阶段真值（优先于过时分支叙述）
- docs/handoff/<latest>.md — 最近 session 交接
- docs/CHANGELOG.md — 版本变更记录（根目录 `CHANGELOG.md` 为真值）
- docs/integration-materials.env.example — LLM/向量接入材料占位（只写环境变量名）

