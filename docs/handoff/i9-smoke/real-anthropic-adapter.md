# I9 smoke - real anthropic adapter

**Result: PASS**

| Field        | Value                |
| ------------ | -------------------- |
| model        | deepseek-flash-combo |
| baseUrl host | undefined            |
| key_env      | NINE_ROUTER_API_KEY  |
| turns        | 2                    |
| stopReason   | completed            |
| toolNames    | echo,get_time        |
| durationMs   | 9777                 |

| Assertion                       | Outcome |
| ------------------------------- | ------- |
| stopReason === completed        | PASS    |
| turnCount >= 2                  | PASS    |
| trace.turns.length >= 2         | PASS    |
| >=1 toolCalls[].kind === ok     | PASS    |
| finalText non-empty             | PASS    |
| echo called >=1                 | PASS    |
| get_time called >=1             | PASS    |
| every turn supplierStop defined | PASS    |

## Notes

- adapter=createRealAnthropicAdapter (SDK client.messages.create, stream:false).
- 7-assertion gate (Q5.2) over real multi-step loop.
