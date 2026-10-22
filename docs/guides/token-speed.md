# TUI token speed

The ContextBar keeps a token-speed readout visible for the active conversation.
The bar reads `<used>/<window> · <rate>`, for example
`16.6k/256.0k · ~150 tok/s`. The rate is `0 tok/s` until the first repaint
after the turn's first output, `~N tok/s` while output is arriving, and the
weighted turn average when the turn ends. The live rate is repainted at most
once per 800 ms (not per stream fragment). A new turn resets the reading to
zero.

## Calculation

Live speed uses the estimated output tokens seen in a rolling one-second
window divided by the elapsed window in seconds. When the window is younger
than one second, it uses the time since the first output fragment. When the
one-second window holds no output, the last rate stays visible instead of
dropping to zero. Text, thinking, and streamed tool-input deltas count as
model output. Tool execution does not.

While the turn continues but waits for the next call's first token, the
weighted turn average stays visible. It replaces the live rate when the turn
ends.

When the provider reports both `outputTokens` and `generationMs`, the completed
call uses those measurements. The weighted turn average combines all completed
calls as `sum(outputTokens) / (sum(generationMs) / 1000)`. This weights each
call by its generation duration. `generationMs` starts at the first output
fragment, so first-token wait and tool execution are excluded.

If a provider measurement is missing, the TUI estimates the call from the
cumulative streamed character count and its measurable output interval. Tiny
fragments accumulate before conversion to tokens so splitting one output into
many chunks does not round each chunk upward. If no positive interval can be
measured, the call is marked estimated and contributes no invented duration.
The readout then keeps any usable completed average, marked `~` when an
estimated call contributed to it.

For adapters without a pre-call usage beat, `agent_status` and
`env_snapshot` events delimit model calls. When a tool call was observed, the
estimated call end is its last generated fragment, not the later boundary
after tool execution.

## Reference

This follows DeepSeek Harness's decode-time aggregation: add output tokens and
decode durations across calls, then divide total tokens by total seconds.
The TUI uses a local streaming estimate until measured call usage is available.

- [DeepSeek turn metrics at pinned revision](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-chat/src/client/contract/turn-metrics.ts)
- [DeepSeek StatsPills at pinned revision](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-chat/src/client/chat/StatsPills.tsx)
