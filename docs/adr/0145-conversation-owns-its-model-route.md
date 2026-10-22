# 0145. A conversation owns its model route; `settings.llm.model` is only the default for new conversations

Date: 2026-10-17
Status: accepted
Deciders: operator (rulings 1–7 settled in the #1258 review, 2026-10-17)
Related: ADR-0015 §1 (`settings.llm.model` as sole source — amended here: sole source of the **default**), ADR-0093 (`/model` picker persistence — its Enter act is redefined here), ADR-0094 (runtime LLM env / EnvLoader hot reload — model no longer hot-applies to live conversations), ADR-0143 (settings load memoized by metadata — makes per-turn route re-resolution free), ADR-0122 (sub-agent model route — precedence unchanged, fallback changed), ADR-0141 (preset overlay — deliberately **not** the carrier, see Alternatives)

Spec: `specs/session-model-isolation.md`. Issue: #1258.

## Context

Selecting a model in one conversation changes the model of every other live conversation, in the same process and across processes. Both channels were verified at master `a67e8273`:

1. **Intra-process.** `SessionHub.reloadFromEnv()` (`src/session-api/hub.ts:2269-2294`) builds one adapter (`:2281`), replaces `cachedDeps.adapter` (`:2282-2284`) and restamps every `engineByRoot` entry (`:2285-2290`). The wire model is fixed at adapter construction (`createAdapterFromEnv`, `src/harness/build-engine.ts:553-590`, `model: wireModelFromRoute(env.llm.model)`). One hub hosts many conversations (TUI switches in-process; serve multiplexes `conversationId`s over one hub), so all of them share one model.
2. **Inter-process.** `/model` writes `~/.iknow/settings.json` (`src/tui/run.tsx:769-791` → `persistModelChanges`, `src/config/persist-settings.ts:669`). Every process watches that file (`src/config/settings-watch.ts:198`) and reloads (`src/tui/run.tsx:1222`, `src/session-api/serve.ts:273`). The self-write sentinel (`src/config/env-loader.ts:118`) suppresses only the writer's own event.

The defect's shape: one mutable value is simultaneously **the default** and **this conversation's choice**.

Five read sites reach the process-global slot directly and would leak around any fix at `runDeps`: compaction (`hub.ts:3446`), the thinking-override env (`overrideEnvForTurn`, `hub.ts:2242-2244`, consumed at `:2594-2601`), `runContinuePending` (`hub.ts:3593-3622`), the sub-agent worker's fallback (`src/harness/subagent/worker.ts:730-741`, `workerRoute?.model ?? env.llm.model` with `env = loadIknowEnv()` read in the worker process), and output masking: `setActiveExtraSecrets` (`src/harness/sandbox/env-isolation.ts:160-163`) is a whole-array replace written per engine build (`src/harness/build-engine.ts:1345`). With several routes live in one process, "last build wins" can drop a live route's key from the mask set — a credential-exposure risk, strictly worse than a wrong model.

## Decision

### 1. Two tiers, two owners

| Tier                         | Carrier                                                                               | Written by                                              | Read by                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| **default model**            | `settings.json → llm.model` (EnvLoader)                                               | the `/model` act; hand edits                            | **conversation creation only** (and the one-shot backfill in §3) |
| **conversation model route** | `SessionFileV1.model` (persisted) + `Map<conversationId, route>` in the hub (runtime) | creation snapshot; that conversation's own `/model` act | every model call made **for** that conversation                  |

A live conversation never reads the default tier again. Nothing another conversation or another process does can change it.

### 2. Creation snapshots the default

`createSession` (`hub.ts:2412-2441`) writes `model: <current default route>` into the new session file, alongside the fields it already stamps, and seeds the map. The TUI path reaches the same method (`src/tui/hub-bridge.ts:563`), so TUI and serve share one rule.

### 3. Persisted, optional, no schema bump

`SessionFileV1` gains `readonly model?: string` (`src/session-api/store/schema.ts:143`). This is additive in exactly the way `workspaceRoot` and `nativeStateFormat` were: absent is valid, present is shape-checked in the optional-field validator (`schema.ts:271-345`; precedent `:291-297`), and sanitize preserves it through `...obj` (`schema.ts:524`). `CURRENT_SCHEMA_VERSION` stays `5` (`schema.ts:232`); no migration. The storage-format change is operator-approved (code-quality red line 4).

A file without the field (every session created before this change) is **backfilled once**: on first attach in a process, the hub snapshots the current default into the map and persists it with that conversation's next save. From then on it behaves like any other conversation.

### 4. Runtime reads the map, never the default

The map is the runtime truth; the file is its durable copy. On attach (`loadSessionForTurn`, `hub.ts:4791`; `getSession`, `hub.ts:2444`) a missing map entry is restored from `file.model`, else backfilled (§3). A present entry is never re-read from the file or re-snapshotted — switching away and back in the TUI changes nothing.

Entry lifetime: removed on `resetSession` (`hub.ts:3307`) and on `shutdown` (`hub.ts:2203`); restored lazily from the file on next attach. Reset keeps the same conversation id and the file is spread-preserved (`hub.ts:3319-3330`), so the conversation keeps its model across reset. **No capacity eviction**: eviction would be safe only because the file is authoritative, and it buys nothing (one short string per conversation). serve has **no** close or delete endpoint (`src/session-api/http.ts` routes: create `:326`, reset `:628`, nothing else removes a conversation), so in serve entries live until reset or process exit.

### 5. One act in `/model`

Selecting a model:

1. sets the current conversation's route (map + session file, inside that conversation's serialize slot);
2. writes `llm.model` in `settings.json` as today (`persistModelChanges` → `markSelfWrite` → `reload()`), which now means "the default for **new** conversations".

There is no "this conversation only" key and no "revert to default" key. Other live conversations — in this process or any other — are unchanged. A hand edit of `llm.model` affects only conversations created afterwards. If step 2 fails after step 1 succeeded, the conversation keeps its new route and the existing failure notice reports the settings write (`persistModelFailure`, `src/tui/run.tsx:788`).

### 6. Credentials and limits still hot-apply

`apiKey` / `baseUrl` / `headers` / `routeMaxTokens` / `temperature` / `stream` / `thinking` / `fallback` are not choices; they still hot-apply to every conversation on the next turn. `reloadFromEnv` keeps its validation and dedupe (`sameHotReloadKeyFields`, `hub.ts:381-392`) but stops being the adapter source for turns: it only invalidates the derived cache (§7) by publishing a new default env reference.

### 7. Read path: per-turn overlay at `runDeps`

Per turn: route from the map → `resolveLlmEnvForRoute(defaultEnv, route)` (new, `src/config/env.ts`, built from `resolveLlmTransport`, `env.ts:520`, the same transport resolution `resolveOptionalRoute` uses at `:572-598`) → derived cache keyed `(route, defaultEnv reference)` → adapter overlaid at `runDeps` (`hub.ts:2744`). This is the seam the code already names: `withThinkingOverride` replaces only `adapter` per turn (`src/session-api/thinking-override.ts:93-120`) and `hub.ts:2780` states "the deps overlay, not the build, is where session identity exists". Harness signatures do not change. N conversations over M distinct routes build M adapters. The cache self-invalidates when the EnvLoader hands out a new reference; a miss costs one re-resolution, which ADR-0143's memo makes free of file reads.

A route that no longer resolves (provider removed from `llm.providers`, key env unset) fails the turn with the typed `LlmProviderConfigError` copy. It **never** silently falls back to the default: that would be the original bug through a side door. The operator recovers by picking a model in `/model`.

### 8. The same change closes every read site

- Compaction (`hub.ts:3446`) uses the conversation's route adapter.
- The thinking override receives the conversation's route env, not `overrideEnvForTurn()` (`hub.ts:2242`), so one turn cannot run two models.
- `runContinuePending` (`hub.ts:3609-3622`) applies the same overlay as `postMessage`.
- Sub-agent worker: the parent puts the conversation's route on the worker envelope (in-band, next to `parentThinking`, `src/harness/subagent/envelope.ts:81`); the worker uses it **only** where it used `env.llm.model` (`worker.ts:741`). `settings.subagent.model` keeps precedence (ADR-0122). No env var — `IKNOW_LLM_MODEL` stays retired (ADR-0015 §1).
- Output masking: `setActiveExtraSecrets` becomes a keyed contribution (`owner → values`) and the active set is the **union** of all live owners. Each engine build contributes under its root; the hub contributes each live route's resolved key under the route. `clearActiveExtraSecrets` removes one owner, not the set.

### 9. Documented contracts that change

- `src/session-api/serve.ts:255-258`: editing `model` in `settings.json` applies to **new** conversations; `apiKey` / `headers` still apply on the next `POST /messages`.
- ADR-0015 §1, ADR-0093, ADR-0094 receive amendment notes pointing here.

## Alternatives rejected

- **Key the existing caches by `conversationId` only.** Closes channel 1 only if the read site stops reading the global slot, and cannot close channel 2: the leak is where the write lands (a watched file), not storage layout.
- **Memory-only capture (the #1258 sketch).** Rejected by the operator: reopening a conversation would silently adopt whatever the default had become.
- **Two acts (`Enter` = this conversation, `d` = default).** Rejected for one act: fewer keys, nothing to collide with, and isolation still holds because live conversations never read the default.
- **Carry the route in the ADR-0141 session overlay.** That overlay is per-process and never persisted (`specs/yolo-mode.md` §1); this route is per-conversation and resume-relevant.

## Consequences

- `/model` in conversation A affects A and future conversations, nothing else.
- Reopening a conversation resumes on its own model; `TurnRecord.modelRequested` / `modelActual` (`src/harness/trace/types.ts:185-186`) remain the forensic record and the test oracle.
- Display: the TUI model row and the `/model` cursor show the **current conversation's** route, not the default.
- Mask set can only grow by live owners; it never shrinks because another root rebuilt.

## Out of scope (separate follow-ups)

- Sub-agent route **inheritance policy** beyond the fallback in §8 (e.g. per-definition overrides).
- Per-conversation `liteModel`, `subagent.model`, or thinking.
- `fsMode` / permission per-conversation isolation (same per-process-holder shape, different consequence).
