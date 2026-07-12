# Changelog

## 0.1.0 (unreleased)

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

### Next

- Ratify open P3 assumptions in `docs/iknow-spec/docs/protocol/ADR-v0.1-assumptions-p3.md`
- Swap in-memory store for durable backend when needed
- Expand medium/slow eval tasks as product grows
