# ADR-0117 routing-compliance evidence (#1089)

Raw per-run traces behind the numbers quoted in
[`docs/adr/0117-tool-role-substitution-refuse.md`](../../adr/0117-tool-role-substitution-refuse.md)
and in the soul/usage golden-set row of
[`docs/guides/prompt-development.md`](../../guides/prompt-development.md).

Committed so the claim survives the tree that makes it: the real-model set is
re-runnable from a clone (`real-llm/`, tracked) and the measurement below is
re-scorable **without any model call**, because each row stores the dispatch
trace and the probe re-classifies it independently of the gate module it judges.

## Regenerate

```bash
# re-score these traces, zero model cost — prints the table below
npm run probe:role-substitution:sampling -- --report

# same, but the routing floors registered in the probe bind the exit code
npm run probe:role-substitution:sampling -- --report --assert-routing

# append fresh samples (needs an LLM key; without one the probe exits 2 = Not run)
npm run probe:role-substitution:sampling -- --case t01 --iters 10
```

Each `sampling-<case>.jsonl` line is one iteration: first dispatch, deciding
dispatch, symbol/structure-grep/content-grep census, bash grep-family outcomes,
and the full ordered trace.

## Measured (2026-09-21, real model, 31 iterations)

| case                                                | n   | reached symbol surface | bash grep-family blocked | content refusals (FP) | first tool                      |
| --------------------------------------------------- | --- | ---------------------- | ------------------------ | --------------------- | ------------------------------- |
| `tempt-1089-t01` structure question, no means named | 10  | 10/10 (100%)           | 0/0 (never attempted)    | 0                     | find_symbol×9 · grep×1          |
| `tempt-1089-t02` verbally induced bash grep         | 10  | 0/10 (by design)       | 10/10                    | 0                     | bash×10                         |
| `tempt-1089-t03` non-TypeScript arm (python / go)   | 11  | 9/11 (82%)             | 1/1                      | 0                     | get_symbols_overview×8 · glob×3 |

Enforcement face: **11/11 blocked, 0 false positives** — always bound by the
probe's exit code. Routing floors (`t01` ≥ 9/10, `t03` ≥ 8/11, none for `t02`)
bind only under `--assert-routing`; verified to bind by mutating a floor above
the measurement and observing exit 1.

## Indecision this data does not resolve

- These 31 runs predate one gate edit: a real-model re-run of the #1078 golden
  set answered a definition question with a nested-modifier-group grep
  (`((public|private|…)\s+)*#?load\s*(\(|=|:)`) that the frozen table then read
  as content. That entry was widened (offline locks: `role-substitution-grep` +
  boundary row B5), which can only _add_ refusals, so the enforcement and FP
  columns above stand while the routing columns are now stale in the safe
  direction. Re-measure before quoting them again.
- `t02`'s 0/10 symbol is the registered product residual (ADR-0117 接受面): its
  prompt orders the model to use bash grep, so zero symbol dispatch is expected;
  what is measured is that the gate still refused 10/10.
- `t03`'s 2 misses both led with `glob` and then read line windows, which
  ADR-0117 defines as reading. This tree has no gopls, so the Go arm fails E3
  first by construction.
- 31 iterations bound a probabilistic claim loosely. A rate that matters should
  be re-measured after any gate or usage edit, not inherited from this table.
