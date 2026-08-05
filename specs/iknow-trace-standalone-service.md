# Spec - `iknow trace` 独立检测服务

状态：v0（在 #182 面板基础上拆分 reader 挂载点）。
范围：把 `src/traceserver/` 的读 API 从 `iknow serve` 里拆出来，独立成
`iknow trace` 子命令进程。写侧零改动。

## 背景

`specs/traceserver-inspection-panel.md` 已交付 reader + 查询 API + Web 面板，
但读 API 当前经 `src/session-api/http.ts` 的 prefix-dispatch 挂在 `iknow serve`
同一进程。问题：trace 读侧重型 fs/JSONL 解析与会话 LLM 流式共享进程，慢读拖累
对话；故障不隔离；无法独立部署/横扩。

## 目标

1. `iknow trace` 作为独立 HTTP 进程托管 `GET /api/v1/traces[?]` + `/fields` + `/health`。
2. `iknow serve` 不再挂读 API；`--trace-out` 写语义保留（serve/chat/ask 仍写 JSONL）。
3. 线协议不变（R2/R3），Web 面板零行为回归。

## 需求

- R1 新增 `src/traceserver/serve.ts`：`startTraceServe({ traceOut, host, port, maxBytes })`
  起独立 `http.createServer`，host = `handleTracesRequest`；自带 `sendError`
  映射 `ValidationError -> 400 validation` / `TraceReadError -> 500 internal`
  （不泄漏 fs 细节）；`GET /api/v1/health` -> `{ ok, service: "iknow-trace", version }`。
- R2 `iknow trace` CLI：`--trace-out <f>`（默认 `./trace.jsonl`，env `IKNOW_TRACE_OUT`）、
  `--port <n>`（默认 24881，env `IKNOW_TRACE_PORT`）、`--host <addr>`（默认 127.0.0.1）、
  `--max-bytes <n>`（默认 8 MiB）。非法参数 exit 1；bind 失败 exit 1。
- R3 `src/session-api/`：删 `handleTracesRequest` import + prefix-dispatch；
  `SessionHttpServerOptions` / `ServeOptions` 去掉 `traceFilePath` / `traceOut` 透传。
  `iknow serve --trace-out` 仍写 trace（hub 写侧不动），启动时打 info 提示面板另起
  `iknow trace`。
- R4 前端：`web/src/api/client.ts` 引入 `TRACE_API = import.meta.env.VITE_TRACE_API_BASE
?? "/api/v1/traces"`，`getTraces` / `getTraceFields` 走 `TRACE_API`，其余端点仍
  `/api/v1`。`web/vite.config.ts` dev proxy 加 `/api/v1/traces` -> 24881。
- R5 文档：`docs/architecture.md` Capability modules 表 traceserver 行改为"独立
  `iknow trace` 进程"；`src/cli/usage.ts` 加 `iknow trace` 子命令；CHANGELOG 记
  breaking（serve 不再挂读 API）。

## 成功判据（SC，二元）

1. `npx tsc --noEmit` + web 类型检查通过。
2. 全量 `npm test`（`VITEST_MAX_FORKS=1`）无新增失败；traceserver 专项测试改用
   `startTraceServe` 起独立进程，覆盖矩阵不变（正常/空/ENOENT/坏行/IO 错误/
   truncation/过滤/分页/400/500/404/fields）。
3. 新增 `tests/cli/trace.test.ts`：`iknow trace` 解析 + 启动 + 端口监听 + health。
4. 浏览器实测（playwright-cli）：`iknow trace` 独立端口 + `iknow serve` 同跑 ->
   面板加载/过滤/行展开全绿（跨端口，vite proxy 或 VITE_TRACE_API_BASE）。
5. 写侧零改动：`src/harness/trace/jsonl.ts`、`loop-engine.ts`、`hub.ts` 写埋点
   不在 diff 中。
6. 无新增 npm 依赖、无 lockfile 变更。
7. `iknow serve --trace-out X` 仍写 trace（serve 端写侧回归测试通过），且不再
   暴露 `/api/v1/traces`（serve 端 404 该路径）。

## 明确排除（范围外）

`iknow dev` 父进程编排（spawn serve+trace）、多租户 trace 文件 / rotation、
trace 服务鉴权 / CORS 策略开关（v1 loopback 裸跑）、OTel 导出。
