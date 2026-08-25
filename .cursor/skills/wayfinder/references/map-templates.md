# Map and Ticket Body Templates

These are the **byte-faithful** templates loaded only when a session is
**charting** the map (creating the `wayfinder:map` issue and its child
tickets). Working through the map doesn't need them — the map's body is
already there.

## Map body template

Used once, at chart time, to fill the `wayfinder:map` issue. Open tickets are
found by query against the tracker, never listed here.

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [<closed ticket title>](link) — <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
```

## Ticket body template

Each ticket is a **child issue** of the map; the tracker's issue id is its
identity. Its body is the question, sized to one 100K token agent session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

## Loading

Reach this file only when you are **charting** (the user invoked with a loose
idea, no existing map). If the user invoked with an existing map (URL or
number), skip this file — the map body is already on the tracker.
