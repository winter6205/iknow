# Example — Full SPECIFY Phase Walkthrough

1 end-to-end runnable example showing the full SPECIFY phase from vague ask to spec doc + 5-verdict gate.

```markdown
# SPECIFY phase: user profile page

## Human reviewer ask

"Add a profile page where users can edit their display name and email preferences."

## Step 1 — Assumptions surfaced (gate)

ASSUMPTIONS I'M MAKING:

1. Web app (Vue 3 SPA), not native mobile
2. Auth is session cookie (existing), not OAuth/OIDC
3. Postgres + Alembic (existing stack), not MongoDB
4. Form submission is partial update (PATCH), not full PUT
5. Email preferences is a JSON column (marketing / transactional / digest), not a separate table
6. Avatar upload is out of scope (separate ask)
   → Human reviewer confirms: 1-6 yes, 6 explicitly deferred.

## Step 2 — Spec doc (committed at specs/user-profile.md)

# Spec: user profile page

## Objective

Logged-in user views and edits their own profile (display name, email preferences). Read-only for other fields (email, created_at).

## Boundaries

- **Does:** GET/PATCH /api/me; form validation; unauthenticated → 401
- **Confirms with human:** schema or CI changes beyond the columns already confirmed
- **Out of this spec:** avatar upload (assumption 6)

## Success Criteria

- GET /api/me returns 200 with UserProfile JSON for authenticated user
- PATCH /api/me accepts partial update, returns 200 with updated profile
- Unauthenticated request to /api/me returns 401
- Invalid display_name (>50 chars / empty / control chars) returns 422
- Form shows validation errors inline
- Refresh shows new display_name and email_prefs values
- pnpm test + pytest -q both exit 0
- playwright e2e profile-flow.spec.ts passes

## Open Questions

(none — assumption gate cleared all)

## Inherits / Changes

This workspace already has Vue 3 + FastAPI + Postgres; quote those as the surface the contract runs on.
Changes: add display_name + email_prefs columns; GET/PATCH /api/me; profile page + form on the existing users surface.

## Step 3 — Reframed success criteria (binary)

- display_name length ∈ [1, 50] and not control chars → 422 otherwise
- email_prefs is JSON object with marketing/transactional/digest boolean keys
- PATCH /api/me returns 200 + updated profile in < 200ms p95
- playwright profile.spec.ts exits 0

## Step 4 — architecture-change-reviewer verdict block

bounded-context-guardian: yes — users/ bounded context exists, new code lives in users/api/, no cross-context import.
defensive-contract-validator: yes — UserProfileUpdate covers empty display_name (422), too-long (422), invalid email_prefs (422), unauthenticated (401), DB failure (typed ProfileUpdateError).
error-handling-enforcer: yes — typed exception ProfileUpdateError, no empty catch, // EXIT: validation failed, return 422 documented on early-return.
complexity-anti-drift: yes — plan keeps one abstraction level per function: update_profile() composes 3 helpers (validate_display_name / coerce_email_prefs / persist) instead of inlining the flow; no god-file planned.
minimal-change-verifier: yes — one task (user profile page); diff stays in that scope.

All 5 verdicts yes → spec advances.

## Step 5 — Hand off to writing-plans

Spec path: specs/user-profile.md
Plan path: plans/user-profile.md (consumed by writing-plans)
```

Note: The example shows the full SPECIFY phase loop — Step 1 assumption gate (6 assumptions confirmed individually + 1 explicitly deferred) → Step 2 required-area spec doc → Step 3 vague-to-binary reframing → Step 4 ACR 5-verdict all yes → Step 5 handoff to writing-plans. Each step corresponds to a real failure mode (assumptions skipped → silent context drift / vague criteria → unverifiable "done" / ACR skip → plan on shaky ground).

## Cross-references

- Architecture gate: `architecture-change-reviewer` (5-verdict frame, runs after SPECIFY)
- Plan + tasks + implement: `writing-plans` (PLAN / TASKS / IMPLEMENT, consumes the spec)
- Bounded context ownership: `bounded-context-guardian` (verdict 1 of 5)
- Defensive contract: `defensive-contract-validator` (verdict 2 of 5, 5 boundary classes)
- Error handling: `error-handling-enforcer` (verdict 3 of 5, typed exceptions)
- Complexity: `complexity-anti-drift` (verdict 4 of 5, one abstraction level per function; nesting ≤ 4)
- Minimal change: `minimal-change-verifier` (verdict 5 of 5, one task / in-scope diff)
- Skill authoring: `skill-authoring` (CSO + TDD-for-skills for this skill)
