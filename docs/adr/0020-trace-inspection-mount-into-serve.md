# 0020. trace 检测读侧融合回 `iknow serve`：同进程路由子树挂载（推翻 #183 独立进程拆分）

Date: 2026-08-17
Status: accepted

Context: PR #183（commit `9ae9cf5e`，spec 归档于 `docs/archive/025-retire-completed-specs-and-plans/specs/iknow-trace-standalone-service.md`）把 trace 读 API 从 `iknow serve` 拆成独立 `iknow trace` 进程（默认 24881），三条理由：慢读拖累对话、故障不隔离、独立部署/横扩。2026-08-17 复盘：trace 是 **A-scenario（developer local debug）专用**（ADR-0003，B-scenario production OTel 显式排除），单用户本机调试无横扩语义；前两条理由可由 per-query cap（reader 已有 `MAX_TRACE_BYTES` 8MiB 封顶）与路由级 try/catch 缓解，不依赖分进程。同时双进程带来真实成本：两个端口心智、两个 SPA 同源却跨 origin 无法互链、启动提示要用户另起一条命令。决策者裁定融合。

Decision: `iknow serve` 同进程、同端口（8787）挂载 trace 读侧路由子树 + `/trace` SPA；`iknow trace` 默认行为反转为探测入口（`--separate` escape hatch 保留独立进程）。写侧（`src/harness/trace/` 经 `session-api/hub.ts`）零改动。`src/traceserver/` 与 `src/session-api/` 保持兄弟目录（S1 bounded context），不物理合并。

- **D1.1 路由表（mounted mode，8787 单端口）**：`GET /api/v1/traces` + `/fields` → `handleTracesRequest`（语义不变）；`GET /api/v1/traces/sessions` → `handleSessionsRequest`（从 standalone 的 `/api/v1/sessions` 迁入 traces 前缀下，避免与 chat `GET /api/v1/sessions` 撞名；chat sessions 路由零改动）；standalone mode（`--separate`）保留 `/api/v1/sessions` 别名一个版本；mounted mode 不重复挂 `/api/v1/health`（session-api 已有）。
- **D1.2 SPA mount**：`GET /trace` + `GET /trace/*` → `trace.html` SPA fallback；`/` 仍 `index.html`。走 `serveStaticRequest` 新增可选 `stripPrefix`（`src/web/serve-static.ts`，stdlib-only 不变），path-traversal 守卫对 strip 后路径生效。两 SPA 共用同一 `web/dist`（vite 多入口现状，零构建改动）。
- **D1.3 错误信封统一**：mounted mode 下 `ValidationError` / `TraceReadError` / unknown 走 session-api `sendError` 同一信封（`{error:{kind,message,context?}}`；`TraceReadError` 固定 500 `trace file read failed`，不 echo fs 细节）；`isSessionStoreError` 守卫语义不变（Error 实例排除逻辑本来就正确），仅注释更新。standalone mode 保留自己的 sendError。
- **D1.4 拆反向依赖**：`createTraceRouter` 工厂注入 `version: string`（caller 从 `cli/usage.ts getVersion()` 取——`session-api/http.ts` 已有该 import 先例）；traceserver 删除对 `../cli/usage.js` 的 import。
- **D1.5 工厂签名**：`createTraceRouter(opts: { traceDir?, maxBytes?, version }) → (req, res) => Promise<boolean>`（`true` = 已处理；`false` = 非 trace 路由，caller 继续）。`startTraceServe` 保留为薄壳（内部组 factory + health + static），`--separate` 继续用。
- **D1.6 前端 API base**：`web/src/api/client.ts` `getTraceSessions()` 改走 `${TRACE_API}/sessions`（即 `/api/v1/traces/sessions`）；`TRACE_API` 默认 `/api/v1/traces` 不变，`VITE_TRACE_API_BASE` 覆盖语义不变。
- **D2.1 `iknow trace` 默认行为**：不起进程——探测 `http://<host>:<port>/api/v1/health`（host/port 用 `--host`/`--port`，默认 127.0.0.1:8787）；成功 → 打印 `http://host:port/trace` + 自动开浏览器（`--no-open` 关闭）+ exit 0；失败 → 打印「未检测到 iknow serve，请先 `iknow serve` 或用 `iknow trace --separate`」+ exit 1。
- **D2.2 `--separate` escape hatch**：保留现行为（独立进程 24881，动态 import `traceserver/serve.js` 保留——chat/ask 启动路径零新增依赖）。
- **D2.3 legacy 检测**：`detectLegacyTrace` fail-fast 保留，且先于探测执行（两种模式都需要迁移后的目录语义）。

Consequences: (1) CHANGELOG Breaking：`iknow trace` 默认行为反转；脚本依赖旧行为者用 `iknow trace --separate`。(2) 慢读缓解依赖 per-query cap（MAX_TRACE_BYTES + result-row cap），极端大 trace 单查询仍可能短暂阻塞 event loop——A-scenario 可接受，B-scenario 由 OTel 路径解决（ADR-0003 排除范围内）。(3) standalone 别名 `/api/v1/sessions` 保留一个版本后删除。(4) `tests/session-api/trace-mount-removed.test.ts`（#183 回归守卫）重命名为 `trace-mounted.test.ts` 并反转断言。(5) 同进程单端口消除双 origin 割裂——chat ↔ trace 页面可普通互链（`/trace?session=<id>` deep-link），trace 数据与 serve 写侧天然同进程（hub 每会话写 `<traceDir>/<convId>.jsonl`，读侧就地可见）。

Evidence: `plans/merge-trace-into-serve.md`（ACR 5 维 PASS：Pass 1 三 yes + Pass 2 两 unclear 维度补 5-boundary-classes 映射与 commit 策略后复审 yes）；issue #492（D1）/ #493（D2）。
