# Example: user profile page (tracer bullets, not a recipe)

Contrast with a recipe plan: that version would list `migrations/versions/abc_add_profile_fields.py`, `UserProfileUpdate`, and a `curl` with a cookie. Those are implementer choices. This version keeps the demoable end-to-end outcomes and the contracts already in the spec.

```markdown
# Plan: user profile page

**Goal:** A logged-in user can view and edit avatar, display name, and email preferences.
**Approach:** Settle avatar storage as a recorded decision; persist new profile fields; expose read/update on the existing me/API surface; add a profile page that uses the design system. CLI/auth flows stay unchanged.
**Spec link:** `docs/specs/user-profile.md`
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## ACR

(paste the 5-line all-yes block from architecture-change-reviewer)

## Tasks (ordered by dependency)

1. **Record the avatar storage decision** — tag: `[decision]`
   - **Inherits:** spec: avatar uploads are capped at 2 MB
   - **Surface:** `docs/adr/` — the ADR file (`<next>-avatar-storage.md`) is this bullet's outcome
   - **Acceptance:** the ADR states the winning storage option with rationale; the spec's contract section cites it; the commit touches no code
   - Status: [ ] pending

2. **Persist profile fields, avatar reference included** — tag: `[implementation]`
   - **Inherits:** spec: columns are additive; downgrade restores the previous shape; avatar is stored as a reference per T1's ADR
   - **Surface:** existing user persistence / migration stack
   - **Acceptance:** after upgrade, a user row can store and read display name, email preferences, and an avatar reference; downgrade is possible
   - [blocks: T1]

3. **Validate profile read and update payloads** — tag: `[implementation]`
   - **Inherits:** spec: display name length cap; email_prefs is a boolean map; empty update is a no-op
   - **Surface:** existing user schema / DTO module
   - **Acceptance:** valid payloads round-trip; over-long name and malformed prefs are rejected
   - [blocks: T2]

4. **[parallel] Authenticated me read/update** — tag: `[implementation]`
   - **Inherits:** spec: unauthenticated → 401; success returns the profile shape from T3
   - **Surface:** existing API router for the current user
   - **Acceptance:** session cookie can GET the profile and PATCH display name; no session → 401
   - [blocks: T2, T3]

5. **[parallel] Profile form matches design system** — tag: `[implementation]`
   - **Inherits:** spec: fields = avatar, display name, email prefs; client-side validation mirrors T3
   - **Surface:** existing web component / design-system package
   - **Acceptance:** form submits the update endpoint; validation errors render; visual tokens come from the design system
   - [blocks: T3]

6. **Profile page is reachable and survives refresh** — tag: `[implementation]`
   - **Inherits:** spec: route `/profile`; refresh shows last saved values
   - **Surface:** existing web app shell / router
   - **Acceptance:** navigate → edit → submit → refresh still shows the new display name; suite that covers this page is green
   - [blocks: T4, T5]
```

Headroom in this example: T1 names the ADR file because that file is the outcome, but it does not pre-select the storage option — the decision itself is the bullet's work. T2 does not name the migration file; T3 does not name Pydantic classes; T4 does not prescribe `curl`; T5 does not freeze `ProfileForm.vue`. Implementers still share the same observables.
