# I408 smoke - session goal (real LLM)

**Result: PASS**

| Field        | Value                 |
| ------------ | --------------------- |
| model        | ocg/deepseek-v4-flash |
| baseUrl host | 172.31.128.1:20128    |
| key_source   | settings.llm.apiKey   |
| maxTurns     | 5                     |
| durationMs   | 5705                  |

## A: T2 + T4 + T5 (real LLM + real runVerifyLoop)

stopReason=completed llmCalls=2 goal.status=achieved goal.source=user_initial

| Assertion                                                                                                                                                                                                                        | Outcome |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| turn1 stopReason === completed _(detail: actual=completed)_                                                                                                                                                                      | PASS    |
| T2 seed: turn1 后 store.goal.text === goalText _(detail: actual="Please reply with exactly the word ACK (goal-text-164f92)")_                                                                                                    | PASS    |
| T2 seed: source === 'user_initial' _(detail: actual=user_initial)_                                                                                                                                                               | PASS    |
| T5 write-back: turn1 后 store.goal.status === 'achieved' _(detail: actual=achieved)_                                                                                                                                             | PASS    |
| turn2 stopReason === completed _(detail: actual=completed)_                                                                                                                                                                      | PASS    |
| T4 seam (real trace): turn2 末位 user message === goalText (非 query) _(detail: userTexts=["Please reply with exactly the word ACK (", "Please reply with exactly the word ACK (", "Please reply with exactly the word ACK ("])_ | PASS    |
| T5 write-back: turn2 后 store.goal.status 保持 'achieved' _(detail: actual=achieved)_                                                                                                                                            | PASS    |
| trace 含 record_type 'verification' (真 runVerifyLoop 跑过) _(detail: verification_records=2)_                                                                                                                                   | PASS    |

User-text messages in trace:

1. "Please reply with exactly the word ACK (goal-text-164f92)"
2. "Please reply with exactly the word ACK (goal-text-164f92)"
3. "Please reply with exactly the word ACK (goal-text-164f92)"

## B: T3 re-pin via ## GOAL: (real LLM + real runVerifyLoop)

stopReason=completed llmCalls=2 goal.status=achieved goal.source=user_pin

| Assertion                                                                                                                                  | Outcome |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| turnB stopReason === completed _(detail: actual=completed)_                                                                                | PASS    |
| T3 re-pin: store.goal.text === newGoalText _(detail: actual="Reply with exactly the word REPIN-78cbfb")_                                   | PASS    |
| T3 re-pin: source === 'user_pin' _(detail: actual=user_pin)_                                                                               | PASS    |
| T3 re-pin: history[0].text === prior goalText (section A 的) _(detail: prior="Please reply with exactly the word ACK (goal-text-164f92)")_ | PASS    |
| T3 re-pin: history[0].status === 'superseded' _(detail: actual=superseded)_                                                                | PASS    |
| T5 write-back: re-pin 后 status === 'achieved' _(detail: actual=achieved)_                                                                 | PASS    |

User-text messages in trace:

1. "Please reply with exactly the word ACK (goal-text-164f92)"
2. "Please reply with exactly the word ACK (goal-text-164f92)"
3. "Please reply with exactly the word ACK (goal-text-164f92)"

## Notes

- Real e2e for #408 (Session-level Goal for Verify-Loop Task Field).
- Observation channel: JSONL trace llm_call.messages (model's actual view) + SessionStore (goal persistence).
- Workspace: dataDir=/tmp/i408-data-ucfwzH, traceDir=/tmp/i408-trace-SCU2rw, traceFile=/tmp/i408-trace-SCU2rw/4b3472f1-b2c7-4665-90c5-af3d9ce0447e.jsonl
- verify.command = `true` → runVerifyLoop exits 0 on round 1 → outcome 'passed' → T5 write-back fires.
