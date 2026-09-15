# Plan: transport retry, continue, failure persist

**Goal:** Invisible transport stalls retry safely; Ctrl+C and `/continue` keep distinct priors; protocol failures keep the user's sentence.
**Approach:** Split clocks/retry from continue prior-strip from persist predicate and sticky notice so each bullet is one demoable contract. No product-name references to third-party CLIs in artifacts.
**Spec link:** `specs/transport-continue-persist.md`
**ACR:** addressed after split — see block (input-contract classes allocated in spec; minimal-change via sequenced bullets)
**待写入:** (empty — amended continue_pending / FaultClass; added model-call idle|hardCap, sticky notice, interrupt system message, user-turn keep on protocol failure)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

## ACR

bounded-context-guardian: yes — harness clocks/fault/retry; session-api persist; tui notice/continue.
input-contract-tests: yes — matrix in spec (continue / retry / persist / sticky).
error-handling-enforcer: yes — clock abort ≠ user_cancel; busy_stop_first; persist-user-only on protocolError.
complexity-anti-drift: yes — extend race-timers / fault-class / with-transport-retry / checkpoint; no new god flow.
minimal-change-verifier: yes — four sequenced bullets below; each one logical outcome.

## Tasks (ordered by dependency)

1. **Clock abort is timeout, not user_cancel; invisible idle is retryable** — tag: `[implementation]`
   - **Inherits:** spec invariants 1–4; SC1–SC2
   - **Surface:** harness race-timers, fault-class / anthropic translate, with-transport-retry
   - **Acceptance:** idle/hardCap abort never translates to `user_cancel`; with no visible deltas, idle expiry enters retry class; after visible text or `tool_use`, idle/hardCap does not auto-retry; second-scale backoff; attempts bounded; existing non-retry 4xx stay none
   - Status: [ ] pending
   - Input contracts: retry table in spec (invalid 4xx, overflow max attempts, concurrent abort during backoff)

2. **Idle default minute-scale + sticky notice without auto-dismiss** — tag: `[implementation]`
   - **Inherits:** spec invariants 3, 8 notice behaviour; SC5
   - **Surface:** config/settings defaults for `idleTimeoutMs`; tui abnormal-stop notice
   - **Acceptance:** default idle is minute-scale (~5 min) for streaming arm; ~20s silence only changes notice lines (still waiting / check network), box stays until user dismisses or deliberate next action; no TTL clear
   - Status: [ ] pending
   - [blocks: T1] for shared timeout reason strings preferred but defaults may land in parallel if notice is independent
   - [parallel] with T1 if notice-only

3. **`/continue` strips trailing interrupt from model prior only** — tag: `[implementation]`
   - **Inherits:** spec invariants 5–7; SC3; CONTEXT continue_pending; EXIT `cancelled_keep_interrupt` for disk
   - **Surface:** session-api continueSession / continue-pending; tui runContinueTurn
   - **Acceptance:** after Ctrl+C with pending tool loop, file still has `Interrupted by user.`; `continueSession` prior passed to `run` omits that trailing interrupt; empty Enter does not continue; busy → `busy_stop_first`; typed user message keeps interrupt in prior
   - Status: [ ] pending
   - Input contracts: continue table in spec

4. **protocolError / emptyFinalResponse persist user only** — tag: `[implementation]`
   - **Inherits:** spec invariant 8; SC4; amends checkpoint #120 “drop whole turn” to user-kept
   - **Surface:** session-api store checkpoint / conditionalSave
   - **Acceptance:** protocolError or emptyFinalResponse after a user query leaves that user message on disk and does not append failed assistant; timeout path unchanged
   - Status: [ ] pending
   - Input contracts: persist table in spec
   - [parallel] with T3

## Code review phase

End of round: `code-review` → if `GATE: BLOCKED` then `review-report-repair` → `verification-before-completion`.
