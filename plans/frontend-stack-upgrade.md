# Plan: Frontend stack upgrade (Vite + React + TS) + componentized product UI

> Branch intent: `master` worktree  
> Goal: replace static v0 shell with **production-bound** SPA  
> Date: 2026-07-12

---

## Skill check

| Skill | Role |
|-------|------|
| `architecture-change-reviewer` | 5-verdict gate |
| `writing-plans` | tasks + binary AC |
| `frontend-ui-engineering` | a11y, tokens, 4 states |
| `design-taste-frontend` | anti-slop product shell |
| `minimal-change-verifier` | no 4-tool rewrite |

---

## Design read

**Reading this as:** enterprise knowledge-base Agent product console for operators (not a marketing landing), with a **dark cockpit / terminal-adjacent** language, **forest-teal + warm parchment** accents (hero-inspired, productized), density for chat, restrained motion.

**Dials:** VARIANCE 4 · MOTION 3 · DENSITY 7

---

## Stack selection (decision record)

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Stay static | Zero deps | Not production component model | Reject |
| **Vite + React + TS** | TS share with backend; ecosystem; a11y libs; hireability | Slightly heavier than Svelte | **Select** |
| Vite + Vue 3 | DX; myvuestyle hero tokens | Extra paradigm vs Node TS monorepo | Runner-up |
| Vite + Svelte | Small bundle | Smaller enterprise ecosystem | Defer |
| Next.js | RSC | Overkill; we already serve via `iknow serve` | Reject |

**Chosen stack**

| Layer | Choice | Why |
|-------|--------|-----|
| Bundler | Vite 6 | Fast, SPA native, proxy to Session API |
| UI lib | React 19 | Component model for multi-turn product surface |
| Language | TypeScript 5.x strict | Align with `session-api` contract types |
| Style | CSS variables + CSS modules | Tokens first; no Tailwind default purple AI look |
| Icons | Inline SVG sparingly / CSS shapes | Avoid heavy icon dep for v1 shell |
| State | `useReducer` + hook container | Session chat is one bounded store |
| Fonts | Self-host `@fontsource` IBM Plex Sans + Mono | No Google runtime CDN dependency |
| Dev | Vite proxy `/api` → `:8787` | Same-origin mental model |
| Prod | `web/dist` served by `iknow serve` | One process deploy |

**Not chosen this slice:** shadcn/Tailwind (risk of template look), Motion heavy anim, Next.js, auth UI.

---

## ACR

| Core Skill | Verdict |
|------------|---------|
| bounded-context-guardian | **yes** — `web/` is host presentation; API stays `session-api` |
| defensive-contract-validator | **yes** — empty send disabled; API errors typed; loading/error UI |
| error-handling-enforcer | **yes** — no empty catch; ErrorBoundary + inline alerts |
| complexity-anti-drift | **yes** — split shell / list / bubble / composer / G2 panel / hook |
| minimal-change-verifier | **yes** — backend only webRoot path; no tool changes |

---

## Tasks

### T1 — Plan + FE package scaffold
- Affects: `plans/frontend-stack-upgrade.md`, `web/package.json`, vite/tsconfig, root scripts
- AC: `npm install --prefix web` succeeds; `npm run web:build` emits `web/dist/index.html`

### T2 — Componentized product UI
- Affects: `web/src/**`
- AC: components present: AppShell, ChatHeader, MessageList, MessageBubble, Composer, G2Panel, StateBlock; hook `useSessionChat`
- AC: no raw purple gradient hero; tokens only for color

### T3 — Serve dist + SPA fallback + tests
- Affects: `src/session-api/http.ts`, tests, docs
- AC: after build, `npm test` pass; serve static from `web/dist`

### T4 — Docs STATUS/CHANGELOG/architecture
- AC: STATUS lists Vite React stack; serve/dev commands updated

---

## Layout (target)

```text
web/
  package.json
  vite.config.ts
  tsconfig.json
  index.html
  src/
    main.tsx
    App.tsx
    api/{client.ts,types.ts}
    hooks/useSessionChat.ts
    styles/{tokens.css,global.css}
    components/
      AppShell.tsx
      ChatHeader.tsx
      MessageList.tsx
      MessageBubble.tsx
      Composer.tsx
      G2Panel.tsx
      StateBlock.tsx
      ErrorBoundary.tsx
  dist/                 # build output (gitignored optional; build before serve)
```

---

## Success

`成功 = Vite React TS SPA builds; components split; professional dark product UI; iknow serve hosts dist; Session API unchanged; npm test green`
