/**
 * #353: iknow settings 文件机制（loop 配置的单一事实源）。
 *
 * 读取 user 级 `~/.iknow/settings.json` 与 project 级 `<cwd>/.iknow/settings.json`，
 * project 覆盖 user（llm 内部逐层合并：project 只覆盖其实际出现的合法字段，
 * 未覆盖的 user 字段保留）。
 *
 * settings-model-extension（#164 第二阶段）：
 *  - `settings.llm.model` 是模型路由 ID 的字面值来源（trim 后非空串），env.ts
 *    不再读 IKNOW_LLM_MODEL；缺失由 env loader fail-fast。
 *  - `settings.llm.apiKey` 接受字面值或 `${VAR}` 占位符，env.ts 经
 *    `expandPlaceholders` 从 process.env > .env.local > .env 解析；未配 →
 *    undefined（消费点守卫抛错）。
 *
 * 对齐 env.ts 的"非法值回退不抛错"纪律：
 *  - 文件不存在 → 空对象；
 *  - 坏 JSON（SyntaxError）→ 空对象，其它意外异常继续抛；
 *  - 非法值（maxTurns 非有限正整数 / contextWindow / thresholdTokens 非有限正数 /
 *    thinking 非 "off"|"adaptive" / thinkingEffort 非五档 /
 *    model 非空串字符串 / fallback 非空串字符串数组 /
 *    apiKey 非字面非占位符）→ 丢弃该字段，且被丢弃的字段不参与覆盖（不抹掉
 *    user 对应值）；
 *  - 顶层 / 中间层必须是普通对象（数组 / 字符串等 → 丢弃该层 / 该字段）。
 *
 * llm.thinking / llm.thinkingEffort 与 env.ts IKNOW_LLM_THINKING(_EFFORT) 同值域，
 * 但按 env > settings 优先级回退（#353 maxTurns 同款）——settings 只做缺省来源。
 *
 * 返回的 IknowSettings 深 frozen（Object.freeze 递归，对齐项目 immutable 纪律）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface IknowSettingsLlmCompress {
  contextWindow?: number;
  thresholdTokens?: number;
}

/** llm.thinking 值域：与 env.ts IKNOW_LLM_THINKING 一致（大小写敏感小写）。 */
export type IknowSettingsThinking = "off" | "adaptive";

/** llm.thinkingEffort 值域：env 五档（不含 "" 占位——空串在 settings 中无意义）。 */
export type IknowSettingsThinkingEffort =
  "low" | "medium" | "high" | "xhigh" | "max";

/** settings 侧 thinkingEffort 合法档位（不含 ""）。SSOT 见 session-api THINKING_EFFORT_VALUES（wire 层含 ""）。 */
export const THINKING_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly IknowSettingsThinkingEffort[];

export interface IknowSettingsLlm {
  maxTurns?: number;
  compress?: IknowSettingsLlmCompress;
  /** 缺省 thinking 开关；env IKNOW_LLM_THINKING 显式设置时覆盖它。 */
  thinking?: IknowSettingsThinking;
  /** 缺省 effort；env IKNOW_LLM_THINKING_EFFORT 显式设置时覆盖它。 */
  thinkingEffort?: IknowSettingsThinkingEffort;
  /** 模型路由 ID（9router）；非空串字符串才合法。 */
  model?: string;
  /**
   * 模型 fallback 路由 ID 列表（用户自配，代码不预置任何默认）。
   * 非空串字符串数组才合法（至少 1 项）；非法 → 丢弃该字段。
   */
  fallback?: string[];
  /**
   * LLM API key 来源（settings-model-extension 单一承载）：
   *  - 字面值：直接作为密钥使用（不经占位符解析）；
   *  - `${VAR}` / `$VAR` 占位符：由 env.ts `expandPlaceholders` 从
   *    process.env[VAR] 优先、.env.local / .env 兜底解析；解析不到 → undefined。
   * 未配 → undefined（不默认、不硬编码；消费点守卫抛「no API key configured」）。
   */
  apiKey?: string;
}

export interface IknowSettings {
  llm?: IknowSettingsLlm;
}

export interface LoadSettingsOpts {
  /** 项目根，默认 process.cwd()。 */
  cwd?: string;
  /** 用户 home，默认 os.homedir()。 */
  home?: string;
}

/** 普通对象（JSON.parse 产出的顶层/中间层只可能是这种；排除 null / 数组）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 有限正数（> 0）：contextWindow / thresholdTokens 的值域。 */
function isPositiveFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** 有限正整数（>= 1 且为整数）：maxTurns 的值域。 */
function isValidMaxTurns(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1
  );
}

/** thinking 值域校验：仅小写 "off" | "adaptive"（大小写敏感，对齐 env 语义）。 */
function isValidThinking(v: unknown): v is IknowSettingsThinking {
  return v === "off" || v === "adaptive";
}

/** thinkingEffort 值域校验：仅小写五档（"" 在 settings 中无意义 → 非合法）。 */
function isValidThinkingEffort(v: unknown): v is IknowSettingsThinkingEffort {
  return (THINKING_EFFORT_LEVELS as readonly string[]).includes(
    typeof v === "string" ? v : ""
  );
}

/** 非空串字符串（trim 后仍有内容）：model 的值域。 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** 非空串字符串数组（至少 1 项，每项 trim 后仍有内容）：fallback 的值域。 */
function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
}

/**
 * 占位符形态：`${VAR}` 或 `$VAR`。与 env.ts `expandPlaceholders` 共用同一
 * VAR 名字符集（`[A-Za-z_][A-Za-z0-9_]*`）。settings.ts 独立持有一份扫描
 * 实现（避免 settings.ts 依赖 env.ts），用同一正则源防 drift（M7 对齐）。
 */
export const PLACEHOLDER_PATTERN =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * 整串占位符语法分析（M7：settings.ts validator 与 env.ts resolver 对齐）：
 *  - placeholders：全串出现的 `${VAR}` / `$VAR` 变量名（去重保序）；
 *  - hasInvalidResidue：剥离合法占位符后仍剩非法残余（含 `${` 但不匹配
 *    `${VAR}`，如 `${}` / `${1VAR}` / `${VAR` 未闭合；或字面里嵌了 `$` 但不
 *    成合法 `$VAR` 形态，如 `foo$bar`）。有残余 → 既非合法占位符串，也非
 *    纯字面密钥（M2 语义：`${constructor}` 属 `$VAR` 形态但 var 名非合法
 *    环境标识符，validator 接受后 resolver 命中 Object.prototype —— 见 M2
 *    isPlainEnvName 守卫）。
 *
 * 语义（与 env.ts `expandPlaceholders` 完全一致）：
 *  - 纯字面（无 `$`）→ placeholders=[] 且无残余；
 *  - 合法占位符串（全串由 `${VAR}` / `$VAR` 拼成）→ 无残余；
 *  - 字面 + 合法占位符混合（`${A}literal`）→ 无残余（env.ts 同样解析）；
 *  - 含非法形态 → hasInvalidResidue=true。
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
  // 非法残余 = 剥离合法占位符后仍剩 `${`（`${}` / `${1VAR}` / `${VAR` 未闭合 /
  // `${A}${1B}` 混合非法）。纯字面残余（无 `${`，如 `plain` / `foo$bar` 的
  // "foo" / `${A}literal` 的 "literal"）是合法字面，不算非法。
  return {
    placeholders: [...placeholders],
    hasInvalidResidue: residue.includes("${"),
  };
}

/**
 * settings.llm.apiKey 形态守卫：trim 非空串。
 *  - 字面（不含 `$`）→ trim 非空即接受；
 *  - 含合法占位符且无非法残余（`${VAR}` / `$VAR` 混排、字面 + 占位符混合）→
 *    接受（占位符由 env.ts 解析）；
 *  - 含 `${` 但含非法形态 / 含 `$` 但不成合法 `$VAR` → 拒绝（非法占位符，
 *    丢弃）。与 env.ts `expandPlaceholders` 的解析语义对齐（M7）。
 */
export function isApiKeyOrPlaceholder(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const trimmed = v.trim();
  if (trimmed.length === 0) return false;
  return !analyzePlaceholderSyntax(trimmed).hasInvalidResidue;
}

/**
 * 读取单个 settings 文件并解析为普通对象。
 * 文件不存在 → {}；坏 JSON（SyntaxError）→ {}（不抛错）；顶层非普通对象 → {}。
 * 仅吞 JSON.parse 的 SyntaxError，其它意外异常重新抛（不静默吞掉）。
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
 * 校验单个 `llm` 层：非法字段丢弃。
 * 非普通对象（数组 / 字符串 / 数字等）→ undefined（丢弃该层）。
 * compress 为普通对象但字段全部非法 → 不产出 compress（丢弃该字段）。
 */
function parseLlm(raw: unknown): IknowSettingsLlm | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsLlm = {};
  if (isValidMaxTurns(raw.maxTurns)) out.maxTurns = raw.maxTurns;
  if (isValidThinking(raw.thinking)) out.thinking = raw.thinking;
  if (isValidThinkingEffort(raw.thinkingEffort)) {
    out.thinkingEffort = raw.thinkingEffort;
  }
  if (isNonEmptyString(raw.model)) out.model = raw.model.trim();
  if (isNonEmptyStringArray(raw.fallback)) {
    out.fallback = raw.fallback.map((s) => s.trim());
  }
  if (isApiKeyOrPlaceholder(raw.apiKey)) out.apiKey = raw.apiKey.trim();
  if (isPlainObject(raw.compress)) {
    const compress: IknowSettingsLlmCompress = {};
    if (isPositiveFinite(raw.compress.contextWindow)) {
      compress.contextWindow = raw.compress.contextWindow;
    }
    if (isPositiveFinite(raw.compress.thresholdTokens)) {
      compress.thresholdTokens = raw.compress.thresholdTokens;
    }
    if (
      compress.contextWindow !== undefined ||
      compress.thresholdTokens !== undefined
    ) {
      out.compress = compress;
    }
  }
  if (
    out.maxTurns === undefined &&
    out.compress === undefined &&
    out.thinking === undefined &&
    out.thinkingEffort === undefined &&
    out.model === undefined &&
    out.fallback === undefined &&
    out.apiKey === undefined
  )
    return undefined;
  return out;
}

/** 逐层合并 llm：project 字段优先，未覆盖的 user 字段保留。 */
function mergeLlm(
  user: IknowSettingsLlm | undefined,
  project: IknowSettingsLlm | undefined
): IknowSettingsLlm | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsLlm = {};
  if (project?.maxTurns !== undefined) out.maxTurns = project.maxTurns;
  else if (user?.maxTurns !== undefined) out.maxTurns = user.maxTurns;
  if (project?.thinking !== undefined) out.thinking = project.thinking;
  else if (user?.thinking !== undefined) out.thinking = user.thinking;
  if (project?.thinkingEffort !== undefined) {
    out.thinkingEffort = project.thinkingEffort;
  } else if (user?.thinkingEffort !== undefined) {
    out.thinkingEffort = user.thinkingEffort;
  }
  if (project?.model !== undefined) out.model = project.model;
  else if (user?.model !== undefined) out.model = user.model;
  if (project?.fallback !== undefined) out.fallback = project.fallback;
  else if (user?.fallback !== undefined) out.fallback = user.fallback;
  if (project?.apiKey !== undefined) out.apiKey = project.apiKey;
  else if (user?.apiKey !== undefined) out.apiKey = user.apiKey;
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
  if (
    out.maxTurns === undefined &&
    out.compress === undefined &&
    out.thinking === undefined &&
    out.thinkingEffort === undefined &&
    out.model === undefined &&
    out.fallback === undefined &&
    out.apiKey === undefined
  )
    return undefined;
  return out;
}

/** 先对每层做值校验，再合并；被丢弃的字段不参与覆盖。 */
function mergeSettings(
  userRaw: Record<string, unknown>,
  projectRaw: Record<string, unknown>
): IknowSettings {
  const userLlm = parseLlm(userRaw.llm);
  const projectLlm = parseLlm(projectRaw.llm);
  const llm = mergeLlm(userLlm, projectLlm);
  return llm ? { llm } : {};
}

/** 递归冻结对象（含嵌套对象）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export function loadIknowSettings(opts?: LoadSettingsOpts): IknowSettings {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();

  const userRaw = readSettingsFile(join(home, ".iknow", "settings.json"));
  const projectRaw = readSettingsFile(join(cwd, ".iknow", "settings.json"));

  return deepFreeze(mergeSettings(userRaw, projectRaw));
}
