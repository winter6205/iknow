# ADR Format

> Schema for Architecture Decision Records in `docs/adr/`.
> In-bundle reference — skills read this file, not a per-project copy.
> Aligned to mattpocock/skills source — lightweight by default, sections only when they earn their place.

ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`, `0002-slug.md`, etc.

Create the `docs/adr/` directory lazily — only when the first ADR is needed.

## Template (default)

A single paragraph is enough. The value is in recording _that_ a decision was made and _why_ — not in filling out sections.

```md
# {NNNN}. {Short title of the decision}

Date: {YYYY-MM-DD}
Status: {proposed | accepted | deprecated | superseded by ADR-NNNN}

{1-3 sentences: the context, the decision, and the reason.}
```

That's it. An ADR can be a single paragraph.

## Required frontmatter

The first three lines are required (they are file-level invariants, not section content):

| Field  | Format                                                                   | Why                                                                                    |
| ------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Title  | `# {NNNN}. {Short title}`                                                | Numbering invariant: title prefix matches filename, so `docs/adr/` scans can correlate |
| Date   | `Date: YYYY-MM-DD`                                                       | Audit trail — when was the decision made                                               |
| Status | one of `proposed` / `accepted` / `deprecated` / `superseded by ADR-NNNN` | State machine — only one status at a time, except the `superseded by` pointer          |

These are the **only** required elements. Everything below is optional.

## Optional sections

Only include these when they add genuine value. Most ADRs won't need them.

- **Status combined** — `accepted; superseded-by ADR-NNNN §Decision N only` is legal; the original decision stands except for the specific section called out.
- **Considered Options** — only when the rejected alternatives are worth remembering (someone will suggest GraphQL again in six months otherwise).
- **Consequences** — only when non-obvious downstream effects need to be called out. Split into `**正面 / Applied:**` and `**负面 / Trade-offs:**` bullets when used.
- **Why not B/C** — only when the rejected alternatives would be easy to re-suggest later and the reasons for rejection are non-obvious.
- **Gate check** — only when the decision was gated by a specific criterion worth recording.
- **Evidence pointers** — only when the decision was grounded in specific data (evals, measurements, traces) that should be citable.

A single-paragraph ADR is the default. Sections are not boilerplate — add them when they earn their place.

## Numbering

Scan `docs/adr/` for the highest existing number and increment by one.

## Status values

| Status                   | Meaning                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `proposed`               | Decision not yet accepted; under review                       |
| `accepted`               | Decision is in force                                          |
| `deprecated`             | Decision is no longer relevant; kept for historical trace     |
| `superseded by ADR-NNNN` | Decision has been replaced by a later ADR; link the successor |

## When to offer an ADR

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use `commit message` for easy-to-reverse decisions, `CONTEXT.md` for terminology, and `docs/SPEC.md` for requirements.

### What qualifies

- **Architectural shape.** "Monorepo." "Event-sourced write model; projected read model into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." Explicit no-s are as valuable as yes-s.
- **Deliberate deviations from the obvious path.** "Manual SQL instead of ORM because X." Anything where a reasonable reader would assume the opposite — these stop the next engineer from "fixing" something deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it — otherwise someone will suggest GraphQL again in six months.

## What does NOT qualify

- Implementation details that are obvious from the code
- Easy-to-reverse decisions (commit message is enough)
- Terminology / vocabulary (CONTEXT.md is the right artifact)
- Requirements or specifications (SPEC.md is the right artifact)

## Supersede protocol

When a later ADR supersedes this one, **do not delete the original**. Set Status to `superseded by ADR-NNNN` and link the successor. The decision chain stays traceable.
