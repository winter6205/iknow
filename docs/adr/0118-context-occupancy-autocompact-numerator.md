# 0118. The usage bar and the auto-compact gate share one occupancy numerator

Date: 2026-09-21
Status: accepted

The denominator is already the policy budget window (ADR-0100). The numerator had forked: the bar used API / `countTokens`, while the proactive gate used `estimateMessagesTokens` (thinking=0, image ≈1). The hoolycheck session `8582d3fc` showed the bar at 955.6k/256k with 34 calls and zero compaction. The gate now consumes **context occupancy**: this beat's finite, >0 `countTokens`, otherwise the previous beat's occupancy, and only then the chars estimate. When pre_call cache fields are absent, occupancy = `inputTokens` — never add cache on top of a total that already includes it. The display still forbids substituting estimates for usage (ADR-0008 D6, display half). The compactors and manual `/compact` bypassing the token gate keep their semantics.

Amends ADR-0008 D6 (estimation is no longer the primary compaction criterion) and ADR-0100 (numerator and denominator now come from the same occupancy ledger, not just the denominator).
