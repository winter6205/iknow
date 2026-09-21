# 0100. Strategy budget window defaults to 256k; auto-compact defaults to 95%

Date: 2026-09-18
Status: accepted

## Context

The usage-display denominator and the proactive auto-compact gate used to be conflated with vendor model ceilings; the default gate was `window − 33k`. Under the operator's strategy budget (256k) that formula compacts too early, and a 1M card must not serve as the percentage denominator either. The number skips ADR-0099, already taken (home project-tree memory).

## Decision

`env.compress.contextWindow` is the operator's **strategy budget window** — the single SSOT for both the usage-display denominator and the proactive gate — not the vendor model ceiling. Repo default 256000. With `thresholdTokens` unset, the gate is `floor(0.95 × contextWindow)`; `window − 33k` is no longer used. An explicit threshold must still be `< window`. Whoever sets the denominator to the true ceiling lowers `IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS` themselves.

## Why not

**Why not display 256k while still compacting against 1M / two windows:** CONTEXT forbids a second token ledger.  
**Why not `min(95%, window − 33k)`:** at 256k it still lands at 87%, so 95% never applies.  
**Why not change only local settings:** the strategy budget is a product default, not a personal override.  
**Why not keep `window − 33k`:** that margin assumed a denominator ≈ the real ceiling; under a strategy budget it compacts too early.
