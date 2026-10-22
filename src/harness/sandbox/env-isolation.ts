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
 * Safely load the settings object for name resolution. env-isolation is an
 * output-scrubbing security layer and must work in any loadable environment
 * (including fail-fast scenarios where no model is configured). Key-name
 * resolution here has no model dependency — `loadIknowEnv` throws when no
 * model is configured; we swallow that and degrade (the secret name list
 * falls back to env scanning only), so the security layer never crashes on a
 * missing assembly precondition.
 */
function tryLoadIknowSettings(): IknowSettings | undefined {
  try {
    return loadIknowSettings();
  } catch {
    return undefined;
  }
}

/** The raw settings.llm.apiKey trimmed, or undefined when absent / blank. */
function apiKeyRawOf(loaded: IknowSettings | undefined): string | undefined {
  const raw = loaded?.llm?.apiKey?.trim();
  return raw ? raw : undefined;
}

/**
 * Safely read the raw settings.llm.apiKey string (trimmed, possibly
 * undefined). Used by call sites that have no settings read of their own
 * (the module-level `SECRET_ENV_NAMES` initializer, `createEnvIsolation`,
 * `currentSecretEnvNames`). The hot path `currentSecretValues` reads once at
 * its entry instead (via `tryLoadIknowSettings` + `apiKeyRawOf`) and passes
 * the result down.
 */
function safeLlmApiKeyRaw(): string | undefined {
  return apiKeyRawOf(tryLoadIknowSettings());
}

/**
 * A literal apiKey (non-empty after trim, no placeholder form) → its value
 * enters the secret mask set, so a literal key echoed into model output /
 * JSON trace is not leaked verbatim. No var name enters env scanning (there
 * is no corresponding env var).
 */
function literalApiKey(apiKeyRaw: string | undefined): string | undefined {
  if (!apiKeyRaw) return undefined;
  // literal = contains no `${VAR}` / `$VAR` placeholder form at all (extractPlaceholders returns empty).
  return extractPlaceholders(apiKeyRaw).length === 0 ? apiKeyRaw : undefined;
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
 * Callers that already hold the settings read pass `apiKeyRaw`; callers
 * without one (module init / createEnvIsolation / currentSecretEnvNames)
 * omit it and a single safe read happens here.
 */
function configuredSecretNames(apiKeyRaw?: string): readonly string[] {
  const names = new Set<string>();
  for (const name of placeholderVarNames(apiKeyRaw ?? safeLlmApiKeyRaw())) {
    names.add(name);
  }
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

/** Active extras — the extra secret values the output mask covers on top of
 *   the env / settings derived ones. Each owner holds ONE slot: setting an
 *   owner replaces only that owner's slot, clearing removes only that owner's
 *   slot, and the mask covers the union of every live owner — so a second
 *   build in the same process can no longer drop the first build's
 *   registry-tracked keys out of the mask.
 *   Owner keys carry a namespace prefix so the production shapes cannot
 *   collide in the one shared map: `root:<build root>` (an engine build) and
 *   `route:<route id>` (a live model route). `DEFAULT_OWNER` (`default:`) is
 *   the key for callers that have no owner of their own.
 *   Output-mask consumers (jsonl / format / stream-draft / hub, all calling
 *   `currentSecretValues()` with no args) therefore cover registry-tracked
 *   keys without changing call sites. This module-level map is the layer's
 *   only shared state; an explicit `extraSecrets` argument takes precedence
 *   over the whole union (`??` semantics). */
const activeExtraSecretsByOwner = new Map<string, ReadonlyArray<string>>();

/** Owner key for callers that have no owner of their own. */
export const DEFAULT_OWNER = "default:";

/** Replace `owner`'s contribution with `values` (deduped). */
export function setActiveExtraSecrets(
  owner: string,
  values: Iterable<string>
): void {
  activeExtraSecretsByOwner.set(owner, Object.freeze([...new Set(values)]));
}

/** Drop `owner`'s contribution, leaving every other owner masked. */
export function clearActiveExtraSecrets(owner: string): void {
  activeExtraSecretsByOwner.delete(owner);
}

/** The union of every live owner's values (empty strings dropped). */
function activeExtraSecretUnion(): readonly string[] {
  const union = new Set<string>();
  for (const ownerValues of activeExtraSecretsByOwner.values()) {
    for (const value of ownerValues) {
      if (value) union.add(value);
    }
  }
  return Object.freeze([...union]);
}

export function currentSecretValues(
  env: NodeJS.ProcessEnv = process.env,
  extraSecrets?: Iterable<string>
): readonly string[] {
  // Single settings read for the whole invocation: the placeholder names and
  // the literal value below both derive from this one raw apiKey read (each
  // used to re-read settings, doubling the settings-file IO on this hot path).
  const apiKeyRaw = apiKeyRawOf(tryLoadIknowSettings());
  const values = new Set<string>();
  // 1) var names → actual values (placeholder-pointed vars + SECRET_PATTERN fallback hits).
  for (const name of configuredSecretNames(apiKeyRaw)) {
    const value = env[name];
    if (value) values.add(value);
  }
  // 2) the literal apiKey's trimmed value also joins the mask set (a literal
  // value distinct from any var-name form, so echo of a literal key stays masked).
  const literal = literalApiKey(apiKeyRaw);
  if (literal) values.add(literal);
  // 3) registry-tracked values merge in (explicit arg wins over the whole
  // owner union; the union is the default); Set dedups.
  const extras = extraSecrets ?? activeExtraSecretUnion();
  for (const v of extras) {
    if (v) values.add(v);
  }
  return Object.freeze([...values]);
}
