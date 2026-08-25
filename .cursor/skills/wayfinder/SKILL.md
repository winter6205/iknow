---
name: wayfinder
description: Use when a chunk of work is more than one agent session can hold — plan it as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear.
bucket: engineering
version: 1.0.0
tags: [Planning, Map, Tickets, FogOfWar, Orchestration, DecisionTracking]
related_skills: [logicsync, domain-modeling]
disable-model-invocation: true
---

A loose idea has arrived — too big for one agent session, wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding finds that way; it doesn't charge at the destination. The skill charts the way as a **shared map** on the repo's issue tracker, then works its **decision tickets** — questions whose resolution is a decision — one at a time until the route is clear.

The destination varies per effort; naming it is the first act of charting — it shapes every ticket. The map is domain-agnostic.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone does the work. The pull to just do the work signals you've reached the map's edge — time to hand off. An effort can override this in **Notes** to carry execution into the map; absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket has a **name** — its issue title. In everything the human reads, refer to it by name, never by bare id or slug. The id and URL ride _inside_ the name, never stand in for it.

## Input

A loose idea (one-line ask) or an existing map (URL/number) on the repo's issue tracker. Wayfinder reads, doesn't write code.

| Input source                       | 形态                                    | 消费方式                                                                                          |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Loose idea from operator           | inline one-line ask                     | `## Invocation` chart mode: drives the `arthurpower:logicsync` session that names the destination |
| Existing map (URL or issue number) | tracker URL / id                        | `## Invocation` work-through mode: load low-res map, pick or accept a frontier ticket             |
| Map's `## Notes` block             | tracker issue body                      | names skills every session should consult before claiming                                         |
| Related / closed ticket bodies     | tracker issue bodies, fetched on demand | zoomed in only when the current ticket depends on their resolution                                |

**What this skill does NOT consume**：code or deliverables (wayfinder produces decisions, not artefacts), `docs/CONTEXT.md` / ADR files (it emits decisions that may _trigger_ an ADR via `arthurpower:domain-modeling`, never reads or authors them), or any spec/plan (downstream — `arthurpower:spec-driven-development` owns the spec, `arthurpower:writing-plans` owns the plan).

## Output

A cleared map on the tracker: `wayfinder:map` issue, its child tickets (research / prototype / grilling / task), a `Decisions-so-far` index, and a routing decision to the next skill.

| Artifact                            | 落点                                    | 下游消费者                                                                             |
| ----------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `wayfinder:map` issue               | tracker, label `wayfinder:map`          | next session re-loads as low-res index                                                 |
| Decision tickets (one per question) | tracker, child issues of the map        | resolved one-per-session; resolution comment closes the ticket                         |
| `## Decisions so far` index         | `wayfinder:map` issue body              | downstream skills orient from this index, not raw ticket bodies                        |
| Handoff routing decision            | recorded in map's `## Notes` on handoff | default `arthurpower:spec-driven-development`; skip-spec → `arthurpower:writing-plans` |

**Explicit non-outputs**：working code or any deliverable (the `## Plan, don't do` stop-gate holds), the spec itself (lives in `arthurpower:spec-driven-development` output), the plan (lives in `arthurpower:writing-plans` output), and `CONTEXT.md` glossary terms (those belong to `arthurpower:domain-modeling`).

## The Map

The map is a single issue labelled `wayfinder:map` — the canonical artifact. Its tickets are child issues.

The map is an **index**, not a store. A decision lives in exactly one place — its ticket — so the map only gists and links.

**Where the map, its tickets, blocking, and frontier queries live is tracker-specific.** The tracker should have been provided — set one up if not; default to GitHub issues (label `wayfinder:map`). Local markdown (`docs/wayfinder/tickets/`) is a fallback only, when the `gh` CLI is unavailable (no GitHub remote, or `gh` not installed).

The map and ticket body **templates** are disclosed at [`references/map-templates.md`](./references/map-templates.md) — load only when charting a new map.

### Tickets

Each ticket is a **child issue** of the map; the tracker's issue id is its identity. Its body is the **Question** template from `references/map-templates.md`, sized to one 100K token agent session.

Each ticket carries a `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`.

A session **claims** a ticket by assigning it to the dev, **first**, before any work, so concurrent sessions skip it. That assignee _is_ the claim: an open, unassigned ticket is unclaimed.

Blocking uses the tracker's **native** dependency relationship — it renders the frontier visually in the tracker UI. Only a tracker lacking native blocking falls back to a body convention. A ticket is **ready** when every ticket blocking it is closed; the **frontier** is the open, ready, unclaimed children — the edge of the known.

The answer is recorded on resolution (see `## Invocation`). Assets created while resolving a ticket are linked from the issue, not pasted in.

## Ticket Types

Every ticket is either **HITL** — worked _with_ a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange.

- **Research** (AFK): Reading docs, third-party APIs, or local resources to surface a fact a decision waits on. Resolved by a research **subagent**. Use when knowledge outside the working directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, concrete artifact to react to — an outline, a stub, or UI/logic code as a rough prototype. Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation via `arthurpower:logicsync` (coupled in one reply). The default case.
- **Task** (HITL or AFK): Manual work that must happen before a _decision_ can be made — nothing to decide, prototype, or research, but the discussion waits until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This type _does_ rather than decides — earning its place by clearing the path for a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts later tickets depend on.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — decisions you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead, graduating what's now specifiable into fresh tickets.

The **Not yet specified** section holds that dim view: suspected questions, areas to revisit. Everything here is in scope, just not sharp enough to ticket. Write as loosely or fully as the view allows.

**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it has prerequisites and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog: it's coarser than a ticket, and one patch may graduate into several tickets, or none.

**Not yet specified** excludes what's already decided, what's already a live ticket, and what's out of scope.

## Out of scope

The destination fixes the scope. Work beyond it is **out of scope** — not fog, not for **Not yet specified**. Scope, not sharpness, lands it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn. When a ticket sits past the destination, **close it** and leave one line in **Out of scope**: gist plus why, linking the closed ticket. It stays out of **Decisions so far**, which records the route actually walked.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** — research tickets excepted. Full step lists at [`references/invocation.md`](./references/invocation.md):

- **Chart the map** — user invokes with a loose idea.
- **Work through the map** — user invokes with a map (URL or number); ticket optional, without one you pick the next decision.

Load the relevant mode's steps from `references/invocation.md` before starting.

## Handoff

When the map clears (frontier empty, all tickets resolved), wayfinder stops: it hands off, it doesn't build. A cleared map owes the next skill a clean seam, not more decisions.

**Stop gate.** Before any handoff action, confirm the handoff target with the operator — same shape as logicsync 结束 (summary in the reply, wait for next message); the target is a human decision, not an inference. Present the 3-way choice:

1. **spec-driven-development** (default) — when the Decisions-so-far set scope / strategy / sequencing that need collapsing into a buildable spec.
2. **writing-plans** (skip spec) — only when the active grilling ticket's Resolution already contains all 5 sections (Problem / Solution / Implementation Decisions / Testing Decisions / Out of Scope); otherwise return to option 1.
3. **Other** — operator-named target.

If the operator answers (1) or (2), route to that skill. If (3), record the chosen target in the map's Notes and route accordingly. Never auto-route from "map cleared" alone.

This mirrors Matt `ask-matt/SKILL.md` line 46: _"When the map clears, it hands off, it doesn't build: merge onto the main flow at /to-spec"_ — the skip path there is the exception. See `docs/wayfinder/tickets/gh-22-handoff-contract.md` for the 3 ratified decisions and `arthurpower/skills/spec-driven-development` Context-loop pre-read for the receiving side.
