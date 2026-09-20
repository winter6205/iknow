import { extractPlaceholders } from "../../config/env.js";
import {
  loadIknowSettings,
  type IknowSettings,
} from "../../config/settings.js";

/**
 * Parse the raw form of settings.llm.apiKey and return the set of **variable
 * names** that must take part in process.env scrubbing.
 *  - placeholder string (`${VAR}` / `$VAR` forms, any legal combination,
 *    including multi-segment `${A}${B}` and literal+placeholder mixes like
 *    `${A}literal`) → deduped var-name array (from `extractPlaceholders`;
 *    multi-segment coverage matters — an earlier version only saw the first
 *    segment and under-scrubbed);
 *  - literal (non-empty after trim, no `$IDENT` / `${VAR}` form) → `[]` (the
 *    key lives in the settings file, outside env scanning; its trimmed value
 *    enters the in-memory mask set of `currentSecretValues` so literal-key
 *    echo is masked too).
 */
function placeholderVarNames(apiKeyRaw: string | undefined): string[] {
  if (!apiKeyRaw) return [];
  const trimmed = apiKeyRaw.trim();
  if (!trimmed) return [];
  return extractPlaceholders(trimmed);
}

/**
 * Safely read the raw settings.llm.apiKey string.
 *  - env-isolation is an output-scrubbing security layer and must work in any
 *    loadable environment (including fail-fast scenarios where no model is
 *    configured). Key-name resolution here has no model dependency —
 *    `loadIknowEnv` throws when no model is configured; we swallow that and
 *    degrade (the secret name list falls back to env scanning only), so the
 *    security layer never crashes on a missing assembly precondition.
 *  - On success returns settings.llm.apiKey trimmed (possibly undefined).
 */
function safeLlmApiKeyRaw(): string | undefined {
  let loaded: IknowSettings;
  try {
    loaded = loadIknowSettings();
  } catch {
    return undefined;
  }
  const raw = loaded.llm?.apiKey?.trim();
  return raw ? raw : undefined;
}

/**
 * A literal apiKey (non-empty after trim, no placeholder form) → its value
 * enters the secret mask set, so a literal key echoed into model output /
 * JSON trace is not leaked verbatim. No var name enters env scanning (there
 * is no corresponding env var).
 */
function literalApiKey(): string | undefined {
  const raw = safeLlmApiKeyRaw();
  if (!raw) return undefined;
  // literal = contains no `${VAR}` / `$VAR` placeholder form at all (extractPlaceholders returns empty).
  return extractPlaceholders(raw).length === 0 ? raw : undefined;
}

export const BASE_ENV_WHITELIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "NODE_NO_WARNINGS",
  "NODE_PATH",
]);

const SECRET_PATTERN =
  /API[_-]?KEY|SECRET|TOKEN|PASSWD|PASSWORD|PRIVATE[_-]?KEY/i;

/**
 * Secret name sources:
 *  1. var names pointed to by settings.llm.apiKey placeholders (any legal
 *     combination, multi-segment included);
 *  2. process.env names matching SECRET_PATTERN (fallback scan, preserving
 *     existing behavior).
 */
function configuredSecretNames(): readonly string[] {
  const names = new Set<string>();
  for (const name of placeholderVarNames(safeLlmApiKeyRaw())) names.add(name);
  for (const name of Object.keys(process.env)) {
    if (SECRET_PATTERN.test(name)) names.add(name);
  }
  return Object.freeze([...names]);
}

export const SECRET_ENV_NAMES: readonly string[] = configuredSecretNames();

export interface EnvIsolation {
  filter(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  forbiddenNames(): readonly string[];
}

export interface EnvIsolationOptions {
  readonly allowEnv: ReadonlyArray<string>;
}

export function createEnvIsolation(opts: EnvIsolationOptions): EnvIsolation {
  const allowed = new Set(opts.allowEnv);
  const forbidden = configuredSecretNames();
  const filter = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const output: NodeJS.ProcessEnv = {};
    for (const name of allowed) {
      if (env[name] !== undefined && !forbidden.includes(name))
        output[name] = env[name];
    }
    return Object.freeze(output);
  };
  return Object.freeze({ filter, forbiddenNames: () => forbidden });
}

/**
 * When cwdReadonly, additionally inject GIT_OPTIONAL_LOCKS=0. `filter()`
 * returns a frozen object, so this copies then adds, bypassing
 * BASE_ENV_WHITELIST (bash fence only, no secret risk). false / absent leaves
 * env untouched.
 */
export function applyCwdReadonlyFenceEnv(
  filtered: NodeJS.ProcessEnv,
  cwdReadonly: boolean | undefined
): NodeJS.ProcessEnv {
  if (cwdReadonly !== true) return filtered;
  return { ...filtered, GIT_OPTIONAL_LOCKS: "0" };
}

export function currentSecretEnvNames(): readonly string[] {
  return configuredSecretNames();
}

/** Active extras — values of the per-engine secret registry (build-engine
 *   writes them via `setActiveExtraSecrets(registry.values())` after building
 *   the registry). Output-mask consumers (jsonl / format / stream-draft / hub,
 *   all calling `currentSecretValues()` with no args) then cover
 *   registry-tracked keys without changing call sites. This module-level
 *   mutable slot is the layer's only shared state; an explicit `extraSecrets`
 *   argument takes precedence over the slot (`??` semantics). */
let activeExtraSecrets: ReadonlyArray<string> = Object.freeze([]);

export function setActiveExtraSecrets(values: Iterable<string>): void {
  activeExtraSecrets = Object.freeze([...new Set(values)]);
}

export function clearActiveExtraSecrets(): void {
  activeExtraSecrets = Object.freeze([]);
}

export function currentSecretValues(
  env: NodeJS.ProcessEnv = process.env,
  extraSecrets?: Iterable<string>
): readonly string[] {
  const values = new Set<string>();
  // 1) var names → actual values (placeholder-pointed vars + SECRET_PATTERN fallback hits).
  for (const name of configuredSecretNames()) {
    const value = env[name];
    if (value) values.add(value);
  }
  // 2) the literal apiKey's trimmed value also joins the mask set (a literal
  // value distinct from any var-name form, so echo of a literal key stays masked).
  const literal = literalApiKey();
  if (literal) values.add(literal);
  // 3) registry-tracked values merge in (explicit arg wins; module slot is the
  // default); Set dedups.
  const extras = extraSecrets ?? activeExtraSecrets;
  for (const v of extras) {
    if (v) values.add(v);
  }
  return Object.freeze([...values]);
}
