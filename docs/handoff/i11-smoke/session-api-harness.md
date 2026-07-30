# I11 smoke - session-api harness

**Result: PASS**

| Field                  | Value           |
| ---------------------- | --------------- |
| model                  | m3-combo        |
| baseUrl host           | localhost:20128 |
| key_env                | NINE_ROUTER_KEY |
| maxTurns               | 6               |
| durationMs             | 4706            |
| serve.stopReason       | completed       |
| serve.turnCount        | 2               |
| serve.sessionTurnCount | 2               |
| cancel.stopReason      | cancelled       |
| cancel.exceptionName   | none            |
| timeout.stopReason     | timeout         |
| timeout.exceptionName  | none            |

| Assertion                                             | Outcome |
| ----------------------------------------------------- | ------- |
| serve stopReason === completed                        | PASS    |
| serve turnCount >= 2 (multi-step)                     | PASS    |
| serve multi-step (sessionTurnCount accumulation >= 2) | PASS    |
| serve finalText non-empty                             | PASS    |
| cancelled stopReason === cancelled                    | PASS    |
| timeout stopReason === timeout                        | PASS    |

## Notes

- 6-assertion gate (SC4) over serve path + hub-level cancelled/timeout.
- serve path: startSessionServe → POST /sessions → POST /sessions/:id/messages (real model).
- cancelled/timeout: SessionHub + injected deps with never-resolving adapter (HTTP layer does not expose signal/signal-typed timeout, so hub-level is the only seam).
