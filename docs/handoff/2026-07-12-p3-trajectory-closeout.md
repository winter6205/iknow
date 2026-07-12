# Handoff — 2026-07-12 · P3 closeout + trajectory eval

## Session outcomes

- Standalone **iknow** runtime (no gbrain link) with 4 tools + deterministic agent loop
- Trajectory suite: `npm run eval` (32 samples)
- Review root-cause fixes (staged + OCR live-review)
- Pushed to private GitHub: `https://github.com/winter6205/iknow` @ `master`

## Verification (evidence)

```text
npm test  → 66/66 pass
npm run eval:
  hard_pass_rate: 1.0
  mean_trajectory_score: ≈0.831
  release_gates: hard_pass_rate_ok + mean_trajectory_ok
  violations: []
git: origin/master tracking; tip includes 850e7a6 (+ earlier P3 commits)
```

## Key paths

| Area | Path |
|------|------|
| Agent | `src/agent-loop/loop.ts`, `trace.ts` |
| Tools | `src/kb-retrieve/`, `kb-verify/`, `kb-compile/`, `kb-governance/` |
| Eval | `src/eval/*`, `npm run eval` |
| Spec | `docs/iknow-spec/` |
| Domain language | `docs/CONTEXT.md` |
| Next materials | `docs/integration-materials.env.example` |

## Decisions in force

- Runtime rewrite at repo root named **iknow**; `_upstream_gbrain/` read-only gitignored
- G2 requires `snapshot_id`; hops ≤5 count only retrieve+verify
- Eval notes/scorer share `src/eval/lexicon.ts`
- Deterministic loop is CI baseline; real LLM/vectors are **next** (M1→M2)

## Open / next

1. User fills `docs/integration-materials.env.example` placeholders (env **names** + chosen providers)
2. M1 embedding arm → M2 LLM agent mode
3. Real query log replace draft eval set; soft-gate calibration
4. P4 engineering (auth prod, async jobs, observability, deploy)

## Do not

- Import or link `_upstream_gbrain` at runtime
- Commit API keys / tokens / passwords (env vars only)
- Drop deterministic mode when adding LLM (keep as default for `npm test` / CI)
