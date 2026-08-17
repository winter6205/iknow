# Plan — trace 检测服务融合进 `iknow serve` webserver

**Feature**: 把 trace 检测读侧服务（PR #183 拆出的独立进程 `iknow trace`，`src/traceserver/`）融合回 `iknow serve` webserver：**同进程、同端口（8787）、路由子树挂载**（`/api/v1/traces/*` API + `/trace` SPA）；`iknow trace` 保留为探测+提示入口，`--separate` escape hatch 保留独立进程模式；web UI 加自然入口（header 全局入口 + 会话行 deep-link）。写侧（`src/harness/trace/` 经 `session-api/hub.ts`）零改动。

**Tracker**: GitHub（gh CLI 可用，origin = `winter6205/iknow.git`，issue tracker = main path，非 fallback）。每个 `[implementation]` bullet → 1 个 `ready-for-agent` issue；blocked-by 关系用 GraphQL `addBlockedBy` 建。

**Status of ACR cross-check**: 见文末 ACR verdict block（`arthurpower:architecture-change-reviewer` 预审）。

**Spec / contracts consumed** (NOT produced by this plan):

- ADR-0003（trace-service-domain-interface）— TraceService 是 **A-scenario（developer local debug）专用**，B-scenario（production OTel）显式排除。本计划**不违背**该裁决；融合正是基于"无横扩语义"这一 A-scenario 性质。
- ADR-0019（workspace-root）— trace 数据路径（`./trace/` 相对 CWD）与 workspace-root/data-dir **本就解耦**（`cli.ts:499-502` 注释：读侧不消费 `IKNOW_TRACE_OUT`），本计划保持该解耦，不引入新路径语义。
- `.claude/rules/code-quality.md` typed-error catch 契约 — `TraceReadError`（`src/traceserver/types.ts`）判别联合 `kind` 保留；错误信封统一走 webserver `sendError`，不 echo fs 细节。
- `.claude/rules/test.md` — 命令 handler 集成测试接真实 store/真实目录；trace-mount 回归守卫测试反转。

> **Contradicts spec #183（已归档 `iknow-trace-standalone-service.md`）— worth reopening because**: #183 的三条拆分理由中，「慢读拖累对话」与「故障不隔离」可用 per-query cap（reader 已有 `MAX_TRACE_BYTES` 8MiB 封顶 + result-row cap）与路由级 try/catch 缓解，不依赖分进程；「独立部署/横扩」在 A-scenario（单用户本机调试）下无语义。决策者（用户 2026-08-17）裁定融合。#183 是归档 spec 非 ADR，按 specs/README.md 索引规则只需在归档指针行追加 supersede 注记。

> **Contradicts `tests/session-api/trace-mount-removed.test.ts`（#183 回归守卫）— worth reopening because**: 该测试断言的正是被推翻的行为（`/api/v1/traces` → 404）。T3 反转断言为「挂载存在」，测试意图不变（锁定当前架构契约），方向随决策翻转。

---

## D1. `[decision]` 挂载契约：路由表 + SPA mount + 错误信封 + 命名

**Affects**: 所有 `[implementation]` bullet 的接口面（`src/traceserver/serve.ts` / `src/session-api/http.ts` / `src/web/serve-static.ts` / `web/src/api/client.ts`）。

**Acceptance**: 以下 6 条裁决记录进 ADR-0020（T1 产出），每条 yes/no + 一行理由；批准后 implementation bullets 照抄执行。

- **D1.1 路由表（mounted mode，8787 单端口）**：
  - `GET /api/v1/traces` + `GET /api/v1/traces/fields` → traceserver `handleTracesRequest`（现状不变）。
  - `GET /api/v1/traces/sessions` → traceserver `handleSessionsRequest`（**从 standalone 的 `/api/v1/sessions` 迁到 traces 前缀下**，避免与 chat `GET /api/v1/sessions` 撞名；chat sessions 路由零改动）。
  - standalone mode（`--separate`）保留 `/api/v1/sessions` 别名（back-compat 一个版本，CHANGELOG 注记）。
  - mounted mode **不**重复挂 `/api/v1/health`（session-api 已有）。
- **D1.2 SPA mount**：`GET /trace` + `GET /trace/*` → `trace.html` SPA fallback；`/` 仍 `index.html`。实现走 `serveStaticRequest` 新增可选 `stripPrefix` 参数（`src/web/serve-static.ts`，stdlib-only 不变，path-traversal 守卫对 strip 后路径生效）。两 SPA 共用同一 `web/dist`（vite 多入口现状，零构建改动）；trace 页引用的 `/assets/*` 绝对路径由通用静态层直接命中，无需重复 mount。
- **D1.3 错误信封统一**：mounted mode 下 trace handler 的 `ValidationError` / `TraceReadError` / unknown 走 session-api `sendError` 同一信封（`{error:{kind,message,context?}}`；TraceReadError 固定 500 `trace file read failed`，不 echo fs 细节）。`isSessionStoreError` 守卫（`http.ts:378-391`）语义不变（Error 实例排除逻辑本来就正确），仅更新注释。standalone mode 保留自己的 sendError。
- **D1.4 traceserver → cli/usage 反向 import**：`createTraceRouter` 工厂**注入** `version: string`（caller 从 `cli/usage.ts getVersion()` 取——session-api/http.ts:17 已有该 import 先例），traceserver 删除 `getVersion` import。
- **D1.5 工厂签名**：`createTraceRouter(opts: { traceDir?, maxBytes?, version }) → (req, res) => Promise<boolean>`（返回 `true` = 已处理；`false` = 非 trace 路由，caller 继续）。`startTraceServe` 保留为薄壳（内部组 factory + health + static），`--separate` 继续用。
- **D1.6 前端 API base**：`web/src/api/client.ts` `getTraceSessions()` 改走 `${TRACE_API}/sessions`（即 `/api/v1/traces/sessions`），不再从 TRACE_API 推导 origin + `/api/v1/sessions`；`TRACE_API` 默认 `/api/v1/traces` 不变，`VITE_TRACE_API_BASE` 覆盖语义不变（standalone dev 仍可用）。

---

## D2. `[decision]` `iknow trace` CLI 默认行为反转 + `--separate`

**Affects**: `src/cli.ts` runTrace、`src/cli/parse-args.ts`、`src/cli/usage.ts`。

**Acceptance**: 以下裁决记录进 ADR-0020，批准后 T4 照抄执行。

- **D2.1 默认行为**：`iknow trace` 不起进程——探测 `http://<host>:<port>/api/v1/health`（host/port 用 `--host`/`--port`，默认 127.0.0.1:8787）；探测成功 → 打印 `http://host:port/trace` + 自动开浏览器（`--no-open` 关闭）+ exit 0；探测失败 → 打印「未检测到 iknow serve，请先 `iknow serve` 或用 `iknow trace --separate`」+ exit 1。
- **D2.2 `--separate` escape hatch**：保留现行为（独立进程 24881，动态 import traceserver/serve.js 保留——chat/ask 启动路径零新增依赖）。
- **D2.3 legacy 检测**：`detectLegacyTrace` fail-fast 保留，且**先于**探测执行（两种模式都需要迁移后的目录语义）。

---

## T1. `[implementation]` ADR-0020 + spec first 文档

- **Affects**:
  - NEW `docs/adr/0020-trace-inspection-mount-into-serve.md` — 记录推翻 #183 的决策：Context（#183 三理由复盘 + A-scenario 无横扩语义）/ Decision（D1+D2 全部裁决逐字记录）/ Consequences（慢读缓解上限、`--separate` 过渡、CHANGELOG breaking 条目）。
  - `specs/trace-service.md` — CLI 段更新：读侧从「独立 `iknow trace` 进程」改为「`iknow serve` 同进程路由子树（ADR-0020）；`iknow trace` 默认探测 + `--separate` escape hatch」。
- **Acceptance** (binary):
  - ADR-0020 存在且包含 D1/D2 全部 9 条裁决的逐字记录（`grep -c "D1\.[1-6]\|D2\.[1-3]" docs/adr/0020-*.md` ≥ 9）。
  - `specs/trace-service.md` 不再含「独立 iknow trace 进程」作为当前读侧形态的描述（`grep -n "iknow trace" specs/trace-service.md` 仅剩 `--separate`/历史注记语境）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

## T2. `[implementation]` traceserver 抽 `createTraceRouter` 工厂 + 拆 cli/usage 反向依赖

- **Affects**:
  - `src/traceserver/serve.ts` — 抽 `createTraceRouter(opts) → (req,res) => Promise<boolean>`（D1.5 签名：traceDir/maxBytes/version 注入；内部路由 `/api/v1/traces` 前缀 + `/api/v1/traces/sessions` + `/api/v1/traces/fields`；standalone 别名 `/api/v1/sessions` 保留在 `startTraceServe` 包装层）；删除 L28 `getVersion` import（health version 改注入）；`startTraceServe` 变薄壳。
  - `src/traceserver/index.ts` — barrel 增 `createTraceRouter` 导出。
  - NEW/改 `tests/traceserver/router.test.ts` — createTraceRouter 不经 `http.createServer` 的纯工厂用例（trace 路由命中返回 true；非 trace 路径返回 false；version 注入出现在 health——standalone 壳层测）。
- **Acceptance** (binary):
  - `grep -rn "cli/usage" src/traceserver/` 零命中。
  - `npx vitest run tests/traceserver/` exit 0（含新增 router 工厂用例 + 既有 serve.test.ts 全绿——startTraceServe 薄壳行为不回归）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

## T3. `[implementation]` session-api 挂载 trace 路由子树 + `/trace` SPA + 反转回归守卫

- **Affects**:
  - `src/web/serve-static.ts` — `ServeStaticOpts` 增可选 `stripPrefix`（D1.2）；traversal 守卫对 strip 后路径生效。
  - `src/session-api/http.ts` — `SessionHttpServerOptions` 增 `trace?: { traceDir?: string; maxBytes?: number }`；`handle()` 在 sessions 路由之后、通用 static 之前插入：`/api/v1/traces` 前缀 → `createTraceRouter`（version 经已有 `getVersion` import 注入）；`/trace`+`/trace/*` → `serveStaticRequest({stripPrefix:"/trace", fallbackHtml:"trace.html"})`；头部 183 R3 注释更新为 ADR-0020 语义；`isSessionStoreError` 注释更新（守卫代码不动）。
  - `src/session-api/serve.ts` — `startSessionServe` 把 `opts.traceOut`（resolve 后）透传进 `listenSessionServer({trace:{traceDir}})`；删除「READ-side reader is now mounted by iknow trace」过时注释。
  - `tests/session-api/trace-mount-removed.test.ts` → **重命名 `trace-mounted.test.ts` 并反转断言**：`GET /api/v1/traces` → 200（空目录 `{records:[],total:0}` 形态）；`GET /api/v1/traces/sessions` → 200；`GET /api/v1/health` 仍 200；chat `GET /api/v1/sessions` 不回归。
  - `tests/session-api/http.test.ts` — 增 mounted 用例：`/trace` → trace.html 200 + Content-Type text/html；`/trace/deep-link` SPA fallback；`/` 仍 index.html（不回归）。
  - NEW `tests/web/serve-static-prefix.test.ts`（或并入既有 serve-static 测试文件）— stripPrefix 边界：`/trace` → trace.html；`/trace/assets/x.js` strip 后命中；traversal `/trace/../index.html` strip 后仍被守卫拦。
- **Acceptance** (binary):
  - `npx vitest run tests/session-api/ tests/web/serve-static*` exit 0，其中 trace-mounted.test.ts 断言 `GET /api/v1/traces` 返回 200。
  - `npm test` 全量 exit 0（无其他测试回归）。
  - 集成用例走 `listenSessionServer({ port: 0 })` 实 fetch（http.test.ts 既有模式），非手测。
  - **5 boundary classes 映射（`.claude/rules/test.md`，新增 mount 逻辑）**——标注 new / inherited，inherited 不重复造轮子但必须可指认：
    1. **empty** — `/trace`（stripPrefix 后余空）→ trace.html 200（new，serve-static-prefix.test.ts）；trace 目录空/未设 → `/api/v1/traces` 200 `{records:[],total:0}`（**inherited**: `tests/traceserver/http.test.ts` 空目录用例；mounted 层仅断言路由到达，不重复解析语义）。
    2. **negative** — `?limit=-1` / 非法 filter → 400 validation（**inherited**: `tests/traceserver/http.test.ts` parseX validation 用例，mounted 经同一 `handleTracesRequest`，语义不变）；session id 含 `/` → path 守卫拒绝（**inherited**: `src/traceserver/http.ts:175-183` sessionFilePath 守卫既有测试）。
    3. **overflow** — limit 超上限 → cap（**inherited**: `tests/traceserver/reader.test.ts` 截断/cap 用例 + MAX_TRACE_BYTES）；`/trace/<4096 字符路径>` → SPA fallback 不 crash（new，serve-static-prefix.test.ts）。
    4. **concurrent** — 同一 `listenSessionServer` 上两并发 fetch（`/api/v1/traces` + `/trace`）→ 双双 200（new，trace-mounted.test.ts）。
    5. **exception** — TraceReadError → mounted 500 信封 `trace file read failed`、wire 无 fs 路径/errno（new，trace-mounted.test.ts；standalone 对应物已有 `tests/traceserver/serve.test.ts` 500 用例）；`/trace/../index.html` → traversal 守卫拦截（new，serve-static-prefix.test.ts）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

## T4. `[implementation]` CLI `iknow trace` 默认反转 + `--separate` `[blocks: T3]`

- **Affects**:
  - `src/cli.ts` — `runTrace` 按 D2.1-D2.3 重写（探测 health → 打印 `/trace` URL / 提示起 serve；`--separate` 走原 startTraceServe 路径；legacy 检测前置保留）。
  - `src/cli/parse-args.ts` — 增 `--separate` boolean flag。
  - `src/cli/usage.ts` — help 文本更新（trace 子命令说明反转）。
  - `src/cli.ts` runServe — 启动消息从「面板请另起 `iknow trace --trace-out ...`」改为「Trace 面板：http://host:port/trace」。
  - NEW `tests/cli/trace-default-mode.test.ts` — 三态：探测成功（临时 http server 假 health）→ exit 0 + 打印 /trace URL；探测失败 → exit 1 + 提示 --separate；`--separate` → 起独立进程（port 0 实测 + close）。
- **Acceptance** (binary):
  - `npx vitest run tests/cli/` exit 0（含新增三态用例）。
  - `npx tsx src/cli.ts trace --help` 文本含 `--separate`。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

## T5. `[implementation]` web UI 入口（header + 会话行 deep-link + trace 面板返回） `[blocks: T3]` `[parallel with T4]`

- **Affects**:
  - `web/src/components/ChatHeader.tsx` — 右侧状态区左侧加 `Trace` 链接（mono 11px text-ink-3，与连接状态同款），`href="/trace"`。
  - `web/src/components/SessionSidebar.tsx` — 会话行 hover 浮出 `⇱trace` deep-link → `/trace?session=<conversationId>`（展开态；折叠态不加，避免与全局入口重复）。
  - `web/src/components/TracePanel.tsx`（+ trace.html header 区）— 加「← 返回对话」链接（`href="/"`）；初始会话选中消费 `?session=` query param（有值优先于 mtime 默认选中——后端 `?session=` 已支持，前端仅初始状态）。
  - `web/src/api/client.ts` — `getTraceSessions()` 改 `${TRACE_API}/sessions`（D1.6）。
  - `web/vite.config.ts` — dev proxy：`/api/v1/traces` 默认目标改 8787（`IKNOW_DEV_TRACE_API` 覆盖保留，供 standalone dev）。
  - `tests/web/trace-api-base.test.ts` — sessions URL 断言更新。
- **Acceptance** (binary):
  - `npx vitest run tests/web/` exit 0。
  - `npm run web:build`（`--prefix web`）exit 0 且 `web/dist/trace.html` + `web/dist/index.html` 并存（多入口不回归）。
  - 手动证据（记入 verification）：`iknow serve` 起后浏览器 `/` 见 Trace 链接、`/trace` 面板见返回链接、`/trace?session=<id>` 选中对应会话（playwright-cli skill 或 curl 断言 HTML 结构）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

## T6. `[implementation]` 文档同步 + eval baseline + CHANGELOG `[blocks: T4, T5]`

- **Affects**:
  - `docs/architecture.md` — Capability modules 表 Trace inspection 行：`Standalone iknow trace process (#183)` → `mounted into iknow serve (ADR-0020); iknow trace default = probe, --separate escape hatch`；CLI 行同步。
  - `docs/STATUS.md` — §1.2 web 端行补 trace 面板同进程入口；§5 常用命令补 `iknow trace` 新语义。
  - `specs/README.md` — 已归档段 trace 三迭代行追加 `superseded by ADR-0020（融合回 serve）` 指针。
  - `CHANGELOG.md` — Breaking：`iknow trace` 默认行为反转（探测 serve，`--separate` 保留独立进程）；Added：`/trace` 面板入口 + `/api/v1/traces/sessions`。
  - NEW `.evals/tasks/<issue#>-merge-trace-into-serve.yaml`（编号 = 主 ticket issue 号）— `test_command: bash -e -c 'npx vitest run tests/session-api/ tests/traceserver/'`，tier medium。
- **Acceptance** (binary):
  - `bash .evals/run.sh --task <issue#>-merge-trace-into-serve` exit 0。
  - `grep -rn "独立.*iknow trace\|Standalone.*iknow trace" docs/architecture.md docs/STATUS.md` 零命中（旧形态描述清干净）。
  - `npm test` 全量 exit 0（收尾基线）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Commit / PR 策略（minimal-change-verifier 显式声明）

**形态：1 个 feature branch（`worktree-merge-trace-into-serve`）+ 7 个 commit（= 7 tracer bullets，1 commit = 1 logical task）+ 单 PR 合入 master。** 与 PR #490 workspace-root 的多-bullet-单-PR 先例同构。每个 commit 的 diff scope 严格对应其 bullet 的 Affects 行；中途 WIP 不需要重复 code-review，收尾走一轮 `arthurpower:code-review` + `arthurpower:verification-before-completion`（全局规则）。

Commit 序（Conventional Commits，branch 上依次落）：

1. `docs(trace): ADR-0020 融合 trace 读侧回 serve + spec 更新`（T1，docs-only）
2. `refactor(traceserver): 抽 createTraceRouter 工厂 + 拆 cli/usage 反向依赖`（T2，纯重构零行为变化）
3. `feat(session-api): mount trace 路由子树 + /trace SPA + 反转 #183 回归守卫`（T3）
4. `feat(cli): iknow trace 默认探测 serve + --separate escape hatch`（T4）
5. `feat(web): trace 面板入口 — header 链接 + 会话行 deep-link + 返回链接`（T5）
6. `docs: architecture/STATUS/specs-README/CHANGELOG 同步 trace 融合`（T6，docs-only）
7. `test(evals): merge-trace-into-serve eval baseline`（T6 的 .evals yaml，单独 commit 保持 docs/eval 分离）

**依赖安全**：T2 是「纯重构零行为变化」commit——落地后 `npm test` 必须全绿（startTraceServe 薄壳行为不回归），这是 expand–contract 的 expand 轨；T3 才引入 mount 行为变化（contract 轨）。两 commit 分离保证任一中途回滚不破坏既有 `iknow trace`。

## 5 boundary classes 映射（defensive-contract-validator 显式声明）

每个新增行为面的 5 类边界覆盖归属——`[new]` = 本计划新增用例，`[inherited]` = 既有测试已覆盖、本计划不重复但在此指认：

| 边界类         | T2 router 工厂                                                                     | T3 mount + /trace SPA                                                                                                                                       | T5 web 入口                                                                |
| -------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **empty**      | factory 无 traceDir → 路由返回 false `[new: router.test.ts]`                       | `/trace` 无 trailing 内容 → trace.html `[new]`；trace 目录空 → traces 200 `{records:[],total:0}` `[inherited: tests/traceserver/http.test.ts]`              | `?session=` 缺省 → mtime 最近会话 `[inherited: 前端默认选中逻辑]`          |
| **negative**   | 非 `/api/v1/traces` 前缀路径 → 返回 false `[new]`                                  | `GET /api/v1/traces` 非 GET（POST）→ 404/405 `[new: trace-mounted.test.ts]`                                                                                 | deep-link 会话不存在 → 面板 fallback 最近会话 `[new: TracePanel 选中逻辑]` |
| **overflow**   | maxBytes=极小 → reader 截断 `[inherited: tests/traceserver/reader.test.ts]`        | 超大 query string → 400/截断 `[inherited: http.test.ts parseX]`                                                                                             | 超长 conversationId → 前端不崩 `[new: 边界用例]`                           |
| **concurrent** | 两次 factory 调用独立闭包，无共享 mutable `[new: router.test.ts]`                  | 并发 `/trace` + `/api/v1/traces` 请求 → 各自独立响应 `[new: http.test.ts]`                                                                                  | 并发轮询不重叠写选中态 `[inherited: useTraceSessionTraces 既有]`           |
| **exception**  | traceDir 指向不存在路径 → readdir ENOENT → 200 空（非 500）`[new: router.test.ts]` | TraceReadError → 500 `trace file read failed`（无 fs leak）`[new: trace-mounted.test.ts]`；`/trace/../` traversal → 403 `[inherited: serve-static.test.ts]` | API 抛错 → ErrorBoundary 不白屏 `[inherited: ErrorBoundary 既有]`          |

读权限类（`.claude/rules/test.md` 第 4 条「权限不足」）：本变更为 read-only 本地调试面，无鉴权层（STATUS.md §2.2 明示「无鉴权」），不适用；以 traversal 403 + sessionFilePath `/`/`\` 拒绝作为越界访问的等价边界（已在表中 exception/negative 列覆盖）。

## 依赖图

```
D1 ─┬→ T1（ADR/spec）→ T2（router 工厂）→ T3（mount + 反转守卫）─┬→ T4（CLI 反转）─┐
D2 ─┘                                                            └→ T5（web 入口）┴→ T6（文档 + eval）
```

- T4、T5 互不依赖，`[parallel]`。
- T6 收口依赖 T4+T5 全部落地。
- 7 bullets = 7 commits（1 commit = 1 logical task，Conventional Commits）。

## 明确不做（范围克制）

- 写侧（`src/harness/trace/` + hub 装配）零改动。
- `IKNOW_SERVE_PORT` / `IKNOW_TRACE_OUT` 收进 env.ts SSOT 是独立技术债，本计划不做。
- 前端两 SPA 不合并（vite 多入口共享 chunk 已是现状最优）。
- 不删 `iknow trace` 子命令（`--separate` escape hatch 保留）。

---

## ACR verdict block

**Pass 1**（2026-08-17，`arthurpower:architecture-change-reviewer` 预审）：

```
bounded-context-guardian: yes — cli/usage 反向 import 经 DI 拆除；serve-static.ts stdlib-only 共享声明既有（L1-17 docstring）；兄弟目录保留；/api/v1/sessions 改名 /api/v1/traces/sessions 消除与 session-api/http.ts:120 chat sessions 的潜在撞名。
defensive-contract-validator: unclear — 计划未把 5 boundary classes 映射到新增 mount 逻辑。
error-handling-enforcer: yes — TraceReadError kind 判别保留（types.ts:65-72）；createTraceRouter 保留自身 try/catch + sendError，wire 信封仍塌缩为 kind:"internal" 无 fs 泄漏（serve.ts:170-179 既有语义）；session-api sendError fallthrough 500 保留。
complexity-anti-drift: yes — 各文件改动点状；createTraceRouter 薄壳；serve-static.ts 扩展是 additive（fallbackHtml 已参数化）；无 god-function/file。
minimal-change-verifier: unclear — 计划未声明 commit 策略（单 PR 与否、scope 边界）。
OVERALL: BLOCKED — 2 unclear
```

**Remediation**：两处 unclear 均非设计缺陷而是计划显式性缺失——本文件已补「Commit / PR 策略」节（7 commits / 单 feature branch / 单 PR，scope 逐条对应 Affects 行）与「5 boundary classes 映射」节（T2/T3/T5 逐列标注 new/inherited）。T3 Acceptance 内嵌同一映射。

**Pass 2**（复审 2 个 unclear 维度）：

```
defensive-contract-validator: yes — T3 Acceptance（lines 87-92）+ 总表（lines 155-167）逐类标注 [new]/[inherited] 并指认既有测试文件与不重复理由；权限不足类显式声明不适用（read-only 无鉴权面），以 traversal 403 + sessionFilePath 拒绝为等价边界。
minimal-change-verifier: yes — Commit/PR 策略（lines 139-153）显式声明 1 branch + 7 commits + 单 PR，scope 逐条对应 Affects 行；expand–contract 分离（T2 纯重构 / T3 行为变化）回滚安全论证具体。
OVERALL: PASS — 5 维全 yes，移交执行
```
