# I4 smoke — embeddings (deterministic agent)

**Result: PASS**

| Check                         | Outcome                              |
| ----------------------------- | ------------------------------------ |
| Multi-turn pipe exit          | 0                                    |
| ≥3 user turns                 | yes (refund / compare / leave)       |
| `/status` seen                | yes (`mode=deterministic … turns=3`) |
| Wall time (pipe)              | ~6.0s                                |
| Governance / snapshot markers | present on answers                   |
| Ask oneshot exit              | 0                                    |
| Ask wall time                 | ~5.5s                                |
| `snapshot_id`                 | present                              |
| `hops_used`                   | 2                                    |
| `governance_status`           | conflict                             |
| `embeddings`                  | true (`--embeddings`)                |

## Notes

- Agent mode stayed `deterministic`; vector retrieve arm enabled via `--embeddings`.
- Key resolved through `IKNOW_EMBEDDING_API_KEY_ENV` (env name only; secret not captured).
- Pipe: turns 1–2 returned KB refund chunks + conflict governance; turn 3 leave-flow returned empty_result / no_hallucination (stale).
- Ask JSON fields verified: `snapshot_id`, `hops_used`, `governance_status` (no secrets in capture).
- Stderr for both runs: empty.
- No fallback/error path observed (embedding API path succeeded end-to-end).

See `docs/handoff/i4-smoke/embeddings.json` for machine-readable result.
