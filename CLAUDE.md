# Project Instructions for Claude Code

## 读取规范

每次开始任务时按需读取：只读取与当前任务相关的文件。

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

### 测试

**产品主路径**:

```bash
npm test          # vitest：unit + harness + integration
```

### Module boundaries

- `src/harness/` - Foundation 运行时（loop-engine / anthropic-adapter / executor / registry）+ ACI 装饰层原型（`src/harness/aci/`，PR #95）。**CLI 产品路径已接入**（020 切 harness，task #14 接 ACI 工具）。
- `src/harness/stubs/` - 替身 tool/model（仅供测试，i9 smoke + 单元测试装配；CLI 默认装配已用 ACI 工具替换）。
- `upstream-openharness` - 只读参考（gitignore），禁止 runtime 链接 / import / symlink / 动态加载。
- `src/session-api/` 静态托管 `prefer web/dist`（无 dist 时回退 `web/`）。
- `src/cli.ts` 是产品 CLI 入口：`chat`（TTY REPL / 管道）/ `ask`（oneshot JSON）/ `serve`（HTTP + SPA）。CLI `RuntimeBundle` 只承载 `{ env, session }`。

完整路径→职责见 `docs/architecture.md` Capability modules 表（真值，SSOT）。

**交互主入口**: TTY `chat`；脚本 `ask`；浏览器 `iknow serve` + `web/dist`（开发可 `web:dev` 代理 `/api`）。  
**LLM 客户端**: 默认流式臂（`IKNOW_LLM_STREAM` 值域 `on | off`，默认 `on`，env.ts SSOT），`off` 回退非流式臂；原生 SSE 事件不出 adapter 边界，host 侧消费 `HarnessStreamEvent`。  
**LLM key / model**: 配置收敛到 `~/.iknow/settings.json`（user）+ `<cwd>/.iknow/settings.json`（project over user，ADR-0015 settings-model-extension）。`settings.llm.model` 字面值 = 模型路由 ID 唯一来源（缺失 fail-fast）；`settings.llm.apiKey` 字面或 `${VAR}` 占位符（loader 经 `expandPlaceholders` 从 process.env / .env.local / .env 解析）。`IKNOW_LLM_API_KEY_ENV` / `IKNOW_LLM_MODEL` 已退役（不再读取）；`IKNOW_LLM_BASE_URL` 仍读（provider/baseUrl 是 9router 项目栈决策）。`models` 200 ≠ chat 必通；探针 `scripts/i4-probe-nine-endpoints.ts`。  
**Secret 处理（#406）**: 默认 `secrets.mode = "roundtrip"`，用户贴 key 自动占位符化（`<<<SECRET_N>>>`），bash 还原层在 spawn 前回填真值；`mode = "block"` 显式保留 #126 deny-only 旧行为。
**Git**: 无用户明确 `push` 授权则不执行。

### UI 调试

调试 UI 时使用 `.claude/skills/playwright-cli/`。

### Domain docs (auto-load on session start)

- docs/CONTEXT.md — 项目领域语言 + Flagged ambiguities
- docs/STATUS.md — 功能现状与展望
- docs/architecture.md — 独立 runtime 能力切分
- docs/handoff/<latest>.md — 最近 session 交接
- specs/security-guardrails.md — 安全护栏 spec（权限/沙箱/中断超时）
- specs/trace-service.md — trace 观测 spec
- specs/146-tui.md — TUI 交互骨架 spec
- specs/120-session-persistence.md — 会话持久化 spec
- CHANGELOG.md — 版本变更记录（根目录真值）
- docs/integration-materials.env.example — LLM 接入材料占位（只写环境变量名）
