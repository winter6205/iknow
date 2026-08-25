# Plan Format

Use this template. Add fields if the feature needs them. Keep the numbered list. Every numbered item is one tracer bullet.

```markdown
# Plan: <feature name>

**Goal:** <one sentence outcome for the whole change>
**Approach:** <2–3 sentences: how the bullets fit; not a file tree>
**Spec link:** <path>
**ACR:** <all-yes / N/A-with-reason; paste the 5-line block below or above Tasks>
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## Tasks (ordered by dependency)

Each numbered item is one tracer bullet: one vertical-slice outcome, one tag, one commit, headroom for the implementer.

1. **<bullet name>** — tag: `[decision]` | `[implementation]`
   - **Inherits:** <quoted spec/ADR clause, or "none — open for implementer">
   - **Surface:** <existing module or bounded context; omit invented filenames>
   - **Acceptance:** <observable yes/no — behaviour, invariant, or named structure; not a line-count / cyclomatic / literal-count gate>
   - Status: [ ] pending
   - [blocks: …] / [parallel] as needed

2. **<bullet name>** — tag: `[implementation]`
   - **Inherits:** …
   - **Surface:** …
   - **Acceptance:** …
   - [blocks: T1]
```

## Field guide

| Field      | Put here                                                                                    | Leave for implementation                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inherits   | Settled EXIT, invariants, scope cuts, already-named types                                   | Newly invented class/function names                                                                                                                                                                                                        |
| Surface    | An existing context (`session-api`, `web`, `src/config`)                                    | Exact new paths (`src/foo/Bar.tsx`) unless the spec already froze them                                                                                                                                                                     |
| Acceptance | "unbound serve refuses a turn"; "migration round-trips"; "one helper factory for this type" | A test file you have not written yet; a curl one-liner that is really the design; S5 numbers (`≤60` lines, `≤10` cyclomatic, `≤4` params, clone %, "≤1 literal") — those are gates, see `complexity-anti-drift` `references/thresholds.md` |
| Approach   | Why these slices, what stays out of scope                                                   | Library versions, helper extraction, folder reshuffles                                                                                                                                                                                     |

**Decision bullets** may name the ADR / CONTEXT files they will create — those files _are_ the outcome.

**Wide mechanical refactors:** expand (new form beside old) → migrate call sites in batches (each batch a tracer bullet) → contract (delete old form). Expand, each migrate batch, and contract are all bullets — each is one commit. Sketch:

1. expand — new form lives beside the old; callers unchanged `[implementation]`
2. migrate batch — one directory / package of call sites `[implementation]`
3. …more batches…
4. contract — old form deleted; build green `[implementation]`
