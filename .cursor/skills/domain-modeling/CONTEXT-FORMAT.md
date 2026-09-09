# CONTEXT.md Format

> Schema for project-level domain glossary (`docs/CONTEXT.md`).
> In-bundle reference — skills read this file, not a per-project copy.
> Aligned to arthurpower's existing `docs/CONTEXT.md` structure.

## Template

```md
# {Context Name} — 领域词汇表

> 本文件是项目领域词汇的**单一事实源 (SSOT)**.
> 仅 `domain-modeling` 技能可写; 其他技能按 `docs/agents/context-contract.md` 消费.

---

## Language

**Order**:
{One or two sentences: what the term IS in this project.}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## Structural invariants

The following are required by `pre-context-write-guard.cjs` (the physical guardrail). A write that violates any of them is rejected at PreToolUse with exit 2.

| Invariant                                                                                   | Why                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Title matches `# {Name} — 领域词汇表` (or English equivalent ending in `— domain glossary`) | Hook regex anchors on this heading                      |
| SSOT blockquote present immediately after title                                             | Signals single-source ownership; hook verifies presence |
| `## Language` section exists                                                                | Hook requires it                                        |
| At least one `**Term**: {definition}` entry                                                 | Hook rejects empty glossaries                           |
| No generic programming terms (function / array / loop / timeout / …)                        | Per context-loop §4.2 glossary gap signal               |

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what the term IS, not what it does.
- **Only project-specific terms.** General programming concepts don't belong even if the project uses them extensively. Before adding a term, ask: is this unique to this context, or a general programming concept? Only the former belongs.
- **Group under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.
- **Override markers.** When a team-level glossary (`docs/team-glossary.md`) conflicts with this project's term, mark the override explicitly:
  ```md
  **Account**: {project-specific def} <!-- project-override: {reason} -->
  ```
  `post-ssot-priority.cjs` detects this marker to decide hard-block vs silent pass.

## Single vs multi-context repos

**Single context (most repos):** One `CONTEXT.md` at the repo root.

**Multiple contexts:** A `CONTEXT-MAP.md` at the repo root lists contexts, their locations, and relationships:

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) — receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) — generates invoices and processes payments

## Relationships

- **Ordering → Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment consumes them
- **Fulfillment → Billing**: Fulfillment emits `ShipmentDispatched` events; Billing consumes them
```

Inference:

- If `CONTEXT-MAP.md` exists, read it to find sub-contexts
- If only a root `CONTEXT.md` exists, single context
- If neither exists, create a root `CONTEXT.md` lazily when the first term is resolved
