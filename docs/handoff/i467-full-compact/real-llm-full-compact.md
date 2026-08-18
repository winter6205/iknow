# I467 smoke — real LLM full-compact

**Result: PASS**

| Field | Value |
|-------|-------|
| model | minimax-cn/MiniMax-M3 |
| baseUrl host | 172.31.128.1:20128 |
| stream | on |
| thinking | adaptive |
| maxOutputTokens | 8192 |
| timeout policy | no-default-client-side-timeout (Claude Code semantics) |

## Phase A — functional

| Field | Value |
|-------|-------|
| outcome | summarized |
| latencyMs | 13549 |
| summaryLen | 4537 |
| outputTokens | 2278 |
## Phase B — long-context latency stress

| Field | Value |
|-------|-------|
| outcome | summarized |
| latencyMs | 17398 |
| dropped count / chars | 74 / 27292 |
| summaryLen | 5364 |

## Phase C — real SDK abort path

| Field | Value |
|-------|-------|
| outcome | timeout |
| wallClockMs | 104 |

### Phase A assertions

| Assertion | Outcome |
|-----------|---------|
| outcome.kind === summarized | PASS |
| summary length >= 200 (non-trivial) | PASS |
| contains 'Primary Request' (9-section) | PASS |
| preserves a seed fact (lexer/#459/ZWJ) | PASS |
| no <analysis> tag leaked | PASS |
| buildCompactedMessages shape ok | PASS |
| usage.outputTokens > 0 | PASS |

### Phase B assertions

| Assertion | Outcome |
|-----------|---------|
| outcome.kind === summarized (long-context 在 SDK 默认 HTTP 超时内完成) | PASS |

### Phase C assertions

| Assertion | Outcome |
|-----------|---------|
| outcome.kind === timeout (real SDK aborted) | PASS |
| wall clock < 1000ms (signal aborted HTTP, not just setTimeout race) | PASS |
