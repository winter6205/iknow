# Changelog

## 0.1.0 (unreleased) — initial scaffold

Bootstrap scaffold from project template. No business code yet.
Baseline: `bash .evals/run.sh` 5/5 fast pass.

### Scaffold verified

- `bash scripts/bootstrap.sh` — 6-step idempotent setup ✓
- `bash .evals/run.sh` — default = tier=fast 5/5 passed in ~9s
- tier-grouped eval framework: fast/medium/slow, parallel within tier
- 3-layer memory model: CLAUDE.md / auto memory / `docs/`

### Next

- Add project-specific CONTEXT.md terms (replace template examples)
- Add medium/slow eval tasks as project grows
- First session handoff in `docs/handoff/<date>-<topic>.md`
