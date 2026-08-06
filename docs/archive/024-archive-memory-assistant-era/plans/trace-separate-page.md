# Plan - Trace 面板独立页面（由 `iknow trace` 进程托管）

## 背景

当前 trace 检测面板与 chat 共用同一个 SPA（`web/src/App.tsx` 的 `Root` + `ViewTabs`，
chat/trace 两个 tab 共用一份 `web/dist` bundle）。用户要求 trace 走**独立页面**，
由 `iknow trace` 进程（24881）自己托管，chat 页面回到 #185 合并时那种"只有对话"的纯净状态。

trace 复用现有 `TracePanel` 组件树，但前后端**分离好**：trace 有自己的 vite entry + 自己的 web 托管。

工作分支：`worktree-trace-separate-page`（已建，相对 master HEAD `5caab0b` 干净）。

## 目标态

```
iknow serve (8787)   ──托管──>  web/dist/index.html  (chat SPA，只有对话)
iknow trace (24881)  ──托管 web + JSON API──>  web/dist/trace.html  (trace 独立页面)

浏览器开 8787  -> 只有 chat
浏览器开 24881 -> 只有 trace 面板
```

两者共享 `web/dist/assets/` 里的 hashed chunk（vite 多 entry 自动 code-split）。

## 步骤（6 步，1 commit = 1 logical task）

### 1. web/src/App.tsx 回退到 chat-only（#185 形状）

目标形状 = `git show d7a867f:web/src/App.tsx`（167 行，无 Root/ViewTabs/TracePanel）。

删除当前 App.tsx 里 trace 专属块：

- `import { TracePanel }` (L9)
- `import { FOCUS_RING }` (L11) — 仅 ViewTabs 用
- `type ViewId` / `VIEW_OPTIONS` (L19-24)
- `App()` 外层 Root 包装注释 + Root/ViewTabs (L26-84)
- 把 `export default function App()` 改回直接 `return <ErrorBoundary><ChatApp/></ErrorBoundary>`

**保留** ChatApp 内部所有非 trace 改动（thinking-settings 透传、handleSend、Composer
thinkingSettings/onThinkingChange、MessageList sending prop）—— 这些是 #185 + follow-up 的，
不是 trace 的。

`handleNewSession`/`handleSelect` 当前是 plain async fn（trace PR 把 useCallback 去掉了）。
两个都行（运行等价），保持现状即可，不必为字节对齐重新包 useCallback。

### 2. 抽取共享静态托管 helper `src/web/serve-static.ts`

从 `src/session-api/http.ts` 抽出（explorer 已定位行号）：

- `MIME` map (L36-44)
- `resolveDefaultWebRoot()` (L47-53)
- `tryServeStatic` 逻辑 (L313-354) + `pipeFile` (L361-370)

新模块导出：

```ts
export function resolveDefaultWebRoot(): string;
export interface ServeStaticOpts {
  res: http.ServerResponse;
  webRoot: string;
  pathname: string;
  fallbackHtml: string; // chat="index.html", trace="trace.html"
}
export function serveStaticRequest(opts: ServeStaticOpts): boolean;
```

路径穿越守卫（resolve 在 webRoot 内）+ SPA fallback（文件不存在回退到 fallbackHtml）+ `/api` 拒绝守卫
**全部保留**。

`src/session-api/http.ts` 改为 import 这个 helper，`tryServeStatic({res,webRoot,pathname})` 调用点
替换为 `serveStaticRequest({res,webRoot,pathname,fallbackHtml:"index.html"})`。**chat 行为零变化**。

### 3. `src/traceserver/serve.ts` 加 web 托管

- `TraceServeOptions` 加 `webRoot?: string`（默认 `resolveDefaultWebRoot()`）
- `handleRequest` 在 404 fallback **之前**加静态分支：
  ```ts
  if (
    method === "GET" &&
    serveStaticRequest({ res, webRoot, pathname, fallbackHtml: "trace.html" })
  )
    return;
  ```
- `/api/v1/health` 和 `/api/v1/traces*` 路由在静态分支**之前**（API 优先，静态兜底）
- `startTraceServe` 把 webRoot 透传给 handleRequest

### 4. Vite 多 entry

新增：

- `web/trace.html`（镜像 `web/index.html`，script src 换成 `/src/trace-main.tsx`，title="iknow trace"）
- `web/src/trace-main.tsx`：
  ```tsx
  import { StrictMode } from "react";
  import { createRoot } from "react-dom/client";
  import { TracePanel } from "./components/TracePanel";
  import "./styles/global.css";
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TracePanel />
    </StrictMode>
  );
  ```

`web/vite.config.ts` 加 `build.rollupOptions.input`（显式声明 index + trace 两个 entry）。
**不加新 npm 依赖**（spec R6 要求）。

### 5. 测试

新增 `tests/traceserver/serve-static.test.ts`，镜像 `tests/session-api/http.test.ts:540-610`：

- GET / -> 返回 trace.html (200, text/html)
- GET /assets/xxx.js -> 200 + 正确 MIME
- GET /../etc/passwd 之类穿越 -> 403
- SPA fallback：不存在的路径 -> trace.html (200)
- /api/v1/health 仍正常（API 优先于静态）
- 无 webRoot 文件时回退行为

更新 `tests/traceserver/serve.test.ts`：webRoot 选项透传 + 默认值。

**不改** session-api 既有测试（refactor 行为保持）；App.tsx 无测试依赖。

### 6. 文档 + CHANGELOG

- `docs/architecture.md` traceserver 行：补"同时托管 trace 检测面板 web SPA"
- `CHANGELOG.md`：Added 段记 "trace 面板独立成 `iknow trace` 托管的页面，从 chat SPA 摘除"
- `specs/iknow-trace-standalone-service.md`：补 R0 注明 web 托管（可选）

## 验证

- `npm run web:typecheck` exit 0
- `npm run web:build` exit 0；`web/dist/` 含 `index.html` + `trace.html` + 共享 `assets/`
- `npm run typecheck`（root tsc）exit 0
- `npm test` 全量绿（VITEST_MAX_FORKS=1）；新增 serve-static 测试通过
- 手动冒烟（可选，有 9router key 时）：
  - `iknow serve --trace-out ./trace.jsonl` (8787) -> 浏览器开 8787 只有 chat，无 trace tab
  - `iknow trace --trace-out ./trace.jsonl` (24881) -> 浏览器开 24881 只有 trace 面板，过滤/行展开正常
- `grep -c 'ViewTabs\|TracePanel' web/dist/assets/index-*.js` 对 chat bundle = 0（trace 不再进 chat bundle）

## 边界 / 不做

- 不动后端 trace 写侧（jsonl.ts / loop-engine.ts / hub.ts）
- 不动 `iknow serve` 的 web 托管行为（chat 路径不变）
- 不加 router 库（spec SC7）
- 不动 session-api 既有的 `/api/v1/traces` 404 行为（拆分 PR 已定）
- 不引入新 npm 依赖

## 文件改动清单

| 文件                                     | 动作                            |
| ---------------------------------------- | ------------------------------- |
| `web/src/App.tsx`                        | 改（删 trace 块，回 chat-only） |
| `src/web/serve-static.ts`                | 新增（共享静态托管 helper）     |
| `src/session-api/http.ts`                | 改（import helper，删内联实现） |
| `src/traceserver/serve.ts`               | 改（加 webRoot + 静态分支）     |
| `web/trace.html`                         | 新增                            |
| `web/src/trace-main.tsx`                 | 新增                            |
| `web/vite.config.ts`                     | 改（rollupOptions.input）       |
| `tests/traceserver/serve-static.test.ts` | 新增                            |
| `tests/traceserver/serve.test.ts`        | 改（webRoot 覆盖）              |
| `docs/architecture.md`                   | 改（traceserver 行）            |
| `CHANGELOG.md`                           | 改（Added 条目）                |
