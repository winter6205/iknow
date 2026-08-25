# Spec Template

Use this template when writing a spec document. The required areas are the shape. Inherits/Changes records what **this** workspace already provides that the contract depends on, or the confirmed choices when the workspace has none yet. Indent, quotes, formatter, and lint taste stay out.

```markdown
# Spec: <feature name>

## Objective

What we are building and why. Who is the user. What does success look like.

## Boundaries

- **Does:** <work this spec covers>
- **Confirms with human:** <choices that stay open until asked>
- **Out of this spec:** <deferred, or owned by another spec / ADR>

## Success Criteria

Specific, testable, binary. Each criterion maps to a measurable check (a command that exits 0, a metric threshold, a property test).

## Open Questions

Anything unresolved that needs human input before PLAN. Write `(none)` if the assumption gate cleared them.

## Inherits / Changes

Quote stack, test command, or surface this workspace already has that the contract depends on.
If this workspace has none yet, write the confirmed choices from the assumption gate.
Do not prescribe indent, quotes, formatter, or lint taste.
```

## Assumption Listing Format

```
ASSUMPTIONS I'M MAKING:
1. <assumption>
2. <assumption>
3. <assumption>
→ Correct me now or these become the spec.
```

## Vague-to-Binary Reframing Format

```
REQUIREMENT: "Make the dashboard faster"

REFRAMED SUCCESS CRITERIA:
- Dashboard LCP < 2.5s on simulated 4G
- Initial data load < 500ms at p95
- CLS < 0.1 during load
→ Are these the right targets?
```
