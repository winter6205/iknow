# Project Instructions for Claude Code

## 读取规范

每次开始任务时按需读取：只读取与当前任务相关的文件。

定位代码先用codebase-memory建立索引。

广扫描交给 `Explore` 子代理。

---

## 代码规范

@.claude/rules/code-quality.md

## 测试规范

@.claude/rules/test.md

## 安全边界

@.claude/rules/security-boundaries.md

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
```

> `npm run eval` 已随 021 归档（`docs/archive/021-retire-legacy-loop-and-eval/`），script 已删。

### Module boundaries

- `src/harness/` - Foundation 运行时（loop-engine / anthropic-adapter / executor / registry）+ ACI 装饰层原型（`src/harness/aci/`，PR #95）。**CLI 产品路径已接入**（020 切 harness，task #14 接 ACI 工具）。
- `src/harness/stubs/` - 替身 tool/model（仅供测试，i9 smoke + 单元测试装配；CLI 默认装配已用 ACI 工具替换）。
- `upstream-openharness` - 只读参考（gitignore），禁止 runtime 链接 / import / symlink / 动态加载。
- `src/session-api/` 静态托管 `prefer web/dist`（无 dist 时回退 `web/`）。
- `src/cli.ts` 是产品 CLI 入口：`chat`（TTY REPL / 管道）/ `ask`（oneshot JSON）/ `serve`（HTTP + SPA）。
- 归档：`src/agent-loop/`（`docs/archive/022-retire-agent-loop/`）+ `src/interaction/`（`docs/archive/022-retire-interaction/`）；`src/kb-retrieve/` + `src/kb-verify/` + `src/kb-compile/` + `src/kb-governance/` + `src/tools/registry.ts`（`docs/archive/023-retire-kb-tools/`）。

完整路径→职责见 `docs/architecture.md` Capability modules 表（真值，SSOT）。

**Embedding**: `--embeddings` / `IKNOW_EMBEDDING_MODE=api` 等向量检索臂及其 CLI flag / env 已随 023 一并移除（harness 为通用 agent，无向量检索；旧 loop residue cleanup）。  
**交互主入口**: TTY `chat`；脚本 `ask`；浏览器 `iknow serve` + `web/dist`（开发可 `web:dev` 代理 `/api`）。  
**LLM 客户端**: 默认流式臂（`IKNOW_LLM_STREAM` 值域 `on | off`，默认 `on`，env.ts SSOT），`off` 回退非流式臂；原生 SSE 事件不出 adapter 边界，host 侧消费 `HarnessStreamEvent`。  
**LLM key**: 环境变量名默认 `ANTHROPIC_AUTH_TOKEN`（LLM 用，env.ts SSOT；embedding 臂已移除）。历史曾用 `NINE_ROUTER_KEY`（9router 专属命名），已 superseded 归档到 ADR-0001；`.env.local` 可用 `IKNOW_LLM_API_KEY_ENV` 覆盖变量名。`models` 200 ≠ chat 必通；探针 `scripts/i4-probe-nine-endpoints.ts`。  
**I4**: 已归档三模式 + HTTP 冒烟证据（`docs/handoff/i4-smoke/`）。  
**Git**: 无用户明确 `push` 授权则不执行。

### UI 调试

调试 UI 时使用 `.claude/skills/playwright-cli/`。

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
