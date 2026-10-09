# Quota interruption: diagnostic evidence and follow-up

Status: diagnosis only; no runtime fix or interactive reproduction delivered by this document.

## Observed incident

The operator reported that TUI messages disappeared after a provider quota error and that the footer showed `verification failed (0 rounds)`. The supplied TUI text reported HTTP 429, Token Plan usage exhausted, provider code 2056. This is provider account quota exhaustion, distinct from reaching a generation output-token limit or the subagent report-fold threshold.

The inspected local session ended on 2026-10-09 at 06:31:50 UTC after approximately 41 minutes. Its last model call and turn ended with `protocolError`. The trace does not retain the provider's raw error body; the quota/code attribution comes from the operator's TUI evidence.

Read-only inspection of the session transcript found 274 JSONL records, including 101 message events. The latest terminal native-state record reports `messageCount: 86`, after a tool-batch state reporting 85. A terminal outcome records `stopReason: protocolError`. These counts do not prove that every live draft survived or that the active-head UI displays every message, but they contradict the claim that the on-disk transcript was reset to zero. No private session payload is copied into this document.

## Why visible content can disappear

On the API-error teardown path that refreshes the session, the TUI resets its stream draft and clears transient stream/tool presentation, then reloads the persisted session and replaces the displayed message projection ([app.tsx](../../src/tui/app.tsx#L3528), [session-state.ts](../../src/tui/session-state.ts#L364)). Failed-call material that was never committed cannot survive this replacement.

The existing [transport failure spec](../../specs/transport-continue-persist.md) explicitly requires genuine user input to survive `protocolError` or `emptyFinalResponse`, while rejecting persistence of the failed assistant turn. Thus prior interruption work did not promise that all transient material would remain visible. Which exact text disappeared in this incident still needs a real PTY reproduction and comparison with the reloaded active transcript; the record counts alone cannot settle that question.

Abnormal stops also attempt a best-effort model-generated epilogue ([loop-engine.ts](../../src/harness/loop-engine.ts#L4370)). That mechanism cannot guarantee a summary when the same provider quota has run out. A host-generated interruption record and explanatory display would avoid depending on another successful model call.

## Why the footer says failed with zero rounds

The verification loop checks completion before running verification. Any non-completed stop other than cancellation currently produces `outcome: failed`; the round count remains zero ([verify-loop.ts](../../src/harness/verify/verify-loop.ts#L1010)). Existing tests explicitly require no verifier invocation, zero records, and zero rounds for `protocolError` ([verify-loop.test.ts](../../tests/harness/verify/verify-loop.test.ts#L851)). The TUI maps that outcome to the failed-verification label ([verify-banner.tsx](../../src/tui/verify-banner.tsx#L83)).

For this path, the banner means the run did not reach verification. It is not evidence that tests ran and failed. The state and wording conflate execution interruption with an actual failed verification result.

## Separate follow-up scope

This issue is independent of the [subagent output handoff plan](../../plans/subagent-output-handoff.md). Before implementing a repair:

1. Reproduce quota exhaustion before any output and after visible output through the production TUI with a controlled provider boundary and an actual PTY. Compare the live UI, newly loaded active transcript, terminal outcome, and verifier invocation count. Distinguish missing draft text from hidden committed history.
2. Decide how interrupted partial content should remain visible and survive reopening without replaying malformed assistant/tool-use messages. Any change to the failed-assistant persistence invariant must explicitly reopen the transport spec, rather than silently overriding it. Preserve genuine user input and valid committed tool results.
3. Give execution interruption a deterministic host explanation and show verification as not executed or blocked by the upstream error when no verification round ran. Actual nonzero-round test failures must retain their failure meaning. Do not synthesize a passed result or a model-authored summary.
4. Examine provider-stable quota/billing codes before specializing retry policy. Today HTTP 429 is classified as transient ([fault-class.ts](../../src/harness/fault-class.ts#L154)); rate limiting and quota exhaustion share that path. A reliable quota signal should stop futile retries, while ordinary retryable rate limits retain bounded backoff. Unknown 429 bodies must not be classified solely by an incidental English phrase.

Acceptance requires a real PTY capture for the failure and reopen paths, isolated production filesystem persistence checks, protocol-valid replay, and separate assertions for not-executed verification versus real verifier failure. These checks have not been run in this documentation task. No provider quota was deliberately exhausted, and the user's active session was not modified.
