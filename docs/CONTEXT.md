# CONTEXT.md — Project Domain Language

> **Format**: be opinionated, pick the best word, list others under `_Avoid_`
> **Rule**: Keep definitions tight. One or two sentences max. Only project-specific terms.

## Language

> Add terms below as the project grows. Each entry: definition + `_Avoid_` alternatives.
> First time on a new project: copy this template, replace terms with project-specific ones.

**Example — fill these in for your project**:

**Customer**:
A person who places orders and consumes services.
_Avoid_: User, client, account holder

**Order**:
A customer's request for a product or service, tracked through fulfillment.
_Avoid_: Request, ticket, transaction

**Snapshot**:
A point-in-time capture of project state, persisted for later inspection or rollback.
_Avoid_: Backup, dump, freeze

## Relationships

> How do the entities above interact? List directional relationships.

<!-- Example format:
- **Order → Fulfillment**: Order emits `OrderPlaced` event; Fulfillment consumes it
- **Customer → Order**: Customer owns 0+ Orders (1:N relationship)
-->

## Flagged ambiguities

> Track previously ambiguous terms that have been resolved. Prevents regression.

<!-- Example format:
- "ticket" was previously used to mean both a support issue and a sale order — resolved: sale order = **Order**, support issue = **Ticket**
-->

---

## Bootstrap mode

If this file looks like the template above (only example entries, no real project terms), run:

```bash
bash scripts/bootstrap.sh --interactive
```

This walks you through 3 questions to seed real project terms:

1. What are the 3-5 core entities in this domain?
2. Which existing labels / names in your code should be normalized?
3. Which ambiguities have caused bugs before?

Answers get written into the `## Language` section above.

---

**Maintenance cadence**: monthly review per `.claude/rules/memory.md` § 月度维护流程.
