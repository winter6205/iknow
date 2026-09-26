/**
 * iknow settings file mechanism — the single source of truth for loop config.
 *
 * Two layers: user-level `~/.iknow/settings.json` and project-level
 * `<cwd>/.iknow/settings.json`. Project files adopt only the `verify` /
 * `secrets` / `permissions` sections; these still override user settings
 * field-by-field (project overrides only the legal fields it actually declares,
 * unlisted user fields are kept). `hooks` is user-layer only (command hooks are
 * arbitrary shell — the same supply-chain risk as `plugins`). Any other
 * top-level section (`llm` / `isolation` / `subagent` / `web` / `lsp` /
 * `memory` / `loop` / `graph` / `hooks`) found in a project file is dropped
 * with a warning (`filterProjectSettingsKeys`); only the user layer may give it.
 * One file behind both paths (cwd === home, or `$HOME` reached via a symlink) still feeds both
 * layers: ADR-0019 D1.1 makes the launch dir the per-root state anchor and ADR-0088 keeps
 * project settings in its `.iknow` — the entry directory is a workspace scope in its own right.
 * In that case only the drop *wording* misleads (nothing left the merged result), so it is
 * suppressed; the filtering itself never is.
 *
 * The `secrets` section:
 *  - `secrets.enabled`: whether hook secret redaction is active; only a boolean
 *    is legal; missing → consumers treat it as true (on by default).
 *  - `secrets.patterns`: list of secret-matching patterns (regex source
 *    strings); only a non-empty string array is legal; missing / empty array →
 *    consumers fall back to the built-in default set (the settings layer never
 *    pre-fills the built-in set, it only carries user config).
 *  - `secrets.mode`: secret handling mode; only `"roundtrip"` | `"block"` is
 *    legal; missing → consumers treat it as "roundtrip" (detect + placeholder
 *    substitution + restore); "block" = the older deny-only preToolUse guard
 *    (compat path). Illegal value → drop the field.
 *
 * settings model extension:
 *  - `settings.llm.model` is the literal source of the model routing ID (a
 *    non-empty trimmed string); env.ts no longer reads IKNOW_LLM_MODEL; a
 *    missing value makes the env loader fail fast.
 *  - `settings.llm.apiKey` accepts a literal or a `${VAR}` placeholder; env.ts
 *    resolves it via `expandPlaceholders` from process.env > .env.local > .env;
 *    unset → undefined (a guard at the consumer point throws).
 *
 * The auto-correction loop:
 *  - the `settings.verify` section carries the loop config; unset → verify is
 *    undefined (the assembly layer resolveVerifyConfig falls back to command="",
 *    handing off to the classifier judge — see verify-config.ts).
 *  - defaults (timeoutSec=600 / onExhausted=report / maxRounds=12) are filled at
 *    the consumer (verify-loop), not here — the settings layer only passes
 *    through explicit user config.
 *
 * Following env.ts's "fall back on illegal values, never throw" discipline:
 *  - file missing → empty object;
 *  - bad JSON (SyntaxError) → empty object; other unexpected errors rethrow;
 *  - illegal values (maxTurns not a finite positive integer / contextWindow /
 *    thresholdTokens not a finite positive number / thinking not
 *    "off"|"adaptive" / thinkingEffort not one of the five levels /
 *    model not a non-empty string / fallback not a non-empty string array /
 *    apiKey neither literal nor placeholder / verify fields out of range or
 *    non-literal / isolation.worktreeOnMutate not boolean) → drop the field,
 *    and a dropped field does not take part in overriding (it won't erase the
 *    matching user value);
 *  - top / intermediate layers must be plain objects (arrays / strings, etc. →
 *    drop that layer / field).
 *
 * One exception to drop-not-throw: an explicit
 * `llm.providers[].models[].maxTokens` that is not a positive safe integer
 * throws `LlmBudgetConfigError` instead of being dropped. That field is the
 * request output budget, and silently discarding it would keep sending requests
 * under the 32,000-token fallback while the operator believes a configured cap
 * is in force.
 *
 * llm.thinking / llm.thinkingEffort share their value domain with env.ts
 * IKNOW_LLM_THINKING(_EFFORT), but fall back by env > settings priority —
 * settings only supplies the default.
 *
 * The returned IknowSettings is deep-frozen (recursive Object.freeze, aligned
 * with the project's immutability discipline).
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  parseIsolationNetwork,
  mergeIsolationNetwork,
  type IknowSettingsIsolationNetwork,
} from "./isolation-network.js";
import {
  parseIsolationCredentials,
  mergeIsolationCredentials,
  type IknowSettingsIsolationCredentials,
} from "./isolation-credentials.js";
import {
  LLM_LEGACY_MAX_OUTPUT_TOKENS_MIGRATION_MESSAGE,
  LLM_MAX_TOKENS_EXPECTED_MESSAGE,
} from "./messages.js";

export type { IknowSettingsIsolationNetwork } from "./isolation-network.js";
export type {
  IknowSettingsIsolationCredentials,
  IknowSettingsCredentialFileEntry,
  IknowSettingsCredentialEnvVarEntry,
} from "./isolation-credentials.js";

export interface IknowSettingsLlmCompress {
  contextWindow?: number;
  thresholdTokens?: number;
}

/**
 * A single model entry in the `llm.providers` section:
 *  - `id`: model routing ID, unique within the provider, non-empty after trim
 *    (reuses `isNonEmptyString`);
 *  - `name?`: display name (non-empty trimmed string);
 *  - `contextWindow?`: drop-not-throw like the rest of this file — a value that
 *    is not a finite positive number is silently dropped;
 *  - `maxTokens?`: the **request output budget** sent as `max_tokens` for this
 *    model entry; when absent, request assembly uses the 32,000-token fallback.
 *    It is not a supplier hard limit. Explicit values are validated as a
 *    positive safe integer: `null`, a wrong type, zero, negative, fractional, or
 *    beyond-safe-integer throws `LlmBudgetConfigError`
 *    (`model_max_tokens_invalid`) instead of being dropped into that fallback.
 * `id` is required; a missing `id` drops the whole model entry (the provider may
 * still be kept; a provider with an empty array drops itself — see
 * `parseLlmProvider`).
 */
export interface IknowSettingsLlmProviderModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

/**
 * Typed configuration error for the request output budget. Two kinds, one
 * surface: an explicit illegal `models[].maxTokens` value in a settings file
 * (thrown while parsing that file) and the retired global
 * `IKNOW_LLM_MAX_OUTPUT_TOKENS` still being configured (thrown by the env
 * loader, which owns the environment reads).
 *
 * Plain-object `satisfies` shape (like `LlmProviderConfigError` /
 * `WebEnvConfigError`): callers discriminate with `isLlmBudgetConfigError`,
 * **never** `err instanceof Error`. The payload carries configuration names and
 * the offending configured value only — never an API key or file content.
 */
export type LlmBudgetConfigError =
  | {
      kind: "model_max_tokens_invalid";
      providerId: string;
      modelId: string;
      field: "maxTokens";
      value: unknown;
    }
  | {
      kind: "legacy_max_output_tokens_env";
      varName: string;
      value: string;
    };

/** Output-budget typed-error discriminated guard. */
export function isLlmBudgetConfigError(
  err: unknown
): err is LlmBudgetConfigError {
  if (err === null || typeof err !== "object") return false;
  const maybe = err as Record<string, unknown>;
  if (maybe.kind === "model_max_tokens_invalid") {
    return (
      typeof maybe.providerId === "string" &&
      typeof maybe.modelId === "string" &&
      maybe.field === "maxTokens" &&
      Object.prototype.hasOwnProperty.call(maybe, "value")
    );
  }
  if (maybe.kind === "legacy_max_output_tokens_env") {
    return typeof maybe.varName === "string" && typeof maybe.value === "string";
  }
  return false;
}

/** JSON renders structured values; `JSON.stringify(undefined)` yields undefined. */
function renderBudgetConfigValue(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/**
 * Renders `LlmBudgetConfigError` text: names the offending model entry (or env
 * variable) and the `models[].maxTokens` migration target. Copy fragments come
 * from `messages.ts` so both kinds describe the same field identically.
 */
export function formatLlmBudgetConfigError(err: LlmBudgetConfigError): string {
  if (err.kind === "model_max_tokens_invalid") {
    return (
      `model_max_tokens_invalid: ${err.providerId}/${err.modelId} ` +
      `field ${err.field} = ${renderBudgetConfigValue(err.value)}. ` +
      LLM_MAX_TOKENS_EXPECTED_MESSAGE
    );
  }
  return (
    `legacy_max_output_tokens_env: ${err.varName} = ` +
    `${renderBudgetConfigValue(err.value)}. ` +
    LLM_LEGACY_MAX_OUTPUT_TOKENS_MIGRATION_MESSAGE
  );
}

/**
 * A single provider entry in the `llm.providers` section:
 *  - `id`: provider routing ID (the first segment of the `provider/model`
 *    routing string), non-empty after trim; not de-duplicated within providers
 *    (the load layer does not dedupe, behaving like the user-fallback array —
 *    later definitions override earlier ones, the first hit wins; at run time
 *    `loadIknowEnv`'s resolution order decides);
 *  - `baseUrl`: Anthropic-compatible endpoint (non-empty trimmed string; V1
 *    does not validate URL shape);
 *  - `apiKeyEnv`: env var name; the key is read at run time via
 *    `process.env[apiKeyEnv]` (non-empty trimmed string; illegal name → typed
 *    throw at the consumer);
 *  - `headers?`: optional dictionary, keys and values both strings (a non-string
 *    value drops the whole key);
 *  - `models`: the provider's model array (non-empty array).
 *
 * V1 hard constraint: this type describes anthropic-format providers only;
 * OpenAI-compatible / Gemini native etc. are left to later rounds.
 */
export interface IknowSettingsLlmProvider {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models: ReadonlyArray<IknowSettingsLlmProviderModel>;
}

/** llm.thinking value domain: matches env.ts IKNOW_LLM_THINKING (case-sensitive, lowercase). */
export type IknowSettingsThinking = "off" | "adaptive";

/** llm.thinkingEffort value domain: the env five levels (no "" placeholder — an empty string is meaningless in settings). */
export type IknowSettingsThinkingEffort =
  "low" | "medium" | "high" | "xhigh" | "max";

/** Legal thinkingEffort levels on the settings side (no ""). SSOT: session-api THINKING_EFFORT_VALUES (the wire layer includes ""). */
export const THINKING_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly IknowSettingsThinkingEffort[];

export interface IknowSettingsLlm {
  maxTurns?: number;
  /**
   * Race ceiling for a single LLM call (per-call, milliseconds).
   * Mirrors the maxTurns validation discipline: only a finite positive integer is
   * legal; non-integer / non-positive / non-number / wrong type → drop the field.
   * env chain: `envOptionalInt("IKNOW_LLM_TIMEOUT_MS") ?? settings.llm.timeoutMs ?? 300_000`.
   */
  timeoutMs?: number;
  /**
   * Ceiling on model-output-increment silence in the streaming arm (ms).
   * Mirrors the timeoutMs validation discipline: only a finite positive integer
   * is legal, everything else is dropped. The default idle is raised from 120s
   * to a minute-scale 300s (~5 min) so long thinking / large output isn't
   * killed by mistake; the invariant that idle stays within `[60s, 600s]` is
   * pinned by tests/harness/model-idle-hardcap-config.test.ts.
   * env chain: `envOptionalInt("IKNOW_LLM_IDLE_TIMEOUT_MS") ?? settings.llm.idleTimeoutMs ?? 300_000`.
   */
  idleTimeoutMs?: number;
  /**
   * Finite hard cap for a single model call in the streaming arm (ms): it times
   * out on reaching the cap even if increments are still arriving.
   * Mirrors the timeoutMs validation discipline.
   * env chain: `envOptionalInt("IKNOW_LLM_HARD_CAP_MS") ?? settings.llm.hardCapMs ?? 900_000`.
   */
  hardCapMs?: number;
  compress?: IknowSettingsLlmCompress;
  /** Default thinking switch; overridden when env IKNOW_LLM_THINKING is explicitly set. */
  thinking?: IknowSettingsThinking;
  /** Default effort; overridden when env IKNOW_LLM_THINKING_EFFORT is explicitly set. */
  thinkingEffort?: IknowSettingsThinkingEffort;
  /** Model routing ID; only a non-empty string is legal. */
  model?: string;
  /**
   * Lite model routing ID, same shape as `model` (`provider/model`), sharing the
   * `providers[]` lookup; currently its only consumer is session-title generation.
   * Only a non-empty string is legal, illegal values are dropped; absence /
   * misconfiguration does not fail fast (assembly: env.ts `resolveLlmLite`).
   */
  liteModel?: string;
  /** Model fallback routing ID list (user-configured; code presets no default).
   * Only a non-empty string array is legal (at least 1 item); illegal → drop the field.
   */
  fallback?: string[];
  /** Source of the LLM API key (the single carrier):
   *  - literal value: used directly as the key (no placeholder expansion);
   *  - `${VAR}` / `$VAR` placeholder: resolved by env.ts `expandPlaceholders`,
   *    preferring process.env[VAR], with .env.local / .env as fallback;
   *    unresolved → undefined.
   * Unset → undefined (no default, no hardcoding; a guard at the consumer throws "no API key configured").
   */
  apiKey?: string;
  /** LLM provider registry — a user-layer key (not adopted from project files).
   *  loadIknowEnv splits settings.llm.model = "<provider>/<model>" and looks it
   *  up: a hit → baseUrl = provider.baseUrl + apiKey = process.env[provider.apiKeyEnv];
   *  a miss → fallback to the current path IKNOW_LLM_BASE_URL + settings.llm.apiKey
   *  (back-compat).
   *  An illegal provider drops entirely (see parseLlmProvider); an empty array → field absent.
   */
  providers?: ReadonlyArray<IknowSettingsLlmProvider>;
}

export interface IknowSettingsVerify {
  /**
   * Verification command. Only a non-empty string is legal; unset → the verify
   * section produces no command field, and the assembly layer resolveVerifyConfig
   * falls back to command="" (handed to the classifier judge — see verify-config.ts).
   */
  command?: string;
  /** Per-file rerun template for failed cases, with a `{files}` placeholder; only a non-empty string is legal. */
  rerunTemplate?: string;
  /** Override regex for extracting the failure count (optional); only a non-empty string is legal. */
  countRegex?: string;
  /**
   * Verification command timeout (seconds). The default 600 is applied at the
   * consumer (the settings layer does not pass a default); only a finite
   * positive integer is legal.
   */
  timeoutSec?: number;
  /**
   * Action when fix attempts are exhausted. Only the `"report"` | `"escalate"`
   * literals are legal; the default report is applied at the consumer.
   */
  onExhausted?: "report" | "escalate";
  /** Overall round cap. The default 12 is applied at the consumer; only a finite positive integer is legal. */
  maxRounds?: number;
}

export interface IknowSettingsSecrets {
  /** Whether hook secret redaction is enabled. When missing, consumers treat it as true (on by default). */
  enabled?: boolean;
  /**
   * List of secret-matching patterns (regex source strings). User-configured;
   * code presets no default; missing / empty array → consumers fall back to the
   * built-in default set (the settings layer does not fill the built-in set).
   * Only a non-empty string array is legal (at least 1 item, each non-empty after trim); illegal → drop the field.
   */
  patterns?: string[];
  /**
   * Secret handling mode. Default = "roundtrip" (detect + placeholder substitution + restore);
   * "block" = the older deny-only preToolUse guard (compat path). Illegal value → drop.
   */
  mode?: "roundtrip" | "block";
}

/**
 * Subagent config section (per-task wallclock, independent of per-call llm.timeoutMs).
 *
 * `taskTimeoutMs` = a subagent's whole-task lifetime cap (ms), consumed by the
 * parent manager's SIGTERM timer. Its semantics, naming, and consumer point stay
 * fully separate from `llm.timeoutMs` (per-call LLM race).
 *
 * Validation discipline (mirrors maxTurns):
 *  - only a finite positive integer (>= 1 and integral) is legal;
 *  - non-positive / non-integer / non-number / wrong type → drop the field;
 *  - all fields illegal → the subagent section is not produced.
 *
 * env chain (mirrors the maxTurns pattern):
 * `envOptionalInt("IKNOW_SUBAGENT_TASK_TIMEOUT_MS") ?? mergedSettings.subagent?.taskTimeoutMs`;
 * the env layer does not pre-fill the 7200s default (the default is declared at
 * the manager consumer point to avoid declaring it in two places).
 */
/**
 * Subagent concurrency cap value domain: a positive integer `3|5|9|15` or `"unlimited"`.
 *  - positive integer → gate value (active+starting >= this value throws SubAgentCapacityError);
 *  - `"unlimited"` → no concurrency rejection (OS / memory remain the real ceiling);
 *  - settings default → env default → 15 (byte-for-byte equal to prior behavior).
 *
 * On-disk form: the `subagent.maxConcurrentWorkers` field in settings.json accepts a
 * positive integer or the literal string `"unlimited"`; every other value (strings
 * like `"off"`, negatives, floats, booleans) is dropped (fail-closed, aligned with
 * the existing value-domain discipline of `IknowSettingsSubagent`).
 */
export type SubagentCapValue = number | "unlimited";

export interface IknowSettingsSubagent {
  taskTimeoutMs?: number;
  /** Concurrency cap for subagents simultaneously in starting/running; only a positive integer or `"unlimited"` takes effect. */
  maxConcurrentWorkers?: SubagentCapValue;
  /**
   * Worker model route (`provider/model`, same `providers[]` as `llm.model`).
   * User layer only — the project allowlist never adopts `subagent` (ADR-0084).
   */
  model?: string;
}

/**
 * Default subagent concurrency cap.
 * env / settings fall back to this value when unset or non-positive; shared by the
 * manager and the env loader. Config must not import harness in reverse.
 */
export const DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS = 15;

/**
 * Durable default for the graph-orchestration overlay.
 *
 * graph is an optional overlay: by default tasks still go through one-shot
 * `spawn_subagent` without entering a graph, so when this section is absent
 * consumers treat it as "off" (the default is not pre-filled at the settings layer).
 * Runtime chain: `settings.graph.enabled > false`; within a session Shift+Tab /
 * `/graph` toggle it in place (`resolveGraphMode` in `harness/graph/mode.ts` is the
 * single assembly point).
 *
 * Validation discipline mirrors `IknowSettingsSubagent`: only a boolean is legal;
 * wrong type → drop the field; all fields illegal / absent → the graph section is not produced.
 */
export interface IknowSettingsGraph {
  enabled?: boolean;
}

/**
 * Code-restore (rewind preimage capture) section — user-layer only.
 *
 * `enabled` is the capture switch. Absent / non-boolean → the field is not
 * produced and consumers treat it as ON (`enabled !== false`), so capture is
 * the default and only an explicit `false` disables it. Not on
 * `PROJECT_SETTINGS_ALLOWED_KEYS`, so a project settings file's `codeRestore`
 * is dropped before merging (capture is a host/session decision, not a
 * team-contract policy).
 *
 * Validation discipline mirrors `IknowSettingsGraph`: boolean-only; all
 * illegal / absent → the section is not produced.
 */
export interface IknowSettingsCodeRestore {
  enabled?: boolean;
}

/**
 * Auto-memory section.
 *
 * `autoExtract` / `dream` accept only booleans; missing / illegal → the field is
 * not produced and consumers treat it as false (defaulting OFF is a decision, not
 * an accident). The two are independent.
 */
export interface IknowSettingsMemory {
  autoExtract?: boolean;
  dream?: boolean;
}

/**
 * Session-level git worktree isolation section.
 *
 * `worktreeOnMutate` accepts only a boolean; missing / non-`true` / illegal values
 * are all treated as OFF (fail-closed, same value-domain discipline as
 * `memory.autoExtract`) — when OFF, the mutate path behaves exactly as today. The
 * only fail-closed read point is `resolveWorktreeOnMutate`.
 *
 * Value-domain contract: the config layer carries boolean value-domain semantics
 * only — it does not read git or hold session state; the switch is read once at
 * the startup load point.
 *
 * `worktreeExclusive` is orthogonal to `worktreeOnMutate` with the same
 * boolean-only / default-OFF / fail-closed discipline; missing / non-`true` is
 * treated as OFF (`resolveWorktreeExclusive` is the single read point). At
 * assembly time `src/harness/build-engine.ts` reads it and passes it to the
 * seams that need it (consumed by the session-api `enter` check); no git / session
 * query happens at the settings layer.
 *
 * L1 weak-mode disclosure: the occupancy enumeration goes through
 * `SessionStore.list()` and is visible only within this process — `SessionStore`
 * is constructed once per process, bound to one cwd / workspaceRoot, with no
 * cross-root / cross-dataDir aggregation entry. Occupancy held by other processes
 * (independent CLI sessions, `iknow serve` under a different PID) is invisible —
 * the same tree could be entered by two processes while this switch only blocks
 * this one. A strong "cross-process occupancy visible" mode would require scanning
 * every project namespace under `<dataDir>/projects/*` (M×N file parses); that is
 * not done here. An operator who turns this switch on already knows the limit.
 */
export interface IknowSettingsIsolation {
  /** Switch: on mutate, create a task worktree and rebind the session (default OFF). */
  worktreeOnMutate?: boolean;
  /**
   * enter-worktree adds a pre-flight occupancy check — if the target tree is held
   * by another existing session record, reject with a typed error (`worktree_claimed`).
   * Default OFF (byte-for-byte as today); when OFF, enter behaves as today with no new
   * rejection path.
   */
  worktreeExclusive?: boolean;
  /**
   * Filesystem isolation mode (how the bash physical fence decides which paths are
   * visible / writable). Defaults to global mode; workspace mode is optional.
   * Orthogonal to PermissionMode and worktreeOnMutate. Value domain `"global" | "workspace"`;
   * illegal values (case mismatch / other strings / non-string) → drop the field, fall back to global.
   * The same fail-closed read point is `resolveFsIsolationMode` (same shape as
   * `resolveWorktreeOnMutate`). User-layer key only — the project file's isolation
   * section is dropped, same discipline as worktreeOnMutate / worktreeExclusive.
   */
  fsMode?: FsIsolationMode;
  /**
   * Domain allowlist config for the egress proxy seam — user-layer key only.
   * Carries the shape validation of `allowedDomains` / `deniedDomains`; `*.x`
   * wildcard semantics and case normalization are left to the semantic layer. An
   * empty array = deny all (a legal fail-closed state); non-string entries / empty
   * after trim / bare `*` / out-of-range `:port` → drop the entry + record it via
   * onWarn (no throw). If this section appears in a project file it is dropped with
   * the whole isolation section (existing `filterProjectSettingsKeys` behavior), so no
   * duplicate warning here. See `src/config/isolation-network.ts`.
   */
  network?: IknowSettingsIsolationNetwork;
  /**
   * Credential roster section — user-layer key only (a project file's isolation
   * section is dropped entirely). Carries `files[]` (path / optional extract which
   * must contain capture group 1 / optional decode:"jwt" / required injectHosts)
   * and `envVars[]` (name / required injectHosts); an illegal entry drops that
   * entry with a warning, no throw; the user-layer total is capped at 16, extras
   * are dropped from the tail with a warning. The two github entries come from the
   * code's built-in roster (`harness/sandbox/egress/credential-assembly.ts` SSOT);
   * this section only narrows / appends. See `src/config/isolation-credentials.ts`.
   */
  credentials?: IknowSettingsIsolationCredentials;
}

/** Filesystem isolation mode value domain. */
export type FsIsolationMode = "global" | "workspace";

/**
 * User command-hook handler (same shape as plugin hooks.json).
 * Only `type: "command"` is accepted; timeout is in seconds (optional).
 */
export interface IknowSettingsHookHandler {
  type: "command";
  command: string;
  timeout?: number;
}

/** A matcher plus its handlers. A missing matcher means match-all. */
export interface IknowSettingsHookGroup {
  matcher?: string;
  hooks: IknowSettingsHookHandler[];
}

/**
 * `settings.hooks`: user-layer only. A missing section = no user command hooks.
 * Unknown event names are ignored. Built-in hooks do not go through this section.
 */
export interface IknowSettingsHooks {
  PreToolUse?: IknowSettingsHookGroup[];
  PostToolUse?: IknowSettingsHookGroup[];
}

/** Closed set of user command-hook events (same set as plugin hooks.json). */
export const HOOK_EVENT_VALUES: readonly (keyof IknowSettingsHooks)[] = [
  "PreToolUse",
  "PostToolUse",
];

/**
 * Web tool config section. Fallback chain env > settings > default (following the
 * maxTurns precedent); these are assembly-time fields (not in the settings
 * hot-reload allowlist, so a change requires a process restart).
 */
export interface IknowSettingsWeb {
  /**
   * web_search backend selection. Value domain matches env.ts's `SEARCH_BACKEND_VALUES`
   * closed set; illegal value → drop the field (drop-not-throw; the loader still throws a
   * typed error for illegal env values).
   */
  searchBackend?: "bing" | "exa" | "tavily" | "brave";
}

/**
 * web.searchBackend closed set (a settings-layer local constant): same value domain as
 * env.ts `SEARCH_BACKEND_VALUES` (ordered to match the env SSOT bing → tavily → exa →
 * brave). settings.ts must not import env.ts in reverse (env.ts → settings.ts already
 * depends; the reverse would be a cycle), so this is derived from the field union; the
 * type level only guarantees elements ⊆ the union, and value-domain parity is held by the
 * sort-deepEqual guard in tests/config/web-settings.test.ts (an explicit test-time red,
 * not silent drift).
 */
export const WEB_SEARCH_BACKEND_VALUES: readonly IknowSettingsWeb["searchBackend"][] =
  ["bing", "tavily", "exa", "brave"];

/**
 * The only fail-closed read point for `isolation.worktreeOnMutate`.
 * Missing / non-boolean / non-`true` → false (falls back to today's behavior); the
 * config layer performs no git / session-state query.
 */
export function resolveWorktreeOnMutate(
  settings: IknowSettings | undefined | null
): boolean {
  return settings?.isolation?.worktreeOnMutate === true;
}

/**
 * The only fail-closed read point for `isolation.worktreeExclusive` (same shape as
 * `resolveWorktreeOnMutate`).
 *
 *  - missing / non-boolean / non-`true` → false (falls back to today's enter behavior,
 *    byte-for-byte; the OFF mode's zero-regression is pinned);
 *  - the config layer carries boolean value-domain semantics only — it does not read
 *    git, hold session state, or enumerate existing session records; the occupancy
 *    decision is executed by the session-api `enter-worktree` seam consuming the result
 *    of a one-time assembly-time read;
 *  - the switch is read once at the startup load point; a session-root rebind does not
 *    trigger a settings reload — `WorktreeIsolationHostOpts.worktreeExclusive` is the
 *    assembly-time carrier of that one-time read result.
 */
export function resolveWorktreeExclusive(
  settings: IknowSettings | undefined | null
): boolean {
  return settings?.isolation?.worktreeExclusive === true;
}

/**
 * The only fail-closed read point for `isolation.fsMode` (mirrors the shape of
 * `resolveWorktreeOnMutate`).
 *
 *  - absent / non-`"workspace"` → `"global"` (falls back to the default global mode;
 *    "default global" is a deliberate design, not an accident);
 *  - returns `"workspace"` only when the literal is strictly === `"workspace"`;
 *    everything else (case mismatch / `"WORKSPACE"` / `"Global"` / other strings /
 *    non-string / boolean / number) falls back to `"global"` — the settings layer does
 *    not throw, consistent with the fail-closed discipline of `worktreeOnMutate` /
 *    `worktreeExclusive`;
 *  - the config layer carries string value-domain semantics and does not read session
 *    state; the switch is read once at the startup load point, and at run time is
 *    toggled in place by `/config` or the `FsModeContext` holder.
 */
export function resolveFsIsolationMode(
  settings: IknowSettings | undefined | null
): FsIsolationMode {
  return settings?.isolation?.fsMode === "workspace" ? "workspace" : "global";
}

/**
 * LSP config section. All fields optional; requestTimeoutMs / diagnosticsWaitMs are
 * positive integers; idleTimeoutMs is an integer >= 0 (0 = sweep off). Consumers:
 * build-engine assembles and injects LspCtx (tool-layer timeout/wait + client idle
 * sweep + disabledServers filtering). The worker does not read the settings file and
 * is injected with the idle default (DEFAULT_LSP_IDLE_TIMEOUT_MS).
 */
export interface IknowLspSettings {
  /** Per-request LSP timeout cap (ms, default 20_000). */
  requestTimeoutMs?: number;
  /** Pre-read wait deadline for lsp_diagnostics (ms, default 2_000). */
  diagnosticsWaitMs?: number;
  /** Idle LSP-client reclaim threshold (ms, default 600_000; 0 means no reclaim). */
  idleTimeoutMs?: number;
  /** List of disabled server ids (a hit → treated as unconfigured). */
  disabledServers?: string[];
}

/**
 * Project-layer `permissions` section: a declarative string-list (`allow` / `ask` /
 * `deny`) plus an optional `defaultMode`. This layer only gates shape (plain object +
 * field types); ajv schema validation and rule parsing / compilation live in
 * `src/harness/permission/project-settings.ts` (SSOT), and the config layer does not
 * import harness in reverse. This field is a pass-through value carrier — it is not
 * consumed at run time, only read once by the permission assembly layer
 * (`resolveProjectPermissionSource` reads the root at a single point).
 */
export interface IknowSettingsPermissions {
  /**
   * Startup `PermissionMode` seed; only `"default"` | `"plan"` is legal;
   * `"full_auto"` fails loud at the project-settings layer (a shared repo must
   * not self-grant automatic mode).
   */
  defaultMode?: string;
  /** allow rule array (strings passed through; compilation is in the permission layer). */
  allow?: ReadonlyArray<unknown>;
  /** ask rule array (strings passed through; compilation is in the permission layer). */
  ask?: ReadonlyArray<unknown>;
  /** deny rule array (strings passed through; compilation is in the permission layer). */
  deny?: ReadonlyArray<unknown>;
}

export interface IknowSettings {
  llm?: IknowSettingsLlm;
  verify?: IknowSettingsVerify;
  secrets?: IknowSettingsSecrets;
  /**
   * Project-layer permission rule section: a declarative `allow` / `ask` / `deny`
   * string list plus an optional `defaultMode`. Parsed at the project layer only —
   * the user layer's `permissions` is not accepted (see `loadIknowSettings`). This
   * interface only gates shape; rule parsing / compilation live in
   * `src/harness/permission/project-settings.ts` (the same SSOT).
   *
   * This field is not consumed at run time: the permission source is read at a
   * single point by the assembly layer via
   * `resolveProjectPermissionSource({ projectIdentityRoot })` (shared by build-engine /
   * worker); this layer is a shape gate, not a second reader. This layer drops illegal
   * fields (drop-not-throw), so treating it as a policy source would silently downgrade
   * a schema violation to "no project rules" — exactly the form the fail-loud policy is meant to exclude.
   */
  permissions?: IknowSettingsPermissions;
  /** Subagent config section (per-task wallclock). */
  subagent?: IknowSettingsSubagent;
  /** Graph-orchestration overlay default for new sessions (off by default). */
  graph?: IknowSettingsGraph;
  /** Rewind preimage capture switch (on by default; only an explicit `false`
   *  disables). User-layer only — dropped from project files by the allowlist. */
  codeRestore?: IknowSettingsCodeRestore;
  /** Tool-loop detection. Only a boolean is legal; consumers treat the default as true. */
  loop?: IknowSettingsLoop;
  /** Auto-memory extraction switch (default OFF). */
  memory?: IknowSettingsMemory;
  /** Session-level git worktree isolation switch (default OFF). */
  isolation?: IknowSettingsIsolation;
  /** LSP config section (all optional, defaults resolved at the consumer). */
  lsp?: IknowLspSettings;
  /** User command hooks (PreToolUse/PostToolUse; user-layer only). */
  hooks?: IknowSettingsHooks;
  /** Web tool config section (web_search backend selection, etc.). */
  web?: IknowSettingsWeb;
  /**
   * Plugin component loading config (user-layer only — a project layer's `plugins`
   * is dropped by the allowlist with a warning). Consumers: src/harness/plugin/roots.ts
   * `resolvePluginRoots` (roots resolution) + `discoverPlugins` (disabled filtering).
   */
  plugins?: IknowSettingsPlugins;
}

export interface IknowSettingsLoop {
  detectToolLoop?: boolean;
}

/**
 * Plugin component loading config section — user-layer only. A project layer's
 * `plugins` is dropped and warned by `PROJECT_SETTINGS_ALLOWED_KEYS` (the existing
 * allowlist mechanism, guarding against "clone-and-execute" supply-chain attacks:
 * plugins carry hooks = arbitrary command execution).
 *
 * Validation discipline: non-plain-object → drop the section (no throw); roots not a
 * string array / an element not a non-empty string → drop the field; same for disabled;
 * all fields illegal → section absent (consumers treat it as "no config"). In the merge
 * phase the project layer's parsePlugins always receives {} (project plugins were
 * already dropped by the allowlist).
 */
export interface IknowSettingsPlugins {
  /** Explicit plugin root list (absolute or relative paths; resolved to absolute on parse). */
  roots?: string[];
  /** Disabled plugin name list — a hit is skipped (works with plugin/roots.ts). */
  disabled?: string[];
}

/**
 * Top-level key allowlist for shared project settings files — a project file adopts
 * only the three "team contract" sections; `hooks` is not in the list (command hooks
 * are arbitrary shell, the same supply-chain class as `plugins`: if a project can
 * configure it, cloning means executing). Any other top-level key (isolation /
 * llm / memory / subagent / web / lsp / loop / graph / hooks ...) found in a project
 * file is dropped, does not override user values, and is warned via `LoadSettingsOpts.onWarn`.
 */
export const PROJECT_SETTINGS_ALLOWED_KEYS = [
  "verify",
  "secrets",
  "permissions",
] as const;

const PROJECT_SETTINGS_ALLOWED_KEY_SET: ReadonlySet<string> = Object.freeze(
  new Set<string>(PROJECT_SETTINGS_ALLOWED_KEYS)
);

export interface LoadSettingsOpts {
  /** Project root, defaults to process.cwd(). */
  cwd?: string;
  /** User home, defaults to os.homedir(). */
  home?: string;
  /**
   * Warning channel: called once per key when a project file has a top-level key
   * outside the allowlist / a user file has `permissions`. Default → `console.warn`,
   * deduplicated per settings-file pair + message (a startup repeats this load from
   * several entry points); an injected channel receives every message unchanged.
   */
  onWarn?: (message: string) => void;
}

/** Plain object (the top/intermediate layer from JSON.parse can only be this; excludes null / arrays). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Wrap-up for `parseIsolation` / `mergeIsolation` — a section that set no keys is
 * treated as "all fields illegal / absent" and returns undefined (consumers treat it
 * as OFF / global).
 *
 * Judge by key count rather than a per-field `=== undefined` chain: adding or
 * removing fields no longer changes the cost of this check.
 */
function undefinedWhenEmpty<T extends object>(out: T): T | undefined {
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * The per-field project > user pick for `mergeIsolation` — use project when defined,
 * else fall back to user; when both are undefined do not set the key (writing
 * `out.x = undefined` would let consumers' `Object.keys` see a phantom key).
 */
function assignPreferred<K extends keyof IknowSettingsIsolation>(
  out: IknowSettingsIsolation,
  key: K,
  fromProject: IknowSettingsIsolation[K],
  fromUser: IknowSettingsIsolation[K]
): void {
  const value = fromProject !== undefined ? fromProject : fromUser;
  if (value !== undefined) out[key] = value;
}

/** Finite positive number (> 0): value domain of contextWindow / thresholdTokens. */
function isPositiveFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Positive safe integer: value domain of `models[].maxTokens` (the request
 * output budget). Stricter than `isPositiveFinite` on purpose — a fractional or
 * beyond-safe-integer token count cannot be sent as `max_tokens` without the
 * wire value silently differing from the configured one.
 */
function isValidModelMaxTokens(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** Finite positive integer (>= 1 and integral): value domain of maxTurns. */
function isValidMaxTurns(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1
  );
}

/**
 * Validation for llm.timeoutMs (per-call LLM race ceiling, ms).
 * Mirrors the maxTurns discipline: only a finite positive integer is legal; non-positive /
 * non-integer / non-number / wrong type → drop.
 */
function isValidTimeoutMs(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1
  );
}

/** LSP idle sweep: 0 = reclaim off; negatives / non-integers are still dropped. */
function isValidIdleTimeoutMs(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0
  );
}

/**
 * Validation for subagent.taskTimeoutMs (per-task whole-task lifetime cap, ms).
 * Mirrors the maxTurns discipline: only a finite positive integer is legal; non-positive /
 * non-integer / non-number / wrong type → drop.
 */
function isValidTaskTimeoutMs(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1
  );
}

/** Value domain of the subagent concurrency cap: a finite positive integer or the literal string `"unlimited"`. */
function isValidMaxConcurrentWorkers(v: unknown): v is SubagentCapValue {
  return (
    (typeof v === "number" &&
      Number.isFinite(v) &&
      Number.isInteger(v) &&
      v >= 1) ||
    v === "unlimited"
  );
}

/** thinking value-domain check: only lowercase "off" | "adaptive" (case-sensitive, aligned with env semantics). */
function isValidThinking(v: unknown): v is IknowSettingsThinking {
  return v === "off" || v === "adaptive";
}

/** thinkingEffort value-domain check: only the five lowercase levels ("" is meaningless in settings → illegal). */
function isValidThinkingEffort(v: unknown): v is IknowSettingsThinkingEffort {
  return (THINKING_EFFORT_LEVELS as readonly string[]).includes(
    typeof v === "string" ? v : ""
  );
}

/** Non-empty string (still has content after trim): value domain of model. */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Non-empty string array (at least 1 item, each still has content after trim): value domain of fallback. */
function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
}

/** secret mode value domain: only "roundtrip" | "block" (consumers treat the default as roundtrip). */
function isValidSecretMode(v: unknown): v is IknowSettingsSecrets["mode"] {
  return v === "roundtrip" || v === "block";
}

/**
 * Value-domain guard for `isolation.fsMode` (case-sensitive, lowercase literals only).
 * Same shape as `isValidSecretMode`: non-literal → the caller drops the field (no cast,
 * no throw).
 *
 * Exported for reuse by `persist-settings.ts`'s write-back validation (the same closed
 * set, to avoid the two drifting apart).
 */
export function isFsIsolationMode(value: unknown): value is FsIsolationMode {
  return value === "global" || value === "workspace";
}

/**
 * Parse a single model entry. A non-empty `id` is the only hard requirement;
 * `name` / `contextWindow` follow the file's drop-not-throw discipline (an
 * illegal value drops that field only). `maxTokens` is the exception: an
 * explicit value must be a positive safe integer or this throws
 * `LlmBudgetConfigError`; absence is legal and yields no key. An illegal `id` →
 * drop the whole model entry (return undefined) before any field is validated.
 */
function parseLlmProviderModel(
  raw: unknown,
  providerId: string
): IknowSettingsLlmProviderModel | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (!isNonEmptyString(raw.id)) return undefined;
  const modelId = raw.id.trim();
  const out: {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
  } = {
    id: modelId,
  };
  if (isNonEmptyString(raw.name)) out.name = raw.name.trim();
  if (isPositiveFinite(raw.contextWindow))
    out.contextWindow = raw.contextWindow;
  if (raw.maxTokens !== undefined) {
    if (!isValidModelMaxTokens(raw.maxTokens)) {
      throw {
        kind: "model_max_tokens_invalid",
        providerId,
        modelId,
        field: "maxTokens",
        value: raw.maxTokens,
      } satisfies LlmBudgetConfigError;
    }
    out.maxTokens = raw.maxTokens;
  }
  return out;
}

/**
 * Parse a single provider entry. If any of `id` / `baseUrl` / `apiKeyEnv` is a missing
 * non-empty string → drop the whole provider. `headers` accepts only string→string maps; a
 * non-string value drops the whole key. `models` is a non-empty array, each item via
 * `parseLlmProviderModel`; still empty after filtering → the provider itself drops.
 */
function parseLlmProviderHeaders(
  raw: unknown
): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") headers[k] = v;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseLlmProviders(raw: unknown): IknowSettingsLlmProvider[] {
  if (!Array.isArray(raw)) return [];
  const out: IknowSettingsLlmProvider[] = [];
  for (const p of raw) {
    const parsed = parseLlmProvider(p);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** Write the legal providers array into out; empty array / non-array → do not write. */
function applyLlmProviders(out: IknowSettingsLlm, raw: unknown): void {
  const providers = parseLlmProviders(raw);
  if (providers.length > 0) out.providers = providers;
}

/** providers is a user-layer key → merge passes the user value straight through. */
function mergeLlmProviders(
  out: IknowSettingsLlm,
  user: IknowSettingsLlm | undefined
): void {
  if (user?.providers !== undefined) out.providers = user.providers;
}

function parseLlmProviderModels(
  raw: unknown,
  providerId: string
): IknowSettingsLlmProviderModel[] {
  if (!Array.isArray(raw)) return [];
  const out: IknowSettingsLlmProviderModel[] = [];
  for (const m of raw) {
    const parsed = parseLlmProviderModel(m, providerId);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function parseLlmProvider(raw: unknown): IknowSettingsLlmProvider | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.baseUrl) ||
    !isNonEmptyString(raw.apiKeyEnv)
  ) {
    return undefined;
  }
  // The provider's own shape gate runs first: a provider dropped for a bad
  // id / baseUrl / apiKeyEnv never reaches per-model budget validation.
  const models = parseLlmProviderModels(raw.models, raw.id.trim());
  if (models.length === 0) return undefined;
  const headers = parseLlmProviderHeaders(raw.headers);
  const out: {
    id: string;
    baseUrl: string;
    apiKeyEnv: string;
    models: IknowSettingsLlmProviderModel[];
    headers?: Record<string, string>;
  } = {
    id: raw.id.trim(),
    baseUrl: raw.baseUrl.trim(),
    apiKeyEnv: raw.apiKeyEnv.trim(),
    models,
  };
  if (headers !== undefined) out.headers = headers;
  return out;
}

/**
 * Placeholder form: `${VAR}` or `$VAR`. Shares the same VAR-name char set with env.ts's
 * `expandPlaceholders` (`[A-Za-z_][A-Za-z0-9_]*`). settings.ts keeps its own scan
 * implementation (to avoid depending on env.ts), using the same regex source to prevent drift.
 */
export const PLACEHOLDER_PATTERN =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Whole-string placeholder syntax analysis (settings.ts validator aligned with the env.ts
 * resolver):
 *  - placeholders: the `${VAR}` / `$VAR` variable names appearing across the whole string
 *    (de-duplicated, order preserved);
 *  - hasInvalidResidue: after stripping legal placeholders, illegal residue remains
 *    (contains `${` but does not match `${VAR}`, e.g. `${}` / `${1VAR}` / unclosed `${VAR`;
 *    or a `$` embedded in a literal that does not form a legal `$VAR`, e.g. `foo$bar`).
 *    With residue → neither a legal placeholder string nor a pure literal key (a name like
 *    `constructor` is `$VAR`-shaped but not a legal env identifier — the resolver would hit
 *    Object.prototype, hence the isPlainEnvName guard).
 *
 * Semantics (exactly matching env.ts `expandPlaceholders`):
 *  - pure literal (no `$`) → placeholders=[] and no residue;
 *  - legal placeholder string (whole string made of `${VAR}` / `$VAR`) → no residue;
 *  - literal + legal placeholder mixed (`${A}literal`) → no residue (env.ts parses it too);
 *  - contains an illegal form → hasInvalidResidue=true.
 */
export function analyzePlaceholderSyntax(value: string): {
  placeholders: string[];
  hasInvalidResidue: boolean;
} {
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const placeholders = new Set<string>();
  const residue = value.replace(
    PLACEHOLDER_PATTERN,
    (_match, braced: string | undefined, bare: string | undefined) => {
      placeholders.add(braced ?? (bare as string));
      return "";
    }
  );
  PLACEHOLDER_PATTERN.lastIndex = 0;
  // Illegal residue = after stripping legal placeholders, `${` still remains (`${}` /
  // `${1VAR}` / unclosed `${VAR` / mixed-illegal `${A}${1B}`). Pure-literal residue (no
  // `${`, e.g. `plain`, the "foo" in `foo$bar`, the "literal" in `${A}literal`) is a legal
  // literal, not illegal.
  return {
    placeholders: [...placeholders],
    hasInvalidResidue: residue.includes("${"),
  };
}

/**
 * Shape guard for settings.llm.apiKey: a non-empty trimmed string.
 *  - literal (no `$`) → accepted once non-empty after trim;
 *  - contains legal placeholders with no illegal residue (`${VAR}` / `$VAR` mixed, or
 *    literal + placeholder mixed) → accepted (placeholders resolved by env.ts);
 *  - contains `${` but in an illegal form / contains `$` but not a legal `$VAR` → rejected
 *    (illegal placeholder, dropped). Aligned with env.ts `expandPlaceholders` semantics.
 */
export function isApiKeyOrPlaceholder(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const trimmed = v.trim();
  if (trimmed.length === 0) return false;
  return !analyzePlaceholderSyntax(trimmed).hasInvalidResidue;
}

/**
 * Read one settings file and parse it into a plain object.
 * File missing → {}; bad JSON (SyntaxError) → {} (no throw); top level not a plain object → {}.
 * Only JSON.parse's SyntaxError is swallowed; other unexpected errors rethrow (never silently eaten).
 */
function readSettingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
  return isPlainObject(parsed) ? parsed : {};
}

/**
 * Validate a single `llm` layer: illegal fields are dropped.
 * Non-plain-object (array / string / number, etc.) → undefined (drop the layer).
 * compress is a plain object but all its fields illegal → no compress is produced (drop the field).
 */
function parseLlm(raw: unknown): IknowSettingsLlm | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsLlm = {};
  if (isValidMaxTurns(raw.maxTurns)) out.maxTurns = raw.maxTurns;
  // Per-call LLM race ceiling (ms).
  if (isValidTimeoutMs(raw.timeoutMs)) out.timeoutMs = raw.timeoutMs;
  // Streaming-arm dual clocks (idle silence ceiling + finite hard cap), same value-domain discipline as timeoutMs.
  if (isValidTimeoutMs(raw.idleTimeoutMs))
    out.idleTimeoutMs = raw.idleTimeoutMs;
  if (isValidTimeoutMs(raw.hardCapMs)) out.hardCapMs = raw.hardCapMs;
  if (isValidThinking(raw.thinking)) out.thinking = raw.thinking;
  if (isValidThinkingEffort(raw.thinkingEffort)) {
    out.thinkingEffort = raw.thinkingEffort;
  }
  if (isNonEmptyString(raw.model)) out.model = raw.model.trim();
  if (isNonEmptyString(raw.liteModel)) out.liteModel = raw.liteModel.trim();
  if (isNonEmptyStringArray(raw.fallback)) {
    out.fallback = raw.fallback.map((s) => s.trim());
  }
  if (isApiKeyOrPlaceholder(raw.apiKey)) out.apiKey = raw.apiKey.trim();
  // providers array parsing — non-array / empty array → field absent.
  applyLlmProviders(out, raw.providers);
  applyLlmCompress(out, raw.compress);
  if (isEmptyLlm(out)) return undefined;
  return out;
}

/**
 * The compress sub-layer validation for parseLlm (moved out verbatim to bound complexity):
 * non-plain-object → nothing produced; plain object but all fields illegal → no compress
 * (drop the field).
 */
function applyLlmCompress(out: IknowSettingsLlm, raw: unknown): void {
  if (!isPlainObject(raw)) return;
  const compress: IknowSettingsLlmCompress = {};
  if (isPositiveFinite(raw.contextWindow)) {
    compress.contextWindow = raw.contextWindow;
  }
  if (isPositiveFinite(raw.thresholdTokens)) {
    compress.thresholdTokens = raw.thresholdTokens;
  }
  if (
    compress.contextWindow !== undefined ||
    compress.thresholdTokens !== undefined
  ) {
    out.compress = compress;
  }
}

/**
 * Whether every IknowSettingsLlm field is undefined — used when dropping the whole section.
 * The literal Record<keyof …> gives compile-time exhaustiveness: a new type field must be
 * registered here too, or typecheck fails (same semantics as the old && chain, drift prevention
 * enforced by the compiler).
 */
function isEmptyLlm(out: IknowSettingsLlm): boolean {
  const fieldPresence: Record<keyof IknowSettingsLlm, boolean> = {
    maxTurns: out.maxTurns !== undefined,
    timeoutMs: out.timeoutMs !== undefined,
    idleTimeoutMs: out.idleTimeoutMs !== undefined,
    hardCapMs: out.hardCapMs !== undefined,
    compress: out.compress !== undefined,
    thinking: out.thinking !== undefined,
    thinkingEffort: out.thinkingEffort !== undefined,
    model: out.model !== undefined,
    liteModel: out.liteModel !== undefined,
    fallback: out.fallback !== undefined,
    apiKey: out.apiKey !== undefined,
    providers: out.providers !== undefined,
  };
  return !Object.values(fieldPresence).some(Boolean);
}

/**
 * Validate a single `verify` layer: illegal fields are dropped.
 * Non-plain-object (array / string / number, etc.) → undefined (drop the layer).
 * verify is a plain object but all fields illegal → undefined (drop the field, the loop stays off).
 * Defaults (timeoutSec=600 / onExhausted=report / maxRounds=12) are not filled here, applied
 * at the consumer (verify-loop).
 */
function parseVerify(raw: unknown): IknowSettingsVerify | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsVerify = {};
  if (isNonEmptyString(raw.command)) out.command = raw.command.trim();
  if (isNonEmptyString(raw.rerunTemplate)) {
    out.rerunTemplate = raw.rerunTemplate.trim();
  }
  if (isNonEmptyString(raw.countRegex)) out.countRegex = raw.countRegex.trim();
  if (isValidMaxTurns(raw.timeoutSec)) out.timeoutSec = raw.timeoutSec;
  if (raw.onExhausted === "report" || raw.onExhausted === "escalate") {
    out.onExhausted = raw.onExhausted;
  }
  if (isValidMaxTurns(raw.maxRounds)) out.maxRounds = raw.maxRounds;
  if (
    out.command === undefined &&
    out.rerunTemplate === undefined &&
    out.countRegex === undefined &&
    out.timeoutSec === undefined &&
    out.onExhausted === undefined &&
    out.maxRounds === undefined
  )
    return undefined;
  return out;
}

/**
 * Validate a single `subagent` layer — illegal fields are dropped.
 * Non-plain-object (array / string / number, etc.) → undefined (drop the layer).
 * taskTimeoutMs not a finite positive integer → drop the field.
 * All fields illegal → undefined (drop the section).
 */
function parseSubagent(raw: unknown): IknowSettingsSubagent | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsSubagent = {};
  if (isValidTaskTimeoutMs(raw.taskTimeoutMs)) {
    out.taskTimeoutMs = raw.taskTimeoutMs;
  }
  if (isValidMaxConcurrentWorkers(raw.maxConcurrentWorkers)) {
    out.maxConcurrentWorkers = raw.maxConcurrentWorkers;
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (model !== "") out.model = model;
  if (
    out.taskTimeoutMs === undefined &&
    out.maxConcurrentWorkers === undefined &&
    out.model === undefined
  )
    return undefined;
  return out;
}

/** Merge verify layer by layer: project fields take priority, uncovered user fields are kept. */
function mergeVerify(
  user: IknowSettingsVerify | undefined,
  project: IknowSettingsVerify | undefined
): IknowSettingsVerify | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsVerify = {};
  if (project?.command !== undefined) out.command = project.command;
  else if (user?.command !== undefined) out.command = user.command;
  if (project?.rerunTemplate !== undefined) {
    out.rerunTemplate = project.rerunTemplate;
  } else if (user?.rerunTemplate !== undefined) {
    out.rerunTemplate = user.rerunTemplate;
  }
  if (project?.countRegex !== undefined) out.countRegex = project.countRegex;
  else if (user?.countRegex !== undefined) out.countRegex = user.countRegex;
  if (project?.timeoutSec !== undefined) out.timeoutSec = project.timeoutSec;
  else if (user?.timeoutSec !== undefined) out.timeoutSec = user.timeoutSec;
  if (project?.onExhausted !== undefined) out.onExhausted = project.onExhausted;
  else if (user?.onExhausted !== undefined) out.onExhausted = user.onExhausted;
  if (project?.maxRounds !== undefined) out.maxRounds = project.maxRounds;
  else if (user?.maxRounds !== undefined) out.maxRounds = user.maxRounds;
  if (
    out.command === undefined &&
    out.rerunTemplate === undefined &&
    out.countRegex === undefined &&
    out.timeoutSec === undefined &&
    out.onExhausted === undefined &&
    out.maxRounds === undefined
  )
    return undefined;
  return out;
}

/**
 * Merge subagent layer by layer: project fields take priority, uncovered user fields are kept.
 * The parse layer already guarantees fields are integers > 0, so merge only does project > user.
 */
function mergeSubagent(
  user: IknowSettingsSubagent | undefined,
  project: IknowSettingsSubagent | undefined
): IknowSettingsSubagent | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsSubagent = {};
  if (project?.taskTimeoutMs !== undefined) {
    out.taskTimeoutMs = project.taskTimeoutMs;
  } else if (user?.taskTimeoutMs !== undefined) {
    out.taskTimeoutMs = user.taskTimeoutMs;
  }
  if (project?.maxConcurrentWorkers !== undefined) {
    out.maxConcurrentWorkers = project.maxConcurrentWorkers;
  } else if (user?.maxConcurrentWorkers !== undefined) {
    out.maxConcurrentWorkers = user.maxConcurrentWorkers;
  }
  // subagent.model is user-layer only (spec / ADR-0084): a project file must never
  // override it, so this reads the user arm alone — unlike the sibling fields,
  // there is no project precedence to express here.
  if (user?.model !== undefined) {
    out.model = user.model;
  }
  if (
    out.taskTimeoutMs === undefined &&
    out.maxConcurrentWorkers === undefined &&
    out.model === undefined
  )
    return undefined;
  return out;
}

/**
 * Validate the `graph` layer — illegal fields are dropped (mirrors parseLoop).
 * Non-plain-object → undefined (drop the layer); non-boolean → drop the field;
 * all fields illegal → undefined (consumers fall back to the default off).
 */
function parseGraph(raw: unknown): IknowSettingsGraph | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsGraph = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (out.enabled === undefined) return undefined;
  return out;
}

/** Merge graph layer by layer: project fields take priority, uncovered user fields are kept. */
function mergeGraph(
  user: IknowSettingsGraph | undefined,
  project: IknowSettingsGraph | undefined
): IknowSettingsGraph | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsGraph = {};
  if (project?.enabled !== undefined) out.enabled = project.enabled;
  else if (user?.enabled !== undefined) out.enabled = user.enabled;
  if (out.enabled === undefined) return undefined;
  return out;
}

/**
 * Validate the `codeRestore` layer — boolean-only, illegal fields dropped
 * (mirrors `parseGraph`). Non-plain-object → undefined; non-boolean → drop the
 * field; all fields illegal → undefined (consumers treat absent as ON via
 * `enabled !== false`).
 */
function parseCodeRestore(raw: unknown): IknowSettingsCodeRestore | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsCodeRestore = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (out.enabled === undefined) return undefined;
  return out;
}

/** Merge the `codeRestore` layer. The project layer's section is always
 *  undefined (dropped by the allowlist before merge), so the user value wins;
 *  the branch mirrors `mergeGraph` for symmetry. */
function mergeCodeRestore(
  user: IknowSettingsCodeRestore | undefined,
  project: IknowSettingsCodeRestore | undefined
): IknowSettingsCodeRestore | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsCodeRestore = {};
  if (project?.enabled !== undefined) out.enabled = project.enabled;
  else if (user?.enabled !== undefined) out.enabled = user.enabled;
  if (out.enabled === undefined) return undefined;
  return out;
}

function parseLoop(raw: unknown): IknowSettingsLoop | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsLoop = {};
  if (typeof raw.detectToolLoop === "boolean") {
    out.detectToolLoop = raw.detectToolLoop;
  }
  if (out.detectToolLoop === undefined) return undefined;
  return out;
}

function mergeLoop(
  user: IknowSettingsLoop | undefined,
  project: IknowSettingsLoop | undefined
): IknowSettingsLoop | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsLoop = {};
  if (project?.detectToolLoop !== undefined) {
    out.detectToolLoop = project.detectToolLoop;
  } else if (user?.detectToolLoop !== undefined) {
    out.detectToolLoop = user.detectToolLoop;
  }
  if (out.detectToolLoop === undefined) return undefined;
  return out;
}

function parseMemory(raw: unknown): IknowSettingsMemory | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsMemory = {};
  if (typeof raw.autoExtract === "boolean") out.autoExtract = raw.autoExtract;
  if (typeof raw.dream === "boolean") out.dream = raw.dream;
  if (out.autoExtract === undefined && out.dream === undefined)
    return undefined;
  return out;
}

function mergeMemory(
  user: IknowSettingsMemory | undefined,
  project: IknowSettingsMemory | undefined
): IknowSettingsMemory | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsMemory = {};
  if (project?.autoExtract !== undefined) out.autoExtract = project.autoExtract;
  else if (user?.autoExtract !== undefined) out.autoExtract = user.autoExtract;
  if (project?.dream !== undefined) out.dream = project.dream;
  else if (user?.dream !== undefined) out.dream = user.dream;
  if (out.autoExtract === undefined && out.dream === undefined)
    return undefined;
  return out;
}

/**
 * Validate the `isolation` layer — illegal fields are dropped (mirrors parseGraph).
 * Non-plain-object → undefined (drop the layer); worktreeOnMutate / worktreeExclusive
 * non-boolean → drop the field (no cast); fsMode not a `"global"` | `"workspace"`
 * literal → drop (case-sensitive, consistent with worktreeOnMutate's boolean-only
 * discipline); the network section is parsed independently by `parseIsolationNetwork`
 * (config-layer contract); the credentials section is parsed independently by
 * `parseIsolationCredentials`. Fields are validated independently and do not affect each
 * other — if any is legal, the section is kept.
 *
 * onWarn is passed through to `parseIsolationNetwork` so illegal network entries leave a
 * trace (sharing the caller-supplied sink with the file-load `[settings] ...` warning channel).
 */
function parseIsolation(
  raw: unknown,
  onWarn?: (message: string) => void
): IknowSettingsIsolation | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out = parseIsolationLegacyFields(raw);
  const network = parseIsolationNetwork(raw.network, onWarn);
  if (network !== undefined) {
    out.network = network;
  }
  const credentials = parseIsolationCredentials(raw.credentials, onWarn);
  if (credentials !== undefined) {
    out.credentials = credentials;
  }
  return undefinedWhenEmpty(out);
}

/**
 * The existing validation for the three fields worktreeOnMutate / worktreeExclusive /
 * fsMode — factored out so parseIsolation only orchestrates the two levels "old three
 * fields + network sub-section" (complexity gate).
 */
function parseIsolationLegacyFields(
  raw: Record<string, unknown>
): IknowSettingsIsolation {
  const out: IknowSettingsIsolation = {};
  if (typeof raw.worktreeOnMutate === "boolean") {
    out.worktreeOnMutate = raw.worktreeOnMutate;
  }
  if (typeof raw.worktreeExclusive === "boolean") {
    out.worktreeExclusive = raw.worktreeExclusive;
  }
  if (isFsIsolationMode(raw.fsMode)) {
    out.fsMode = raw.fsMode;
  }
  return out;
}

/**
 * Merge isolation layer by layer — project fields take priority, uncovered user fields
 * are kept. The four fields merge independently per-field project > user (mirroring the
 * llm.timeoutMs shape); if any field is legal after merge, the section is kept.
 * `isolation` is a user-layer key — on the production path `project` is always an empty
 * object (see `mergeSettings`), so a project file cannot take the gate off. The network
 * section could theoretically take the project > user branch (`mergeIsolationNetwork`
 * aligned to the same shape), but it is unreachable in production (already dropped at the
 * filter stage); the branch is kept for symmetry + so a future layer-ownership change is one edit.
 */
function mergeIsolation(
  user: IknowSettingsIsolation | undefined,
  project: IknowSettingsIsolation | undefined
): IknowSettingsIsolation | undefined {
  if (!user && !project) return undefined;
  const out = mergeIsolationLegacyFields(user, project);
  const network = mergeIsolationNetwork(user?.network, project?.network);
  if (network !== undefined) out.network = network;
  const credentials = mergeIsolationCredentials(
    user?.credentials,
    project?.credentials
  );
  if (credentials !== undefined) out.credentials = credentials;
  return undefinedWhenEmpty(out);
}

/**
 * The per-field project > user merge for the three fields worktreeOnMutate /
 * worktreeExclusive / fsMode (their existing semantics) — factored out so mergeIsolation
 * only orchestrates the two levels "old three fields + network sub-section" (complexity gate).
 */
function mergeIsolationLegacyFields(
  user: IknowSettingsIsolation | undefined,
  project: IknowSettingsIsolation | undefined
): IknowSettingsIsolation {
  const out: IknowSettingsIsolation = {};
  assignPreferred(
    out,
    "worktreeOnMutate",
    project?.worktreeOnMutate,
    user?.worktreeOnMutate
  );
  assignPreferred(
    out,
    "worktreeExclusive",
    project?.worktreeExclusive,
    user?.worktreeExclusive
  );
  assignPreferred(out, "fsMode", project?.fsMode, user?.fsMode);
  return out;
}

/**
 * Validate the `lsp` layer — illegal fields are dropped (mirrors parseIsolation).
 * Non-plain-object → undefined; requestTimeoutMs / diagnosticsWaitMs not positive integers → drop;
 * idleTimeoutMs not an integer >= 0 → drop (0 is legal = sweep off); disabledServers not a
 * non-empty string array → drop the field; all fields illegal / absent → undefined (consumers use defaults).
 */
function parseLsp(raw: unknown): IknowLspSettings | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowLspSettings = {};
  if (isValidTimeoutMs(raw.requestTimeoutMs)) {
    out.requestTimeoutMs = raw.requestTimeoutMs;
  }
  if (isValidTimeoutMs(raw.diagnosticsWaitMs)) {
    out.diagnosticsWaitMs = raw.diagnosticsWaitMs;
  }
  if (isValidIdleTimeoutMs(raw.idleTimeoutMs)) {
    out.idleTimeoutMs = raw.idleTimeoutMs;
  }
  if (isNonEmptyStringArray(raw.disabledServers)) {
    out.disabledServers = raw.disabledServers.map((s) => s.trim());
  }
  if (
    out.requestTimeoutMs === undefined &&
    out.diagnosticsWaitMs === undefined &&
    out.idleTimeoutMs === undefined &&
    out.disabledServers === undefined
  )
    return undefined;
  return out;
}

/** Merge lsp layer by layer: project fields take priority, uncovered user fields are kept. */
function mergeLsp(
  user: IknowLspSettings | undefined,
  project: IknowLspSettings | undefined
): IknowLspSettings | undefined {
  if (!user && !project) return undefined;
  const out: IknowLspSettings = {};
  if (project?.requestTimeoutMs !== undefined) {
    out.requestTimeoutMs = project.requestTimeoutMs;
  } else if (user?.requestTimeoutMs !== undefined) {
    out.requestTimeoutMs = user.requestTimeoutMs;
  }
  if (project?.diagnosticsWaitMs !== undefined) {
    out.diagnosticsWaitMs = project.diagnosticsWaitMs;
  } else if (user?.diagnosticsWaitMs !== undefined) {
    out.diagnosticsWaitMs = user.diagnosticsWaitMs;
  }
  if (project?.idleTimeoutMs !== undefined) {
    out.idleTimeoutMs = project.idleTimeoutMs;
  } else if (user?.idleTimeoutMs !== undefined) {
    out.idleTimeoutMs = user.idleTimeoutMs;
  }
  if (project?.disabledServers !== undefined) {
    out.disabledServers = project.disabledServers;
  } else if (user?.disabledServers !== undefined) {
    out.disabledServers = user.disabledServers;
  }
  if (
    out.requestTimeoutMs === undefined &&
    out.diagnosticsWaitMs === undefined &&
    out.idleTimeoutMs === undefined &&
    out.disabledServers === undefined
  )
    return undefined;
  return out;
}

/**
 * Web tool config: validate the `web` layer — illegal fields are dropped (mirrors parseIsolation).
 * Non-plain-object → undefined; searchBackend not in the closed set → drop the field (drop-not-throw,
 * consistent with the settings layer's other fields; illegal env values still surface as a more visible
 * typed error); all fields illegal / absent → undefined (env / default bing as fallback).
 */
function parseWeb(raw: unknown): IknowSettingsWeb | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsWeb = {};
  if (
    typeof raw.searchBackend === "string" &&
    (WEB_SEARCH_BACKEND_VALUES as readonly string[]).includes(raw.searchBackend)
  ) {
    out.searchBackend = raw.searchBackend as IknowSettingsWeb["searchBackend"];
  }
  if (out.searchBackend === undefined) return undefined;
  return out;
}

/**
 * Validate the `plugins` layer — illegal fields are dropped (mirrors parseWeb).
 * Non-plain-object → undefined; roots not a string array / any element not a non-empty
 * string → drop the field; same discipline for disabled; all fields illegal → undefined
 * (consumers treat it as "unconfigured").
 *
 * User-layer only: mergePlugins always looks only at user — project-layer plugins were
 * already dropped by PROJECT_SETTINGS_ALLOWED_KEYS at the `filterProjectSettingsKeys` stage.
 */
function parsePlugins(raw: unknown): IknowSettingsPlugins | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsPlugins = {};
  if (Array.isArray(raw.roots)) {
    const roots = raw.roots.filter(isNonEmptyString).map((s) => s.trim());
    if (roots.length > 0) out.roots = roots;
  }
  if (Array.isArray(raw.disabled)) {
    const disabled = raw.disabled.filter(isNonEmptyString).map((s) => s.trim());
    if (disabled.length > 0) out.disabled = disabled;
  }
  if (out.roots === undefined && out.disabled === undefined) return undefined;
  return out;
}

/** Merge the plugins section layer by layer — user is the only source (project layer was dropped by the allowlist earlier). */
function mergePlugins(
  user: IknowSettingsPlugins | undefined,
  _project: IknowSettingsPlugins | undefined
): IknowSettingsPlugins | undefined {
  if (!user) return undefined;
  const out: IknowSettingsPlugins = {};
  if (user.roots !== undefined) out.roots = user.roots;
  if (user.disabled !== undefined) out.disabled = user.disabled;
  return out;
}

/** Web tool config: merge the web layer — project fields take priority, uncovered user fields are kept. */
function mergeWeb(
  user: IknowSettingsWeb | undefined,
  project: IknowSettingsWeb | undefined
): IknowSettingsWeb | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsWeb = {};
  if (project?.searchBackend !== undefined) {
    out.searchBackend = project.searchBackend;
  } else if (user?.searchBackend !== undefined) {
    out.searchBackend = user.searchBackend;
  }
  if (out.searchBackend === undefined) return undefined;
  return out;
}

/**
 * Validate the user `hooks` layer. Illegal groups/handlers are dropped without throwing.
 * Non-plain-object → undefined; unknown events ignored; both events empty → undefined.
 */
function parseHooks(raw: unknown): IknowSettingsHooks | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsHooks = {};
  const pre = parseHookEventGroups(raw.PreToolUse);
  const post = parseHookEventGroups(raw.PostToolUse);
  if (pre !== undefined) out.PreToolUse = pre;
  if (post !== undefined) out.PostToolUse = post;
  if (out.PreToolUse === undefined && out.PostToolUse === undefined) {
    return undefined;
  }
  return out;
}

function parseHookEventGroups(
  raw: unknown
): IknowSettingsHookGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const groups: IknowSettingsHookGroup[] = [];
  for (const entry of raw) {
    const group = parseHookGroup(entry);
    if (group !== undefined) groups.push(group);
  }
  return groups.length > 0 ? groups : undefined;
}

function parseHookGroup(raw: unknown): IknowSettingsHookGroup | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (raw.matcher !== undefined && !isNonEmptyString(raw.matcher)) {
    return undefined;
  }
  if (!Array.isArray(raw.hooks)) return undefined;
  const handlers: IknowSettingsHookHandler[] = [];
  for (const handlerRaw of raw.hooks) {
    const handler = parseHookHandler(handlerRaw);
    if (handler !== undefined) handlers.push(handler);
  }
  if (handlers.length === 0) return undefined;
  const group: IknowSettingsHookGroup = { hooks: handlers };
  if (isNonEmptyString(raw.matcher)) group.matcher = raw.matcher;
  return group;
}

function parseHookHandler(raw: unknown): IknowSettingsHookHandler | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (raw.type !== "command") return undefined;
  if (!isNonEmptyString(raw.command)) return undefined;
  const handler: IknowSettingsHookHandler = {
    type: "command",
    command: raw.command,
  };
  if (typeof raw.timeout === "number" && Number.isFinite(raw.timeout)) {
    handler.timeout = raw.timeout;
  }
  return handler;
}

/** hooks are user-layer only: the project layer was dropped by the allowlist, so merge just passes user through. */
function mergeHooks(
  user: IknowSettingsHooks | undefined,
  _project: IknowSettingsHooks | undefined
): IknowSettingsHooks | undefined {
  return user;
}

/**
 * The single-field project > user priority for mergeLlm (moved out of mergeLlm's per-field
 * if/else-if pairs verbatim to bound complexity): take project when it has a value, else
 * user when it has a value, neither → field absent.
 */
function pickLlmField<K extends keyof IknowSettingsLlm>(
  out: IknowSettingsLlm,
  key: K,
  project: IknowSettingsLlm | undefined,
  user: IknowSettingsLlm | undefined
): void {
  if (project?.[key] !== undefined) out[key] = project[key];
  else if (user?.[key] !== undefined) out[key] = user[key];
}

/**
 * Merge llm layer by layer: project fields take priority, uncovered user fields are kept.
 * `llm` is a user-layer key — on the production path `project` is always an empty object
 * (see `mergeSettings`), so in practice only user values take effect.
 */
function mergeLlm(
  user: IknowSettingsLlm | undefined,
  project: IknowSettingsLlm | undefined
): IknowSettingsLlm | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsLlm = {};
  // Per-field project > user (including timeoutMs / the streaming-arm dual clocks),
  // all via pickLlmField; liteModel is an optional key.
  pickLlmField(out, "maxTurns", project, user);
  pickLlmField(out, "timeoutMs", project, user);
  pickLlmField(out, "idleTimeoutMs", project, user);
  pickLlmField(out, "hardCapMs", project, user);
  pickLlmField(out, "thinking", project, user);
  pickLlmField(out, "thinkingEffort", project, user);
  pickLlmField(out, "model", project, user);
  pickLlmField(out, "liteModel", project, user);
  pickLlmField(out, "fallback", project, user);
  pickLlmField(out, "apiKey", project, user);
  // providers is a user-layer key → pass the user value straight through.
  mergeLlmProviders(out, user);
  if (project?.compress !== undefined || user?.compress !== undefined) {
    const compress: IknowSettingsLlmCompress = {};
    if (project?.compress?.contextWindow !== undefined) {
      compress.contextWindow = project.compress.contextWindow;
    } else if (user?.compress?.contextWindow !== undefined) {
      compress.contextWindow = user.compress.contextWindow;
    }
    if (project?.compress?.thresholdTokens !== undefined) {
      compress.thresholdTokens = project.compress.thresholdTokens;
    } else if (user?.compress?.thresholdTokens !== undefined) {
      compress.thresholdTokens = user.compress.thresholdTokens;
    }
    if (
      compress.contextWindow !== undefined ||
      compress.thresholdTokens !== undefined
    ) {
      out.compress = compress;
    }
  }
  if (isEmptyLlm(out)) return undefined;
  return out;
}

/**
 * Validate a single `secrets` layer: illegal fields are dropped.
 * Non-plain-object (array / string / number, etc.) → undefined (drop the layer).
 * enabled not boolean → drop the field; patterns not a non-empty string array → drop the field;
 * all fields illegal → undefined (drop the layer).
 */
function parseSecrets(raw: unknown): IknowSettingsSecrets | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsSecrets = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (isNonEmptyStringArray(raw.patterns)) {
    out.patterns = raw.patterns.map((s) => s.trim());
  }
  if (isValidSecretMode(raw.mode)) out.mode = raw.mode;
  if (
    out.enabled === undefined &&
    out.patterns === undefined &&
    out.mode === undefined
  )
    return undefined;
  return out;
}

/** Merge secrets layer by layer: project fields take priority, uncovered user fields are kept. */
function mergeSecrets(
  user: IknowSettingsSecrets | undefined,
  project: IknowSettingsSecrets | undefined
): IknowSettingsSecrets | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsSecrets = {};
  if (project?.enabled !== undefined) out.enabled = project.enabled;
  else if (user?.enabled !== undefined) out.enabled = user.enabled;
  if (project?.patterns !== undefined) out.patterns = project.patterns;
  else if (user?.patterns !== undefined) out.patterns = user.patterns;
  if (project?.mode !== undefined) out.mode = project.mode;
  else if (user?.mode !== undefined) out.mode = user.mode;
  if (
    out.enabled === undefined &&
    out.patterns === undefined &&
    out.mode === undefined
  )
    return undefined;
  return out;
}

/**
 * Value-check each layer first, then merge; dropped fields do not take part in overriding.
 *
 * On the production path `projectRaw` has passed the project allowlist
 * (`loadIknowSettings` → `filterProjectSettingsKeys`), so the non-allowlisted sections
 * (llm / isolation / subagent / web / lsp / memory / loop / graph) are always empty objects
 * — each `mergeXxx`'s `project > user` branch is currently unreachable for them (kept to
 * preserve the merge functions' own semantic completeness; the branch is not deleted).
 * The three allowlisted sections (verify / secrets / permissions) are unaffected: project
 * still overrides user field by field. `hooks` is user-layer only.
 */
function mergeSettings(
  userRaw: Record<string, unknown>,
  projectRaw: Record<string, unknown>,
  onWarn?: (message: string) => void
): IknowSettings {
  const userLlm = parseLlm(userRaw.llm);
  const projectLlm = parseLlm(projectRaw.llm);
  const llm = mergeLlm(userLlm, projectLlm);
  const userVerify = parseVerify(userRaw.verify);
  const projectVerify = parseVerify(projectRaw.verify);
  const verify = mergeVerify(userVerify, projectVerify);
  const userSecrets = parseSecrets(userRaw.secrets);
  const projectSecrets = parseSecrets(projectRaw.secrets);
  const secrets = mergeSecrets(userSecrets, projectSecrets);
  // Subagent config section (per-task wallclock), independent of llm.timeoutMs (per-call).
  const userSubagent = parseSubagent(userRaw.subagent);
  const projectSubagent = parseSubagent(projectRaw.subagent);
  const subagent = mergeSubagent(userSubagent, projectSubagent);
  const userLoop = parseLoop(userRaw.loop);
  const projectLoop = parseLoop(projectRaw.loop);
  const loop = mergeLoop(userLoop, projectLoop);
  // Graph-orchestration overlay default for new sessions (off by default).
  const userGraph = parseGraph(userRaw.graph);
  const projectGraph = parseGraph(projectRaw.graph);
  const graph = mergeGraph(userGraph, projectGraph);
  // Rewind preimage capture switch (on by default; project value dropped by the
  // allowlist so only the user layer can carry it).
  const codeRestore = mergeCodeRestore(
    parseCodeRestore(userRaw.codeRestore),
    parseCodeRestore(projectRaw.codeRestore)
  );
  // Auto-memory switch (default OFF — an absent section means off).
  const memory = mergeMemory(
    parseMemory(userRaw.memory),
    parseMemory(projectRaw.memory)
  );
  // Session-level git worktree isolation switch (default OFF — an absent section means off).
  // isolation.network parsing uses the same onWarn channel (same `[settings] ...`
  // prefix as filterProjectSettingsKeys) so illegal entries leave a trace.
  const isolation = mergeIsolation(
    parseIsolation(userRaw.isolation, onWarn),
    parseIsolation(projectRaw.isolation, onWarn)
  );
  // LSP config section (all optional, defaults resolved at the consumer).
  const lsp = mergeLsp(parseLsp(userRaw.lsp), parseLsp(projectRaw.lsp));
  // Web tool config (web_search backend selection; the env > settings fallback chain is in env.ts).
  const web = mergeWeb(parseWeb(userRaw.web), parseWeb(projectRaw.web));
  // User command hooks (userRaw only; project hooks were dropped by the allowlist).
  const hooks = mergeHooks(
    parseHooks(userRaw.hooks),
    parseHooks(projectRaw.hooks)
  );
  // Permission rule section — parsed only from the project layer (the user layer's same-named
  // key was already dropped in `loadIknowSettings`). `projectRaw` passed the allowlist before entering.
  const permissions = parsePermissions(projectRaw.permissions);
  // Plugin component loading config — user-layer only (project-layer plugins were
  // dropped at the allowlist stage; here `parsePlugins(projectRaw.plugins)` is always undefined).
  const plugins = mergePlugins(
    parsePlugins(userRaw.plugins),
    parsePlugins(projectRaw.plugins)
  );
  return assembleSettings({
    llm,
    verify,
    secrets,
    subagent,
    loop,
    graph,
    codeRestore,
    memory,
    isolation,
    lsp,
    web,
    hooks,
    permissions,
    plugins,
  });
}

/** Put only the parsed sections into the result object (absent sections produce no key). */
function assembleSettings(segments: IknowSettings): IknowSettings {
  const out: IknowSettings = {};
  for (const [key, value] of Object.entries(segments)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * The project-layer `permissions` section only gates shape (plain object / `defaultMode`
 * string / `allow` / `ask` / `deny` arrays); value domain and rule legality are validated by
 * the ajv schema in `src/harness/permission/project-settings.ts` (typed error). Fields with an
 * illegal shape are dropped without throwing (drop-not-throw).
 */
function parsePermissions(raw: unknown): IknowSettingsPermissions | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsPermissions = {};
  if (typeof raw.defaultMode === "string") out.defaultMode = raw.defaultMode;
  if (Array.isArray(raw.allow)) out.allow = raw.allow;
  if (Array.isArray(raw.ask)) out.ask = raw.ask;
  if (Array.isArray(raw.deny)) out.deny = raw.deny;
  // Empty section (all fields illegal / absent) → produce no permissions (aligned with the parseSecrets discipline).
  if (
    out.defaultMode === undefined &&
    out.allow === undefined &&
    out.ask === undefined &&
    out.deny === undefined
  )
    return undefined;
  return out;
}

/** Recursively freeze an object (including nested objects). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Filter a project file's top-level keys — only allowlisted keys pass; keys outside the
 * list are dropped and warned one by one (one message per key, naming the key). The drop is
 * deliberate: a project file must not override the user layer (drop-not-throw, an illegal source takes no effect).
 */
function filterProjectSettingsKeys(
  projectRaw: Record<string, unknown>,
  onWarn: (message: string) => void
): Record<string, unknown> {
  const accepted: Record<string, unknown> = {};
  for (const key of Object.keys(projectRaw)) {
    if (PROJECT_SETTINGS_ALLOWED_KEY_SET.has(key))
      accepted[key] = projectRaw[key];
    else
      onWarn(
        `[settings] project settings key "${key}" ignored (not in project allowlist)`
      );
  }
  return accepted;
}

/**
 * Default warn sink dedup state (module-level on purpose: one startup calls
 * `loadIknowSettings` from ~8 entry points, so the same fact would otherwise be
 * printed ~8 times). Keyed by the two paths, the text, and a change signal per file — so a
 * warning about a *different* settings file is still reported, and a long-lived process
 * (`iknow serve`, or anything reloading settings) re-arms after an edit instead of muting a
 * later state for good. Only repetition about an unchanged file is noise. An injected
 * `onWarn` never passes through here and keeps seeing every message.
 */
const reportedDefaultWarnings = new Set<string>();

/**
 * Cheap change signal for one settings file. A file that cannot be stat'd (not written yet,
 * or unreadable) has no detectable content change, so it gets one stable marker — and a warn
 * path must never throw on its way to printing a warning.
 */
function fileChangeSignal(path: string): string {
  try {
    const { mtimeMs, size } = statSync(path);
    return `${mtimeMs}\u0000${size}`;
  } catch {
    return "absent";
  }
}

function warnOncePerFile(
  userPath: string,
  projectPath: string,
  message: string
): void {
  const fact = [
    userPath,
    projectPath,
    message,
    fileChangeSignal(userPath),
    fileChangeSignal(projectPath),
  ].join("\u0000");
  if (reportedDefaultWarnings.has(fact)) return;
  reportedDefaultWarnings.add(fact);
  console.warn(message);
}

/**
 * Whether the two layer paths name one file. Text equality after `resolve` is not enough:
 * `$HOME` can be reached through a symlink while `process.cwd()` reports the physical path,
 * and then two spellings name one file, so the wording the suppression in `loadIknowSettings`
 * exists for would come back. `realpathSync` asks the filesystem; it throws on a path not
 * written yet, which is exactly when two differently-spelled paths cannot be one existing file.
 */
function isSameSettingsFile(userPath: string, projectPath: string): boolean {
  if (resolve(userPath) === resolve(projectPath)) return true;
  try {
    return realpathSync(userPath) === realpathSync(projectPath);
  } catch {
    return false;
  }
}

export function loadIknowSettings(opts?: LoadSettingsOpts): IknowSettings {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
  const userPath = join(home, ".iknow", "settings.json");
  const projectPath = join(cwd, ".iknow", "settings.json");
  // ADR-0019 D1.1 / ADR-0088 make the entry directory a workspace scope of its own, so when
  // both layer paths name one file, the project layer must keep working exactly as before.
  const sameFile = isSameSettingsFile(userPath, projectPath);
  const onWarn =
    opts?.onWarn ??
    ((message: string) => warnOncePerFile(userPath, projectPath, message));

  const userRaw = readSettingsFile(userPath);
  const projectRaw = readSettingsFile(projectPath);
  // In the one-file case that sentence is false: `permissions` does take effect, via
  // this very project layer. Same for the per-key "ignored" lines below — the user's own
  // values are not being dropped. Suppress the text only, never the filtering.
  if (!sameFile && Object.prototype.hasOwnProperty.call(userRaw, "permissions"))
    onWarn(
      '[settings] user settings key "permissions" ignored (project-layer only)'
    );

  return deepFreeze(
    mergeSettings(
      userRaw,
      filterProjectSettingsKeys(
        projectRaw,
        sameFile ? () => undefined : onWarn
      ),
      onWarn
    )
  );
}
