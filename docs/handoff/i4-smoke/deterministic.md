# I4 smoke — deterministic

**Result: PASS**

| Check | Outcome |
|-------|---------|
| Multi-turn pipe exit | 0 |
| ≥3 user turns | yes (refund / compare / leave) |
| `/status` seen | yes (`mode=deterministic … turns=3`) |
| Wall time | ~10.7s |
| Governance / snapshot markers | present on answers |
| Ask oneshot exit | 0 |
| `snapshot_id` | present |
| `hops_used` | 2 |
| `governance_status` | conflict |

## Notes
- Pipe: turns 1–2 returned KB refund chunks + conflict governance; turn 3 leave-flow returned empty_result / no_hallucination (stale).
- Ask JSON fields verified: `snapshot_id`, `hops_used`, `governance_status` (no secrets in capture).
- Stderr for both runs: empty.

See `docs/handoff/i4-smoke/deterministic.json` for machine-readable result.
