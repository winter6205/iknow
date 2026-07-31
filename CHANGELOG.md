# Changelog

## 0.1.0 (unreleased)

### Breaking (internal, pre-release)

- 归档 `src/kb-*` 4-tool 套件（`kb_retrieve` / `kb_verify_citation` / `kb_compile` / `kb_governance`）+ 装配 facade `src/tools/registry.ts` -> `docs/archive/023-retire-kb-tools/`。CLI 产品路径（`buildHarnessEngine`）在 020 切到 harness 后已不再消费 `kb_*`（只跑 `echo` / `get_time` demo 工具），4-tool 套件仅作为 `src/index.ts` 导出 + 4 个 test 文件存活，零生产消费者。连带修剪：`src/index.ts` 删 13 行 export；`src/shared/schema.ts` 删 `Kb*Input/Output` / `Chunk` / `PriorChunk` / `SourceSpan` / `CompiledFact` / `SnapshotPayload` / `RRF_K` 等类型（保留 `CallerRole` / `SessionContext`，CLI slash 仍用）；`src/runtime/create-runtime.ts` 删 embedding/vector-index 路径，简化为 `store + env`；`src/cli/runtime.ts` 的 `RuntimeBundle` 删 `vectorIndex` 字段；删 4 个 test（`verify` / `compile` / `rrf` / `embedding`）。**保留为孤儿待后续清理**：`SessionContext.simulate_governance_timeout` / `--governance-timeout` flag / `prepareRuntime.degrade`（0 消费者）；`--embeddings` flag（runtime 内 no-op）。归档非删除，对齐 021/022 惯例。
- 移除 `src/index.ts` 对旧 `src/agent-loop/` 与 `src/eval/` 的 re-export（13 旧 loop 符号 + 5 EVAL 符号 + `eval/types` type re-export）；包状态 `private: true` + `0.1.0 (unreleased)` 未发布，无外部消费者，仅记录内部 API 变更，审计可追溯。详见 #48（021）Resolution Q3。
- `TurnDto.answer` 从 `IknowAnswer`（G2 envelope）改为 `TurnAnswerDto {finalText, stopReason, turnCount}`（harness RunResult 投影）；G2 envelope 在 Session API wire 退役。详见 #51（022）Resolution Q1。
- `SessionSummary` 移除 `caller_role` 字段；wire 不再接受/返回 caller role（harness 路径退役）。详见 #51（022）Resolution Q2-G4。
- 删除 `POST /api/v1/sessions/:id/commands` slash 端点（404）；slash 命令在 harness 路径退役。详见 #51（022）Resolution Q3。
- 新增 `GET /api/v1/sessions` 列表端点（`{sessions: SessionListEntry[]}`）+ web 会话历史侧栏（`SessionSidebar`）。详见 #51（022）Resolution Q1。
- `src/shared/schema.ts` 删除 `IknowAnswer` + `ToolCallLog` 类型定义；公开面经 `export type *` 不再 export（BREAKING for internal consumers）。详见 #51（022）Resolution Q1。
- 归档 `src/interaction/`（5 文件）→ `docs/archive/022-retire-interaction/` + `src/agent-loop/`（7 文件）→ `docs/archive/022-retire-agent-loop/`；归档非删除，对齐 021 惯例。详见 #51（022）Resolution Q5。
- Session API 路径切到 harness foundation（`src/session-api/` 零 import 旧 loop）；`SessionHub` 直接调用 `run()` + `priorMessages` 续传。详见 #51（022）Resolution Q1-Q5。

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
