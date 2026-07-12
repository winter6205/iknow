# Changelog

## 0.1.0 (unreleased)

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
