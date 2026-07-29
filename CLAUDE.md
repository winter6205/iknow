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

每次开始任务时按需读取：只读取与当前任务相关的文件。

定位阶段优先 codebase-memory（`get_architecture` / `search_graph` / `get_code_snippet`），再 `Read` 取具体符号；广扫描交给 `Explore` 子代理。

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
npm test          # vitest：unit + eval alignment + trajectory + harness
npm run eval      # 32-sample trajectory suite
```

### Module boundaries

- `src/harness/` - Foundation 运行时（loop-engine / anthropic-adapter / stubs / executor / registry）。**暂不接产品流量；4 tool 协议不动**。
- `src/interaction/` - host 层（会话袋 / slash / 人读&JSON 投影），**不是**第五个 tool。
- `_upstream_gbrain/` - 只读参考（gitignore），禁止 runtime 链接 / import / symlink / 动态加载。
- `src/session-api/` 静态托管 `prefer web/dist`（无 dist 时回退 `web/`）。
- `src/cli.ts` 是产品 CLI 入口：`chat`（TTY REPL / 管道）/ `ask`（oneshot JSON）/ `serve`（HTTP + SPA）。

完整路径→职责见 `docs/architecture.md` Capability modules 表（真值，SSOT）。

**Agent mode**: `deterministic`（默认 / CI）或 `llm`（`--mode llm` / `IKNOW_AGENT_MODE`；显式 `--mode` 优先）。  
**Embedding**: 可选 `--embeddings` / `IKNOW_EMBEDDING_MODE=api`（9router 等）；失败回退 overlap。  
**交互主入口**: TTY `chat`；脚本 `ask`；浏览器 `iknow serve` + `web/dist`（开发可 `web:dev` 代理 `/api`）。  
**LLM 客户端**: `stream: false` + `parseLlmResponseJson`（容忍 SSE trailer）。  
**9router key**: 环境变量名 `NINE_ROUTER_KEY`（LLM 与 embedding 共用，env.ts SSOT）；`models` 200 ≠ chat/embeddings 必通；探针 `scripts/i4-probe-nine-endpoints.ts`。  
**I4**: 已归档三模式 + HTTP 冒烟证据（`docs/handoff/i4-smoke/`）。  
**Git**: 无用户明确 `push` 授权则不执行。

### Domain docs (auto-load on session start)

- docs/CONTEXT.md — 项目领域语言 + Flagged ambiguities
- docs/STATUS.md — 功能现状与展望
- docs/architecture.md — 独立 runtime 能力切分
- docs/design/interaction-surface-v0.md — 交互方案
- docs/iknow-spec/HANDOFF.md — 协议/阶段真值（优先于过时分支叙述）
- docs/handoff/<latest>.md — 最近 session 交接
- specs/minimum-sequential-agent-loop.md — Foundation（`src/harness/`）权威 spec
- plans/minimum-sequential-agent-loop.md — 对应实施计划
- CHANGELOG.md — 版本变更记录（根目录真值）
- docs/integration-materials.env.example — LLM/向量接入材料占位（只写环境变量名）
