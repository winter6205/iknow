# 0002. web UI flip: Variant A "soft light · rounded" design language + Tailwind v4 styling

Date: 2026-07-31
Status: accepted

## Context

After 022's migration finished adapting the web frontend's functionality, the UI still carried the 020-era "forest cockpit" dark functional-prototype style (CSS Modules + hand-written CSS variables, 7 `.module.css` files totalling 737 lines). Review (wayfinder grilling, comment `5135170423`) decided to move the web UI from "visual polish" to "archive the old version + rewrite with Tailwind", using the winning Variant A prototype as the design reference (branch `worktree-web-prototype-variants` @ `5796a73`).

`docs/design/frontend-stack-upgrade-v1.md` §3/§8 originally froze "no Tailwind", and §6/§9 originally defined the dark forest cockpit — both need an explicit flip (already recorded in place in that document's §0 Decision Flip).

## Decision

1. **Design language**: retire the forest cockpit dark theme, adopt Variant A "soft light · rounded" — warm off-white `#f6f3ec` + pine green `#3e6b52` + 20px soft corner radius + layered soft shadows + Outfit Variable / IBM Plex Sans / IBM Plex Mono.
2. **Styling approach**: introduce **Tailwind v4** (`@tailwindcss/vite` plugin + CSS-first `@theme`), overturning the v1 §3/§8 freeze. Design values go into the `@theme` block of `web/src/styles/tokens.css` (zero config files, no PostCSS chain).
3. **Delivery boundary**: components + style rewrite only; the data pipeline (`useSessionChat` / `api/client.ts` / `api/types.ts`) and the backend wire are untouched.
4. **G2 evidence-projection scope ruling**: review once required rendering `source_spans / governance_status / snapshot_id / hops_used / notes`, premised on G2 being on the wire; but spec 022 (already merged) retired the G2 envelope, leaving `TurnAnswerDto = { finalText, stopReason, turnCount }` (`src/session-api/contract.ts:18-22`). **Ruling**: component structure fully implements evidence projection (reusing Variant A), wired in via **optional props**; the data pipeline and backend wire are **not changed**. The evidence UI does not fire currently (props undefined) — capability reserved; putting G2 back on the wire is handled by a **separate ticket** (which must flip spec 022 Q1). Precedent: `renderBody` reserved without implementation.

**Why not alternatives:**

- _Keep CSS Modules + hand-written variables_: zero new dependencies, but Variant A's color/radius/shadow/spacing tokens are expressed more compactly via Tailwind `@theme`, and utility classes eliminate the duplication across the 7 `.module.css` files; rollback cost was accepted in review.
- _Tailwind v3 (postcss + autoprefixer)_: requires postcss.config + tailwind.config + content globs; v4 is zero-config, auto-scans content, and is contemporaneous with Vite 6 / React 19, so v4 was chosen.
- _shadcn/ui component library_: template-risk (excluded consistently with v1); take only Tailwind's styling layer.
- _Next.js (prototype-cli-integration plan A)_: not adopted; the UI stack stays Vite (plan B route).

**A8 spirit assessment (new dev dependency)**: Tailwind is a dev dependency (`tailwindcss` + `@tailwindcss/vite`), not runtime, and never enters the product bundle's runtime. A8's wording was scoped to 022, but its spirit — "tech-stack changes require a new-assumption gate" — is a project-level Iron Law; this ADR is that assessment gate. Build-chain impact = a single Vite plugin injection; does not violate A10 (not a test framework).

## Consequences

- (+) Eliminates the 7 `.module.css` files; design tokens have a single source (`@theme`); visual consistency.
- (+) Variant A's design values map naturally onto Tailwind utility classes.
- (−) Adds 2 dev dependencies + a root lockfile change.
- (−) The evidence-projection component currently has no wire data driving it (reserved state); a future ticket must close this.
- Rollback = rewrite the styling layer again (hard to reverse, hence this ADR).

**Evidence pointers**: issue comment `5135170423` (20 decisions) · commit `5796a73` (Variant A primary source) · `src/session-api/contract.ts:18-22` (wire truth) · `docs/design/frontend-stack-upgrade-v1.md` §0 + §3/§6/§8/§9 (flipped in place).
