import { loadIknowEnv } from "../../config/env.js";

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

function configuredSecretNames(): readonly string[] {
  const configured = loadIknowEnv().llm.apiKeyEnv;
  const names = new Set<string>();
  if (configured) names.add(configured);
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

export function currentSecretEnvNames(): readonly string[] {
  return configuredSecretNames();
}

export function currentSecretValues(
  env: NodeJS.ProcessEnv = process.env
): readonly string[] {
  return Object.freeze(
    configuredSecretNames()
      .map((name) => env[name])
      .filter((value): value is string => Boolean(value))
  );
}
