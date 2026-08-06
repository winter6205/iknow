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

### 0.0.1 Addendum index

The v1 decisions above cover the SPA shell. Subsequent slices added capability on top of the same stack; each addendum freezes a sub-decision. **SSE remains non-goal for this slice** (`GET …/events` → **501**; see §0.1.5).

- **§0.1** (2026-08-05) — Web thinking / tool-call / markdown rendering decisions: see [§0.1](#01-addendum-2026-08-05-web-thinking--tool--markdown-display).

---

## 0.1 Addendum (2026-08-05): web thinking / tool / markdown display

> Status: **Implemented** (web + session-api wire additive extension). Tracer bullets + ACR 5-verdict gate: `plans/web-thinking-tool-display.md`. Source: user task 2026-08-05.

This addendum freezes four sub-decisions that extend the v1 SPA with thinking / tool-call display + markdown rendering + thinking toggle/intensity, all without changing the SPA shell (Vite + React + TS), the Session HTTP API contract shape (only **additive** extension), or the backend harness. **SSE / token streaming remains non-goal** — see §0.1.5.

### 0.1.1 Markdown rendering — react-markdown + remark-gfm + rehype-highlight

| Option                                             | Pros                                                                                                              | Cons                                                                                                       | Verdict    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| **react-markdown + remark-gfm + rehype-highlight** | AST → React component; GFM tables/strikethrough/strikethrough built in; hljs classes injectable; mature + minimal | +3 deps                                                                                                    | **Adopt**  |
| Hand-rolled GFM parser                             | Zero deps                                                                                                         | High correctness risk (nested lists, fenced-code escapes, GFM tables); large XSS surface; YAGNI violation  | **Reject** |
| `marked` / `remark-stringify` direct               | Tiny footprint                                                                                                    | No component injection → language label + copy button on code blocks hard; re-implement GFM table handling | Reject     |

**YAGNI argument:** a hand-rolled parser has high correctness risk on GFM edge cases (nested lists, code-fence escapes, autolinks). react-markdown's AST → React component mapping is controllable at the component layer (`CodeBlock` injects language label + copy button; tables & strikethrough are direct pass-through). The three deps form a minimal mature set; lockfile change was explicitly authorized by the user.

`MarkdownBody` consumes plain text; `CodeBlock` swaps the `<pre><code>` element with a `<pre><code class="hljs …">` + action bar (language label + copy button). `tokens.css` carries a `--hljs-*` CSS variable block so hljs' default theme integrates with Variant A.

### 0.1.2 Thinking display strategy

- **Default collapsed** — `ThinkingBlock` starts collapsed (`useState(false)`); `aria-expanded` + keyboard-operable disclosure.
- **`signature` / `data` never go on the wire** — `TurnAnswerDto.thinking.entries[i].text` is the only field; `redacted_thinking.data` is a replay artifact and is intentionally dropped by `projectThinkingView` (`src/session-api/turn-projection.ts`). Replay material stays server-side only.
- **Redacted only displays a count placeholder** — when `redactedCount > 0`, `ThinkingBlock` renders `[已加密思考]` rows for the count (no decoding / no display of `data`). This is consistent with `CONTEXT.md` "LoopTrace strictly excludes payload".
- **Truncation** — `MAX_THINKING_TEXT_CHARS = 2000` per entry (post-mask, pre-truncation) in `src/session-api/turn-projection.ts`; wire field is bounded regardless of model output length.

### 0.1.3 toolCalls preview strategy

- **Truncation constants** (in `src/session-api/turn-projection.ts`):
  - `MAX_TOOL_INPUT_PREVIEW_CHARS = 500` — `JSON.stringify(input)` → mask → truncate.
  - `MAX_TOOL_OUTPUT_PREVIEW_CHARS = 1500` — concatenate `tool_result` text blocks → mask → truncate.
- **Mask wiring** — both previews pass through `createOutputMask(currentSecretValues()).mask` before wire output (SC20 boundary; consistent with the `finalText` mask applied in `toTurnDto`). Same one-shot mask rebuild per call.
- **`truncated` flag** — `ToolCallView.truncated: boolean` tells the frontend whether the output was truncated; frontend renders `…（已截断）` accordingly.
- **`tool_use_id` pairing** — `projectToolCalls` pairs `tool_use` with `tool_result` by id; missing result → `outputPreview=""`, `isError=false`, `truncated=false`. Pair order = block order in the assistant message.

### 0.1.4 Per-request thinking override — env remains the SSOT

- **Wire shape (additive only)** — `PostMessageRequest.thinking?: { mode: "off" | "adaptive", effort?: "" | "low" | "medium" | "high" | "xhigh" | "max" }` (`src/session-api/contract.ts`). Field is optional; absence preserves pre-existing byte-identical wire behavior.
- **Validation** — `parseThinkingOverride` (`src/session-api/thinking-override.ts`): bad shape / unknown mode / unknown effort → `ValidationError` → HTTP 400 with the standard `ApiErrorBody` envelope. **No silent fallback** — wire surface fails loud.
- **One-shot adapter rebuild** — `withThinkingOverride` rebuilds a per-turn `LoopEngineDeps` whose `adapter` carries the override; `executor` / `registry` / `maxTurns` / `timeoutMs` are reused from the cached deps (`withThinkingOverride` returns a new deps object). The wire `stream:false` protocol is unchanged.
- **env stays the SSOT for defaults** — `IKNOW_LLM_THINKING` / `IKNOW_LLM_THINKING_EFFORT` (`src/config/env.ts`) set the server default cached in `ensureDeps`. The override only affects that single turn; absent override → cached deps (behavior identical to pre-additive).
- **Frontend persistence + per-request send** — `web/src/lib/thinking-settings.ts` (pure functions: parse / serialize / toWireOverride / load / save); localStorage key `iknow:thinking`; default `enabled: false` (mode="off"). `ThinkingControls` toggles + intensity segmented selector; `useSessionChat.sendMessage` forwards `toWireOverride(settings)` with each `postMessage`.

### 0.1.5 SSE remains non-goal

The /events reserved route (`GET /api/v1/sessions/:id/events`) still returns **501**. "Thinking state" on the UI means **in-flight request indicator + round-level complete display**, **not** token streaming. A dedicated streaming slice is required to flip this; no implementation in the current addendum.

### 0.1.6 Post-review repair notes (2026-08-05)

A code-review 双轴 (spec / standards) pass against the commit stack implementing §0.1.1–§0.1.4 surfaced two findings that warrant explicit decision records so they do not regress under future refactors.

- **`projectMessagesToTurns` uses turn-slice projection (intentional cross-turn tightening).** Each query's slice runs from the user message **to the next non-tool_result user message** (instead of "the next assistant message"). The narrower bound is deliberate: the prior shape leaked subsequent turns' text into the projection whenever the assistant never produced text in a turn (e.g. `maxTurns` runs that ran only tools); the new shape is byte-stable across history replay. The helpers `findTurnSliceEnd` + `findFinalTextInSlice` (extracted during the repair pass) carry the bounds and the text-of-slice logic so the main function stays ≤10 cyclomatic.
- **`withThinkingOverride` rebuilds an independent Anthropic client per turn.** The override replaces `adapter` only (registry / executor / maxTurns / timeoutMs reuse the cached deps), but the adapter itself carries a fresh `Anthropic` client constructed from the current `env` (via `opts.env ?? loadIknowEnv()`). The trade-off: an env drift mid-session (key rotation, `IKNOW_LLM_BASE_URL` override) takes effect on the **next override turn** instead of being pinned to the cached client. Cost is one lightweight HTTP-client allocation per override turn (no socket open until first request), acceptable given the override is rare and the cached path is untouched.
- **`WireThinkingOverride` + `THINKING_EFFORT_VALUES` are the SSOT.** `contract.ts` exports both; `thinking-override.ts` validates against the readonly array via a typed guard (no second hard-coded value list).
- **Code-block copy path:** `web/src/components/MarkdownBody.tsx`'s `code` component now reads the raw text from the hast `node` prop via `web/src/lib/hast.ts`'s `hastText` rather than walking the rendered React children. The old traversal dropped source characters between hljs spans (`const x = 1;` → ` :  = ;`). Acceptance: byte-equal copy in `tests/web/markdown-copy.test.ts` (renderToStaticMarkup) and the live-serve browser check.
- **Empty-finalText turn visibility:** `web/src/hooks/useSessionChat.ts`'s `turnsToMessages` keeps agent turns whose `finalText` is empty whenever the turn carries thinking entries or tool calls. The old predicate `if (t.answer.finalText.trim())` dropped the entire turn in the `maxTurns` / `timeout` shapes that ran only tools; the new predicate matches `AgentCard`'s display path (text section empty + thinking/toolCalls rendered).

---

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
