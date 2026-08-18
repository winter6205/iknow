# I467 smoke — real LLM full-compact

**Result: PASS**

| Field | Value |
|-------|-------|
| model | minimax-cn/MiniMax-M3 |
| baseUrl host | 172.31.128.1:20128 |
| stream | on |
| thinking | adaptive |
| maxOutputTokens | 8192 |
| COMPACT_TIMEOUT_SECONDS | 90 |

## Phase A — functional

| Field | Value |
|-------|-------|
| outcome | summarized |
| latencyMs | 12543 |
| summaryLen | 5021 |
| outputTokens | 1924 |
## Phase B — long-context latency stress

| Field | Value |
|-------|-------|
| outcome | summarized |
| latencyMs | 16405 |
| dropped count / chars | 74 / 27292 |
| defaultTimeoutMs | 90000 |
| summaryLen | 6362 |

## Phase C — real SDK abort path

| Field | Value |
|-------|-------|
| outcome | timeout |
| wallClockMs | 116 |

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
| outcome.kind in {summarized, timeout} | PASS |

### Phase C assertions

| Assertion | Outcome |
|-----------|---------|
| outcome.kind === timeout (real SDK aborted) | PASS |
| wall clock < 1000ms (signal aborted HTTP, not just setTimeout race) | PASS |
