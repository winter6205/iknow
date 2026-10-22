# Spec: context occupancy — one numerator for gate and bar

The usage bar and the proactive auto-compact read the same occupancy number. The denominator stays the policy budget window.

## Does

- The bar's percentage numerator = **context occupancy**. The **formula** stays shared by TUI and Web; both display confirmed values — the TUI refreshes per measured `pre_call` / `post_call` beat, Web per persisted answer. A projection is gate input only and never repaints the bar (ADR-0008 2026-10-22).
- Before every `step`, the proactive gate compares occupancy against `floor(0.9 × contextWindow)` (or an explicit threshold).
- The gate probe and the usage-bar probe measure the **same** request triple (`tools` + `system` + `messages`) and make the **same skip decision**, so they agree on the measured reading for the same beat. The gate's `system` comes from the run-scoped frozen prefix, so the run's first step measures without it. On an image-bearing beat the gate falls back to the anchored projection while the bar keeps the last confirmed reading — they differ only in whether a measurement exists.
- Occupancy priority: anchored projection when the request carries images → this beat's finite, >0 `countTokens` (image-free) → anchored projection when measurement is absent → previous-beat occupancy(usage) → `estimateMessagesTokens`.
- Image pricing is pixel-based: the shared estimator reads the image header (bounded prefix; PNG / JPEG / GIF, WebP when its header is present, otherwise the ceiling), scales the long edge to 1568 px, then `round(width × height / 750)`, clamped to `[1, 3072]`; malformed or truncated input reads the ceiling. Top-level `image` blocks and images nested in `tool_result.content` use the same formula — base64 length never drives the estimate.
- A projected reading never repaints the bar (the bar consumes measured beats only); the unanchored estimate replaces the anchored one once a compaction or any other history replacement invalidates the anchor, for the gate.
- pre_call with cache fields absent: occupancy = `inputTokens`. post_call: the three token classes are summed.
- Manual `/compact` still does not pass through the token gate.

## Does not

- Change the policy budget window default or the ratio-based derivation formula.
- Use the vendor's 1M window as the denominator.
- Change the window / full_summary compactors.
- Fill trace or `lastUsage` with estimates; a projected reading is gate-only and never becomes the confirmed value.
- Add cache fields on top of a countTokens total that already includes them.
- Treat a projected reading as accounting truth or a second token ledger.

## Contract

- EXIT: missing `countTokens` / throw / non-finite or ≤0 → this beat has no measurement; must not collapse into `below_token_threshold`; fall through to the anchored projection, then previous-beat occupancy, then estimation.
- empty: no measurement and the estimate is below the threshold → noop.
- overflow: occupancy above the threshold (even when the estimate is below) → must not noop.
- concurrent: on an image-free measured beat, when this beat's measurement disagrees with the previous beat's, this beat wins.
- Without `onStream` the display may skip countTokens; the gate still falls through the anchored projection → previous beat → estimation.
- Gate probe scope: the gate's `countTokens` measures the same `tools` + `system` + `messages` triple the display's pre_call beat measures, so both report one occupancy. `tools` is counted from the first beat. `system` comes from the run-scoped frozen prefix, so the run's **first step** measures without it: that beat under-reads by the system share, and a resumed session already over the gate therefore reaches it one step later. From step 2 on the triple is complete. Measuring messages alone (the pre-2026-10-15 accounting) is retired — it under-read the payload by the whole system+tools share, so a gate at 95% fired around 102% on the display scale. An image-bearing beat does not probe `countTokens` at all (the gateway charges image payloads as text); the gate and the display share that skip decision. After a compaction the anchor is null, so the first image-bearing beat degrades to the unanchored estimate and the reactive `PromptTooLongError` path remains the backstop.

Basis: ADR-0118 (2026-10-21 amendment); ADR-0100; ADR-0008 D6 display half (2026-10-21 amendment, superseded for the bar by the 2026-10-22 amendment).
