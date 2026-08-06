# I4 smoke — llm

**Result: PASS**

| Check                | Outcome           |
| -------------------- | ----------------- |
| Probe chat HTTP      | 200 parse_ok=true |
| Ask exit             | 0                 |
| snapshot_id          | true              |
| hops_used            | 5                 |
| governance_status    | conflict          |
| tool_calls length    | 8                 |
| ask llm_success      | true              |
| pipe exit            | 0                 |
| pipe llm_error_count | 0                 |
| pipe status_seen     | true              |

Key source: 9router DB apiKeys name=iknow (not printed).
Parse: stream:false + SSE trailer strip.
