/**
 * #353: iknow settings 文件机制（loop 配置的单一事实源）。
 *
 * 读取 user 级 `~/.iknow/settings.json` 与 project 级 `<cwd>/.iknow/settings.json`，
 * project 覆盖 user（llm / secrets 内部逐层合并：project 只覆盖其实际出现的合法字段，
 * 未覆盖的 user 字段保留）。
 *
 * `secrets` 段（#126 hook-system）：
 *  - `secrets.enabled`：是否启用 hook 敏感信息脱敏，boolean 才合法；缺失 → 消费方按
 *    true（默认开启）处理。
 *  - `secrets.patterns`：敏感信息匹配模式（正则源串）列表，非空串字符串数组才合法；
 *    缺失 / 空数组 → 消费方回退内置默认集（settings 层不预填内置集，只承载用户配置）。
 *  - `secrets.mode`（#406 T4）：secret 处理模式，仅 `"roundtrip"` | `"block"` 合法；
 *    缺失 → 消费方按 "roundtrip"（识别 + 占位符替换 + 还原）处理；"block" = 旧
 *    deny-only preToolUse guard（#126 兼容路径）。非法值 → 丢弃该字段。
 *
 * settings-model-extension（#164 第二阶段）：
 *  - `settings.llm.model` 是模型路由 ID 的字面值来源（trim 后非空串），env.ts
 *    不再读 IKNOW_LLM_MODEL；缺失由 env loader fail-fast。
 *  - `settings.llm.apiKey` 接受字面值或 `${VAR}` 占位符，env.ts 经
 *    `expandPlaceholders` 从 process.env > .env.local > .env 解析；未配 →
 *    undefined（消费点守卫抛错）。
 *
 * #128 自动修正闭环（T5）：
 *  - `settings.verify` 段承载闭环配置；未配置 → verify undefined（装配层
 *    resolveVerifyConfig 以 command="" 兜底, 由分类器判官接管, 见 verify-config.ts）。
 *  - 默认值（timeoutSec=600 / onExhausted=report / maxRounds=12）不在 settings
 *    层填，由消费点（verify-loop）兜底——settings 层只透传用户显式配置。
 *
 * 对齐 env.ts 的"非法值回退不抛错"纪律：
 *  - 文件不存在 → 空对象；
 *  - 坏 JSON（SyntaxError）→ 空对象，其它意外异常继续抛；
 *  - 非法值（maxTurns 非有限正整数 / contextWindow / thresholdTokens 非有限正数 /
 *    thinking 非 "off"|"adaptive" / thinkingEffort 非五档 /
 *    model 非空串字符串 / fallback 非空串字符串数组 /
 *    apiKey 非字面非占位符 / verify 段各字段越界或非字面量）→ 丢弃该字段，
 *    且被丢弃的字段不参与覆盖（不抹掉 user 对应值）；
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
  /**
   * #358 T1: 单次 LLM 调用竞速上限（per-call，毫秒）。
   * 镜像 maxTurns 校验纪律：有限正整数才合法；非整数 / 非正数 / 非数字 / 错类型 → 丢弃该字段。
   * env 链：`envOptionalInt("IKNOW_LLM_TIMEOUT_MS") ?? settings.llm.timeoutMs ?? 300_000`。
   */
  timeoutMs?: number;
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

export interface IknowSettingsVerify {
  /**
   * 验证命令。非空串才合法；未配置 → verify 段不产 command 字段，装配层
   * resolveVerifyConfig 以 command="" 兜底（分类器判官接管，见 verify-config.ts）。
   */
  command?: string;
  /** 失败用例单跑模板，`{files}` 占位；非空串才合法。 */
  rerunTemplate?: string;
  /** 失败数提取正则覆盖（可选）；非空串才合法。 */
  countRegex?: string;
  /**
   * 验证命令超时（秒）。默认 600 由消费点兜底（settings 层不透传默认值）；
   * 有限正整数才合法。
   */
  timeoutSec?: number;
  /**
   * 修正耗尽处置。仅 `"report"` | `"escalate"` 字面量合法；默认 report 由
   * 消费点兜底。
   */
  onExhausted?: "report" | "escalate";
  /** 兜底总轮数上限。默认 12 由消费点兜底；有限正整数才合法。 */
  maxRounds?: number;
  /**
   * 分类器（command 缺失时的子代理 LLM 判官）模型路由 ID（A7）。
   * 显式指定时用其值；缺省解析到 settings.llm.model。ADR-0015 扩展，
   * 非空串才合法（与 command 同纪律），代码层不硬编码模型 ID。
   */
  classifierModel?: string;
}

export interface IknowSettingsSecrets {
  /** 是否启用 hook 敏感信息脱敏。缺失时消费方按 true 处理（默认开启）。 */
  enabled?: boolean;
  /**
   * 敏感信息匹配模式（正则源串）列表。用户自配，代码不预置任何默认；
   * 缺失 / 空数组 → 消费方回退内置默认集（settings 层不填内置集）。
   * 非空串字符串数组才合法（至少 1 项，每项 trim 后非空）；非法 → 丢弃该字段。
   */
  patterns?: string[];
  /**
   * #406 T4: secret 处理模式。缺省 = "roundtrip"（识别+占位符替换+还原）；
   * "block" = 旧 deny-only preToolUse guard（#126 兼容路径）。非法值 → 丢弃。
   */
  mode?: "roundtrip" | "block";
}

/**
 * #358 T1: 子代理配置段（per-task wallclock，独立于 per-call llm.timeoutMs）。
 *
 * `taskTimeoutMs` = 子代理整任务寿命上限（毫秒），父 manager SIGTERM 计时消费。
 * 与 `llm.timeoutMs`（per-call LLM 调用竞速）语义、命名、消费点全程分离（C9）。
 *
 * 校验纪律（镜像 maxTurns）：
 *  - 有限正整数（>= 1 且为整数）才合法；
 *  - 非正 / 非整数 / 非数字 / 错类型 → 丢弃该字段；
 *  - 全部字段非法 → 不产出 subagent 段。
 *
 * env 链（镜像 maxTurns 模式）：
 * `envOptionalInt("IKNOW_SUBAGENT_TASK_TIMEOUT_MS") ?? mergedSettings.subagent?.taskTimeoutMs`，
 * env 层不预填 7200s 默认值（缺省值在 T2 的 manager 消费点声明，避免两处声明）。
 */
export interface IknowSettingsSubagent {
  taskTimeoutMs?: number;
}

export interface IknowSettings {
  llm?: IknowSettingsLlm;
  verify?: IknowSettingsVerify;
  secrets?: IknowSettingsSecrets;
  /** #358 T1: 子代理配置段（per-task wallclock）。 */
  subagent?: IknowSettingsSubagent;
  /** #672 T3: 工具环检测。boolean 才合法；缺省由消费方按 true。 */
  loop?: IknowSettingsLoop;
}

export interface IknowSettingsLoop {
  detectToolLoop?: boolean;
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

/**
 * #358 T1: llm.timeoutMs 校验（per-call LLM 调用竞速上限，毫秒）。
 * 镜像 maxTurns 纪律：有限正整数才合法；非正 / 非整数 / 非数字 / 错类型 → 丢弃。
 */
function isValidTimeoutMs(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1
  );
}

/**
 * #358 T1: subagent.taskTimeoutMs 校验（per-task 整任务寿命上限，毫秒）。
 * 镜像 maxTurns 纪律：有限正整数才合法；非正 / 非整数 / 非数字 / 错类型 → 丢弃。
 */
function isValidTaskTimeoutMs(v: unknown): v is number {
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

/** secret mode 值域：仅 "roundtrip" | "block"（缺省由消费方按 roundtrip 处理）。 */
function isValidSecretMode(v: unknown): v is IknowSettingsSecrets["mode"] {
  return v === "roundtrip" || v === "block";
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
  // #358 T1: per-call LLM 调用竞速上限（毫秒）。
  if (isValidTimeoutMs(raw.timeoutMs)) out.timeoutMs = raw.timeoutMs;
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
    out.timeoutMs === undefined &&
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

/**
 * 校验单个 `verify` 层：非法字段丢弃。
 * 非普通对象（数组 / 字符串 / 数字等）→ undefined（丢弃该层）。
 * verify 为普通对象但字段全部非法 → undefined（丢弃该字段，闭环不启用）。
 * 默认值（timeoutSec=600 / onExhausted=report / maxRounds=12）不在此填充，
 * 由消费点（verify-loop）兜底。
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
  if (isNonEmptyString(raw.classifierModel)) {
    out.classifierModel = raw.classifierModel.trim();
  }
  if (
    out.command === undefined &&
    out.rerunTemplate === undefined &&
    out.countRegex === undefined &&
    out.timeoutSec === undefined &&
    out.onExhausted === undefined &&
    out.maxRounds === undefined &&
    out.classifierModel === undefined
  )
    return undefined;
  return out;
}

/**
 * #358 T1: 校验单个 `subagent` 层 —— 非法字段丢弃。
 * 非普通对象（数组 / 字符串 / 数字等）→ undefined（丢弃该层）。
 * taskTimeoutMs 非有限正整数 → 丢弃该字段。
 * 全部字段非法 → undefined（丢弃该段）。
 */
function parseSubagent(raw: unknown): IknowSettingsSubagent | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsSubagent = {};
  if (isValidTaskTimeoutMs(raw.taskTimeoutMs)) {
    out.taskTimeoutMs = raw.taskTimeoutMs;
  }
  if (out.taskTimeoutMs === undefined) return undefined;
  return out;
}

/** 逐层合并 verify：project 字段优先，未覆盖的 user 字段保留。 */
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
  if (project?.classifierModel !== undefined) {
    out.classifierModel = project.classifierModel;
  } else if (user?.classifierModel !== undefined) {
    out.classifierModel = user.classifierModel;
  }
  if (
    out.command === undefined &&
    out.rerunTemplate === undefined &&
    out.countRegex === undefined &&
    out.timeoutSec === undefined &&
    out.onExhausted === undefined &&
    out.maxRounds === undefined &&
    out.classifierModel === undefined
  )
    return undefined;
  return out;
}

/**
 * #358 T1: 逐层合并 subagent：project 字段优先，未覆盖的 user 字段保留。
 * 仅 taskTimeoutMs 一个字段；parse 层已保证 > 0 整数，merge 仅做 project > user 选择。
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
  if (out.taskTimeoutMs === undefined) return undefined;
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

/** 逐层合并 llm：project 字段优先，未覆盖的 user 字段保留。 */
function mergeLlm(
  user: IknowSettingsLlm | undefined,
  project: IknowSettingsLlm | undefined
): IknowSettingsLlm | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsLlm = {};
  if (project?.maxTurns !== undefined) out.maxTurns = project.maxTurns;
  else if (user?.maxTurns !== undefined) out.maxTurns = user.maxTurns;
  // #358 T1: per-call LLM 调用竞速上限（per-field project > user）。
  if (project?.timeoutMs !== undefined) out.timeoutMs = project.timeoutMs;
  else if (user?.timeoutMs !== undefined) out.timeoutMs = user.timeoutMs;
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
    out.timeoutMs === undefined &&
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

/**
 * 校验单个 `secrets` 层：非法字段丢弃。
 * 非普通对象（数组 / 字符串 / 数字等）→ undefined（丢弃该层）。
 * enabled 非 boolean → 丢弃该字段；patterns 非非空串字符串数组 → 丢弃该字段；
 * 全部字段非法 → undefined（丢弃该层）。
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

/** 逐层合并 secrets：project 字段优先，未覆盖的 user 字段保留。 */
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

/** 先对每层做值校验，再合并；被丢弃的字段不参与覆盖。 */
function mergeSettings(
  userRaw: Record<string, unknown>,
  projectRaw: Record<string, unknown>
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
  // #358 T1: 子代理配置段（per-task wallclock），与 llm.timeoutMs（per-call）独立。
  const userSubagent = parseSubagent(userRaw.subagent);
  const projectSubagent = parseSubagent(projectRaw.subagent);
  const subagent = mergeSubagent(userSubagent, projectSubagent);
  const userLoop = parseLoop(userRaw.loop);
  const projectLoop = parseLoop(projectRaw.loop);
  const loop = mergeLoop(userLoop, projectLoop);
  const out: IknowSettings = {};
  if (llm) out.llm = llm;
  if (verify) out.verify = verify;
  if (secrets) out.secrets = secrets;
  if (subagent) out.subagent = subagent;
  if (loop) out.loop = loop;
  return out;
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
