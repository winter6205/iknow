# Tracker reference (disclosed from `## Tracker`)

This file is a **disclosed reference**. Load it only when the skill body's
`## Tracker` pointer fires — the operator this run named GitHub issues
(「用 issue」「发到 GitHub」). Default storage is local markdown; do not
open this file because `gh` is installed or origin points at GitHub.

Full `gh` commands, GraphQL mutation mechanics, and the gh-22 handoff
boundary live here so the top of SKILL.md stays a routing view.

## Default (local markdown)

When this file is not loaded:

- Plan lives in `plans/<feature>.md`. That file is the acceptance surface.
- Spec stays in `specs/<feature>.md`. This skill does not create a spec issue.
- Wayfinder maps and decision tickets, when that skill is running, live in
  `docs/wayfinder/tickets/`. This skill does not publish them.

## Opt-in (GitHub issues)

Apply only after the operator named GitHub this run (gh-08 / gh-16 fusion
location; publisher stays in this skill, no `tracker-publisher`):

1. **Wayfinder map + decision tickets** → one GitHub issue per ticket, all carrying the label `wayfinder:map`. Create with `gh issue create --label 'wayfinder:map' --title "<ticket-title>" --body-file <ticket.md>`. The `wayfinder:map` label is the routing key for the wayfinder-map context.
2. **Spec output** (from `spec-driven-development` or a grilling ticket whose Resolution already carries the 5 spec sections per gh-22) → one **spec issue**. Create with `gh issue create --label 'spec' --title "spec: <feature>"`; body is the rendered spec markdown.
3. **Plan output** (this skill's `plans/<feature>.md`) → one **ticket issue per tracer bullet**, all carrying the label `ready-for-agent`. Create in dependency order (blockers first) so each issue gets a real number before its dependents reference it: `gh issue create --label 'ready-for-agent' --title "T1 <name>" --body-file <ticket.md>`. Then render the blocking edges — for every `[blocks: T1, T2]` annotation in `plans/<feature>.md` (the source of truth), use the GraphQL `addBlockedBy` mutation (`gh issue edit` has NO `--add-blocking` flag): resolve each issue's node id via `gh api graphql -f query='query { repository(owner:"<owner>", name:"<repo>") { issue(number:<n>) { id } } }'`, then run `gh api graphql -f query='mutation { addBlockedBy(input: {issueId: "<dependent-node-id>", blockingIssueId: "<blocker-node-id>"}) { clientMutationId } }'` so the blocker shows natively on the dependent. **Completion criterion**: every tracer-bullet issue carries `ready-for-agent` (NOT `wayfinder:map` — that label is path 1's decision tickets only), and every `[blocks:]` edge in the plan file renders as a native blocking link on the tracker.

## Handoff boundary interaction (gh-22)

The wayfinder → spec handoff is independent of storage. Map clears →
`spec-driven-development` (default) or `writing-plans` when the grilling
ticket's Resolution already has the 5 spec sections. Artifacts stay local
files unless this opt-in path is active; then steps 1–3 above apply.

## Fusion note (gh-08 + gh-16)

Publisher responsibilities stay fused here (gh-07). GitHub is an opt-in
projection of the same contracts, not a second plan format.
