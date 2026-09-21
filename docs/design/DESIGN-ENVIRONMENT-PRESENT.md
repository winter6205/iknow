# DESIGN-ENVIRONMENT-PRESENT · environment-presence anchor in the TUI

> Package: horizon perception · acceptance profile locked
> Plan: the perception plan (anchor item)
> Spec: the perception spec — Boundaries · Success Criteria
> Status: decided (anchor locked)

## Context

The acceptance goal requires the TUI operator to see the workspace's current
state (cwd / git summary / diff highlights) at a glance, while **not**
polluting the ADR-0028 status bar (`agent_status` user messages). The spec
already fixes:

- The data is **for the human, not the model** — **not** into `messages`,
  **not** as verify input, **not** into the ADR-0028 status-bar user messages.
- The anchor must be **one fixed landing spot**, pinned by the plan among
  next-to-banner / strip / footer.
- The summary defaults to a **2000 codepoints** cap (the plan may tune the
  number; the cap itself must not be removed).
- Failure states (cwd unresolvable / not a git repo / refresh throws) render a
  degraded placeholder and **never throw**.

The TUI already has `AgentStatusLine` (`src/tui/agent-status-line.tsx`), which
is the **model-facing status bar** (ADR-0028) as a **read-only projection** in
the TUI chrome — it reads `agent_status` stream events / snapshots and never
writes back. If the two concepts (human-read vs model-facing) shared one
stream or one slot, you would get bidirectional pollution — "human-read fields
being read by the model" or "model fields mis-projected onto human UI" —
violating the spec's negative contract (not in messages / not verify input /
not written to the status bar).

The exploration-phase conclusion: introduce a separate `EnvironmentPane` /
`EnvPresenceStrip` naming (avoiding collision with `AgentStatusLine`), mounted
in the TUI chrome area, **not** in the `agent_status` stream events and **not**
in `messages`.

## Decision

**Environment presence = a new independent slot in the human-read TUI chrome,
alongside `AgentStatusLine`, not reusing its data source.** Four pinned
resolutions:

1. **Anchor**: the human-read TUI chrome row (same chrome region as
   `AgentStatusLine`, in parallel).
   - Naming options: `EnvironmentPane` (a whole block with cwd + git summary +
     diff highlights) or `EnvPresenceStrip` (a single row with cwd + short git
     summary); neither collides with `AgentStatusLine`.
   - The implementer may pick either, but must stay **consistent throughout** —
     one component name = one definition = one mount point.
2. **Data source**: an independent stream **parallel** to `AgentStatusLine` —
   an "environment presence snapshot" event computed by harness / TUI.
   - **Do not** reuse the `agent_status` events, its snapshot structure, or the
     existing verify projection seam in `session-api/turn-projection.ts`.
   - The snapshot refreshes at user-visible turn boundaries; it is not
     appended per tool call into the model context (the spec's refresh
     discipline).
3. **Cap**: summary ≤ **2000 codepoints** (measured with
   `String.prototype.length`); an over-long diff is truncated with an explicit
   `(truncated)` marker.
4. **Not verify input**: the environment-presence component is read by **no**
   path of verify / judge / goal / advisor; its data flow and
   `VerificationRecord` never cross.

## Consequences

**Positive:**

- The anchor is **unique**, so the plan's acceptance can assert with a single
  grep (exactly one `EnvironmentPane` / `EnvPresenceStrip` definition + mount
  point under `src/tui/`).
- The human-read and model-facing streams are **physically isolated** —
  `agent_status` remains exclusive to the ADR-0028 status bar, and environment
  presence introduces a new event type; any regression that "writes
  human-read fields into the model bar" is caught at the compile/type boundary.
- The 2000-codepoint cap is written into the acceptance as a hard constraint,
  so the overflow path exercised by the closing test run
  (`npx vitest run tests/tui tests/harness/verify tests/session-api`) has a
  documented basis.
- The naming `EnvironmentPane` / `EnvPresenceStrip` avoids the
  `AgentStatusLine` collision, so a later contributor cannot assume "same
  component, swap the data source" will work.

**Negative (must hold):**

- **Not** on the `agent_status` append path — grepping `agent_status` in new
  files such as `src/tui/environment-*.tsx` / `src/harness/env-snapshot.ts`
  must return **zero hits** (the closing grep enforces the negative contract).
- **Not** into `messages` — the snapshot consumer side (`src/tui/**`) must
  **not** call `messages.push` nor submit any user message containing
  cwd/git/diff to the hub.
- **Not** verify input — no read path of `VerificationRecord` / the hub may
  back-reference `EnvSnapshot` / `EnvironmentPane`.
- **Not** written to the ADR-0028 status bar — the status-bar write paths in
  `src/harness/agent-status.ts` / `build-engine.ts` do **not** accept
  cwd/git/diff fields.

**EXIT (typed-failure boundaries, aligned with the spec's Boundaries section):**

- cwd unresolvable → placeholder `(cwd unavailable)`, **no throw**.
- non-git workspace / `git` failure → `(not a git repo)` /
  `(git unavailable)`, **no throw**.
- refresh throws → keep the previous frame's snapshot or a placeholder; the
  error goes to the trace/log side channel, **not** into the model context.
- whole snapshot absent → the component silently disappears (**no** placeholder
  row rendered), avoiding empty strings in the UI.

**Acceptance anchors (plan item closure):**

- This decision file exists and points to exactly one component name → the
  plan's acceptance bullet is checked off as `Status: [x] done — <commit sha>`.
- Closing run: exactly one `EnvironmentPane` / `EnvPresenceStrip` definition +
  mount point under `src/tui/`; `grep -r agent_status src/tui/environment-*`
  returns **zero hits**; `npx vitest run tests/tui tests/harness/verify
  tests/session-api` is green.
