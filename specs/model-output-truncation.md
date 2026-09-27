# Spec: model output truncation

**Status:** architecture review passed; ready for implementation planning.
**Surface:** harness model requests, session transcript and outcome projection, TUI, Web internal HTTP route.

## Objective

When a model exhausts its requested output budget, iknow must stop that generation safely, preserve any committed user-visible assistant text as incomplete, and show the same durable failure state in the live TUI/Web turn and after reopening the session. The request budget must follow the effective model configuration, with a 32,000-token fallback for entries without `maxTokens`.

## Confirmed Assumptions

These decisions were confirmed in the closed MOT-1 through MOT-4 tickets and the operator's follow-up:

1. The selected model entry's `models[].maxTokens` supplies request `max_tokens`; an absent value uses 32,000. Re-resolve it when the selected or fallback model changes.
2. MiniMax M3 is configured at 131,072 tokens. The fallback stays 32,000 for models without a configured value; it is not a supplier hard-limit claim.
3. Retire `IKNOW_LLM_MAX_OUTPUT_TOKENS` through an explicit migration. It must not silently override a model entry.
4. An output-limit stop ends the current generation. The harness makes no automatic retry or continuation call, and executes no tool call from the truncated response. A user follow-up starts a new turn.
5. Persist the terminal outcome per settled host turn. Output truncation is `StopReason: nonSuccessStop` with separate supplier-stop detail `truncation`. A missing outcome, including in legacy history, is `unknown`.
6. Keep committed user-visible assistant text in history and present it as incomplete. If a response has only thinking and no assistant text, show no assistant answer.
7. TUI and Web project the same deterministic English output-limit notice from the persisted outcome, both live and after reopening. The notice is not an assistant message. Do not make a closing-summary model call for output-limit truncation; other abnormal-stop summary behavior is unchanged.
8. Resolve `maxTokens` from the effective model route for main and separately routed subagent requests; use the same 32,000 fallback when that route's model entry omits it.
9. For a truncated response whose native assistant message contains materialized `tool_use` blocks, preserve those blocks and signatures unchanged, execute no tools, and immediately append a user message containing only one `is_error` `tool_result` per returned tool-use ID. Each result must say the tool was not executed because the output limit was reached. Do not use process-death/unknown-side-effect wording. If the adapter fails before it can return a materialized block and ID, use the existing `protocolError` path and do not invent an ID.
10. Respect documented supplier limits where available. The 32,000 fallback for an unknown model is a request fallback, not an inferred supplier hard maximum.
11. The synthetic `role: user` tool-result message is protocol content belonging to the same failed host turn, not a new human instruction or turn. Its stable turn identity also binds the terminal outcome.

## Boundaries

- **Does:**
  - Resolve the output budget from the effective model entry for main and subagent model requests. If that entry has no `maxTokens`, use 32,000. Populate the MiniMax M3 configuration at 131,072.
  - Validate `models[].maxTokens` as an optional positive safe integer. Absence selects the 32,000 fallback; `null`, wrong type, zero, negative, fractional, or unsafe-integer values fail with a typed configuration error rather than being dropped into fallback.
  - Replace the global output-token environment setting with a fail-fast migration path. A non-empty legacy value from the process environment or loaded env files produces an actionable typed configuration error directing the operator to `models[].maxTokens`; do not rewrite `settings.json` automatically.
  - Normalize supplier output-limit signals at the adapter boundary and settle the host turn as `nonSuccessStop` with supplier detail `truncation`. Stop before execution of every tool call returned in that response. Do not route this stop through transport retry or generate an automatic continuation.
  - For a truncated response with materialized `tool_use` blocks, append the unchanged native assistant message, then immediately append one synthetic `role: user` protocol message containing only one `is_error` `tool_result` per returned ID, then append the terminal turn outcome. All records bind to the same stable turn identity; the synthetic message does not begin a new human turn. If the adapter fails before returning a materialized block/ID, follow the existing `protocolError` path and never invent an ID.
  - Append one authoritative terminal outcome for each settled host turn, keyed to a stable turn identity that also works for `/continue` when it appends no human message. Project that outcome into the live HTTP response, TUI hub bridge, Web history, and TUI reopened history.
  - If persistence of the assistant message, synthetic tool results, or turn outcome fails, surface a typed persistence failure to the host and never report the turn as completed. A missing persisted outcome projects as `unknown`; after a process crash between the assistant message and synthetic tool results, existing orphan-tool-use repair may apply.
  - Treat absent terminal evidence as `unknown`; do not infer `completed` or `truncation` from assistant messages. Keep the existing `StopReason` union unchanged; `unknown` is an outcome projection for missing evidence, not a new stop reason.
  - Represent `unknown` independently from `StopReason` in turn projections; do not synthesize `stopReason: completed` for a turn with no terminal record.
  - Preserve committed visible assistant text, indicate that the turn is incomplete, and render one deterministic English output-limit notice from the outcome. Use the same semantic notice during the live turn and after reopening. For a legacy `unknown` outcome, do not show a truncation notice or label the turn completed/incomplete.
  - Omit the output-limit closing-summary model call. Do not change closing-summary behavior for other abnormal stops.
  - Keep the policy provider-independent: adapters normalize provider signals; the harness owns stop behavior and tool safety.
- **Confirms with human:** None. All map decisions and the two formerly open details below are confirmed.
- **Out of this spec:**
  - Redesigning model prompts or constraining reasoning before a provider reports output exhaustion.
  - Automatic recovery, retry, or continuation after output-limit exhaustion.
  - A general redesign of abnormal-stop summaries, transport retries, interruption closeout, or refusal handling.
  - Other client products beyond TUI and Web's internal session route.
  - A provider-wide registry of hard output limits. A configured request cap is not proof of a provider's hard maximum; known model configuration must use documented values where available.

## Success Criteria

Each criterion is binary and must be covered by focused tests in the downstream implementation.

- **SC1 — Configured request budget:** With a selected model entry containing `maxTokens: 72000`, a captured Anthropic-compatible request contains `max_tokens: 72000`.
- **SC2 — Missing-entry fallback:** With no effective model-entry `maxTokens`, a captured request contains `max_tokens: 32000`.
- **SC3 — Main model changes:** Selecting another configured model or switching to a configured fallback changes the next main request's `max_tokens` to that effective model entry's value; it never retains the prior model's cap.
- **SC4 — MiniMax M3 configuration:** The maintained M3 seed/example uses `maxTokens: 131072`; the provider-settings documentation describes `maxTokens` as the request output budget, not display-only metadata.
- **SC5 — Legacy env migration:** A non-empty `IKNOW_LLM_MAX_OUTPUT_TOKENS` set in the process environment or loaded env file causes startup/config loading to fail with a typed configuration error naming the variable and `models[].maxTokens` migration. The loader does not silently use it or mutate settings files. With the legacy value absent, normal model-entry/fallback resolution succeeds.
- **SC6 — Output-limit stop:** Given a supplier output-limit signal, the run returns `nonSuccessStop` with detail `truncation`; the tool executor receives zero calls from that response, and the harness issues no retry or continuation request for that same generation. The assertion is scoped to retry/continuation of that generation and does not prohibit unrelated host work.
- **SC7 — Durable turn outcome:** After any settled host turn, the session transcript contains one terminal outcome linked to that turn's stable identity, including `/continue` with no new human message. For truncation with materialized tool calls, transcript event order is assistant message → synthetic tool-result protocol message → terminal outcome, all linked to the same turn identity. The synthetic message does not create a new human turn. The output-limit outcome records `nonSuccessStop` plus `truncation`; loading history without an outcome projects `unknown` independently of `StopReason`, without synthesizing `completed`.
- **SC8 — Live and reopened presentation:** TUI and Web show the same deterministic English output-limit notice for the same recorded outcome during the live turn and after reopening. Committed visible assistant text remains available and is marked incomplete. The notice is not present in the assistant message history or sent as model input.
- **SC9 — Thinking-only response:** If truncation yields no assistant text, the turn contains no assistant answer text; the output-limit notice remains visible in TUI and Web.
- **SC10 — No closing summary:** For output-limit truncation, the host issues no closing-summary model call for that stop. This does not prohibit unrelated model work. Existing summary behavior for other abnormal stop reasons remains unchanged.
- **SC11 — Unknown legacy outcome:** TUI and Web show neither a truncation notice nor a completed/incomplete label for a turn whose terminal outcome is unknown.
- **SC12 — Subagent model budget:** With a separately configured subagent route whose model entry has `maxTokens: 64000`, a captured subagent request contains `max_tokens: 64000`; when that effective entry omits `maxTokens`, its request contains `max_tokens: 32000`.
- **SC13 — Truncated tool-use replay:** Given a returned truncated native assistant message with two materialized `tool_use` IDs, the transcript preserves the native assistant blocks and signatures, invokes no tool executor, and immediately appends exactly one synthetic `role: user` protocol message whose only content blocks are exactly two `is_error` `tool_result` blocks paired to those IDs. The results state that the calls were not executed because the output limit was reached and contain no process-death/unknown-outcome wording. The synthetic message and terminal outcome share the current turn identity and do not create a new human turn. A subsequent load/replay has valid tool pairing. If the adapter fails before returning a materialized block/ID, the run follows the existing `protocolError` path and records no invented ID or synthetic tool result.
- **SC14 — Typed persistence failure:** Injected failure while appending the assistant message, synthetic tool-result message, or terminal outcome surfaces a typed persistence failure to the host and never returns or projects the turn as `completed`. When the terminal outcome is absent on reload, its projection is `unknown`. A simulated process crash after the assistant message but before its synthetic tool results may use the existing orphan-tool-use repair path.
- **SC15 — Known versus unknown supplier limits:** The maintained MiniMax M3 seed/examples use 131,072, below its documented maximum of 524,288 tokens ([MiniMax Anthropic Messages API](https://platform.minimax.io/docs/api-reference/text-chat-anthropic)). For entries without a verified documented maximum, neither the configured request value nor the 32,000 fallback is described or enforced as that supplier's hard maximum. The generic harness does not hard-clamp a positive safe integer to a supplier maximum, including for M3.
- **SC16 — Supplier rejection is surfaced:** With M3 configured above its documented maximum using a positive safe integer, the exact configured `max_tokens` value is sent to the supplier. If the supplier rejects it, the provider/API error reaches the existing error surface; the harness does not silently clamp, swallow, or reinterpret it as successful completion.
- **SC17 — `maxTokens` input contract:** An absent field selects 32,000. Explicit `null`, wrong-type values, zero, negative, fractional, and unsafe-integer values each produce a typed configuration error; they are not silently dropped or treated as absent.
- **SC18 — Independent route budgets:** With distinct main and subagent routes configured to different `maxTokens`, each captured request uses its own effective route's value, including when both requests are active at the same time. Neither request receives the other route's cap; an absent cap on either route independently selects 32,000.

## Open Questions

(none)

The English notice's exact wording is intentionally left to the implementation. It must state that the model response did not finish and may invite a new user instruction; it must remain deterministic and semantically consistent across live/reopened TUI and Web.

## Architecture Change Review

bounded-context-guardian: yes — protocol closeout and the terminal outcome remain in the same host turn; adapters, harness, persistence, and clients retain separate responsibilities.
input-contract-tests: yes — SC5, SC14, SC17, and SC18 cover configuration, persistence failures, and concurrent route isolation.
error-handling-enforcer: yes — configuration and persistence failures are typed; supplier rejection remains visible.
complexity-anti-drift: yes — the contract assigns each responsibility to its existing module boundary.
minimal-change-verifier: yes — the scope is limited to output-budget configuration, truncation safety, and TUI/Web presentation without a provider-cap registry.

## Inherits / Changes

### Exact domain terms from `docs/CONTEXT.md`

> **append-only messages**: Foundation's authoritative Anthropic-native conversation history and the sole source of message content. Messages are added immutably (`[...prev, x]`), never edited in place or copied into a second authoritative history; the **session transcript** projects them from JSONL events, while a separate **turn outcome** records each turn's terminal state.

> **session transcript**: 会话权威账本——单文件 append-only JSONL，每条事件有 id 与 parent；当前可见历史由 **rewind head** 投影，旧链保留。ADR-0027。

> **turn outcome**: A terminal record in the **session transcript** for one settled host turn, linked by a stable turn identity even when no new user message was appended. It carries the authoritative **StopReason** and separate normalized supplier-stop detail without entering model-facing messages; a missing record means unknown, not `completed`. ADR-0126.

> **StopReason**: Loop Engine 的停止判别联合——016 五类（completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse）末尾追加 017 的 `cancelled` 与 `timeout`，再追加 `fused`（本 run 工具环停滞，ADR-0029）；追加不重排，Transition 形状随之自动扩展。

> **sticky notice**: TUI 底栏/提示槽里异常停或传输过程的英文（或既有）提示框；默认不自动收回——人关掉、或主动开下一轮等明确动作才清。可在同一框内改文案（等待 → 退避 → 失败因）。

### Existing decisions this contract depends on

- ADR-0126 owns adapter normalization, `nonSuccessStop` plus supplier detail, append-only terminal outcomes, stable turn identity, and the rule that non-success supplier stops precede tool execution. This spec adds model-budget selection and the output-limit presentation/recovery policy.
- ADR-0094 owns the `provider/model` routing ID versus the raw `models[].id` wire model and the shared `EnvLoader` path. This spec adds per-model output-budget resolution on that route; the legacy output-token env variable becomes an actionable migration error.
- ADR-0029 keeps transport retry policy separate from `StopReason`; this spec makes output-limit exhaustion a terminal harness policy and does not add a retry class.
- ADR-0108's frozen-prefix rule applies to foreground interruption. This spec does not change the interruption cut. For a supplier-settled truncation, it preserves the materialized native assistant content and closes returned tool-use IDs with explicit output-limit `tool_result` blocks.
- ADR-0011 continues to own max-turns and other abnormal-stop summary behavior. This spec carves out output-limit truncation, which must not trigger a closing-summary model call.
- ADR-0093's “Why not per-model temperature / max_tokens” defers model-specific request parameters. ADR-0122's “Per-route thinking or max tokens” says the worker uses host-level values. This spec reopens both decisions for output budgets only: each main or subagent request uses the effective route's model entry, with the 32,000 fallback when no entry value is present. Other host-level sampling settings are unchanged.

### Persist list

- Amend ADR-0011 to state that output-limit truncation does not invoke its abnormal-stop closing-summary model call; preserve the existing policy for other abnormal stops.
- Amend ADR-0093 and ADR-0122 so separately routed subagent requests use their effective model entry's `maxTokens` (or the 32,000 fallback); other host-level sampling settings remain unchanged.
- No new `docs/CONTEXT.md` term is required by this draft; it reuses `turn outcome`, `StopReason`, and `sticky notice` as defined above.
