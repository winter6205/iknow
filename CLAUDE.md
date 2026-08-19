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

## 网络工具

- `mcp__exa__*`。

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

**交互主入口**: TTY `chat`；脚本 `ask`；浏览器 `iknow serve` + `web/dist`（开发可 `web:dev` 代理 `/api`）。任意入口可加 `--workspace-root <dir>`（或 env `IKNOW_WORKSPACE_ROOT`）让 per-root 状态跟从该目录，详见 ADR-0019 Workspace root 段。  
**LLM 客户端**: 默认流式臂（`IKNOW_LLM_STREAM` 值域 `on | off`，默认 `on`，env.ts SSOT），`off` 回退非流式臂；原生 SSE 事件不出 adapter 边界，host 侧消费 `HarnessStreamEvent`。  
**LLM key / model**: 配置收敛到 `~/.iknow/settings.json`（user）+ `<cwd>/.iknow/settings.json`（project over user，ADR-0015 settings-model-extension）。`settings.llm.model` 字面值 = 模型路由 ID 唯一来源（缺失 fail-fast）；`settings.llm.apiKey` 字面或 `${VAR}` 占位符（loader 经 `expandPlaceholders` 从 process.env / .env.local / .env 解析）。`IKNOW_LLM_API_KEY_ENV` / `IKNOW_LLM_MODEL` 已退役（不再读取）；`IKNOW_LLM_BASE_URL` 仍读（provider/baseUrl 是 9router 项目栈决策）。`models` 200 ≠ chat 必通；探针 `scripts/i4-probe-nine-endpoints.ts`。  
**Secret 处理（#406）**: 默认 `secrets.mode = "roundtrip"`，用户贴 key 自动占位符化（`<<<SECRET_N>>>`），bash 还原层在 spawn 前回填真值；`mode = "block"` 显式保留 #126 deny-only 旧行为。
**本机 key 已配**。`npm run test:real-llm` 可跑。
`mcp__aiterm__pty_*` 已配：TUI/REPL 真实交互用它。
**Settings 热更新**: `~/.iknow/settings.json` 或 `<cwd>/.iknow/settings.json` 改动**免重启生效**（fs.watch 100ms debounce → 下一轮 postMessage 用新 env；reload 失败保留旧 env）。运行时 `/thinking` `/effort` 面板 **Esc 保存退出**会写回 `settings.json`（project 级若存在写 project，否则写 `<workspaceRoot>/.iknow/settings.json` —— workspace-root per-root 隔离，详见 ADR-0019；不再 fallback 到 `~/.iknow/settings.json`，杀死 global-pollution 路径）；合并 llm 子树保留 apiKey/model/secrets 等全部原字段；写回用 sha256 self-write 哨兵跳过自身 reload 防回环（PR #413 单向通道不变）；失败 notice 不 crash。面板内 Enter 固定 / Space-Tab 预览不落盘。
**Workspace root（ADR-0019）**: iknow 在任意根目录启动时，per-root 状态（identity workspace seed / `user.md` / `BOOTSTRAP.md` / memory store / serve data / settings 写回 fallback）跟从该启动根目录，与 `home`（global 配置锚，settings merge 兜底 + `~/.iknow/init.sh` host-init + user-level memory global scope）解耦。**CLI flag**: `--workspace-root <dir>`（mirror `--data-dir` 模式添加到 `src/cli/parse-args.ts`）。**env**: `IKNOW_WORKSPACE_ROOT`（在 `src/config/env.ts` SSOT 注册，resolver 通过 `envOptional` 读取；resolver 不直接读 `process.env`）。**优先级链**: `[explicit, env, process.cwd()]` —— 无 `--workspace-root` 且无 `IKNOW_WORKSPACE_ROOT` → 默认 `process.cwd()`。**迁移 opt-out**: 临时还原旧行为用 `--workspace-root "$HOME"`。**典型场景**: `throwaway-dir` 隔离做实验（identity / memory / serve / settings 全部落在 throwaway 不污染 `~/.iknow`）；per-project 状态独立（每个项目根 `.iknow/` 互不干扰）；host-init 仍 global（`~/.iknow/init.sh`，per-machine 不 per-project）。**SSOT**: `src/config/workspace-root.ts`（pure resolver, no I/O, 4 种 typed-error 判别联合 mirror `IknowIdentityError`）。**ADR**: `docs/adr/0019-workspace-root-per-root-state-decoupling.md`。
**Git**: 无用户明确 `push` 授权则不执行。

### Domain docs (auto-load on session start)

- docs/CONTEXT.md — 项目领域语言 + Flagged ambiguities
- docs/STATUS.md — 功能现状与展望
- docs/architecture.md — 独立 runtime 能力切分
- docs/handoff/<latest>.md — 最近 session 交接
- specs/README.md — 活跃 module spec 活索引（只列当前活跃；新增/归档只改那里一处）
- CHANGELOG.md — 版本变更记录（根目录真值）
- docs/integration-materials.env.example — LLM 接入材料占位（只写环境变量名）
