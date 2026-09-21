# Multi-provider settings.json template (`llm.providers` registry + TUI `/model`)

> Decision: `docs/adr/0093-llm-provider-registry.md`.
> This file gives copy-ready **shape templates** only — **the repo bundles no provider connection info**; you fill in baseUrl and keys yourself.
> The target file is always the user-layer `~/.iknow/settings.json` (`llm` is a user-layer key, ADR-0084; written into a project file it is dropped).

---

## 1. Minimal working template

Copy the block below into `~/.iknow/settings.json` and replace the `<...>` placeholders:

```json
{
  "llm": {
    "model": "minimax-cn/MiniMax-M3",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}",
    "providers": [
      {
        "id": "minimax-cn",
        "baseUrl": "<your minimax anthropic-compatible endpoint>",
        "apiKeyEnv": "MINIMAX_CN_API_KEY",
        "models": [
          {
            "id": "MiniMax-M3",
            "name": "MiniMax-M3",
            "contextWindow": 1000000,
            "maxTokens": 128000
          }
        ]
      }
    ]
  }
}
```

The key must live in the **process environment**. Export it in the same shell before starting iknow:

```bash
export MINIMAX_CN_API_KEY=<your subscription key>
```

> **`apiKeyEnv` reads only the process environment**: `resolveProviderApiKey` checks only `process.env[apiKeyEnv]`,
> and the Node entry point **does not** load `<cwd>/.env.local` / `.env` (those two files are read only by `loadIknowEnv`
> into a `fileMap`, which serves the placeholder chain of `llm.apiKey`) — **writing the key into `.env.local` has no effect**.
> Three injection options: `export` (shell rc) / the process manager's environment / `node --env-file=<file>`
> (Node ≥ 20.6). **The variable must be in place before the process starts**; exporting later or editing the file
> later is never picked up — restart the process (settings-watch covers only the two `settings.json` files, `.env.local`
> is neither watched nor hot-reloaded).
> If the variable is unset → typed startup error `provider_api_key_missing: <providerId> (env <VAR> unset)`;
> there is **no** silent fallback to `settings.llm.apiKey` — once a provider registers an `apiKeyEnv`, env is the only source.
>
> **Contrast with `llm.apiKey`'s `${VAR}` placeholders**: that chain **does** read `.env.local` (`expandPlaceholders`
> has a fileMap fallback, see `docs/llm-config-quickstart.md`). The split is deliberate: a provider's `apiKeyEnv`
> is a deployment-environment contract; placeholders are the workspace-level config — don't put this key into
> `.env.local` and wonder why nothing happens.

---

## 2. Two providers (Volcano Engine Ark + MiniMax) example

```json
{
  "llm": {
    "model": "minimax-cn/MiniMax-M3",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}",
    "providers": [
      {
        "id": "volcengine-ark",
        "baseUrl": "<Volcano Engine Ark anthropic-compatible endpoint>",
        "apiKeyEnv": "VOLCENGINE_ARK_API_KEY",
        "models": [
          {
            "id": "deepseek-v3-250324",
            "name": "DeepSeek V3",
            "contextWindow": 128000,
            "maxTokens": 16384
          },
          {
            "id": "doubao-pro-256k",
            "name": "Doubao Pro 256K",
            "contextWindow": 256000,
            "maxTokens": 16384
          }
        ]
      },
      {
        "id": "minimax-cn",
        "baseUrl": "<your minimax anthropic-compatible endpoint>",
        "apiKeyEnv": "MINIMAX_CN_API_KEY",
        "headers": { "X-Session": "iknow-dev" },
        "models": [
          {
            "id": "MiniMax-M3",
            "name": "MiniMax-M3",
            "contextWindow": 1000000,
            "maxTokens": 128000
          }
        ]
      }
    ]
  }
}
```

```bash
# process environment (export in the same shell, then start; do not use .env.local — see above)
export VOLCENGINE_ARK_API_KEY=<Ark key>
export MINIMAX_CN_API_KEY=<minimax key>
```

To switch to Ark: type `/model` in the TUI, use `↑↓` to select `volcengine-ark/deepseek-v3-250324`, press `Enter`.

---

## 3. Field semantics (SSOT is `src/config/settings.ts`; this table is navigation only)

| Field                                  | Required | Type               | Description                                                                                                                        |
| -------------------------------------- | -------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `providers[].id`                       | yes      | non-empty string   | provider routing ID; the **first segment** of the `provider/model` routing string.                                                  |
| `providers[].baseUrl`                  | yes      | non-empty string   | Anthropic-compatible endpoint; overrides `IKNOW_LLM_BASE_URL` when this provider is matched.                                        |
| `providers[].apiKeyEnv`                | yes      | non-empty string   | **variable name** whose `process.env` value is used as the key (not the key itself).                                                |
| `providers[].headers`                  | no       | `{string: string}` | optional; fed into the SDK client's `defaultHeaders` (once, not per-call).                                                          |
| `providers[].models`                   | yes      | non-empty array    | models under this provider; fewer than 1 entry → the whole provider is dropped.                                                     |
| `models[].id`                          | yes      | non-empty string   | the **second segment** of the routing string.                                                                                       |
| `models[].name`                        | no       | non-empty string   | display name (used by the picker / list).                                                                                           |
| `models[].contextWindow` / `maxTokens` | no       | positive number    | display and future use only; V1 does not rewrite the global `IKNOW_LLM_*` env.                                                      |
| `llm.model`                            | yes      | non-empty string   | current model routing ID. Matches a provider → use it; **no match → legacy `IKNOW_LLM_BASE_URL` + `settings.llm.apiKey`** (back-compat). |

**Validation discipline (drop-not-throw)**: a missing or non-string `id` / `baseUrl` / `apiKeyEnv` → **the whole provider is dropped**; non-string values in `headers` → that key is dropped; a `models` entry missing `id` → that model is dropped; `models` empty after filtering → the whole provider is dropped. Drops happen silently (no throw), and dropped fields never overwrite the rest of your file.

**`apiKey` vs providers**: `llm.apiKey` is used only when the registry does **not** match. On a provider hit, the key always comes from `process.env[apiKeyEnv]` and `llm.apiKey` is ignored (it does not participate in the fallback).

---

## 4. TUI `/model`

| Action                      | Behavior                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/model`                    | opens the picker (one `provider/model` per line, cursor on the current entry). Empty providers → a notice says none configured; the picker does not open. |
| `↑` / `↓`                   | move focus, clamped to the **visible window** (first 12 entries; V1 has no scrolling — excess items are only counted in "…N more"). |
| `Enter`                     | select → writes back to `llm.model` in `~/.iknow/settings.json` → triggers env reload → **takes effect next turn**. |
| `Esc`                       | close the panel, change nothing.                                                                           |
| `Space` / `Tab` / `←` / `→` | ignored (unbound).                                                                                         |

> **When it takes effect**: same as `/thinking` — if the current turn is already running, the old adapter finishes it; the new provider/model starts from the next turn.
> **Write-back**: only the `llm.model` field changes; everything else in the file (apiKey / thinking / memory / permissions / your own fields) is preserved. The write is atomic with a self-write sentinel, so no reload loop is triggered.

`/info` shows the current `Model: <provider>/<model>`. The model segment of the status bar (ContextBar) displays the registry entry's `name` (e.g. `MiniMax M3`); if the entry has no `name` or the model is not in the registry, the status bar falls back to the routing string.

---

## 5. FAQ

- **Provider configured but missing from `/model`**: check for an empty `id` / `baseUrl` / `apiKeyEnv`, or an empty `models` array — these are dropped silently. Use `/info` to confirm the current model string, and startup `[settings]` warnings to confirm the file layer was adopted (`llm` must be written at the **user layer**).
- **Startup error `provider_api_key_missing`**: the variable named by `apiKeyEnv` has no value in the **process environment**. `export <VAR>=<key>` in the shell that launches iknow (or inject via a process manager / `node --env-file=<file>`) and **restart the process**; writing it into `<cwd>/.env.local` has no effect, and post-start exports or edits are not hot-reloaded (see the injection notes in section 1).
- **Switching back to the legacy path**: set `llm.model` to a string without `/`, or to a prefix not present in `providers` — this falls back to `IKNOW_LLM_BASE_URL` + `llm.apiKey`.
- **Adding a non-Anthropic-protocol provider**: not supported in V1 (only `@anthropic-ai/sdk`). See the "why not multi-format" decision in ADR-0093.

---

## Related

- `docs/adr/0093-llm-provider-registry.md`
- `docs/llm-config-quickstart.md` (settings.json as the single carrier; the `llm` user-layer key discipline)
- `docs/adr/0084-project-settings-allowlist-and-permissions.md`
