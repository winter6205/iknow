# Project Instructions for Claude Code

本文件是本项目的团队共享项目级规范。所有会影响代码、Git、测试、提交、发布、项目记忆和工程决策的行为都必须遵守本文件。

个人偏好不得写入本文件。个人偏好写入 `CLAUDE.local.md`，并确保该文件不提交到 Git。

---

## 不变量 (NEVER / MUST)

NEVER:

1. 在没有用户明确授权的情况下执行 push / release / deploy / tag / force push / rebase public branch
2. 把临时调试代码、无关格式化、无关重构混入功能提交
3. 擅自修改安全、认证、权限、支付、数据迁移、CI/CD、生产配置等高风险区域
4. 删除或跳过测试来让构建通过；不得把失败测试改成跳过
5. 把密钥 / token / cookie / 私钥 / 证书 / 生产数据写入提交信息、日志、测试快照或聊天输出
6. 通过 alias / 脚本 / 临时移动 hooks / 修改 hooks 文件 / 修改权限 / 绕过 lint-staged / husky / pre-commit 等方式规避质量门禁

MUST:

1. 先理解，再修改。先计划，再执行。先验证，再提交。
2. 优先使用只读命令 (`ls` / `find` / `grep` / `rg` / `cat` / `git status` / `git diff` / `git log` / `git show`)。
3. 涉及多文件修改、架构调整、高风险模块、依赖升级时，先输出 Plan + Files expected to change + Validation。
4. 小步提交。每个提交只表达一个意图。
5. 不绕过项目已有的质量门禁。如果 pre-commit / 测试失败，必须报告失败原因并提出修复方案。
6. 用户请求与本规范冲突时，必须说明冲突点并请求用户确认；不得临时绕过。

---

## 可维护性 6 规范 (S1-S6)

| 编号 | 规范 | Skill |
|------|------|-------|
| S1 | 限界上下文 | `bounded-context-guardian` |
| S2 | 防御契约 | `defensive-contract-validator` |
| S3 | 显式错误处理 | `error-handling-enforcer` |
| S4 | 测试即规约 | `maintainability-reviewer`  |
| S5 | 抗劣化简洁 | `complexity-anti-drift` |
| S6 | 最小变更 + 依赖真实 | `minimal-change-verifier` |

详细定义见全局规则: `~/.claude/rules/s{1-6}-*.md`。本项目评审走 subagent: `.claude/agents/maintainability-reviewer.md`。

---

## 1. 上下文读取顺序

每次开始任务时按需读取：

1. `README.md`
2. `docs/architecture.md`
3. `docs/git-workflow.md`
4. `docs/testing.md`
5. 当前任务相关目录下的 `CLAUDE.md`
6. 当前任务相关代码 / 测试 / 配置文件
7. `/memory` 中显示的项目记忆与自动记忆摘要

不要一次性读取所有文件。只读取与当前任务相关的文件，避免污染上下文。

---

## 2. 依赖管理规范

新增依赖前必须说明：

1. 为什么需要新依赖？
2. 是否已有项目依赖可复用？
3. 维护活跃度如何？
4. 包体积或运行时影响如何？
5. 是否引入安全或许可证风险？
6. 是否需要锁文件更新？

不得无理由升级大版本依赖。不得混用包管理器。

- 项目使用 `pnpm-lock.yaml` → 不得运行 `npm install` 生成 `package-lock.json`
- 项目使用 `package-lock.json` → 不得生成 `pnpm-lock.yaml` 或 `yarn.lock`

---

## 3. 文档规范

当代码行为 / 配置 / 命令 / 环境变量 / API / 迁移步骤发生变化时，必须同步更新文档。文档应说明：

1. 使用方式
2. 示例
3. 限制
4. 错误处理
5. 迁移方式（若适用）

不得让 README / docs / 注释与实际代码行为不一致。

---

## 4. 任务完成汇报格式

完成任务后必须按以下格式汇报：

```text
Summary:
- ...

Changed files:
- ...

Validation:
- ...

Git:
- Branch: ...
- Commit: ...
- Push: not performed unless explicitly requested

Risks / Notes:
- ...
```

如果没有运行测试，必须明确说明原因，不得省略。

---

## 5. 规范变更流程

本文件是项目级行为规范。修改本文件或 `.claude/rules/*.md` 前必须：

1. 说明修改原因。
2. 说明影响范围。
3. 检查是否与 `.claude/settings.json` / hooks / README / docs 冲突。
4. 单独提交规范变更，不与业务代码混合。

---

## 6. 引用 — 拆分规则

详细规则下沉到 `.claude/rules/`，本文件通过 `@path` 引用：

- **任务前技能检查 + 工具路由 + 熔断** → @.claude/rules/workflow.md（**最元，所有任务先看**）
- Git workflow + commit + pre-commit → @.claude/rules/git.md
- Memory 三层 + 写入准入 + 维护 → @.claude/rules/memory.md
- 代码修改 + 测试 + 高风险区域 → @.claude/rules/code-quality.md
- 权限 + 工具使用 + 安全与隐私 → @.claude/rules/security-boundaries.md
- 5 个通用任务模板 (test-coverage / pr-review / error-handling-fix / refactor-dedup / security-audit) → @.claude/rules/task-templates.md
- 项目架构 → @docs/architecture.md
- 规格交接 → @docs/iknow-spec/HANDOFF.md
- 接入材料占位 → @docs/integration-materials.env.example
- Git 工作流细节 → @docs/git-workflow.md（待建）
- 测试细节 → @docs/testing.md（待建）
- 发布流程 → @docs/release.md（待建）

---

## 7. Agent skills

列出本项目可用的 skills / evals / handoff 协议, 避免每次重发明.

### Skills 路由 (按任务形状)

| 任务形状 | 走 skill |
|---|---|
| 接手陌生项目 / 摸架构 | `codebase-memory` (get_architecture + search_graph) |
| 改前摸调用链 | `serena` (find_referencing_symbols) |
| Agent 生命周期 / 阶段门 | 项目 skill `agent-development-lifecycle` |
| Trajectory / 门禁评测 | 项目 skill `agent-evaluation-system` + `npm run eval` |
| 改前写测试 / S2 边界 | `defensive-contract-validator` |
| Bug 修复 | `systematic-debugging` (含 Phase 1 红线: 先建反馈循环) |
| 审查报告修复 / review report repair | 项目 skill `review-report-repair` |
| 写 spec / 设计 | `spec-driven-development` |
| 多文件规划 | `writing-plans` |
| 完成前验收 | `verification-before-completion` |
| 跨 session 记忆 / 规则迭代 | `self-evolving-rules` (7 步流程) |
| Skill 创建 / 优化 | `arthurpower:skill-authoring` / `SkillOpt` |

### Eval (iknow product + template)

**产品 trajectory（主路径）**:

```bash
npm test          # unit + eval alignment + trajectory unit tests
npm run eval      # 32-sample suite → docs/iknow-spec/docs/eval/results/ (gitignored)
```

硬门禁目标: `hard_pass_rate = 1.0`；Sprint-1 软目标: `mean_trajectory_score ≥ 0.6`。

**模板 scaffold eval**（仓库自带）:

- @.evals/README.md — eval framework 怎么用
- @.evals/run.sh — bash runner
- @.evals/tasks/*.yaml — task definitions

跑 template baseline: `bash .evals/run.sh`

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
**Git**: 无用户明确 `commit`/`push` 授权则不执行。

### Domain docs (auto-load on session start)

- @docs/CONTEXT.md — 项目领域语言 + Flagged ambiguities
- @docs/STATUS.md — 功能现状与展望
- @docs/architecture.md — 独立 runtime 能力切分
- @docs/design/interaction-surface-v0.md — 交互方案
- @docs/iknow-spec/HANDOFF.md — 协议/阶段真值（优先于过时分支叙述）
- @docs/handoff/<latest>.md — 最近 session 交接
- @docs/CHANGELOG.md — 版本变更记录（根目录 `CHANGELOG.md` 为真值）
- @docs/integration-materials.env.example — LLM/向量接入材料占位（只写环境变量名）

### 3 层记忆模型 (where to write)

| 层 | 位置 | 写什么 | 写入触发 |
|---|---|---|---|
| L1 | `~/.claude/CLAUDE.md` + `~/.claude/rules/*.md` | 跨项目通用规则 | 3+ 项目同模式 / 显式升级 |
| L2 | auto memory (session 内) | session learnings | 自动 (L3 compaction) |
| L3 | session context + `docs/` (CONTEXT.md / handoff / CHANGELOG) | 当前任务 + 项目知识 | inline + task-end 3 问 |

**知识查询优先级** (高→低):
1. 代码本身 (最终真值)
2. codebase-memory graph (结构性事实, 自动新鲜)
3. docs/CONTEXT.md / handoff (业务领域语言 + 历史)
4. CLAUDE.md (本文件, 跨项目规则)

**无 L4 决定**: 不引入 `.serena/memories/` — 与 codebase-memory + CONTEXT.md 重叠, 实际无增量价值. 详见 `docs/CONTEXT.md` Flagged ambiguities "serena memories vs codebase-memory".

### Task-end ritual (走 verification-before-completion 之后)

- Q1 学到什么 → 追加 @docs/CONTEXT.md (新术语 + _Avoid_)
- Q2 状态变了什么 → 走 `claude-md-management` 更新本文件
- Q3 业务变更 → 追加 @docs/CHANGELOG.md + 新建 `docs/handoff/<date>.md`
