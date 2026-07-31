# Frontend stack upgrade v1 — decision record

> Status: **Implemented** (Vite React TS product console under `web/`) + **review repair pass** for commit `198759b` (see `docs/handoff/2026-07-12-review-repair-198759b.md`).  
> Scope: product console SPA only (host presentation). **Does not** change 4-tool protocol or G2 envelope.  
> Related: `plans/frontend-stack-upgrade.md` · `docs/design/session-http-api-v0.md` · `docs/design/interaction-surface-v0.md`  
> Supersedes (for FE stack only): static zero-deps shell narrative in early I3.5 handoff.

---

## 0. Decision Flip (issue #92, 2026-07-31)

Two stack decisions recorded below were **explicitly flipped** by the issue #92 discussion
(wayfinder grilling, comment `5135170423`). This section is the authoritative flip record;
the original text is preserved inline with strikethrough/annotation. ADR-0002 carries the
hard-to-reverse rationale.

| #   | Original decision                                                          | Flip                                                                                                                     | Why                                                                                                                                                                |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | §3/§8 Style = CSS variables + CSS Modules, **no Tailwind** (template-risk) | **Tailwind v4** (`@tailwindcss/vite`, CSS-first `@theme`)                                                                | Issue #92 decision #3. Variant A design values map cleanly into a Tailwind `@theme`; zero config files; no PostCSS chain. shadcn component library stays excluded. |
| F2  | §6/§9 Design language = dark “forest cockpit”                              | **Variant A「软光 · 圆滑」** (warm off-white `#f6f3ec` + pine green `#3e6b52` + 20px soft radius + layered soft shadows) | Issue #92 decision #2/#5. PR #21 prototype Variant A won user review; forest cockpit retired.                                                                      |

**Scope ruling (issue #92 #1 vs #13-16).** Decision #1 bounds delivery to _component + style
rewrite; data pipeline preserved_ (`api/types.ts` / `client.ts` / `useSessionChat.ts` unchanged).
Decisions #13-16 ask to render evidence fields (`source_spans` / `governance_status` /
`snapshot_id` / `hops_used` / `notes`), whose premise — G2 fields on the wire — was **retired by
spec 022** (SC6/SC8, merged via PR #90): `TurnAnswerDto = { finalText, stopReason, turnCount }`.
**Ruling:** components fully implement the evidence-projection structure (faithful to #13-16,
reusing Variant A) via **optional props**, but the data pipeline and backend wire are **not**
changed. Evidence UI does not trigger today (props undefined) — capability is reserved; putting
G2 back on the wire is a **separate ticket** (would re-flip spec 022 Q1). Precedent: decision #19
already reserves `renderBody` without implementing Markdown.

**UI stack unchanged:** Vite (not Next.js — the prototype-cli-integration proposal A is not adopted).

---

## 1. Context

I3.5 introduced Session HTTP (`src/session-api/`) and a same-origin chat surface. The first shell was zero-dependency static HTML/JS under `web/` to minimize surface area.

That was correct for a proof host. A multi-turn **product console** needs:

- Typed DTOs aligned with Session API
- Component split (list / composer / G2 panel / states)
- Strict TypeScript build gate
- Design tokens without “default AI purple” template look

This record freezes the **SPA stack** and layout. Backend paths stay `/api/v1/*`; SSE remains reserved (**501** until a later slice).

---

## 2. Why React (over Vue / Svelte / stay-static)

| Option                          | Pros                                                                        | Cons                                                             | Verdict                   |
| ------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------- |
| Stay static (HTML + ES modules) | Zero FE deps                                                                | No component model, weak TS gate, hard multi-turn productization | **Reject** for product UI |
| **Vite + React + TS**           | Aligns with Node/TS monorepo; large a11y/hiring ecosystem; stable SPA model | Slightly heavier than Svelte                                     | **Select**                |
| Vite + Vue 3                    | Strong DX                                                                   | Second paradigm vs backend TS mental model                       | Runner-up                 |
| Vite + Svelte                   | Small bundle                                                                | Smaller enterprise ecosystem for this team                       | Defer                     |
| Next.js / full RSC              | SSR/RSC story                                                               | Overkill; production already serves via `iknow serve`            | **Reject**                |

**Decision:** host presentation is a **Vite 6 + React 19 + TypeScript** SPA in package `web/` (`iknow-web`). Protocol and Session API are unchanged.

---

## 3. Stack table

| Layer         | Choice                                                      | Notes                                                                                                                                                 |
| ------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundler / dev | Vite 6                                                      | `web/vite.config.ts`; HMR; `base: "/"`                                                                                                                |
| UI library    | React 19                                                    | Component model for chat + G2 side panel                                                                                                              |
| Language      | TypeScript (strict)                                         | `web/tsconfig.json`; `tsc --noEmit` in build                                                                                                          |
| React plugin  | `@vitejs/plugin-react`                                      | Standard JSX transform                                                                                                                                |
| Style         | **Tailwind v4** (`@tailwindcss/vite`) + CSS `@theme` tokens | `web/src/styles/tokens.css` (`@theme` block), `global.css` — design values from PR #21 Variant A (issue #92 flip; see Decision Flip below + ADR-0002) |
| Fonts         | Self-hosted `@fontsource/ibm-plex-sans` + `ibm-plex-mono`   | No Google Fonts runtime CDN                                                                                                                           |
| Icons         | Inline SVG / CSS sparingly                                  | No heavy icon pack in v1 shell                                                                                                                        |
| Client state  | Bounded session store (hook + reducer pattern)              | One conversation surface; server remains source of turns                                                                                              |
| HTTP client   | `web/src/api/client.ts` + `types.ts`                        | Mirrors Session API v0 DTOs                                                                                                                           |
| Dev proxy     | Vite `server.proxy["/api"]` → `http://127.0.0.1:8787`       | Same-origin mental model in dev                                                                                                                       |
| Prod static   | `web/dist`                                                  | Prefer `web/dist` in `resolveDefaultWebRoot()`; fallback `web/` if dist absent                                                                        |
| Host process  | `iknow serve` / `npm run serve`                             | `node:http` Session API + static SPA                                                                                                                  |

**Not chosen this slice:** shadcn component library (template-risk), Motion-heavy animation, Next.js, production auth UI, message-id product model. _(Tailwind was originally excluded; **flipped in issue #92** — see Decision Flip below.)_

---

## 4. Component tree (product UI)

Target layout under `web/src/`:

```text
web/
  package.json              # iknow-web scripts: dev / build / preview / typecheck
  vite.config.ts
  tsconfig.json
  index.html                # #root + /src/main.tsx
  src/
    main.tsx
    App.tsx
    vite-env.d.ts
    api/
      client.ts             # health / sessions / messages / commands / reset
      types.ts              # G2 + Session DTOs
    hooks/
      useSessionChat.ts     # bootstrap / submit / reset / mode·role commands
    styles/
      tokens.css            # forest cockpit design tokens
      global.css
    components/
      AppShell.tsx          # chrome: header + main + side
      ChatHeader.tsx        # session meta, mode/role, new session
      MessageList.tsx       # turn timeline
      MessageBubble.tsx     # user / agent bubbles
      Composer.tsx          # input + send (empty send disabled)
      G2Panel.tsx           # snapshot / governance / hops / spans / tools
      StateBlock.tsx        # empty / loading / error / data phases
      ErrorBoundary.tsx
  dist/                     # vite build output (served in prod)
```

**Presentation rules (unchanged from interaction design):**

- Answer body: `human_text` preferred, else `answer.text`
- Side panel always projects G2: `snapshot_id`, `governance_status`, `hops_used`, `source_spans`, `tool_calls`
- **Forbidden:** pretty text without G2 fields
- UI **does not** call the 4 tools; priors stay server-side

**UI phases:** `idle → loading → ready ⇄ sending`, with recoverable `error`.

---

## 5. Dev / prod commands

From repository root (Node ≥ 20). Frontend package lives in `web/` (own `package-lock.json`).

### Install

```bash
npm install --prefix web
```

### Development (two processes)

```bash
# Terminal A — Session API + (optional) static root
npm run serve
# or: npx tsx src/cli.ts serve --port 8787 --mode deterministic

# Terminal B — Vite SPA with /api proxy → :8787
npm run dev --prefix web
# open http://127.0.0.1:5173/
```

Root convenience aliases (when present in root `package.json`):

```bash
npm run web:dev    # → vite in web/
npm run web:build  # → tsc --noEmit && vite build in web/
```

If root aliases are absent, use `npm run <script> --prefix web` as above.

### Production static

```bash
npm run build --prefix web   # emits web/dist/index.html + assets
npm run serve                # prefers web/dist; SPA fallback to index.html for non-API GET
```

### Quality

```bash
npm run typecheck --prefix web
npm test                     # includes session-api; static index assert soft-skips if dist missing
```

---

## 6. Design language — “Variant A · 软光 · 圆滑” (Soft Light)

> **Flipped (issue #92, 2026-07-31):** the former “forest cockpit” dark language is **retired**. The product console now adopts PR #21’s winning prototype Variant A — warm light, soft rounded cards, single pine-green accent. See the Decision Flip section at the top of this document and ADR-0002.

Product console for operators (not a marketing landing). Warm light surface, soft rounded cards, restrained motion.

| Token family  | Intent                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| Base surfaces | Warm off-white (`--color-bg` `#f6f3ec`); card surface `--color-surface` `#fffdf8`         |
| User bubble   | Soft sage `--color-user` `#eef0e6`                                                        |
| Text          | Dark olive-black (`--color-ink` `#23281f`) + secondary/tertiary alpha steps               |
| Accent        | Pine green (`--color-accent` `#3e6b52`), single accent — not purple gradient “AI default” |
| Status        | ok (pine) / warn (`#a3781f`) / danger (`#b04a3a`) + soft tints                            |
| Radius        | 20px soft cards/bubbles · 12px panels · 999px pills                                       |
| Shadow        | Layered soft shadows (bubble / card / chip)                                               |
| Type          | Outfit Variable (display) + IBM Plex Sans (UI) + IBM Plex Mono (ids, hops)                |
| Density       | Chat-first; left session sidebar + centered message column (no right G2 panel)            |

Source of truth for colors/spacing: `web/src/styles/tokens.css` (`@theme` block).

**Dials (design taste):** variance moderate · motion low–moderate (stagger + soft expand) · density moderate.

---

## 7. Boundaries with backend

```text
[ Vite React SPA ]  --JSON-->  [ session-api HTTP ]  --host-->  [ ConversationState ]
        |                              |
        |                              +--> Agent.answer(query, { prior_chunks, history })
        v
   web/dist/*  (prod) or Vite dev server (dev)
```

| Concern              | Owner                                     |
| -------------------- | ----------------------------------------- |
| 4 tools + hops + G2  | `src/kb-*`, `src/agent-loop/`             |
| Session bag / priors | `src/interaction/`, `src/session-api/hub` |
| HTTP contract        | `docs/design/session-http-api-v0.md`      |
| UI projection only   | `web/`                                    |

---

## 8. Non-goals

- No fifth KB tool (`kb_chat` / `kb_memory`)
- No protocol change to G2 required fields
- No production auth / IdP / multi-tenant isolation in this stack slice
- No SSE token streaming until `GET …/sessions/:id/events` is implemented (**currently 501**)
- No claim that “pretty UI” may drop `snapshot_id` / `source_spans`
- No runtime link to `_upstream_gbrain/`
- No Next.js / separate deploy story required for v1 host
- ~~No Tailwind/shadcn as default look~~ **Flipped (issue #92):** Tailwind v4 is now the styling layer (shadcn component library still excluded)

---

## 9. Honest capability status (do not over-claim)

| Item                                           | Status                                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite + React + TS package under `web/`         | **Implemented** (buildable package + product UI)                                                                                                                                                                        |
| Design tokens + API client types               | **Yes**                                                                                                                                                                                                                 |
| `iknow serve` prefers `web/dist`               | **Yes** (`resolveDefaultWebRoot`); SPA at site root `/` (not `/web/`)                                                                                                                                                   |
| Componentized product UI files                 | **Implemented** under `web/src/components/*` + `useSessionChat`                                                                                                                                                         |
| Review repair pass (`198759b`)                 | **Done** — stale async gen, optimistic mode/role, sourcemap leak, composer clear-before-send, CSS/a11y clusters; base-path HIGH deferred as false positive. Handoff: `docs/handoff/2026-07-12-review-repair-198759b.md` |
| Session API create / message / command / reset | **Yes** (in-memory)                                                                                                                                                                                                     |
| SSE streaming                                  | **Not implemented** → **501** on reserved path                                                                                                                                                                          |
| Production auth                                | **Not implemented**                                                                                                                                                                                                     |
| Persistent sessions / KB                       | **Not implemented** (memory only)                                                                                                                                                                                       |
| Light theme                                    | **Adopted (issue #92 flip):** Variant A warm-light is now the default; dark forest cockpit retired                                                                                                                      |

---

## 10. Success criteria (stack upgrade)

- [x] Decision: React + Vite + TS recorded (this doc)
- [x] `web/` is a separate npm package with Vite build scripts
- [x] Prod host path preference: `web/dist` then fallback
- [x] Product UI components implemented (chat + G2 panel + composer + shell)
- [x] Review repair pass for live review of `198759b` (see handoff)
- [x] `npm run build --prefix web` intended green with product components
- [x] Serve dist: chat create+message returns full G2; panel shows snapshot (host contract unchanged)
- [x] SSE still **501** until a dedicated streaming task (non-goal of this slice)

**成功 =** SPA stack frozen; product UI implemented (not scaffold-only); build emits `web/dist`; serve hosts it at `/`; Session API + G2 unchanged; streaming/auth not falsely claimed; review repair disposition recorded.
