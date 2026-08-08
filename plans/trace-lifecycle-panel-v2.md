# Plan: 完整生命周期追踪面板 v2（Trace Lifecycle Panel v2）

**Goal:** 把 trace 从扁平 JSONL 升级为可可视化、按会话切换、可实时监控、覆盖完整生命周期的追踪面板（一条 `iknow trace` 命令 → 浏览器 → FlowTree）。
**Architecture:** 写侧每会话独立文件（`<traceDir>/<convId>.jsonl`）+ 新增 `session`/`sandbox_cmd` record + model 字段；读侧会话列表/下钻 API + 增量轮询；CLI 默认目录 + 自动 open；web 端 FlowTree 可视化。全程不修改三个现有 trace spec。
**Tech Stack:** TypeScript（ESM）+ Node 内置 http/fs/crypto；web 用现有 React 19 + Vite + Tailwind；零新增 runtime deps。
**Spec link:** `specs/trace-lifecycle-panel-v2.md`（ACR 5/5 yes）

## Tasks (ordered by dependency)

> 每个 tracer bullet 是**垂直切片**：端到端可演示、≤1 commit、一个 `[decision]`/`[implementation]` tag。依赖序：写侧（T1-T3）→ 迁移（T4）→ 读侧（T5-T6）→ CLI（T7）→ 前端（T8）。T1/T2/T3 可部分并行（接口先定，实现分层）。

### T1. `[decision]` 写侧接口契约定版 — affects: `src/harness/trace/types.ts`

- **Acceptance**: `types.ts` 含 `SessionRecord`（含 `agentVersion`）、`SandboxCmdRecord`（含 `parentTurnId` 单值）、`LlmCallRecord` 加 `modelRequested`/`modelActual`/`provider`；`TraceService` 接口加 `recordSession`/`recordSandboxCmd`（均 `@throws never`）；`TraceRecordType` union 加 `"session"|"sandbox_cmd"`。`npm run typecheck` 绿。
- **Commit**: `feat(trace): 写侧接口定版（session/sandbox_cmd/model 字段）`
- **Status**: [ ] pending

### T2. `[implementation]` 每会话独立文件写入 — affects: `src/harness/trace/jsonl.ts`, `src/session-api/hub.ts`

- **Acceptance**: `createJsonlTraceService` 写 `<filePath>/<conversationId>.jsonl`（filePath 作目录）；`recordViolationTrace`（hub.ts:615）同域写 `<filePath>/<convId>.jsonl`。集成测试断言：写一批 → 目录下生成 `<convId>.jsonl`、非单文件。`npm test` 绿。
- **Commit**: `feat(trace): 每会话独立文件写入`
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Status**: [ ] pending

### T3. `[implementation]` session/sandbox_cmd 埋点 — affects: `src/harness/loop-engine.ts`, `src/harness/trace/jsonl.ts`

- **Acceptance**: loop-engine 入口 `recordSession` 埋点（L1 根，`agentVersion` 由 caller 注入）；`sandbox_cmd` 埋点留 pendingRuntime（schema 就位，不写 JSONL 行）。测试断言：run 产生 1 条 session 根记录 + N 条 turn/llm_call。`npm test` 绿。
- **Commit**: `feat(trace): session L1 根埋点 + sandbox_cmd schema 留位`
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Status**: [ ] pending

### T4. `[implementation]` 旧 trace 迁移脚本 — affects: `scripts/trace-migrate.ts`（新）, `src/cli.ts`

- **Acceptance**: `scripts/trace-migrate.ts` 读旧 `./trace.jsonl` → 按 conversation_id 分文件到 `./trace/<convId>.jsonl`，保留原行；坏行跳过计入报告。`tests/scripts/trace-migrate.test.ts` 覆盖（单文件→多文件、按 id 分、保留原行、坏行）。`npm test` 绿。
- **Commit**: `feat(trace): 旧 trace 迁移脚本`
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Status**: [ ] pending

### T5. `[implementation]` 读侧会话列表 reader — affects: `src/traceserver/sessions.ts`（新）, `src/traceserver/types.ts`

- **Acceptance**: `sessions.ts` 提供 `listSessions(traceDir)`（readdir+stat，返回 `conversation_id/mtime/size/agent_version`，不读内容）；无目录→空列表；stat ENOENT→跳过；agent_version 根记录缺失/坏行→absent。`tests/traceserver/sessions.test.ts` 覆盖。`npm test` 绿。
- **Commit**: `feat(trace): 读侧会话列表 reader`
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Status**: [ ] pending

### T6. `[implementation]` 读侧 HTTP 端 + 增量读取 — affects: `src/traceserver/http.ts`, `src/traceserver/serve.ts`, `src/traceserver/reader.ts`

- **Acceptance**: `GET /api/v1/sessions` 返回会话列表；`GET /api/v1/traces?conversation_id=<id>` 路由到会话文件；缺省 conversation_id→最近活跃会话（不 400 不混看）；`?poll=<ms>` 支持增量读取（0 停轮询）；`/fields`+`/health` 不变；poll 负值/非整数→400。`tests/traceserver/http.test.ts` + `reader-incremental.test.ts` 覆盖。`npm test` 绿。
- **Commit**: `feat(trace): 读侧会话列表端 + 下钻 + 增量轮询`
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Status**: [ ] pending

### T7. `[implementation]` CLI 启动体验 + 默认目录 — affects: `src/cli.ts`, `src/cli/parse-args.ts`, `src/cli/usage.ts`

- **Acceptance**: `runTrace` 默认 `./trace/` 目录（无需 `--trace-out`）+ 默认自动 open 浏览器（`--no-open` 关闭）+ 检测旧 `./trace.jsonl` fail-fast 提示迁移；`serve` 保持分开 + 提示"另起 iknow trace"。`tests/cli/trace.test.ts` 覆盖 `--no-open`/默认目录/fail-fast。`npm test` 绿。
- **Commit**: `feat(trace): 启动体验（默认目录 + 自动 open + --no-open）`
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Status**: [ ] pending

### T8. `[implementation]` FlowTree 可视化面板 — affects: `web/src/components/FlowTree.tsx`（新）, `web/src/components/TracePanel.tsx`, `web/src/api/client.ts`

- **Acceptance**: FlowTree 6 站点树状拓扑（移植原型 `/tmp/.trash-trace-view/variants/FlowTree.tsx`）；会话列表→下钻切换；实时轮询当前会话（默认 1s，`?poll=` 可配）；错误行 danger 色。`npm run web:typecheck` + `web:build` 绿；冒烟：`npx tsx src/cli.ts trace` → 浏览器 FlowTree 渲染。
- **Commit**: `feat(trace): FlowTree 可视化面板`
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit
- **Status**: [ ] pending

## Cross-references

- architecture-change-reviewer verdict: all 5 yes（spec 内 ACR gate 第二轮 PASS）
- affected S1-S6 skills: S2 defensive-contract（T5/T6 边界）、S5 complexity（T3 sandbox_cmd 留位）、S6 minimal-change（每 bullet 1 commit）
- parallelization surface: T1（接口）先于 T2/T3（实现）；T4（迁移）依赖 T2（写路径）；T5/T6 依赖写侧 completed；T7 依赖 T5（列表可看）；T8 依赖 T6（下钻数据通）。T2/T3 可并行（都依赖 T1）。
