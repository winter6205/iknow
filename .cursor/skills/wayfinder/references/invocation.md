# Invocation — Detailed Work-Through

The SKILL.md `## Invocation` section gives the two-mode entry point and the
**one ticket per session** rule. The detailed step lists for each mode live
here; load them when you are about to run that mode.

## Chart the map

User invokes with a loose idea.

1. **Name the destination.** Run a `arthurpower:logicsync` session
   to pin down what this map is finding its way to — the spec, decision, or
   change. The destination fixes the scope, so it's settled first.
2. **Map the frontier.** Grill again, **breadth-first**: fan out across the
   whole space, surfacing open decisions and first steps takeable now.
   **If this surfaces no fog** — the way is already clear, the whole journey
   fits one session — you don't need a map. Ask the user how to proceed.
3. **Create the map** (label `wayfinder:map`): Destination and Notes filled
   in, Decisions-so-far empty, the fog sketched into **Not yet specified**.
4. **Create the tickets you can specify now** as child issues — then wire
   blocking edges in a **second pass** (issues need ids before they can
   reference each other). Wiring sorts them into the frontier and those with
   prerequisites; everything you can't yet specify stays in the fog — the
   **Not yet specified** section.
5. **Fire the research subagents.** For each `research` ticket you just
   created, spin up a research subagent to resolve it in parallel,
   capturing its findings on a throwaway `research/<name>` branch with a
   context pointer from the ticket.
6. Stop — charting is one session's work; it hand-resolves nothing.

Templates to copy into the issue body live in
[`map-templates.md`](./map-templates.md).

## Work through the map

User invokes with a map (URL or number). A ticket is **optional** — without
one, you pick the next decision, not the user.

1. Load the **map** — the low-res view, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise take the
   first frontier ticket in order. **Claim it**: assign it to yourself
   before any work.
3. Resolve it — **zoom as needed**: fetch the full body of any related or
   closed ticket on demand; invoke the skills the `## Notes` block names.
   If in doubt, use `arthurpower:logicsync`.
4. Record the resolution: post the answer as a **resolution comment**,
   **close** the issue, and **append a context pointer** to the map's
   Decisions-so-far.
5. Add newly-surfaced tickets (create-then-wire); graduate fog the answer
   has made specifiable, clearing each graduated patch from **Not yet
   specified**. If the answer reveals a ticket sits beyond the destination,
   **rule it out of scope** rather than resolving it. If the decision
   invalidates other parts of the map, update or delete those tickets.

The user may run ready tickets in parallel, so expect other sessions to be
editing the tracker concurrently.
