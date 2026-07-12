# Changelog

## 0.1.0 (unreleased)

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

- **Interaction polish** (next stage): multi-turn UX quality, TTY smoke checklist, optional session export
- Ratify `docs/iknow-spec/docs/protocol/ADR-v0.1-assumptions-p3.md`
- Replace draft eval samples with real queries; calibrate soft gates
- Persist KB / observability / deploy (P4)
