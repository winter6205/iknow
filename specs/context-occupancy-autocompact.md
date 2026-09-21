# Spec: context occupancy — one numerator for gate and bar

The usage bar and the proactive auto-compact read the same occupancy number. The denominator stays the policy budget window.

## Does

- The bar's percentage numerator = **context occupancy** (one formula shared by TUI and Web).
- Before every `step`, the proactive gate compares occupancy against `floor(0.95 × contextWindow)` (or an explicit threshold).
- Occupancy priority: this beat's finite, >0 `countTokens` → previous-beat occupancy(usage) → `estimateMessagesTokens`.
- pre_call with cache fields absent: occupancy = `inputTokens`. post_call: the three token classes are summed.
- Manual `/compact` still does not pass through the token gate.

## Does not

- Change the policy budget window default or the 95% formula.
- Use the vendor's 1M window as the denominator.
- Change the window / full_summary compactors.
- Fill trace or `lastUsage` with chars/N estimates.
- Add cache fields on top of a countTokens total that already includes them.

## Contract

- EXIT: missing `countTokens` / throw / non-finite or ≤0 → this beat has no measurement; must not collapse into `below_token_threshold`; fall through to previous-beat occupancy, then estimation.
- empty: no measurement and the estimate is below the threshold → noop.
- overflow: occupancy above the threshold (even when the estimate is below) → must not noop.
- concurrent: when this beat's measurement disagrees with the previous beat's, this beat wins.
- Without `onStream` the display may skip countTokens; the gate still falls through previous beat → estimation.
- Gate probe scope: this beat's `countTokens` measures only the messages the gate sees (excluding system/tools); the display's pre_call beat measures system+tools+messages. The same-beat gap between the two numbers is stitched back by the previous beat's API usage entering the chain (one-beat lag, never a permanent fork) — this is the registered accounting.

Basis: ADR-0118; ADR-0100; ADR-0008 D6 display half.
