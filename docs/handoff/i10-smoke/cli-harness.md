# I10 smoke - CLI path to harness

**Result: PASS**

| Field                      | Value                                |
| -------------------------- | ------------------------------------ |
| model                      | m3-combo                             |
| baseUrl host               | localhost:20128                      |
| key_env                    | NINE_ROUTER_KEY                      |
| maxTurns                   | 6                                    |
| durationMs                 | 13657                                |
| ask.stopReason             | completed                            |
| ask.turnCount              | 2                                    |
| ask.jsonKeys               | finalText,stopReason,turnCount,trace |
| chat parsedTurnCount       | 2                                    |
| chat t1.stopReason         | completed                            |
| chat t1.turnCount          | 2                                    |
| chat t1.trace.turns.length | 2                                    |
| chat t1.tools              | echo,get_time                        |
| chat t2.stopReason         | completed                            |
| chat t2.turnCount          | 1                                    |
| chat t2.trace.turns.length | 1                                    |
| chat t2.tools              |                                      |
| chat t2Grew                | true                                 |

| Assertion                                                                                          | Outcome |
| -------------------------------------------------------------------------------------------------- | ------- |
| ask.stopReason === completed                                                                       | PASS    |
| ask.turnCount >= 2                                                                                 | PASS    |
| ask.finalText non-empty & ask JSON has 4 keys (finalText/stopReason/turnCount/trace) + no messages | PASS    |
| chat turn1.stopReason === completed                                                                | PASS    |
| chat turn2 really executed (non-zero trace.turns + non-empty finalText)                            | PASS    |
| tool list (parsed from trace.toolCalls) includes both echo and get_time                            | PASS    |

## Notes

- ask + chat-pipe 6-assertion gate (T6): oneshot + priorMessages continuation driven by real CLI subprocess.
- formatRunJson deliberately omits `messages` (CLI projection SSOT).
- chat turn2 growth proven via trace.turns length and toolCalls — CLI projection has no `messages` field so an earlier messagesLen counter would have been a lie.
