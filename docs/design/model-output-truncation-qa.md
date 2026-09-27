# Model Output Truncation: Decision Q&A

This digest records the settled product and harness decisions for output-limit stops. It describes the target contract; it does not claim the implementation is complete.

## What does an output-limit stop mean to the caller?

The provider adapter normalizes the supplier's stop signal as output-limit truncation. The loop returns a structured `nonSuccessStop` with typed `truncation` detail, representing a failed turn separately from API errors. If a truncated response contains materialized `tool_use` blocks, preserve the native blocks, execute no tools, and pair every tool-call ID with an error `tool_result` stating that execution did not occur because of the output limit. This is a settled truncation outcome, not process death.

## Where is the failed-turn outcome authoritative?

Persist one terminal outcome per settled host turn, linked by a stable turn identity, including `/continue` turns that append no new user message. The Web response, TUI bridge, and reopened histories project that same outcome. They must not infer `completed` from assistant text. If legacy history has no terminal outcome, its status is unknown.

## Which output-token limit should a request use?

Use the effective `models[].maxTokens` entry for each request, including main-agent and separately routed subagent requests; recalculate it when that request's selected or fallback model changes. If the field is absent, use 32,000 tokens. Configure MiniMax M3 at its documented recommended 131,072 tokens, and check the maintained M3 seed/example against its documented 524,288-token maximum. Do not use 128K (131,072 tokens) as a universal fallback: supported models can have lower output limits, and the fallback is not evidence of a supplier's hard maximum. The generic harness does not hard-clamp an arbitrary user-configured positive safe integer cap; surface a supplier rejection as a provider/API error. During migration, if `IKNOW_LLM_MAX_OUTPUT_TOKENS` is still configured, report an actionable configuration error; it must not silently override a model entry or trigger a `settings.json` rewrite.

## Does the harness retry or continue after truncation?

No. Output-limit exhaustion ends the current generation without automatic retry or continuation, including when reasoning used the whole budget. A user follow-up starts a new turn. Any native thinking replay in that new turn must follow the selected provider's history requirements. There is no model-independent mechanism in this policy that guarantees a single generation will finish within its output limit.

## What should TUI and Web show?

Keep committed, user-visible partial text in message history and present it as incomplete using the persisted turn outcome. If the response contains only thinking, show no assistant answer. TUI and Web show the same deterministic English failure notice during the live turn and after reopening the session. The notice is a UI projection of the outcome, separate from assistant content; it may invite a new instruction, which starts a new turn.

## Should truncation trigger a closing-summary call?

No. Do not make a model call to generate a closing summary after output-limit truncation. Existing closing-summary behavior for other abnormal stops is unchanged.

## Source records

The decisions above came from the local, ignored Wayfinder records in `docs/wayfinder/model-output-truncation.md` and its four `docs/wayfinder/tickets/mot-*.md` tickets. Carry this digest into the downstream specification and plan; those local records may not be present in another checkout.
