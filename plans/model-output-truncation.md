# Plan: model output truncation

**Goal:** Model requests use the configured budget for their effective route, and output exhaustion settles as a safe, durable incomplete turn shown consistently in TUI and Web.
**Approach:** Validate model budgets and retire the legacy global override, then apply each route's budget to its requests. Persist settled turn outcomes before wiring provider-independent truncation closeout and replay-safe tool-use handling; finish with the shared live and reopened TUI/Web presentation.
**Spec link:** [specs/model-output-truncation.md](../specs/model-output-truncation.md)
**ACR:** all-yes; verdict block below.
**Per-ticket loop (all bullets):** test-driven-development → typecheck and tests → verification-before-completion.
**Persist list:** None — the spec's ADR amendments are already present in its inputs, and this plan adds no domain terms.

## ACR

bounded-context-guardian: yes — protocol closeout and the terminal outcome remain in the same host turn; adapters, harness, persistence, and clients retain separate responsibilities.
input-contract-tests: yes — SC5, SC14, SC17, and SC18 cover configuration, persistence failures, and concurrent route isolation.
error-handling-enforcer: yes — configuration and persistence failures are typed; supplier rejection remains visible.
complexity-anti-drift: yes — the contract assigns each responsibility to its existing module boundary.
minimal-change-verifier: yes — the scope is limited to output-budget configuration, truncation safety, and TUI/Web presentation without a provider-cap registry.

## Tasks (ordered by dependency)

1. **Validate per-model budget configuration and migrate the legacy setting** — tag: `[implementation]`
   - **Inherits:** “Validate `models[].maxTokens` as an optional positive safe integer. Absence selects the 32,000 fallback; `null`, wrong type, zero, negative, fractional, or unsafe-integer values fail with a typed configuration error rather than being dropped into fallback.” The non-empty `IKNOW_LLM_MAX_OUTPUT_TOKENS` migration is fail-fast and does not rewrite `settings.json`.
   - **Surface:** `src/config`, maintained model configuration seeds and examples, provider-settings documentation.
   - **Acceptance:** Valid configured budgets and absence load successfully; every invalid explicit value and a non-empty legacy variable from the process environment or a loaded env file fail with an actionable typed error. The maintained MiniMax M3 seed/examples specify 131,072, documentation identifies `maxTokens` as the request output budget and does not describe configured values or the fallback as supplier hard limits, and loading does not mutate settings files.
   - **Covers:** SC4, SC5, SC17.
   - Status: [ ] pending

2. **Apply the effective model budget to main-session requests** — tag: `[implementation]`
   - **Inherits:** “The selected model entry's `models[].maxTokens` supplies request `max_tokens`; an absent value uses 32,000. Re-resolve it when the selected or fallback model changes.” The request value is not a supplier hard-limit claim; documented supplier rejection remains visible.
   - **Surface:** Main-session model routing and request assembly in `src/config` and `src/harness`, Anthropic-compatible provider adapter.
   - **Acceptance:** Captured main requests send the selected model entry's exact budget or 32,000 when absent; switching the selected or fallback model changes the next request's budget. The harness does not clamp configured positive safe integers to inferred supplier caps; with M3 configured above its documented maximum, the exact value is sent and a supplier rejection reaches the existing API error surface without being treated as completion.
   - **Covers:** SC1, SC2, SC3, SC15, SC16.
   - **Depends on:** T1.
   - Status: [ ] pending

3. **Apply an independent budget to separately routed subagent requests** — tag: `[implementation]`
   - **Inherits:** “Resolve `maxTokens` from the effective model route for main and separately routed subagent requests; use the same 32,000 fallback when that route's model entry omits it.”
   - **Surface:** Subagent model routing and worker request assembly in `src/harness`, shared provider registry configuration.
   - **Acceptance:** Captured subagent requests use the effective subagent route's configured budget or its own 32,000 fallback. Concurrent main and subagent requests with different route budgets each send their own value, with neither inheriting the other's cap.
   - **Covers:** SC12, SC18.
   - **Depends on:** T1.
   - Status: [ ] pending

4. **Persist one authoritative outcome for each settled host turn** — tag: `[implementation]`
   - **Inherits:** “After any settled host turn, the session transcript contains one terminal outcome linked to that turn's stable identity, including `/continue` with no new human message.” A missing record projects as `unknown`, independently of `StopReason`, and does not synthesize `completed`.
   - **Surface:** Host turn settlement and the `src/session-api` transcript store/history projection.
   - **Acceptance:** Each settled host turn, including `/continue` without an appended human message, has one append-only terminal outcome linked to its stable identity. Rewind and reopened history project outcomes from the active transcript head, not abandoned branch records (ADR-0027/0126); missing outcomes project as `unknown`. An injected outcome-persistence failure surfaces as a typed persistence failure and never reports the turn as completed.
   - **Covers:** SC7, SC14.
   - Status: [ ] pending

5. **Stop output-limit generations without retry or closing-summary calls** — tag: `[implementation]`
   - **Inherits:** “An output-limit stop ends the current generation. The harness makes no automatic retry or continuation call, and executes no tool call from the truncated response.” The returned outcome is `nonSuccessStop` with supplier detail `truncation`; ADR-0011's closing-summary behavior for other abnormal stops remains unchanged.
   - **Surface:** Supplier stop normalization, Loop Engine, and host closeout in `src/harness`.
   - **Acceptance:** A normalized supplier output-limit signal settles the generation as `nonSuccessStop` with detail `truncation`, executes no tools from that response, and makes no retry, continuation, or closing-summary model call for that truncation. Other abnormal-stop summary behavior remains unchanged.
   - **Covers:** SC6, SC10.
   - **Depends on:** T4.
   - Status: [ ] pending

6. **Close truncated native tool-use messages so transcript replay remains valid** — tag: `[implementation]`
   - **Inherits:** “For a truncated response whose native assistant message contains materialized `tool_use` blocks, preserve those blocks and signatures unchanged, execute no tools, and immediately append a user message containing only one `is_error` `tool_result` per returned tool-use ID.” The synthetic protocol message and outcome share the current turn identity and do not create a new human turn.
   - **Surface:** `src/harness` tool execution guard and `src/session-api` transcript append/replay.
   - **Acceptance:** For materialized tool-use IDs, the unchanged assistant message is followed immediately by one synthetic protocol message with exactly one matching `is_error` result per ID, then the terminal outcome; none of the calls execute, and reloading the transcript preserves valid tool pairing. Results say the calls were not executed because the output limit was reached. If no materialized ID is returned, the existing `protocolError` path records no invented ID or synthetic result. Injected failures appending the assistant message, synthetic result message, or terminal outcome surface as typed persistence failures and never report completion; existing orphan-tool-use repair remains available after a crash between appends.
   - **Covers:** SC13, SC14.
   - **Depends on:** T4, T5.
   - Status: [ ] pending

7. **Show the same durable truncation state in live and reopened TUI/Web turns** — tag: `[implementation]`
   - **Inherits:** “TUI and Web project the same deterministic English output-limit notice from the persisted outcome, both live and after reopening.” Preserve committed visible assistant text as incomplete; thinking-only truncation shows no assistant answer. The notice is not an assistant message, and an unknown legacy outcome gets neither a truncation notice nor a completed/incomplete label.
   - **Surface:** TUI turn presentation, Web internal session HTTP route and presentation, live and reopened session projections.
   - **Acceptance:** Live and reopened turns in both clients render a semantically identical deterministic English notice from the persisted outcome, keep committed assistant text visible and marked incomplete, and do not add the notice to assistant history or model input. Thinking-only truncation shows the notice without assistant answer text; a legacy turn with unknown outcome shows neither the notice nor a completed/incomplete label.
   - **Covers:** SC8, SC9, SC11.
   - **Depends on:** T4, T5.
   - Status: [ ] pending

## End-of-round review

After all bullets land, run `arthurpower:code-review`; if its gate is blocked, repair the reported findings in the next slot and then run `verification-before-completion`. Checkpoint commits are allowed; the plan does not require one commit per bullet.
