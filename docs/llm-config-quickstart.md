# iknow LLM config quickstart — settings.json as the single carrier (ADR-0015)

> Templates for `.env.local` and `settings.json`.
> SSOT = ADR-0015 (`docs/adr/0015-llm-config-settings-single-source.md`) + ADR-0084
> (`docs/adr/0084-project-settings-allowlist-and-permissions.md`; project settings allowlist).

---

## 1. In one sentence

**All model / key configuration lives in exactly one place: the user-layer `~/.iknow/settings.json`**. The shared project-layer `<cwd>/.iknow/settings.json` only adopts `verify` / `secrets` / `permissions`; `hooks` and `llm` (as well as `web` / `isolation` / `memory` / `subagent` / `lsp` / `loop` / `graph`) are **user-layer keys** — written into a project file they are discarded, never shadow the user value, and a startup warning is printed (ADR-0084). `.env.local` degrades to a **pure env-var loader**: it only supplies the real values behind `${VAR}` placeholders and is no longer a configuration surface.

---

## 2. `.env.local` template (copy to `<cwd>/.env.local`, replace `<ANGLE_BRACKET>`)

```env
# iknow .env.local — 纯 env var 装载器（ADR-0015 settings 单承载）
# 作用：只给 settings.json 里的 ${VAR} 占位符提供真值；不再配置 model / apiKey
# 已退役（不要写，写了也不读）：IKNOW_LLM_MODEL / IKNOW_LLM_API_KEY_ENV

# --- LLM 栈（provider / baseUrl 是项目级代码默认，一般无需覆盖）------------
# 默认 http://localhost:20128/v1；WSL 下用网关 IP（~/.bashrc 动态探测已配）
# IKNOW_LLM_BASE_URL=http://172.31.128.1:20128/v1

# --- 占位符真值（settings.json 里写 ${ANTHROPIC_AUTH_TOKEN} 时会读这里）-----
ANTHROPIC_AUTH_TOKEN=<your_real_api_key_here>

# --- 其它保留 env（可选，非必填）---------------------------------------------
# 输出 token 预算不再走 env：写在 models[].maxTokens 里（见第 3 节）。
# IKNOW_LLM_MAX_OUTPUT_TOKENS 已退役 —— 设成任何非空值都会直接报
# legacy_max_output_tokens_env 配置错误，不再静默覆盖模型条目。
IKNOW_LLM_TIMEOUT_MS=300000
IKNOW_LLM_TEMPERATURE=0
IKNOW_LLM_STREAM=on            # 流式臂开关 on|off，默认 on

# Web 工具出站代理（可选，trust_env=false 语义：显式配置才生效）
# 设 IKNOW_WEB_PROXY 后 web_fetch / web_search 走代理（HTTP 代理地址）

# ACI web backend：发现（web_search）与阅读（web_fetch）共用一个名字
# （可选；settings.web.searchBackend 已承载，env 仅作覆盖）
# 本轮厂商只接 Exa。缺搜/缺抓回落默认（Bing HTML / 本机 network-guard）。
# 通话仍是 bash + network:true（host-net amplify），不升第 9 件工具。
# IKNOW_WEB_SEARCH_BACKEND=exa
```

> ⚠️ **Hard rule**: never commit `.env.local` to git (it belongs in `.gitignore`). Real keys go only here (or an OS secret store / shell export), **never as a literal in `settings.json`** — unless you truly want the key on disk; note that a literal key makes the output-masking pass depend on the in-memory value set (see ADR-0015 "Concrete Quiddity").

---

## 3. `settings.json` template (user layer `~/.iknow/settings.json` only)

```json
{
  "llm": {
    "model": "ocg/deepseek-v4-flash",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}",
    "fallback": ["deepseek-flash-combo"]
  },
  "web": {
    "searchBackend": "exa"
  },
  "subagent": {
    "thinking": "adaptive",
    "thinkingEffort": "high"
  }
}
```

- **`model`**: literal model routing ID (required). Missing → fail-fast, throws "no LLM model configured in settings.llm.model".
- **`apiKey`**: exactly one of two forms —
  - placeholder (recommended): `"${ANTHROPIC_AUTH_TOKEN}"`, resolved at load time from `process.env[VAR]` > `.env.local` > `.env`;
  - literal: `"sk-..."` stores the key directly (no env dependency, but the key lands in the settings file).
  - Omitted → `undefined`, and the consumer-site guard throws "LLM mode needs API key. Set settings.llm.apiKey (literal or ${VAR} placeholder) in ~/.iknow/settings.json. llm is a user-layer key (ADR-0084)...".
- **`fallback`** (optional): array of fallback model routing IDs; user-configured, never preset by code.

> **Layer ownership (ADR-0084)**: the `llm`, `web`, and `subagent` sections below are **user-layer keys** — write them only in `~/.iknow/settings.json`. The project file `<cwd>/.iknow/settings.json` adopts only `hooks` / `verify` / `secrets` / `permissions`; its `llm` / `web` / `subagent` sections are dropped (`filterProjectSettingsKeys`, `src/config/settings.ts`), never override user values, and print a startup warning `[settings] project settings key "..." ignored`.

### 3.1 `settings.json` full schema reference

The user-layer `settings.json` carries the **`llm`, `web`, and `subagent` sections**, accepting only the fields below (`parseLlm` / `parseWeb` / `parseSubagent` validate field by field; invalid values are dropped, not thrown). Fields come from `IknowSettingsLlm` / `IknowSettingsWeb` / `IknowSettingsSubagent` in `src/config/settings.ts` (SSOT — trust the code over this table).

| Field path                     | Type                                              | Default (unset)         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.model`                    | string (trimmed, non-empty)                       | **fail-fast throw**     | Literal model routing ID, sole source, **required**.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `llm.apiKey`                   | string (literal or `${VAR}` / `$VAR`)             | `undefined`             | Key source; consumer-site guard throws "LLM mode needs API key.".                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `llm.fallback`                 | string[] (non-empty)                              | `[]`                    | Fallback routing ID list, user-configured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `llm.thinking`                 | `"off" \| "adaptive"`                             | `"off"`                 | Default thinking switch; overridden when env `IKNOW_LLM_THINKING` is explicitly set (env > settings > default).                                                                                                                                                                                                                                                                                                                                                                                             |
| `llm.thinkingEffort`           | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `""` (not sent)         | Default effort; overridden when env `IKNOW_LLM_THINKING_EFFORT` is explicitly set.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `llm.maxTurns`                 | number (integer ≥1)                               | `undefined` (unlimited) | Max loop turns per conversation; overridden by env `IKNOW_LLM_MAX_TURNS`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `llm.compress.contextWindow`   | number (>0, finite)                               | `256000`                | **Strategy budget window** (denominator of usage display and the auto-compact gate, not a provider ceiling); overridden by env `IKNOW_MODEL_CONTEXT_WINDOW`. ADR-0100.                                                                                                                                                                                                                                                                                                                                      |
| `llm.compress.thresholdTokens` | number (>0, finite)                               | `undefined` (derived)   | Proactive auto-compact threshold; when unset, `floor(0.95 × contextWindow)`; overridden by env `IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS`, which must be `< contextWindow`. ADR-0100.                                                                                                                                                                                                                                                                                                                            |
| `web.searchBackend`            | `"bing" \| "exa" \| "tavily" \| "brave"`          | `"bing"`                | **ACI web backend**: one name drives both discovery and reading; overridden by env `IKNOW_WEB_SEARCH_BACKEND`. The missing leg for `tavily` / `brave` / `exa` without a key falls back: search uses the current default engine, fetching uses local `web_fetch` + `network-guard`. An invalid ID fails loud with a typed error at assembly, never silently renamed. The call itself remains `bash` + `network: true` (host-net amplify). |
| `web.backendKey` | string (literal or `${VAR}`) | `undefined` | **The API key for the selected backend** — the settings-side carrier, so a normal install configures backend + key in one file without authoring an env file. Same value shape and `expandPlaceholders` chain as `llm.apiKey`: a literal is used verbatim, a `${VAR}` / `$VAR` is resolved from `process.env` first then `.env.local` / `.env`. **Vendor-neutral by design** — `loadIknowEnv` routes this value into the key slot of whatever `searchBackend` resolved to, so no vendor is baked into the field name and a config keeps working if the selection changes to a backend that becomes real. Precedence is `process.env` > `.env.local` / `.env` > settings > no key, and the chain is **first-usable-wins**: an env value that is empty, `"yes"`, or an unresolvable placeholder falls through to settings instead of shadowing it. `"yes"` / empty / unresolvable placeholder on the settings side → `undefined`, never a raw `${VAR}` leaking downstream. `bing` is the zero-key default path and has no slot, so a key paired with it is simply unused. A key alone does **not** select the backend — `searchBackend` must also be set, otherwise the default `bing` applies. Assembly-time field, same as `web.searchBackend`: a process restart is required. `TAVILY_API_KEY` / `BRAVE_API_KEY` remain env-only so the `backend_unset_with_key` guard can name them (both backends are `not_shipped` stubs today). User-layer only — a project file's `web` section is dropped by the allowlist, so a cloned repo can never ship a key. |
| `subagent.thinking`            | `"off" \| "adaptive"`                             | inherit parent          | Optional worker thinking mode. Invalid values are dropped. User-layer only; no env override.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `subagent.thinkingEffort`      | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | inherit parent          | Optional worker effort. Invalid values are dropped. User-layer only; no env override.                                                                                                                                                                                                                                                                                                                                                                                                                       |

**For `llm`, every field with a default is optional**: omitting `thinking` / `thinkingEffort` means thinking defaults to `off` and effort is not sent — that is "using the default", not "failed to read".

For `subagent`, omitted thinking fields inherit the parent's effective thinking settings. Setting only `thinkingEffort` enables adaptive thinking for the worker; setting only `thinking` inherits the parent's effort. An explicit `"off"` suppresses thinking and effort in the worker request. Each new worker reads user settings when it starts, so changes affect subsequent spawns and continuations; a running worker keeps its current values.

**Note**: the following fields are **not carried by settings.json**; they stay env-only (`process.env > .env.local > .env > code default`), and `parseLlm` / `parseWeb` ignore them if written into settings.json:

- `baseUrl` (`IKNOW_LLM_BASE_URL`), `timeoutMs` (`IKNOW_LLM_TIMEOUT_MS`), `temperature` (`IKNOW_LLM_TEMPERATURE`), `stream` (`IKNOW_LLM_STREAM`)
- `chat.showThinking` (`IKNOW_CHAT_SHOW_THINKING`), `web.searchUrl` / `web.proxy` (`IKNOW_WEB_SEARCH_URL` / `IKNOW_WEB_PROXY`), `mcp.connectTimeoutMs` (`IKNOW_MCP_CONNECT_TIMEOUT_MS`)

**The output-token budget is the one thing that moved the other way**: it is no longer an env-only setting. `IKNOW_LLM_MAX_OUTPUT_TOKENS` is retired — a non-empty value in the process environment, `.env`, or `.env.local` makes config loading fail with the typed error `legacy_max_output_tokens_env`, naming the variable and pointing at `models[].maxTokens`. Set the budget per model entry in the provider registry (`llm.providers[].models[].maxTokens`, a positive whole number): that value is sent to the provider as `max_tokens`, and an entry without it falls back to 32,000 tokens. A configured budget is a request budget, not a supplier hard limit (MiniMax M3 documents 524,288 tokens; the maintained example configures 131,072). An explicit illegal `models[].maxTokens` value (`null`, wrong type, zero, negative, fractional, beyond `Number.MAX_SAFE_INTEGER`) fails loading with `model_max_tokens_invalid` instead of silently dropping into the fallback. Neither error rewrites `~/.iknow/settings.json` — edit the file yourself.

**Exception**: `web.searchBackend` (the **ACI web backend** single name) **is carried by settings.json** — closed set `"bing" | "tavily" | "exa" | "brave"`, resolution chain `IKNOW_WEB_SEARCH_BACKEND` env > `web.searchBackend` settings > default `"bing"`. An invalid env value throws a typed error; an invalid settings value is dropped by `parseWeb` in `src/config/settings.ts` (drop-not-throw, falls back to default). Currently only Exa is connected; missing search/fetch legs fall back to defaults, and stubs are never reported as connected. The call remains amplify (`bash` + `network: true`); no separate curl tool. Assembly-time field: a process restart is required after changing it (not on the hot-reload allowlist, see "hot reload" below).

**The backend key rides along with the backend**: `web.backendKey` is settings-carried too, so the whole web backend is configurable in one file — no env file required for a normal install. The field is named for the *selected backend*, not a vendor: `loadIknowEnv` routes it into whichever backend `searchBackend` resolved to. Both shapes are accepted, and the env layer is the single place that resolves them:

```json
{
  "web": {
    "searchBackend": "exa",
    "backendKey": "${EXA_API_KEY}"
  }
}
```

`"backendKey": "${EXA_API_KEY}"` reads the variable from the environment (the shape most people want — the settings file stays key-free and stays safe to share); `"backendKey": "your-key-here"` puts the literal key straight into the file. Swap the `${EXA_API_KEY}` name for whatever variable the selected backend expects; the field itself does not change. Precedence is `process.env` > `.env.local` / `.env` > settings, and it resolves **first usable wins** — a stale `EXA_API_KEY=yes` left in an env file falls through to the settings key rather than shadowing it. A developer with `EXA_API_KEY` exported keeps using their env value without editing the file. The file is chmod 0600 on every atomic write, but treat it as a secret if you inline a key. Note that both fields are assembly-time: restart the process after editing.

> **A misspelled placeholder name fails quiet.** A `${VAR}` that does not resolve (typo, or the variable is not set in this shell) yields `undefined`, which drops the backend to the default `bing` — no error is raised, because an unresolved key is indistinguishable from "no key configured". If Exa seems to be ignored, check the variable name and that it is exported in the shell that launched iknow. The fail-closed `backend_unset_with_key` guard cannot catch this: `web.searchBackend` folds to `"bing"` at the env layer, so the loader never sees the "unset" tri-state on this path.

#### Full example (with the thinking default tier)

```json
{
  "llm": {
    "model": "ocg/deepseek-v4-flash",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}",
    "fallback": ["deepseek-flash-combo"],
    "thinking": "adaptive",
    "thinkingEffort": "medium"
  },
  "subagent": {
    "thinking": "adaptive",
    "thinkingEffort": "high"
  }
}
```

> **On "hot reload"**: settings.json **takes effect via hot reload** — `src/config/settings-watch.ts` (`fs.watch` + `fs.watchFile`, 100ms debounce) watches `~/.iknow/settings.json` and `<cwd>/.iknow/settings.json`; after a change, the next postMessage round calls the LLM with the new env. **Only these 9 main-adapter fields are on the hot-reload allowlist**: `model` / `apiKey` / `thinking` / `thinkingEffort` / `fallback` / `baseUrl` / `maxOutputTokens` / `temperature` / `stream` (the full input surface of `createAdapterFromEnv`, see `src/harness/build-engine.ts:124-142`). Fields outside the allowlist — `llm.compress.contextWindow` / `llm.compress.thresholdTokens` (loop-engine `compress` config; hub hot-rebuild does not re-run it), `llm.maxTurns` (loop-engine `maxTurns`, same reason), `chat.showThinking` / `web.searchUrl` / `web.proxy` / `mcp.connectTimeoutMs` (assembly-time / other arms of `IknowEnv`, not adapter inputs) — **require a process restart**. Subagent thinking fields follow the worker-start behavior described above, independently of main-adapter hot reload. A failed reload (bad JSON / missing model / apiKey resolution failure) → **the old env is kept** (the process does not crash; a message goes to stderr by default: `[settings-hot-reload] reload failed: ...`). The TUI chat path is wired in: the ContextBar model name refreshes live, and the thinking baseline refreshes only for fields "not manually taken over" — submitting via the `/model` / `/thinking` / `/effort` panels sets the takeover flag for that field, after which settings changes in this session no longer rewrite it (switching models must never reset an in-use override; reopening the process returns to the settings baseline). Switching models redraws only the model segment of the ContextBar, no whole-tree repaint (the env display snapshot is pushed via store subscription, `src/tui/env-display-store.ts`). `.env.local` / `.env` are hot-reloaded on the same chain (`loadIknowEnv` re-reads on every reload).
>
> **On the "reverse channel / panel write-back"**: saving and exiting the `/thinking` / `/effort` panels with **Esc** writes back to `settings.json` (ADR-0084 write-back layer: `thinking` / `effort` / `memory` are user-layer keys, **always written to the user layer `~/.iknow/settings.json`** regardless of whether a project file exists; the llm subtree is merged, apiKey/model/secrets and other fields preserved verbatim). The write-back does not trigger its own reload (a sha256 self-write sentinel skips on content-hash match, preventing a loop; the one-way file → runtime channel is unchanged). A failed write-back (EACCES / disk full / serialization failure) → a TUI notice; the in-memory override is kept, no crash. Enter-pin / Space-Tab preview inside the panel never persists; after restart the value returns to settings.json (or the default).

---

## 4. Three typical setups

| Scenario                                   | How                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recommended** (key never in a file)      | settings `"apiKey": "${ANTHROPIC_AUTH_TOKEN}"` + `ANTHROPIC_AUTH_TOKEN=<key>` in `.env.local`                                                                                         |
| Temporary model switch (nothing persisted) | `export IKNOW_LLM_MODEL` is retired. Instead: change `"model"` in settings to the target value, or temporarily `export` a var and reference it via a `${VAR}` placeholder in settings |
| Literal key (no env dependency)            | write `"apiKey": "sk-..."` directly in settings                                                                                                                                       |

---

## 5. Cloud development / remote LLM endpoints

The local WSL gateway (`http://localhost:20128/v1` / `9router`) is unreachable in cloud development. iknow talks to any Anthropic-compatible endpoint — point `IKNOW_LLM_BASE_URL` at the remote and put the model routing ID in settings; no code changes needed.

**The full template is in the project root `.env.example` (git-tracked); copy it to `.env.local` and fill in real values:**

```bash
cp .env.example .env.local     # .env.local 已 gitignore
```

**The key lines of `.env.local` (MiniMax China example):**

```env
IKNOW_LLM_BASE_URL=https://api.minimaxi.com/anthropic
MINIMAX_API_KEY=<你的订阅 Key，从 https://platform.minimaxi.com/user-center/payment/token-plan 拿>
# 可选（默认 300000 / 0 / on，按需覆盖）；输出 token 预算不再走 env（见 3.1）
IKNOW_LLM_TIMEOUT_MS=300000
IKNOW_LLM_TEMPERATURE=0
IKNOW_LLM_STREAM=on
```

**Add model + apiKey placeholder in `~/.iknow/settings.json` (user layer):**

```json
{
  "llm": {
    "model": "MiniMax-M3",
    "apiKey": "${MINIMAX_API_KEY}"
  }
}
```

> `llm` is a user-layer key (ADR-0084) — writing it into `<cwd>/.iknow/settings.json` gets it dropped and has no effect.

- `llm.model` is a literal (the env route is retired, ADR-0015); MiniMax-M3 = the latest 1M-context model, supports tool use / streaming / thinking. Alternatives: `MiniMax-M2.7` / `MiniMax-M2.5` / `MiniMax-M2.1` / `MiniMax-M2`, plus `-highspeed` variants.
- `llm.apiKey` uses the `${MINIMAX_API_KEY}` placeholder → `expandPlaceholders` (`src/config/env.ts`) resolves the real value through `resolveValueFromFilename` with priority `process.env[VAR] > .env.local > .env`; the file-side `fileMap` is merged and built by `parseEnvFile` inside `loadIknowEnv` (no line numbers are carried, to avoid drift with the code).
- The variable name need not be `MINIMAX_API_KEY`: any name works as long as settings.json and `.env.local` agree (e.g. `"${ANTHROPIC_AUTH_TOKEN}"` + `ANTHROPIC_AUTH_TOKEN=<key>` is equally fine).

**Other Anthropic-compatible endpoints (same chain):**

| Scenario                                     | `IKNOW_LLM_BASE_URL`                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Local WSL gateway / 9router (default)        | Leave empty → `http://localhost:20128/v1`                                                         |
| MiniMax China (Anthropic-compatible)         | `https://api.minimaxi.com/anthropic`                                                              |
| MiniMax International (Anthropic-compatible) | `https://api.minimax.io/anthropic`                                                                |
| Anthropic official                           | `https://api.anthropic.com`                                                                       |
| Self-hosted proxy / other OpenAI-compatible  | `https://<host>/v1` (needs an OpenAI-compatible client; iknow defaults to the Anthropic protocol) |

---

## 6. Verification

```bash
# 配置后确认 iknow 能加载（settings 生效 + 真模型可达）
# （i135 冒烟脚本 phase1 已移入 iknow-archive/scripts-probes/）
npx tsx ../iknow-archive/scripts-probes/i135-settings-model-extension-smoke.ts   # i135 A/B/C/D 四组，12/12 通过 = 配置正确
# ACI web backend：真打 api.exa.ai（search + contents）。缺 EXA_API_KEY → Not run / exit 0
npm run probe:aci-web-backend
# 真远程 e2e（指向 IKNOW_LLM_BASE_URL + settings.llm.model 真实调用）
npm run test:real-llm
```

---

## 7. Zero friction: local → cloud in three steps

For: the local WSL gateway is unreachable from a cloud VM, but the local machine can still write files → scp the config files to the cloud directly, and **the user fills in only one API key line**.

### Step 1: one-time local setup (scaffolding already in place)

`<cwd>/.env.example` (git-tracked) + `~/.iknow/settings.json` (user layer, already contains model + apiKey placeholder). The user only needs:

```bash
cd /path/to/iknow
cp .env.example .env.local          # gitignore
chmod 600 .env.local                 # 收紧权限

vim .env.local
# 只需改这一行（其它不动）：
#   MINIMAX_API_KEY=<在这里填 MiniMax 订阅 Key>
# 改完后形如：
#   MINIMAX_API_KEY=eyJhbGciOi...
```

> `~/.iknow/settings.json` already contains `model: "MiniMax-M3"` + `apiKey: "${MINIMAX_API_KEY}"`, nothing more to change; if the variable name changes, align it at this one place.

### Step 2: scp the two files to the cloud

```bash
scp .env.local user@cloud-vm:/path/to/iknow/.env.local
scp ~/.iknow/settings.json user@cloud-vm:~/.iknow/settings.json   # llm 是用户层键（ADR-0084），传用户层
# .env.example 已 git tracked，云端 git pull 后自动有；.env.local 是 gitignored、用户层 settings 在仓库外，两者都逐机传
```

### Step 3: verify on the cloud VM

```bash
ssh user@cloud-vm
cd /path/to/iknow
git pull                            # 拉 .env.example（git tracked）
ls -la .env.local ~/.iknow/settings.json   # 应都存在
npm run test:real-llm           # 远程 A1/A2 应 PASS（settings 加载 + 占位符解析由真实 e2e 覆盖）
```

### Rotating the key

When the key changes, edit the one line on the cloud; no need to re-upload settings.json:

```bash
ssh user@cloud-vm
vim .env.local                       # 改 MINIMAX_API_KEY= 一行
```

settings.json stays untouched; the env chain (`process.env > .env.local > .env`) is hot-reloaded automatically (`src/config/settings-watch.ts`, 100ms debounce).

### Fresh clone on a new machine

After git clone there is no user-layer `~/.iknow/settings.json` — iknow then fail-fasts with "no LLM model configured in settings.llm.model. Set it in ~/.iknow/settings.json.". Create it (**user layer**, not `<cwd>/.iknow/settings.json`):

```bash
mkdir -p ~/.iknow
cat > ~/.iknow/settings.json <<'EOF'
{
  "llm": {
    "thinking": "adaptive",
    "model": "MiniMax-M3",
    "apiKey": "${MINIMAX_API_KEY}"
  }
}
EOF
chmod 600 ~/.iknow/settings.json
cp .env.example .env.local && chmod 600 .env.local && vim .env.local
```

---

## Related

- ADR-0015 `docs/adr/0015-llm-config-settings-single-source.md`
- ADR-0084 `docs/adr/0084-project-settings-allowlist-and-permissions.md` (project settings allowlist: project files adopt only `hooks` / `verify` / `secrets` / `permissions`)
- `.env.example` (project root; git-tracked; remote endpoint + placeholder-value template)
