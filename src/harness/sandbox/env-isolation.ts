import { extractPlaceholders } from "../../config/env.js";
import {
  loadIknowSettings,
  type IknowSettings,
} from "../../config/settings.js";

/**
 * settings-model-extension：解析 settings.llm.apiKey 的原始形态，返回
 * 需要参与 process.env 清洗的**变量名**集合。
 *  - 占位符串（`${VAR}` / `$VAR` 形态，任意合法组合，含多段 `${A}${B}` 与
 *    字面 + 占位符混合如 `${A}literal`）→ 返 var 名去重数组（来自
 *    `extractPlaceholders`，M1 修复多段遮蔽漏洗）；
 *  - 字面（trim 后非空、不含 `$IDENT` / `${VAR}` 形态）→ 返 []（密钥已在
 *    settings 文件里不进 env 扫描；其 trimmed 值进 `currentSecretValues`
 *    的内存遮蔽集，M3 修复字面密钥回显遮蔽失效）。
 */
function placeholderVarNames(apiKeyRaw: string | undefined): string[] {
  if (!apiKeyRaw) return [];
  const trimmed = apiKeyRaw.trim();
  if (!trimmed) return [];
  return extractPlaceholders(trimmed);
}

/**
 * 安全地读 settings.llm.apiKey 原始字符串。
 *  - env-isolation 是输出清洗安全层，必须在任何环境可加载（含 model 未配的
 *    fail-fast 场景）。模块顶层 / 每次调用的 key 名解析对 model 无依赖——
 *    `loadIknowEnv` 在 model 未配时抛「no LLM model configured」，此处吞掉
 *    并退化（secret 名单仅剩 env 扫描），不让安全层因装配前置条件缺失而崩溃。
 *  - 成功时返回 settings.llm.apiKey trim 后的原始串（可能为 undefined）。
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
 * 字面 apiKey（trim 后非空、不含占位符形态）→ 其值进入 SC20 遮蔽集，
 * 避免字面密钥回显到模型输出 / JSON trace 时被原样泄露（M3 修复）。变
 * 量名不进 env 扫描（无对应 env var）。
 */
function literalApiKey(): string | undefined {
  const raw = safeLlmApiKeyRaw();
  if (!raw) return undefined;
  // 字面 = 不含任何 `${VAR}` / `$VAR` 占位符形态（extractPlaceholders 返空）。
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
 * settings-model-extension：secret 名单来源 =
 *  1. settings.llm.apiKey 占位符指向的变量名（任意合法组合，含多段；
 *     M1 修复多段 `${A}${B}` 漏洗）；
 *  2. process.env 中命中 SECRET_PATTERN 的变量名（兜底扫描，保持既有行为）。
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
 * #562 T5 / #653:cwdReadonly 后滤注入 GIT_OPTIONAL_LOCKS=0。
 * `filter()` 返回 freeze 对象,不能原地赋值;本函数拷贝后 additive,绕过
 * BASE_ENV_WHITELIST(只用于 bash fence,无 secret 风险)。false / 缺省不改 env。
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

/** #406 T3:active extras — per-engine secret registry 的值（build-engine 构造
 *   registry 后经 `setActiveExtraSecrets(registry.values())` 写入）。让输出
 *   mask 消费点（jsonl / format / stream-draft / hub 全走 `currentSecretValues()`
 *   无参调用）无需改调用点即可覆盖 registry 追踪的密钥。模块级可变槽位是本层
 *   唯一共享状态；显式 `extraSecrets` 入参优先于槽位（`??` 语义）。 */
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
  // 1) 变量名 → 实际值（占位符指向的 var + SECRET_PATTERN 兜底命中的 var）。
  for (const name of configuredSecretNames()) {
    const value = env[name];
    if (value) values.add(value);
  }
  // 2) M3：字面 apiKey 的 trimmed 值也进遮蔽集（与变量名形态不同的字面值，
  // 避免对字面密钥回显时 SC20 遮蔽失效）。
  const literal = literalApiKey();
  if (literal) values.add(literal);
  // 3) #406 T3:registry 追踪值并入（显式入参优先，缺省用模块槽位）；Set 去重。
  const extras = extraSecrets ?? activeExtraSecrets;
  for (const v of extras) {
    if (v) values.add(v);
  }
  return Object.freeze([...values]);
}
