/**
 * #353: iknow settings 文件机制（loop 配置的单一事实源）。
 *
 * 读取 user 级 `~/.iknow/settings.json` 与 project 级 `<cwd>/.iknow/settings.json`，
 * project 覆盖 user（llm 内部逐层合并：project 只覆盖其实际出现的合法字段，
 * 未覆盖的 user 字段保留）。
 *
 * 对齐 env.ts 的"非法值回退不抛错"纪律：
 *  - 文件不存在 → 空对象；
 *  - 坏 JSON（SyntaxError）→ 空对象，其它意外异常继续抛；
 *  - 非法值（maxTurns 非有限正整数 / contextWindow / thresholdTokens 非有限正数 /
 *    model 非空串字符串 / fallback 非空串字符串数组）→ 丢弃该字段，
 *    且被丢弃的字段不参与覆盖（不抹掉 user 对应值）；
 *  - 顶层 / 中间层必须是普通对象（数组 / 字符串等 → 丢弃该层 / 该字段）。
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

export interface IknowSettingsLlm {
  maxTurns?: number;
  compress?: IknowSettingsLlmCompress;
  /** 模型路由 ID（9router）；非空串字符串才合法。 */
  model?: string;
  /**
   * 模型 fallback 路由 ID 列表（用户自配，代码不预置任何默认）。
   * 非空串字符串数组才合法（至少 1 项）；非法 → 丢弃该字段。
   */
  fallback?: string[];
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

/** 非空串字符串（trim 后仍有内容）：model 的值域。 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** 非空串字符串数组（至少 1 项，每项 trim 后仍有内容）：fallback 的值域。 */
function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
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
  if (isNonEmptyString(raw.model)) out.model = raw.model.trim();
  if (isNonEmptyStringArray(raw.fallback)) {
    out.fallback = raw.fallback.map((s) => s.trim());
  }
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
    out.model === undefined &&
    out.fallback === undefined
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
  if (project?.model !== undefined) out.model = project.model;
  else if (user?.model !== undefined) out.model = user.model;
  if (project?.fallback !== undefined) out.fallback = project.fallback;
  else if (user?.fallback !== undefined) out.fallback = user.fallback;
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
    out.model === undefined &&
    out.fallback === undefined
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
