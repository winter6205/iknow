# Changelog

## 0.1.0 (unreleased)

### Feature

- **Identity assembly (#196)**: 在 `deps.system` 注入缝上装配身份层 — `identity` (Name/Kind/Signature) + `soul` (core truths/boundaries/vibe/continuity) + `~/.iknow/user.md` 用户画像 + 首启 `BOOTSTRAP` 引导。所有 iknow 入口 (chat / tui / ask / serve) 走同一装配层。`state.json` 持久化 `bootstrap_seeded`,二次启动跳过 BOOTSTRAP 段。`initializeIknowWorkspace()` eager + idempotent,在 `build-engine.ts` 与 4 入口(chat / serve / tui / ask)各调一次,失败降级 warn 不阻塞装配。

### Breaking (internal, pre-release)

- `iknow serve` 不再托管 `/api/v1/traces` 读 API；检测面板改由独立 `iknow trace` 子命令进程提供（默认端口 24881；`iknow trace --trace-out <path>` 读 `serve --trace-out <path>` 写入的同一 JSONL）。`--trace-out` 在 `serve` / `chat` / `ask` 上的写语义未变（仍由 hub 写埋点落到 JSONL）。详见 #183。
- `src/session-api/http.ts` 移除 `handleTracesRequest` import + `/api/v1/traces` prefix-dispatch + `SessionHttpServerOptions.traceFilePath`；`SessionHttpServerOptions` 仅保留 `hub` / `webRoot` / `host` / `port`。`src/session-api/serve.ts` 不再将 `traceOut` 转发到 session server，但 `serve` 仍 `accept --trace-out` 用于写侧。web 端：`getTraces` / `getTraceFields` 走 `TRACE_API = import.meta.env.VITE_TRACE_API_BASE ?? "/api/v1/traces"`；其余 session API 端点仍 `/api/v1`。Vite dev proxy 新增 `/api/v1/traces` → `http://127.0.0.1:24881`（`IKNOW_DEV_TRACE_API` 可覆盖）。`TraceReadError` 包裹不带 fs 细节，仍 500 internal。

- `getApiKey` / `assertOfflineCompatible`（`src/config/env.ts`，经 `src/index.ts` re-export）改签名为单 `opts` 参数（`{ envVarName, fileMap? }` / `{ env, agentMode? }`）；随 024 全仓库位置参数 → options object 重构，全仓库 ≥2 位置参数函数统一改为 opts 形态（41 文件，纯重构行为零变更；014/015/016/017 冻结契约 step/run/LoopAdapter/Executor.executeAll/Registry/TurnTrace 与 Error 构造器均不动）。包状态 `private: true` + `0.1.0 (unreleased)` 未发布，无外部消费者，仅记录内部 API 变更，审计可追溯。详见 #97（024）。
- 归档 `src/kb-*` 4-tool 套件（`kb_retrieve` / `kb_verify_citation` / `kb_compile` / `kb_governance`）+ 装配 facade `src/tools/registry.ts` -> `docs/archive/023-retire-kb-tools/`。CLI 产品路径（`buildHarnessEngine`）在 020 切到 harness 后已不再消费 `kb_*`（只跑 `echo` / `get_time` demo 工具），4-tool 套件仅作为 `src/index.ts` 导出 + 4 个 test 文件存活，零生产消费者。连带修剪：`src/index.ts` 删 13 行 export；`src/shared/schema.ts` 删 `Kb*Input/Output` / `Chunk` / `PriorChunk` / `SourceSpan` / `CompiledFact` / `SnapshotPayload` / `RRF_K` 等类型（保留 `CallerRole` / `SessionContext`，CLI slash 仍用）；`src/runtime/create-runtime.ts` 删 embedding/vector-index 路径，简化为 `store + env`；`src/cli/runtime.ts` 的 `RuntimeBundle` 删 `vectorIndex` 字段；删 4 个 test（`verify` / `compile` / `rrf` / `embedding`）。**保留为孤儿待后续清理**：`SessionContext.simulate_governance_timeout` / `--governance-timeout` flag / `prepareRuntime.degrade`（0 消费者）；`--embeddings` flag（runtime 内 no-op）。归档非删除，对齐 021/022 惯例。
- 移除 `src/index.ts` 对旧 `src/agent-loop/` 与 `src/eval/` 的 re-export（13 旧 loop 符号 + 5 EVAL 符号 + `eval/types` type re-export）；包状态 `private: true` + `0.1.0 (unreleased)` 未发布，无外部消费者，仅记录内部 API 变更，审计可追溯。详见 #48（021）Resolution Q3。
- `TurnDto.answer` 从 `IknowAnswer`（G2 envelope）改为 `TurnAnswerDto {finalText, stopReason, turnCount}`（harness RunResult 投影）；G2 envelope 在 Session API wire 退役。详见 #51（022）Resolution Q1。
- `SessionSummary` 移除 `caller_role` 字段；wire 不再接受/返回 caller role（harness 路径退役）。详见 #51（022）Resolution Q2-G4。
- 删除 `POST /api/v1/sessions/:id/commands` slash 端点（404）；slash 命令在 harness 路径退役。详见 #51（022）Resolution Q3。
- 新增 `GET /api/v1/sessions` 列表端点（`{sessions: SessionListEntry[]}`）+ web 会话历史侧栏（`SessionSidebar`）。详见 #51（022）Resolution Q1。
- `src/shared/schema.ts` 删除 `IknowAnswer` + `ToolCallLog` 类型定义；公开面经 `export type *` 不再 export（BREAKING for internal consumers）。详见 #51（022）Resolution Q1。
- 归档 `src/interaction/`（5 文件）→ `docs/archive/022-retire-interaction/` + `src/agent-loop/`（7 文件）→ `docs/archive/022-retire-agent-loop/`；归档非删除，对齐 021 惯例。详见 #51（022）Resolution Q5。
- Session API 路径切到 harness foundation（`src/session-api/` 零 import 旧 loop）；`SessionHub` 直接调用 `run()` + `priorMessages` 续传。详见 #51（022）Resolution Q1-Q5。

### Added

- Trace inspection panel：新增 `src/traceserver/`（read-only）：同步 JSONL reader（`MAX_TRACE_BYTES = 8 MiB` + 行边界截断 + `TraceReadError` 包裹 fs 错误）+ `GET /api/v1/traces`（filter：conversation_id / record_type / status；pagination：limit 1..200 / offset ≥ 0；坏行计入 `skipped_lines`；snake_case wire）+ `GET /api/v1/traces/fields`（字段声明表 `TRACE_FIELD_DEFS` SSOT，加载时自检 key 唯一性，违则 throw）；`SessionHttpServerOptions.traceFilePath` 接线（`serve --trace-out` 经 `path.resolve` 相对 CWD，对齐 ADR-0003 D3）；未配置 traceFilePath → 404 `not_found`、`TraceReadError` → 500 `internal`、参数非法 → 400 `validation`（含 `field`）。前端：web `TracePanel` 容器 + `TraceStatsBar` / `TraceFilterBar` / `TraceTable` / `TraceExpandedRow` 子组件；`App.tsx` 顶层 view 切换 `对话` / `Trace 面板`，chat view 始终挂载（`useSessionChat` 状态不丢），TracePanel 卸载/挂载可重新拉数；字段列选择 / datetime 格式化 / cell tone 抽到 `web/src/components/traceFields.ts` 供单测。**新增 trace 字段 = `src/harness/trace/types.ts` 加类型 + `TRACE_FIELD_DEFS` 加一行，面板自动生效**；写侧（`src/harness/trace/jsonl.ts` / `loop-engine.ts` / `hub.ts.recordViolationTrace`）未触碰，验证：33 单测 + 集成全绿。

- Trace 检测面板独立成由 `iknow trace` 进程托管的页面（trace.html），从 chat SPA 摘除；chat 页面回归纯对话形态。共享 vite 多 entry + 共享 `web/dist/assets/` chunk；trace 进程经 `src/web/serve-static.ts` 复用 chat 的静态托管 helper，落地 `/` → trace.html、SPA fallback、路径穿越 403、`/api` 拒绝守卫四件套；`/api/v1/*` 路由优先于静态（health 不会被 trace.html 遮蔽）。`web/src/App.tsx` 删 `Root` / `ViewTabs` / `TracePanel` 装配块，回到 chat-only 形态。详见 `plans/trace-separate-page.md`。

- ACI Web 类工具 `web_fetch` / `web_search`（`src/harness/aci/tools/web-fetch.ts` / `web-search.ts`，行为真值 upstream-openharness `web_fetch_tool.py` / `web_search_tool.py`）+ 共享 SSRF 出口层 `network-guard.ts`（URL 语法 / 嵌入凭据 / 非公网 IP 字面量与 DNS 结果 / 本地主机名 / 单标签 / ≤5 跳重定向逐跳重验 / 非 2xx 拒绝；fetch + DNS 解析 deps 注入，测试全离线；生产默认出口 `createDefaultGuardDeps` SSOT）+ 共享原语 `html-text.ts`（HTML→文本 / 实体解码）与 `ip-classify.ts`（IPv4/IPv6 非公网分类）。两工具 `aci` 元数据：`category=read-only`（权限默认 allow）/ `isConcurrencySafe=true` / `interruptBehavior=cancel` / `timeoutTier=default`（30s）。`web_fetch` 输出含 `UNTRUSTED_BANNER` 防 prompt injection 横幅 + HTML→文本提取（跳过 script/style + 实体解码 + 收边 trim + 段落换行 `\n` 保留以对齐 upstream HTMLParser 状态机可读性）+ `max_chars` 截断（默认 12000，运行时 clamp 500..50000）；`web_search` 默认 DuckDuckGo html 端点（`search_url` 入参或 `IKNOW_WEB_SEARCH_URL` 可覆写，覆写同受 SSRF 校验；env 读取经 `loadIknowEnv` SSOT——`IknowEnv.web.searchUrl`，工具不直读 process.env），`max_results` 默认 5（1..10），`/l/?uddg=` 重定向链接归一。`buildHarnessEngine` 装配 append-only 6 → 8 工具（既有顺序不动，policy byName 键空间稳定）。生产默认出口 UA 改为浏览器伪装串 `DEFAULT_USER_AGENT`（network-guard.ts SSOT；Mozilla/Chrome/AppleWebKit + `iknow/0.1` 后缀）——对齐 upstream `Mozilla/... OpenHarness/0.1.7` 风格，应对 Cloudflare 等反爬 UA 过滤（实测：旧产品 UA 被 Ars Technica 返 202 challenge；新 UA 使 TechCrunch 完整通过 200 + 301KB + 191 链接）。测试：web 工具 3 文件 66 例 + env 3 例 + html-text 38 例 + UA 默认值 3 例，共新增 110 例（正常 / 失败 / 边界 / 权限 / 空输入 / 并发扇出 / pathological HTML 6 类）。code-review 双轴审查：Standards 0 High（4 Medium 全整改：decodeEntities/defaultLookup 去重抽共享层、fetchPublicResponse 拆 followGuardedRedirects ≤30 行、env.ts SSOT 接线、clamp 运行时测试补齐）。

### Changed

- #120 会话持久化：会话池根从 `<cwd>/data` 迁至 `~/.iknow`，项目命名空间采用 `<basename>-<sha1(cwd)[:12]>`（`resolveProjectSessionDir`）；`serve --data-dir` 覆盖保留，旧 `<cwd>/data` 不读、不迁移、不删除。`SessionFileV1` schema 升级为 v2，新增顶层 `summary` / `cwd` / `sanitized_at`；`sanitizeSessionFile` 前向兼容 v1（读取时补齐并零写盘），拒绝 `schemaVersion > 2` 及形状错误的 `messages`，不做修复。`SessionStore.list()` 条目新增 `summary`，既有 `conversation_id` / `updatedAt` / `lastFinalText` 保持不变；CLI `CliChatState.messages` 改为 `ReadonlyArray` + `Object.freeze`（#120 Q3）。详见 `specs/120-session-persistence.md`。

- 抽取共享静态托管 helper `src/web/serve-static.ts`（`resolveDefaultWebRoot` + `serveStaticRequest({res, webRoot, pathname, fallbackHtml})`），从 `src/session-api/http.ts` 抽出 `MIME` / `resolveDefaultWebRoot` / `tryServeStatic` + `pipeFile`。`/api` 拒绝守卫 + 路径穿越 403 + SPA fallback 三件套行为不变；`src/session-api/http.ts` 改为 import helper（chat 行为零变化），trace 进程复用同一 helper（fallbackHtml `"trace.html"`）。纯重构，行为字节对齐。

### Web thinking/tool/markdown 显示（wire 加法式扩展）

- **session-api wire 加法式扩展**：`TurnAnswerDto` 新增可选 `thinking`（entries 文本列表 + `redactedCount` 计数）与 `toolCalls`（name / inputPreview / outputPreview / isError / truncated）投影；新模块 `src/session-api/turn-projection.ts`（纯函数）：thinking 每条目截断 `MAX_THINKING_TEXT_CHARS=2000`，tool input 预览截断 `MAX_TOOL_INPUT_PREVIEW_CHARS=500`、output 预览截断 `MAX_TOOL_OUTPUT_PREVIEW_CHARS=1500`，全部先经 `createOutputMask` mask 再截断（SC20 输出边界，与 finalText mask 一致）；`redacted_thinking.data` / `thinking.signature` 永不上 wire（replay 材料，仅计数）。postMessage 与历史回放（GET session）共用同一投影。
- **每请求 thinking 覆盖**：`PostMessageRequest` 新增可选 `thinking: { mode: "off" | "adaptive", effort?: "" | low | medium | high | xhigh | max }`；新模块 `src/session-api/thinking-override.ts`：wire 解析 + 值域校验（非法 → `ValidationError` → 400 嵌套 envelope，不静默回退）+ 按回合一次性 adapter 重建（仅替换 adapter，executor/registry/maxTurns/timeoutMs 复用缓存 deps）。无覆盖请求行为与既有 wire 字节一致；env `IKNOW_LLM_THINKING` / `IKNOW_LLM_THINKING_EFFORT` 仍为默认 SSOT。
- **web 显示**：markdown 渲染（react-markdown + remark-gfm + rehype-highlight；`MarkdownBody` + `CodeBlock` 语言标签 + 复制按钮）；`ThinkingBlock` 思考内容默认折叠（aria-expanded），redacted 仅渲染 `[已加密思考]` 计数占位；`ToolCallList` 工具调用卡片（单展开 + 截断标记「已截断」）；`ThinkingControls` 思考开关 + 强度分段选择（localStorage `iknow:thinking` 持久化，`toWireOverride` 随每次 postMessage 下发）。
- **web 已有功能完善**：非 completed stopReason 停止原因提示 + turnCount「N 轮」元信息（`StopNotice`；文案映射纯函数 `web/src/lib/stop-reason.ts`，completed / 未知值不显示）。
- 测试：`tests/session-api/turn-projection.test.ts` / `thinking-override.test.ts` + hub/http 扩展；`tests/web/thinking-settings.test.ts` / `tests/web/stop-reason.test.ts`（根 vitest；web 包禁测试框架的 spec 约束不变）。
- **不变 / 不声明**：SSE `/events` 仍 **501**（non-goal 不变）；G2 evidence 未回 wire（spec 022 退役，独立票）；`ask` JSON 通道与 CLI 投影零变化；harness 零 diff。决策补录：`docs/design/frontend-stack-upgrade-v1.md` §0.1；计划与 ACR 门禁：`plans/web-thinking-tool-display.md`。

### Docs (CLAUDE.md + architecture.md 整理)

- CLAUDE.md 删除 `### Runtime map` 14 行 path 表（~80% 与 `docs/architecture.md` Capability modules 表重复，且漏 `src/harness/` 等新模块），替换为 5 行 `### Module boundaries`（仅保留非显而易见边界 callouts），并指向 architecture.md 为 SSOT
- `docs/architecture.md` Capability modules 表补 `src/harness/`（Foundation，标注暂不接产品流量）/ `src/runtime/` / `src/tools/` / `src/config/` / `src/eval/`，并标 `src/agent-loop/` 待退役（016->018 路线）
- CLAUDE.md 删除「下阶段焦点」行（动态路线信息归 `docs/STATUS.md`，避免 always-on 层持有易腐数据）
- CLAUDE.md 上下文读取顺序：删除两个死引用（`docs/git-workflow.md` / `docs/testing.md` 不存在），加 codebase-memory 定位提示
- CLAUDE.md Domain docs 补 `specs/minimum-sequential-agent-loop.md` + `plans/minimum-sequential-agent-loop.md`；修正 `CHANGELOG.md` 路径为根目录（原 `docs/CHANGELOG.md` 不存在）
- CLAUDE.md `npm test` 注释更新：vitest 入口，含 `tests/harness/**`
- CLAUDE.md「I4」行去掉展望尾巴（I5 退到 STATUS 展望）

### Web MVP prototype → CLI integration (iknow-prototype)

- Prototype `/api/chat` **mock removed**; frontend now consumes the real **Session HTTP API** (`iknow serve`)
- New Session API client with typed DTOs + error envelope + graceful degrade (`src/lib/iknow-api.ts`)
- Non-streaming chat hook (v0 API returns one full **G2** `IknowAnswer` per turn): lazy session, host-side fake typewriter, abort/reset/commands (`src/hooks/use-iknow-chat.ts`); shared via `chat-provider.tsx`
- **G2 machine panel** (`src/components/answer-meta.tsx`): governance-status badge, `snapshot_id`, tool-call trajectory, cited `source_spans`, hops, notes — replaces the demo weather card
- Caller role (`employee|manager|admin`) + mode (`deterministic|llm`) wired to `…/commands` on the live session (`ui-store.ts`, `sidebar.tsx`)
- Same-origin proxy `/api/v1/*` → `IKNOW_API_PROXY_TARGET` (default `127.0.0.1:8787`); or set `NEXT_PUBLIC_IKNOW_API_BASE` to call a backend directly (CORS-free static-export path)
- Removed `ai` / `@ai-sdk/react` / `zod` deps + `serverExternalPackages` workaround (were mock-only)
- E2E rewritten against real `iknow serve` (Playwright dual `webServer`): 6 specs green — G2 envelope (governance=conflict), snapshot, source/tool spans, role switch, new-session reset, sidebar
- Verified: `typecheck` / `biome check` / `next build` (2 static routes) / `test:e2e` green
- **Decision (proposed, needs ratification):** product UI stack A (prototype → Next static export, `iknow serve`-hosted) vs B (port look/components back to Vite `web/`) — recommend **A**, flags conflict with `frontend-stack-upgrade-v1`: `docs/design/prototype-cli-integration-and-ui-stack-decision-v0.md`

### Web MVP prototype (iknow-prototype, standalone)

- New **`iknow-prototype/`**: Next.js 15.5 + React 19 App Router MVP, TypeScript strict
- Stack: Vercel AI SDK (`@ai-sdk/react` `useChat`, streaming + tool-call render), Tailwind 3.4 + shadcn-style `Button`, Zustand (UI state) + TanStack Query (history), Framer Motion, Lucide, react-markdown + rehype-highlight (code copy)
- Design: light/white base, <=5-color palette, non-AI aesthetic, no emoji
- Backend is a **key-free mock**: `MockLanguageModelV1` streams a deterministic answer + a `getWeather` tool call (`src/lib/mock-model.ts`); no real LLM/auth
- E2E: Playwright 6 specs (empty state, streaming+copy, weather tool card, suggestions, sidebar toggle, role switch); uses installed Chrome (`channel: chrome`)
- Verified: `typecheck` / `biome check` / `next build` / `test:e2e` all green
- Branch `feat/web-mvp-prototype` (not pushed); commits `66208c4`→`58af68a`
- **Unchanged / not claimed:** existing `web/` SPA, Session API contract, 4 tool protocol; prototype not yet wired to the CLI backend
- Handoff + next task (原型接入 CLI): `docs/handoff/2026-07-21-web-mvp-prototype.md`

### I4 smoke + LLM client resilience

- Full I4 interaction smoke: deterministic / embeddings / llm CLI + Session HTTP (`docs/handoff/i4-smoke/`)
- LLM client: force `stream: false`; `parseLlmResponseJson` tolerates SSE `data: [DONE]` trailers
- Tests: `tests/llm-client-parse.test.ts`
- Note: env name is `NINE_ROUTER_API_KEY`; some agent shells saw `models` 200 but chat/embeddings 401 on the same value (endpoint auth / env inheritance)
- Session closeout: CONTEXT / Claude.md runtime map / `docs/handoff/2026-07-13-session-closeout.md`

### Frontend stack upgrade (Vite + React + TS)

- Product UI package under **`web/`**: Vite 6 + React 19 + TypeScript SPA (`iknow-web`)
- Build output **`web/dist`**; `iknow serve` prefers dist (fallback to `web/` when absent)
- Design language: forest cockpit tokens (`web/src/styles/tokens.css`); API client mirrors Session API DTOs
- Dev: `npm run dev --prefix web` (proxy `/api` → `:8787`); prod: `npm run build --prefix web` then `npm run serve`
- Decision record: `docs/design/frontend-stack-upgrade-v1.md` · plan: `plans/frontend-stack-upgrade.md`
- **Unchanged / not claimed:** Session API contract; SSE still **501**; no production auth

### Session HTTP API + Web UI (host interaction)

- **`iknow serve`**: in-process Session API (`src/session-api/`) + SPA static host (`web/dist` preferred)
- Routes: `GET /api/v1/health`, `POST/GET /api/v1/sessions`, `…/messages`, `…/commands`, `…/reset`
- Every message returns full **G2** `IknowAnswer`; human projection optional
- Reserved: `GET …/sessions/:id/events` → **501** (SSE future)
- Contract: `docs/design/session-http-api-v0.md` · plan: `plans/web-interaction-session-api.md`
- Tests: `tests/session-api.test.ts` (hub + HTTP + static index)

### Product CLI chat (host interaction)

- **TTY REPL** + **pipe-aware** serial turns (`src/cli/chat-session.ts`)
- Session: `ConversationState`, `prior_chunks` bridge, slash `/status` `/mode` `/role` …
- Human view default in chat; `ask` / oneshot remain G2 JSON for scripts
- Explicit `--mode` wins over `IKNOW_AGENT_MODE`; empty ask → usage (no demo query)
- SIGINT: first warns, second exits immediately (`process.exit(130)`)
- Commits of note: `ffc475e` (CLI polish), `f431436` (ffc475e review SIGINT/chain)

### M1 / M2 model wiring

- Embedding vector arm (OpenAI-compatible) + optional LLM tool agent
- Fail-closed offline/key/protocol checks; deterministic remains CI default

### Trajectory eval harness (ADLC Phase 4 / P3 closeout)

- **`npm run eval`**: full 32-sample trajectory suite (`src/eval/*`)
- Structured `tool_calls` on every answer (trajectory-eval-spec §1.2)
- Hard gates: G2 / hops / edge policies; Sprint-1 soft target mean trajectory ≥0.6
- Results artifact path gitignored: `docs/iknow-spec/docs/eval/results/`

### P3 scaffold

Standalone enterprise KB agent (no gbrain runtime dependency):

- **4 tools**: `kb_retrieve`, `kb_verify_citation`, `kb_compile`, `kb_governance`
- **Agent loop**: hop-bounded loop (`max_hops`) with G2 response envelope
- **Knowledge store**: in-memory store (fixture seed for demos/eval)
- **Capability layout**: `src/kb-retrieve/`, `src/kb-verify/`, `src/kb-compile/`, `src/kb-governance/`, `src/agent-loop/`, `src/knowledge-store/`
- **Tests**: `npm test` — unit + eval-set + trajectory
- **Upstream**: `_upstream_gbrain/` gitignored READ-ONLY reference only — runtime has zero link to gbrain

### Initial scaffold

Bootstrap scaffold from project template.

- `bash scripts/bootstrap.sh` — 6-step idempotent setup
- `bash .evals/run.sh` — default = tier=fast baseline
- tier-grouped eval framework: fast/medium/slow, parallel within tier
- 3-layer memory model: CLAUDE.md / auto memory / `docs/`

### Review hardening (trajectory OCR + staged reviews)

- Shared `src/eval/lexicon.ts` + policy-string scorer (`policy-checks.ts`)
- Data-driven `session_overrides` on eval samples; resilient suite runner
- `ToolCallLog.ordinal`; `release_gates`; draft eval-set warn
- Store/compile/loop root-cause fixes from prior staged review

### Ops

- Remote: private `https://github.com/winter6205/iknow` (`master` tracking `origin/master`)

### Next

- Web/TTY interaction polish; optional session export; SSE streaming behind reserved path
- Ratify `docs/iknow-spec/docs/protocol/ADR-v0.1-assumptions-p3.md`
- Replace draft eval samples with real queries; calibrate soft gates
- Persist sessions + KB / observability / deploy (P4)
