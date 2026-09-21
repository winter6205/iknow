# 0001. Bake 9router stack (key var + model) into env.ts code defaults

Date: 2026-07-29
Status: deprecated

iknow pinned 9router as the sole LLM/embedding provider plus m3-combo as the primary model: `NINE_ROUTER_KEY` (the key variable name shared by LLM and embedding) and `m3-combo` (a 9router routing ID) were hard-wired into `src/config/env.ts` as code defaults. `.env.local` only needed to hold the secret value itself, no longer re-declaring `IKNOW_LLM_API_KEY_ENV` / `IKNOW_LLM_MODEL` / `IKNOW_EMBEDDING_API_KEY_ENV`.

**Why not B/C:**

- _Pure transport (zero defaults in env.ts; all 9router configuration via .env.local + .env.example)_: fits the "env.ts only transports local overrides" mental model, but the project stack would live entirely outside git — a fresh clone must first create `.env.local`, and git history cannot answer "which model is iknow's primary". Too costly for a product committed to 9router.
- _Per-machine override (no defaults, rely on .env.local)_: a degenerate version of (1); duplicates the burden of .env.example with no benefit.

**Consequences / Trade-offs:**

- _Applied:_ root cause of drift eliminated (the same variable sourced from both env.ts default and .env.local); a fresh clone runs as soon as the key is filled in; `loadIknowEnv`'s default chain and `.env.local`'s real values are aligned; key names asserted by live tests synced to `NINE_ROUTER_KEY`.
- _Trade-offs:_ switching models now requires a code change (the env.ts default) instead of a pure `.env.local` switch — acceptable, because 9router routing changes are a project-level stack decision, and git history records them more reliably than `.env.local`.

**Evidence pointers:**

- env.ts default drift produced a two-source ambiguity between `NINE_ROUTER_API_KEY` (default) and `NINE_ROUTER_KEY` (.env.local); unified by commit `3d4da40`.
- Full vitest suite (25 files / 233 tests) passed; a pure-code-default probe (empty cwd, no .env.local) outputs `m3-combo` / `NINE_ROUTER_KEY` ✓.

---

## Update (2026-08-05): key variable name default NINE_ROUTER_KEY -> ANTHROPIC_AUTH_TOKEN

The **current-state part** of this ADR's original decision ("bake `NINE_ROUTER_KEY` into env.ts as the key variable name default") has been corrected: the fallback in `src/config/env.ts` changed from `NINE_ROUTER_KEY` to `ANTHROPIC_AUTH_TOKEN`, aligning with the actual deployment (the deployment environment has only `ANTHROPIC_AUTH_TOKEN`, no `NINE_ROUTER_KEY`) and with general-ecosystem naming.

**Why corrected (not a repudiation of the whole ADR):** ADR-0001's core claim — "key variable name + primary model baked into env.ts as code defaults; `.env.local` holds only values" — still holds and is retained. Only the reversible detail of which variable name to pick was corrected: `NINE_ROUTER_KEY` is 9router-specific naming and is noise for people/projects untouched by 9router history (the probe variable-name drift above is one instance); `ANTHROPIC_AUTH_TOKEN` is a general-ecosystem name, so a fresh clone runs with one variable configured.

**Unchanged parts:**

- `m3-combo` as the primary model default — retained.
- `.env.local` holds values only; `IKNOW_LLM_API_KEY_ENV` can still override the variable name — retained (mechanism unchanged, only the default value moved; the now-redundant `IKNOW_LLM_API_KEY_ENV=ANTHROPIC_AUTH_TOKEN` line in the original `.env.local` may be deleted).
- `process.env > .env.local > .env` precedence — retained.

**Related:** the literal values `NINE_ROUTER_KEY` / `NINE_ROUTER_API_KEY` in historical narrative are preserved un-erased in historical records such as CHANGELOG / handoff / plans (git traceability).

---

## Update (2026-08-06): Status -> deprecated

This ADR is marked `deprecated` (not `superseded by NNNN` — no single new ADR replaces it). Reasons: the original decision's **embedding arm was archived along with 023** (the harness is a general agent with no vector retrieval), and the **key variable name default was corrected to `ANTHROPIC_AUTH_TOKEN` by the 2026-08-05 Update section**. The core mechanism ("project-stack defaults baked into `env.ts`; `.env.local` holds values only") remains valid, so the file is kept, neither deleted nor archived; `docs/archive/024-archive-memory-assistant-era/` records the same archival batch. When reading this ADR, take the 2026-08-05 Update section as the current state.

---

## Update (2026-08-12): model-default clause superseded — settings.llm.model configurable, hardcoded m3-combo removed

The **current-state part** of this ADR's original decision ("bake `m3-combo` into `src/config/env.ts` as the primary model code default") has been superseded by the settings mechanism (phase 2): the model default moves from "hard-wired" to "configurable + fail-fast" — `IknowSettingsLlm` in `src/config/settings.ts` gains `model?: string` and `fallback?: string[]` fields, and the model chain in `src/config/env.ts` becomes `env > settings` with **no code default at all**.

**Supersede boundary (other clauses retained):**

- **Hardcoded `m3-combo` removed**: `env.ts` no longer falls back to `"m3-combo"`.
- **Unconfigured model -> fail-fast (typed error)**: when both `IKNOW_LLM_MODEL` and `settings.llm.model` are absent, the env loader throws "iknow: no LLM model configured…" instead of silently using any default.
- **Fallback is user-configured**: new `settings.llm.fallback?: string[]` (user-declared list of fallback routing IDs); no fallback is pre-baked in code; `env.llm.fallback` unset = `[]`.
- **Env still highest**: `IKNOW_LLM_MODEL` (env) takes precedence over `settings.llm.model`; fallback comes only from settings.
- **Unchanged parts**: the key variable name default `ANTHROPIC_AUTH_TOKEN` and provider/baseUrl `http://localhost:20128/v1` remain baked into env.ts code defaults; `.env.local` holds values only and `IKNOW_LLM_API_KEY_ENV` can still override the variable name — retained.

**Related:** settings mechanism phase 1.

---

## Update (2026-08-12): remaining clauses superseded — convergence onto ADR-0015 settings single source

Among this ADR's remaining "project-stack defaults baked into `env.ts`" clauses, the **key variable name indirection + model env-override mechanism** has been superseded by `docs/adr/0015-llm-config-settings-single-source.md` (settings-model-extension Phase 1+2): LLM configuration converges onto `settings.json` as the single carrier.

**Supersede boundary (new in this section, overwriting parts of the 2026-08-12 section above):**

- **`apiKeyEnv` indirection retired**: the `LlmEnv.apiKeyEnv` field is deleted. The key's only source = `settings.llm.apiKey` (a literal or a `${VAR}` / `$VAR` placeholder), resolved by `expandPlaceholders` from `process.env[VAR]` > `.env.local` > `.env`; the notion of a "key variable name" no longer exists.
- **`IKNOW_LLM_API_KEY_ENV` mechanism retired**: no env lever remains for overriding the key variable name (the corresponding clause in ADR-0001's 2026-08-05 Update section is void).
- **`IKNOW_LLM_MODEL` retired**: the clause above ("env still highest: `IKNOW_LLM_MODEL` (env) takes precedence over `settings.llm.model`") is void — `env.ts` no longer reads `IKNOW_LLM_MODEL`; the model's only source = the literal in `settings.llm.model` (fail-fast when missing).
- **`.env.local` responsibility narrowed**: it degrades to a placeholder-value source (the `.env.local` values for `${VAR}` variables in `settings.llm.apiKey`), no longer a direct configuration entry point for model / key variable name.

**Retained clauses (not superseded by 0015):**

- provider = 9router and the baseUrl code default `http://localhost:20128/v1` remain baked into `env.ts` (`IKNOW_LLM_BASE_URL` fallback).
- `.env.local` holds values only (placeholder values); the `process.env > .env.local > .env` precedence is retained for non-LLM configuration fields.
- No default variable names, no hardcoded fallback model (0015 continues the fail-fast discipline of the 2026-08-12 section).

**Related:** `docs/adr/0015-llm-config-settings-single-source.md`, `docs/CONTEXT.md` §83.
