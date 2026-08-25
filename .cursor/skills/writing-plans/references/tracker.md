# Tracker reference (disclosed from `## Tracker = GitHub (main path)`)

This file is a **disclosed reference**, loaded only when the agent reaches the
context pointer in the skill body's `## Tracker = GitHub (main path)` section.
Full gh commands, GraphQL mutation mechanics, fallback rules, and the gh-22
handoff-boundary interaction live here so the top of SKILL.md stays a routing
view, not a CLI manual.

## Main path (GitHub issues)

Apply the main path as follows (gh-08 ratified decision; gh-16 fusion location):

1. **Wayfinder map + decision tickets** → one GitHub issue per ticket, all carrying the label `wayfinder:map`. Create with `gh issue create --label 'wayfinder:map' --title "<ticket-title>" --body-file <ticket.md>`. The `wayfinder:map` label is the routing key for the wayfinder-map context.
2. **Spec output** (from `spec-driven-development` or a grilling ticket whose Resolution already carries the 5 spec sections per gh-22) → one **spec issue**. Create with `gh issue create --label 'spec' --title "spec: <feature>"`; body is the rendered spec markdown.
3. **Plan output** (this skill's `plans/<feature>.md`) → one **ticket issue per tracer bullet**, all carrying the label `ready-for-agent`. Create in dependency order (blockers first) so each issue gets a real number before its dependents reference it: `gh issue create --label 'ready-for-agent' --title "T1 <name>" --body-file <ticket.md>`. Then render the blocking edges — for every `[blocks: T1, T2]` annotation in `plans/<feature>.md` (the source of truth), use the GraphQL `addBlockedBy` mutation (`gh issue edit` has NO `--add-blocking` flag): resolve each issue's node id via `gh api graphql -f query='query { repository(owner:"<owner>", name:"<repo>") { issue(number:<n>) { id } } }'`, then run `gh api graphql -f query='mutation { addBlockedBy(input: {issueId: "<dependent-node-id>", blockingIssueId: "<blocker-node-id>"}) { clientMutationId } }'` so the blocker shows natively on the dependent. **Completion criterion**: every tracer-bullet issue carries `ready-for-agent` (NOT `wayfinder:map` — that label is path 1's decision tickets only), and every `[blocks:]` edge in the plan file renders as a native blocking link on the tracker.

## Fallback (local markdown)

Use the fallback ONLY when one of the following holds:

- No GitHub remote on the local clone (`git remote get-url origin` fails).
- `gh` CLI not installed (`gh --version` exits non-zero) or not authenticated (`gh auth status` reports not logged in).

In fallback mode:

- Plan lives in `plans/<feature>.md` as today.
- Decision / spec / ticket files live in `docs/wayfinder/tickets/` and `docs/specs/`.
- The plan header must record the fallback rationale so a reader knows why no tracker edges exist.

## Handoff boundary interaction (gh-22)

The tracker choice interacts with the wayfinder → spec handoff boundary (gh-22). When the main path is active:

- Map tickets live on GitHub with the `wayfinder:map` label.
- After the map clears, the handoff target is `spec-driven-development` (default) — its output is a spec issue (step 2 above) — or `writing-plans` directly when the grilling ticket's Resolution already contains the 5 spec sections per gh-22's exception clause.
- Plan tickets then follow step 3 with native blocking edges.

When the fallback is active, the handoff boundary still applies (map closes → spec or plans), but the artifacts are local markdown files instead of GitHub issues. The contract is the same; the storage changes.

## Fusion note (gh-08 + gh-16)

This section documents the fusion of gh-08's tracker decision into the writing-plans skill. The original gh-16 ticket scoped a new `tracker-publisher` skill; per gh-07 (Fusion strategy) that surface is intentionally not created — the publisher responsibilities are fused into writing-plans here, with `gh issue create` plus the GraphQL `addBlockedBy` mutation as the direct CLI surface.
