# 0015. LLM config converges to settings.json as single carrier — model literal + apiKey field + ${VAR} placeholders

Date: 2026-08-12
Status: accepted

> **Amendment 2026-09-19** (ADR-0113): §1 still holds — the **main-session** `settings.llm.model` is fail-fast when missing. The optional `settings.llm.liteModel` does not change this clause.
>
> **Amendment 2026-09-12** (ADR-0084 Slice B): in the guard wording cited by §1 and §2, the tail pointing at `<cwd>/.iknow/settings.json` is **superseded** — `llm` is a user-layer key; project files only adopt `hooks` / `verify` / `secrets` / `permissions`, so the wording points only at `~/.iknow/settings.json` (`src/config/messages.ts`). §1's model-literal sole source, §2's apiKey single field and placeholder semantics, and §5's untouched scope all remain unchanged.
>
> **Amendment 2026-09-13** (ADR-0093): §2's "replaces `apiKeyEnv` indirection" is **reopened** — `settings.llm.providers[i].apiKeyEnv` reintroduces a per-provider variable name **inside the user-layer registry** (reads `process.env[apiKeyEnv]` directly, with no fallback to the `.env.local` / `.env` fileMap; env absent → typed throw, no fallback to the literal `apiKey`). The rest of §2 is unchanged: the global `IKNOW_LLM_API_KEY_ENV`, the `LlmEnv.apiKeyEnv` field, and the `settings.llm.apiKey` placeholder path for non-matching provider routes all stand as originally written. §1's model-literal sole source and fail-fast-on-missing are unchanged; the literal may now read as a `provider/model` routing ID.
>
> Carrier pointer: the sibling key `settings.llm.fallback` (user-declared fallback routing IDs, no code pre-bake) rides this same `settings.llm` carrier but is ruled in ADR-0001's 2026-08-12 Update — carried there, not here.

## Context

iknow historically had several coexisting LLM config entry points (a manifestation of ADR-0001's substack):

- **`env.ts` hard-coding `m3-combo`** (the m3-combo 9router routing ID welded in as the code default)
- **`env.ts` indirect addressing via the `apiKeyEnv` field** (reading `process.env[IKNOW_LLM_API_KEY_ENV]`, default `ANTHROPIC_AUTH_TOKEN`) — any secret becomes a variable-name lookup
- **`process.env[IKNOW_LLM_MODEL]`** (direct env override of the model)
- **`.env.local`** as bottom fallback

Four entry points + two precedence chains split the developer mental model; from the user's side "where exactly do I change the model?" had no single answer (a second-phase project was opened). The hard-coded fallback + indirect addressing also exposed an external vendor's variable name (`ANTHROPIC_AUTH_TOKEN`) through iknow's business interface, conflicting with the project goal of keeping external vendor variable names out of iknow's business interface.

The settings mechanism (first phase) had already built `settings.json`'s carrying capability (user + project merge, drop-not-throw, deep frozen), but the model / API-key fields were not wired in.

## Decision

**`settings.json` is the single carrier for LLM config.** Three concrete convergences:

### 1. `settings.llm.model` literal is the sole source

- **SSOT** = `settings.llm.model` (non-empty string after trim) — routing for the **main session**. Background tool-less completion is separately governed by the optional `settings.llm.liteModel` (ADR-0113); absence of lite does not change this clause's fail-fast.
- **Missing → fail-fast**: `loadIknowEnv` throws "iknow: no LLM model configured in settings.llm.model. Set it in ~/.iknow/settings.json (or <cwd>/.iknow/settings.json)."
- **Retired**: `process.env[IKNOW_LLM_MODEL]` is read by no code anymore (including env.ts / scripts / i135 smoke / 4 serve-path test fixtures)
- **No placeholders**: the model field does not expand `${VAR}` — the model routing ID is declared, literal, and code-reviewable

### 2. `settings.llm.apiKey` single field (replacing `apiKeyEnv` indirect addressing)

- **SSOT** = `settings.llm.apiKey` (accepts exactly one of two forms):
  - **Literal**: `"apiKey": "sk-abc123..."` — the key lands directly
  - **Placeholder**: `"apiKey": "${ANTHROPIC_AUTH_TOKEN}"` — expanded at parse time from `process.env`, falling back to `.env.local`
- **Missing → undefined** (no fail-fast; no default variable name read; no name hard-coded). The consumption-point guard throws "LLM mode needs API key. Set settings.llm.apiKey (literal or ${VAR} placeholder) in ~/.iknow/settings.json or <cwd>/.iknow/settings.json."
- **`LlmEnv` interface drops the `apiKeyEnv` field**: the indirect-addressing mechanism retires; `LlmEnv` keeps only `apiKey: string | undefined`
- **Retired**: the `IKNOW_LLM_API_KEY_ENV` env variable (together with its "choose the key variable name" switch) retires completely; `ANTHROPIC_AUTH_TOKEN` is no longer a code-default variable name

### 3. `.env.local` degrades to a pure env-var loader

- Its only job: inject `KEY=VALUE` into `process.env`
- It serves only as one source of truth behind `${VAR}` placeholders
- **No longer a direct model-config entry** (the earlier reading where `IKNOW_LLM_MODEL` could come from `.env.local` has retired)

### 4. Sandbox masking layer

`placeholderVarNames()` / `configuredSecretNames()` / `currentSecretValues()` in `src/harness/sandbox/env-isolation.ts` switch to parsing the raw form of `settings.llm.apiKey`:

- **Placeholder strings** (any legal combination of `${VAR}` / `$VAR`, including multi-segment `${A}${B}` and literal+placeholder mixes like `${A}literal`) → the deduplicated variable-name array enters `configuredSecretNames()` (`extractPlaceholders` shares settings.ts's placeholder-regex source). Masking covers multi-segment / mixed forms (M1 fixes the multi-segment masking wash leak).
- **Literals** (non-empty after trim, containing no `$IDENT` / `${VAR}` form) → no variable name enters the env scan; the trimmed value enters `currentSecretValues()`' in-memory masking set (M3 fixes the literal-key echo masking failure). The drift risk (masking set not auto-refreshed when the literal value changes) is addressed under Concrete Quiddity.

**Fully settings-driven** — the business layer (including the `LlmEnv` interface) contains no external vendor variable name at all.

### 5. Other env fields (untouched scope)

`maxTurns` / `compress` / `stream` / `thinking` / `maxOutputTokens` / `timeoutMs` / `temperature` / `thinkingEffort` / web.* / mcp.* and other env fields keep the current `process.env > .env.local > .env > defaults`. This ADR converges only the two LLM fields `model` + `apiKey`.

## Consequences

### Positive

- **Single config address**: answering "where do I change the model" requires naming exactly one place, `settings.json` (the fail-fast wording points at the same address)
- **Clean business interface**: no `ANTHROPIC_AUTH_TOKEN` / `m3-combo` or other external-vendor identifier literals appear in the `LlmEnv` interface
- **Friendly placeholder semantics**: temporary model switches via `shell export` also go through `${VAR}` resolution (`.env.local` fallback), consistent with out-of-process team habits
- **Readability**: the settings file is reviewable directly, without shuttling between code and external environment to verify
- **Test isolation**: `tests/_helpers/install-test-settings-source.ts` uses `HOME` redirection + a fork-local tmp dir so each vitest fork gets independent settings with no shared mutable state

### Negative / Trade-offs

- **Losing "`.env.local` directly overrides model"**: previously writing `IKNOW_LLM_MODEL=xxx` in `.env.local` sufficed; **now `settings.json` must be edited**. A leftover `IKNOW_LLM_MODEL` line in a user's `.env.local` becomes visual noise without behavioral effect (no longer read)
- **Losing "env variable name overridable"**: previously `IKNOW_LLM_API_KEY_ENV=OTHER_KEY` could change which variable name iknow looks for; **now the referenced name is determined solely by the settings placeholder**. Teams using a non-default name like `LLM_API_KEY` must bind it explicitly in settings.json via `"apiKey": "${LLM_API_KEY}"`
- **Placeholder syntax limits**: only `${VAR}` / `$VAR` forms; no `$$` escape, no default-value expressions (e.g. `${VAR:-default}` — **explicitly rejected** to avoid introducing implicit fallbacks)
- **Mental-model migration**: the belief that `.env.local` is the config carrier is deep-rooted; the new mechanism requires **all model / key config to land in the settings file**, with `.env.local` serving only as the placeholder source of truth

### Concrete Quiddity

Masking of a literal apiKey (`settings.llm.apiKey` shaped like `"sk-..."`) relies on `currentSecretValues()` reading settings **live** on every call to obtain the trimmed value (`env-isolation.literalApiKey()` re-fetches `loadIknowSettings()` per call; the module-top-level SECRET_ENV_NAMES does not cache the literal value). Drift risks:

- `settings.llm.apiKey`'s literal value changing between two masking calls → the stale literal would remain in the masking set until cache invalidation (M3 implementation choice: **do not cache the literal value**, re-fetch per call, avoiding this drift).
- A literal value already printed verbatim into trace files, stdout, or stderr → historical data cannot be retroactively masked (that is output-write-side discipline, not something the masking mechanism can repair). Writing / rewriting settings must pair with the live semantics of `currentSecretValues()`.

### Reversibility

**Hard to reverse** (satisfies the three ADR conditions): the change spans src/ + tests/ + scripts/ + docs/ across 4 domains, 30+ files, touching `LlmEnv` interface fields (deletion), fail-fast paths, and the sandbox masking layer. Reverting means restoring every call site + reintroducing the indirect-addressing mechanism — costly.

### Implementation notes

- `src/config/settings.ts` + the `isApiKeyOrPlaceholder` validator; the `IknowSettingsLlm.apiKey?: string` field
- The `expandPlaceholders()` helper in `src/config/env.ts` (handles `${VAR}` / `$VAR`, resolving from `process.env` with `.env.local` fallback; not found → `undefined`)
- Unified guard wording in `src/harness/build-engine.ts` / `src/tui/deps.ts` / `src/session-api/thinking-override.ts`
- The ask error JSON envelope field in `src/cli.ts`: `apiKeyEnv` → `apiKey`
- `src/harness/sandbox/env-isolation.ts` parses the settings form to drive the cleansing list
- Test-fixture (`LlmEnv` field) cleanup across 9+ files; 4 serve-path tests switch from `process.env.IKNOW_LLM_MODEL = "test-model"` to the `installTestSettingsSource()` helper
- `scripts/i135-settings-model-extension-smoke.ts` rewritten as four groups A/B/C/D (settings take effect / model-missing fail-fast / apiKey-missing guard / literal apiKey)
- `scripts/i153-probe-9router-thinking.ts:459` and other probe scripts cleaned of direct `process.env.IKNOW_LLM_MODEL` reads

## Supersedes

- The 2026-08-12 Update section of **ADR-0001** (`docs/adr/0001-9router-stack-as-code-defaults.md`), which removed the `m3-combo` fallback — this ADR goes further: ① it retires the `apiKeyEnv` indirect-addressing mechanism as well; ② it retires the entire env-variable-name mechanism `IKNOW_LLM_MODEL` / `IKNOW_LLM_API_KEY_ENV`; ③ the model source becomes settings-literal-only, no longer routed through env
- ADR-0001's mechanism of baking project-stack defaults (key variable name `ANTHROPIC_AUTH_TOKEN`, provider/baseUrl `http://localhost:20128/v1`) into env.ts code defaults is **kept** (provider/baseUrl and key-variable-name defaults are two separate problems; this ADR does not touch the provider/baseUrl code default); but `ANTHROPIC_AUTH_TOKEN` is no longer the **default key variable name** — to reference it in settings, **the user must explicitly write the `${ANTHROPIC_AUTH_TOKEN}` placeholder**

## Evidence

- Phase 1 tracer bullet (`scripts/i164-tracer-bullet-model.ts`) four-group field test:
  - Group A: settings `{model: "ocg/deepseek-v4-flash", apiKey: "${ANTHROPIC_AUTH_TOKEN}"}` → real call succeeds; wire `model` field `ocg/deepseek-v4-flash` → 9router rewrites to response `deepseek-v4-flash` (content "OK", non-empty)
  - Group B: settings `{}` → fail-fast throws "no LLM model configured in settings.llm.model", exit 1
  - Group C: settings `{model: "..."}` + `ANTHROPIC_AUTH_TOKEN=""` → guard throws "no API key configured", exit 1
  - Group D: settings literal `"apiKey": "sk-..."` → runs end to end without depending on env
- `npx tsc --noEmit` exit 0
- `npm test` 2416/2417 passing (only a pre-existing flake; unrelated to this change)
- Throughout, the key was injected only via the `ANTHROPIC_AUTH_TOKEN` env; no plaintext key landed on disk in settings files, fixtures, scripts, or logs

## Related

- The settings mechanism (settings-reading infrastructure, phase 1)
- `docs/CONTEXT.md §83` (the LLM-config SSOT boundary, to be kept in sync)
