/**
 * Load iknow runtime config from process.env + optional `.env` / `.env.local` (cwd)
 * + `.iknow/settings.json` (#353, loop 配置的单一事实源)。
 *
 * settings-model-extension (#164 第二阶段) — LLM 配置收敛到 settings.json 单承载:
 *   - `settings.llm.model` 是模型路由 ID 的**字面值**唯一来源（无占位符、无 env 回退）。
 *     缺失 → fail-fast 抛「no LLM model configured in settings.llm.model」（见
 *     `LLM_MODEL_MISSING_MESSAGE`）。
 *     `IKNOW_LLM_MODEL` env 支已退役（不再读取）。
 *   - `settings.llm.apiKey` 接受字面值或 `${VAR}` 占位符，经 `expandPlaceholders`
 *     从 `process.env[VAR]` 优先、`.env.local` / `.env` 兜底解析；解析不到 →
 *     undefined（消费点守卫抛「LLM mode needs API key.」）。
 *     `IKNOW_LLM_API_KEY_ENV` env 支已退役（不再读取），apiKey 不再依赖 env 变量名。
 *   - `settings.llm.fallback` / `maxTurns` / `compress` 保留（用户自配）。
 * 其它字段保持既有 `process.env > .env.local > .env > hardcoded defaults`。
 *
 * Never logs secret values.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadIknowSettings, type IknowSettings } from "./settings.js";
import { LLM_MODEL_MISSING_MESSAGE } from "./messages.js";
import { WORKSPACE_ROOT_ENV_KEY } from "./workspace-root.js";

export interface LlmEnv {
  baseUrl: string;
  /**
   * 模型路由 ID（settings.llm.model 字面值，trim 后必填）。
   * env loader fail-fast 保证有值（settings 唯一来源，无任何代码默认）。
   */
  model: string;
  /**
   * 模型 fallback 路由 ID 列表（来自 settings.llm.fallback，用户自配）。
   * 未配置 → []（无兜底；fallback 的消费方自行决定是否/如何使用）。
   */
  fallback: string[];
  /**
   * LLM API key（settings.llm.apiKey 经 `expandPlaceholders` 解析）。
   * 字面值或 `${VAR}` 占位符解析成功 → 真实密钥；解析失败 → undefined。
   * 消费点守卫：!env.llm.apiKey 时 build-engine / tui-deps / thinking-override
   * 抛「LLM mode needs API key.」（不允许硬编码兜底）。
   */
  apiKey: string | undefined;
  maxOutputTokens: number;
  temperature: number;
  /**
   * #151 T4 请求侧 thinking 控制臂:
   *   - "off"      → 不发送 thinking / output_config(默认)
   *   - "adaptive" → 发送 thinking:{type:'adaptive'};effort 非空时再追加 output_config:{effort:N}
   * 非法值 → 回退 "off"。
   */
  thinking: "off" | "adaptive";
  /**
   * #151 T4 effort 档位:空 → 不发送 output_config。
   * 非法值 → 视同空。
   */
  thinkingEffort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * #179 T6 (#147 D0) 流式臂开关:
   *   - "on"  → adapter 走 `client.messages.stream(...)`(默认)
   *   - "off" → 非流式回退臂(`messages.create`,017 A1 既有行为)
   * 非法值 → 回退 "on" 且不崩溃(对齐 thinking flag 的回退纪律,方向相反)。
   */
  stream: "on" | "off";
  /**
   * plan T5: 单次会话最大循环轮数上限(可选正整数)。
   * `undefined`(默认)= 无限(loop-engine 无轮数上限);
   * 显式配置时 loop-engine 达上限即停(超限 throw + reactive compact 分支归 loop-engine)。
   * 值域校验:非整数 / < 1 由 CLI `--max-turns` 解析层拒绝(parse-args.ts),
   * env 侧走 envOptionalInt(未设 / 空 / 非数字 → undefined,不抛错)。
   */
  maxTurns?: number;
  /**
   * #358 T1: 单次 LLM 调用竞速上限(per-call,毫秒)。
   * env 链:`envOptionalInt("IKNOW_LLM_TIMEOUT_MS") ?? mergedSettings.llm?.timeoutMs ?? 60_000`。
   * 第三层 60_000 默认保留(envInt 既有 fallback,延后到 envOptionalInt 之后作
   * 兜底,不破坏既有 env=任意值的行为,只增加 upstream settings 来源)。
   * 镜像 maxTurns 模式(env > settings),但 maxTurns 缺省 = 无限,本字段缺省 = 60s。
   */
  timeoutMs: number;
}

/**
 * #152 T5:thinking 可见面控制臂(env flag → env SSOT)。
 *
 * `IKNOW_CHAT_SHOW_THINKING` 值域 `"off" | "on"`(大小写不敏感)。
 * 非法值 → 回退 `false`。默认 off(thinking 不进答案正文)。
 */
export interface ChatEnv {
  /**
   * #152 T5:是否在回答中显示模型 thinking 文本。
   * `false`(默认)= 不显示,保持既有 chat 投影行为不变;
   * `true` = 在答案文本前以区隔样式显示 thinking。
   */
  showThinking: boolean;
}

/**
 * ACI Web 类工具的 env 配置臂（web_search 端点覆写 + 出站代理）。
 *
 * `IKNOW_WEB_SEARCH_URL`：可选 HTML 搜索端点覆写（私网后端 / 测试用）。
 * 空 → undefined（web_search 落默认 DuckDuckGo html 端点）。
 *
 * `IKNOW_WEB_PROXY`：可选出站 HTTP(S) 代理 URL（对齐 upstream
 * `OPENHARNESS_WEB_PROXY`，trust_env=False 语义 —— 显式配置才生效，
 * 不读系统 HTTP(S)_PROXY）。装配方在 network-guard 构造 ProxyAgent
 * dispatcher；非空时 web_fetch / web_search 出口走代理（远端解析 +
 * 出网，绕开本地 DNS 污染 / egress 阻断）。代理 URL 仍走与目标同套
 * 语法校验（协议 / host / 凭据）。
 *
 * 读取经本模块统一走 process.env > .env.local > .env 优先级（env.ts
 * SSOT，与 LLM key 同一加载链路）；工具自身不直读 process.env。
 */
export interface WebEnv {
  searchUrl: string | undefined;
  proxy: string | undefined;
}

/**
 * #119 T1: 自动压缩配置臂(env SSOT, 透传至 harness/compress/)。
 *
 * `IKNOW_MODEL_CONTEXT_WINDOW`:模型上下文窗口大小(整数)。默认 200000,
 * 非数字 → 回退 200000(对齐 envInt 既有纪律, 不抛错)。
 *
 * `IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS`:proactive auto-compact 阈值(可选整数)。
 * 未设 / 空串 / 非数字 → undefined(由 threshold.ts 在 derive 时缺省推导
 * `window - 33000`, 硬校验 `threshold < window`)。提前校验归 T4 不归 env loader。
 */
export interface IknowCompressEnv {
  // 字段访问形如 `env.compress.contextWindow` / `env.compress.thresholdTokens`。
  contextWindow: number;
  thresholdTokens: number | undefined;
}

/**
 * #378 根因 B: MCP 连接超时配置臂(env SSOT, 透传至 createMcpManager.timeoutMsOverride)。
 *
 * `IKNOW_MCP_CONNECT_TIMEOUT_MS`:MCP server 连接超时毫秒(正整数)。
 * 默认 60_000(根因 B: 30s 被 npx -y cold start 击穿, 提到 60s 缓解)。
 * 非法值(非数字 / 负数 / 0)→ 回退 60_000(统一双轨, 零/负超时无意义)。
 */
export interface McpEnv {
  connectTimeoutMs: number;
}

/**
 * #358 T1: 子代理配置臂(透传至 harness/subagent/manager.ts 的 SIGTERM 计时器消费点)。
 *
 * `taskTimeoutMs` = 子代理整任务寿命上限(per-task wallclock, 毫秒)。
 * 与 `LlmEnv.timeoutMs`(per-call LLM 调用竞速)语义、命名、消费点全程分离(C9)。
 *
 * env 链:`envOptionalInt("IKNOW_SUBAGENT_TASK_TIMEOUT_MS") ?? mergedSettings.subagent?.taskTimeoutMs`。
 * env 层无第三层默认值(7200s 常量由 T2 的 manager 消费点声明,
 * 避免缺省值在两处声明, settings 单一承载通过 mirror 校验)。
 */
export interface IknowSubagentEnv {
  /** 子代理整任务寿命上限(毫秒);env 不设 + settings 未配 → undefined。 */
  taskTimeoutMs: number | undefined;
}

export interface IknowEnv {
  llm: LlmEnv;
  /** #152 T5:thinking 可见面控制臂。 */
  chat: ChatEnv;
  /** ACI Web 类工具配置臂（web_search 端点覆写）。 */
  web: WebEnv;
  /** #119 T1: 自动压缩配置臂(透传至 harness/compress/)。 */
  compress: IknowCompressEnv;
  /** #378 根因 B: MCP 连接超时配置臂(透传至 createMcpManager.timeoutMsOverride)。 */
  mcp: McpEnv;
  /** #358 T1: 子代理配置臂(per-task wallclock; manager SIGTERM 计时器消费)。 */
  subagent: IknowSubagentEnv;
  /**
   * ADR-0019 (T1): workspace-root per-root state anchor, read from
   * `IKNOW_WORKSPACE_ROOT` via envOptional (canonical reader; empty/unset
   * → undefined). Consumers pass this into `resolveWorkspaceRoot({env})`
   * (priority chain `[explicit, env, cwd]`); the resolver validates the
   * path is absolute and exists, throwing a typed `WorkspaceRootError`
   * for relative / missing paths.
   */
  workspaceRoot: string | undefined;
}

/** Placeholder values treated as "no real secret set" (case-insensitive). */
const API_KEY_PLACEHOLDERS = new Set(["yes"]);

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (v.startsWith("<") && v.endsWith(">")) continue; // unfilled placeholder
    out[k] = v;
  }
  return out;
}

interface EnvGetOpts {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly fallback?: string;
}

function envGet(opts: EnvGetOpts): string {
  const { file, key } = opts;
  const fallback = opts.fallback ?? "";
  const fromProc = process.env[key];
  if (fromProc !== undefined && fromProc !== "") return fromProc;
  if (file[key] !== undefined && file[key] !== "") return file[key]!;
  return fallback;
}

/** Optional string env: 未设 / 空串 → undefined（区别于 envGet 的 "" 兜底）。 */
function envOptional(opts: EnvGetOpts): string | undefined {
  const raw = envGet({ file: opts.file, key: opts.key });
  return raw.length > 0 ? raw : undefined;
}

interface EnvIntOpts {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly fallback: number;
}

/** Integer env values (tokens, timeouts). Non-finite → fallback. */
function envInt(opts: EnvIntOpts): number {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return opts.fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : opts.fallback;
}

/**
 * #378 根因 B: 正整数 env values(MCP 连接超时等)。
 * envInt 只查 finite, 但 0 / 负超时无意义, 此处收紧为 > 0 才透传,
 * 否则回退 fallback(未设 / 非数字 / 负数 / 0 → fallback, 不抛错)。
 */
function envPositiveInt(opts: EnvIntOpts): number {
  const n = envInt(opts);
  return n > 0 ? n : opts.fallback;
}

interface EnvOptionalIntOpts {
  readonly file: Record<string, string>;
  readonly key: string;
}

/**
 * #119 T1: 可选整数 env values(如 auto-compact 阈值)。
 * 未设 / 空串 → undefined;否则 Number + isFinite + trunc 后返回,
 * 非数字 → undefined(回退纪律对齐 envInt, 不抛错)。
 */
function envOptionalInt(opts: EnvOptionalIntOpts): number | undefined {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

interface EnvNumberOpts {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly fallback: number;
}

/** Float env values (e.g. temperature 0.0–2.0). Non-finite → fallback. */
function envNumber(opts: EnvNumberOpts): number {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return opts.fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : opts.fallback;
}

interface EnvFileKeyOpts {
  readonly file: Record<string, string>;
  readonly key: string;
}

/**
 * #151 T4 / S4: 解析 IKNOW_LLM_THINKING 值域 "off" | "adaptive"(大小写不敏感)。
 * 未设 / 空串 / 非法值 → undefined(区别于 envThinkingMode 的"非法回退 off"):
 * S4 需要三态(off / adaptive / 未设),未设时才能回退 settings.llm.thinking。
 */
function envThinkingModeOptional(
  opts: EnvFileKeyOpts
): "off" | "adaptive" | undefined {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  if (raw === "off" || raw === "adaptive") return raw;
  return undefined;
}

/**
 * #151 T4 / S4: 解析 IKNOW_LLM_THINKING_EFFORT 值域 "low" | "medium" |
 * "high" | "xhigh" | "max"。未设 / 空串 / 非法值 → undefined
 * (区别于 envThinkingEffort 的"非法视同空"):S4 需要区分"未设"以回退 settings。
 */
function envThinkingEffortOptional(
  opts: EnvFileKeyOpts
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  switch (raw) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return raw;
    default:
      return undefined;
  }
}

/**
 * #152 T5: 解析 IKNOW_CHAT_SHOW_THINKING。合法值 "on" / "off"（大小写不敏感），
 * 非法值 → 回退 false（默认不显示 thinking）。
 */
function envShowThinking(opts: EnvFileKeyOpts): boolean {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  return raw === "on";
}

/**
 * #179 T6 (#147 D0): 解析 IKNOW_LLM_STREAM 值域 "on" | "off"(大小写不敏感)。
 * 默认 on(D0:流式为默认臂);非法值 → 回退 "on",不抛错。
 * 与 envThinkingMode 先例同构,仅回退方向相反(thinking 默认 off,stream 默认 on)。
 */
function envStreamMode(opts: EnvFileKeyOpts): "on" | "off" {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  if (raw === "off") return "off";
  return "on";
}

/**
 * 占位符形态：`${VAR}` 或 `$VAR`。`expandPlaceholders` 与 settings.ts
 * `isApiKeyOrPlaceholder` 共用同一 VAR 名字符集（`[A-Za-z_][A-Za-z0-9_]*`）。
 */
const PLACEHOLDER_PATTERN =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * 提取 value 中所有 `${VAR}` / `$VAR` 占位符的变量名（去重保序）。
 * 与 settings.ts `analyzePlaceholderSyntax` 共用同一正则源（防 drift）。
 * env-isolation 的 SC20 遮蔽名单也复用此函数（M1：多段 `${A}${B}` 与
 * 字面 + 占位符混合的合法形态都能提取出变量名）。
 */
export function extractPlaceholders(value: string): string[] {
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const names = new Set<string>();
  value.replace(
    PLACEHOLDER_PATTERN,
    (_match, braced: string | undefined, bare: string | undefined) => {
      names.add(braced ?? (bare as string));
      return "";
    }
  );
  PLACEHOLDER_PATTERN.lastIndex = 0;
  return [...names];
}

/**
 * M2（prototype 注入）守卫 — `isPrototypeOwnKey`：
 * Object.prototype 自有键（`constructor` / `__proto__` / `toString` /
 * `hasOwnProperty` / `valueOf` 等）不是合法 env var 名 —— `process.env[name]`
 * 与 `fileMap[name]` 都会命中 Object.prototype 返回函数 / 对象，
 * `raw.trim is not a function` TypeError。任何路径读到这些键 → 拒绝。
 */
function isPrototypeOwnKey(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(Object.prototype, name);
}

/**
 * M2（prototype 注入）守卫 — `isPlainEnvName`：
 *  - 合法标识符形态（`[A-Za-z_][A-Za-z0-9_]*`）；
 *  - 非 Object.prototype 自有键（防 prototype 注入）；
 *  - `Object.hasOwn(process.env, varName)`（process.env 是真值源才走）。
 */
function isPlainEnvName(varName: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) return false;
  if (isPrototypeOwnKey(varName)) return false;
  return Object.prototype.hasOwnProperty.call(process.env, varName);
}

/** 按优先级解析单个占位符变量：process.env[varName]（isPlainEnvName 守卫）→ fileMap[varName]。 */
function resolveValueFromFilename(
  varName: string,
  fileMap: Record<string, string>
): string | undefined {
  // M2 硬拒：任何 Object.prototype 自有键（包括 fileMap 显式同名 `constructor`）都不解析。
  if (isPrototypeOwnKey(varName)) return undefined;
  if (isPlainEnvName(varName)) {
    const fromProc = process.env[varName];
    if (fromProc !== undefined && fromProc !== "") return fromProc;
  }
  // fileMap 兜底：仅当 varName 是合法标识符、且 fileMap 自身拥有该键时读取
  // （防 fileMap 命中 Object.prototype；与 process.env 同款 hasOwn 守卫）。
  if (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(varName) &&
    Object.prototype.hasOwnProperty.call(fileMap, varName)
  ) {
    const fromFile = fileMap[varName];
    if (fromFile !== undefined && fromFile !== "") return fromFile;
  }
  return undefined;
}

/**
 * settings-model-extension：解析 settings.llm.apiKey 的字面值 / `${VAR}` 占位符。
 *
 *  - undefined → undefined（未配，消费点守卫抛「no API key configured」）；
 *  - 字面值（不含 `$VAR` / `${VAR}` 形态）→ 原样 trim 返回（设置文件里的字面
 *    密钥即真实密钥；含 `$IDENT` 形态被当作占位符解析，无 `$$` 转义）；
 *  - `${VAR}` / `$VAR` → 从 `process.env[VAR]` 优先、`fileMap[VAR]`（.env.local /
 *    .env 合并）兜底解析；任一变量解析不到（未设 / 空 / "yes" 占位符 /
 *    非普通环境名）→ 返 undefined（触发消费点守卫）；
 *  - `"yes"`（dotenv 风格占位符，大小写不敏感）→ 视同未设 → undefined。
 *
 * 多段占位符（如 `${A}${B}`）逐段解析后拼接；任一缺失整串返 undefined。
 * 非法占位符形态（如 `${}` / `${1VAR}` / `${VAR` 未闭合）→ undefined
 * （与 settings.ts `isApiKeyOrPlaceholder` 的丢弃语义对齐 —— 含 `${` 但不匹配
 * `${VAR}` 形态的串不是合法占位符也不是字面密钥）。
 * 本函数不打印 / 不落盘任何密钥值。
 */
export function expandPlaceholders(
  value: string | undefined,
  fileMap: Record<string, string>
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (API_KEY_PLACEHOLDERS.has(trimmed.toLowerCase())) return undefined;
  // 含 `${` 时先做 braced 残骸检测：所有 `${...}` 子串必须都是合法 `${VAR}`，
  // 残余 `${` 视为非法（`${}` / `${1VAR}` / `${VAR` 未闭合）→ undefined。
  // 必须在「字面短路」前判，否则 `${}` 等会被当作纯字面返回。
  if (trimmed.includes("${")) {
    const bracedOnly = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;
    const stripped = trimmed.replace(bracedOnly, "");
    if (stripped.includes("${")) return undefined;
  }
  const names = extractPlaceholders(trimmed);
  if (names.length === 0) return trimmed; // 字面密钥原样返回。
  let resolved = true;
  const out = trimmed.replace(
    PLACEHOLDER_PATTERN,
    (match: string, braced: string | undefined, bare: string | undefined) => {
      const varName = braced ?? (bare as string);
      const raw = resolveValueFromFilename(varName, fileMap);
      if (raw === undefined) {
        resolved = false;
        return match;
      }
      const val = raw.trim();
      if (!val || API_KEY_PLACEHOLDERS.has(val.toLowerCase())) {
        resolved = false;
        return match;
      }
      return val;
    }
  );
  return resolved ? out : undefined;
}

export function loadIknowEnv(
  cwd: string = process.cwd(),
  settings?: IknowSettings,
  home?: string
): IknowEnv {
  // process.env still wins via envGet; among files, .env.local overrides .env.
  // settings 参数是测试注入缝；不传时自动读取真实 settings 文件（project > user 合并）。
  // home 参数透传给 loadIknowSettings：测试隔离 user 级 settings 用（os.homedir()
  // 不响应运行时 process.env.HOME 修改，须显式注入）。
  const mergedSettings = settings ?? loadIknowSettings({ cwd, home });

  const file = {
    ...parseEnvFile(join(cwd, ".env")),
    ...parseEnvFile(join(cwd, ".env.local")),
  };

  // settings-model-extension：模型唯一来源 = settings.llm.model 字面值（无占位符、
  // 无 env 回退）。缺失 → fail-fast 抛错（不硬编码兜底）。IKNOW_LLM_MODEL 已退役。
  const modelRaw = mergedSettings.llm?.model?.trim();
  if (!modelRaw) {
    throw new Error(LLM_MODEL_MISSING_MESSAGE);
  }

  return {
    llm: {
      baseUrl: envGet({
        file,
        key: "IKNOW_LLM_BASE_URL",
        fallback: "http://localhost:20128/v1",
      }).replace(/\/$/, ""),
      model: modelRaw,
      fallback: mergedSettings.llm?.fallback ?? [],
      // settings-model-extension：apiKey 来源 = settings.llm.apiKey（字面或 ${VAR}
      // 占位符）经 expandPlaceholders 解析；未配 / 解析不到 → undefined（消费点守卫）。
      apiKey: expandPlaceholders(mergedSettings.llm?.apiKey, file),
      maxOutputTokens: envInt({
        file,
        key: "IKNOW_LLM_MAX_OUTPUT_TOKENS",
        // #578: 8192 仍装不下 thinking=adaptive + 奢侈品腕表自包含 HTML write_file
        // (~150-200 行)。先前 2048→8192 (#trace 8e05e04c) 只覆盖贪吃蛇 HTML；腕表页
        // 更大，撞 max_tokens → truncation → write_file 缺 content。16384 容纳
        // thinking budget + 完整 HTML JSON，不改 timeoutMs。
        fallback: 16384,
      }),
      // #358 T1: per-call LLM 调用竞速上限(env > settings > 60_000 fallback)。
      // 镜像 maxTurns 模式(envOptionalInt ?? settings),但保留第三层 60_000 默认
      // (envInt 既有 fallback),env 不设 + settings 未配 → 60_000。
      timeoutMs:
        envOptionalInt({
          file,
          key: "IKNOW_LLM_TIMEOUT_MS",
        }) ??
        mergedSettings.llm?.timeoutMs ??
        60_000,
      temperature: envNumber({
        file,
        key: "IKNOW_LLM_TEMPERATURE",
        fallback: 0,
      }),
      // S4: settings.llm.thinking / thinkingEffort 回退（env > settings > 默认）。
      // Optional 解析保证三态：env 显式 off/adaptive 或合法 effort 直接赢；
      // 未设 / 空 / 非法 → undefined → 落 settings；两者皆缺 → off / ""。
      thinking:
        envThinkingModeOptional({
          file,
          key: "IKNOW_LLM_THINKING",
        }) ??
        mergedSettings.llm?.thinking ??
        "off",
      thinkingEffort:
        envThinkingEffortOptional({
          file,
          key: "IKNOW_LLM_THINKING_EFFORT",
        }) ??
        mergedSettings.llm?.thinkingEffort ??
        "",
      // #179 T6 (D0):流式默认开;非法值回退 on。
      stream: envStreamMode({
        file,
        key: "IKNOW_LLM_STREAM",
      }),
      // plan T5: 可选正整数;未设 / 空 / 非数字 → undefined(= 无限)。
      // #353: settings.llm.maxTurns 回退（env > settings）。
      maxTurns:
        envOptionalInt({
          file,
          key: "IKNOW_LLM_MAX_TURNS",
        }) ?? mergedSettings.llm?.maxTurns,
    },
    chat: {
      // #152 T5:默认 off（不显示 thinking，保持现状）。
      showThinking: envShowThinking({
        file,
        key: "IKNOW_CHAT_SHOW_THINKING",
      }),
    },
    web: {
      // 可选端点覆写：空 → undefined（web_search 落默认 DuckDuckGo html 端点）。
      searchUrl: envOptional({ file, key: "IKNOW_WEB_SEARCH_URL" }),
      // 可选出站代理：空 → undefined（network-guard 直连）。显式配置才生效。
      proxy: envOptional({ file, key: "IKNOW_WEB_PROXY" }),
    },
    // #119 T1: 自动压缩配置臂(透传至 harness/compress/ via LoopEngineDeps.compress)。
    // thresholdTokens 阈值合理性校验(threshold >= window 拒绝)归 T4 threshold.ts,
    // 本 loader 仅承载 raw env 解析, 不抛错。
    compress: {
      // #353: settings.llm.compress.contextWindow 回退（env > settings > 200000 默认）。
      contextWindow: envInt({
        file,
        key: "IKNOW_MODEL_CONTEXT_WINDOW",
        fallback: mergedSettings.llm?.compress?.contextWindow ?? 200000,
      }),
      // #353: settings.llm.compress.thresholdTokens 回退（env > settings）。
      thresholdTokens:
        envOptionalInt({
          file,
          key: "IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS",
        }) ?? mergedSettings.llm?.compress?.thresholdTokens,
    },
    // #378 根因 B: MCP 连接超时(默认 60_000, 缓解 npx -y cold start 击穿 30s)。
    mcp: {
      connectTimeoutMs: envPositiveInt({
        file,
        key: "IKNOW_MCP_CONNECT_TIMEOUT_MS",
        fallback: 60_000,
      }),
    },
    // #358 T1: 子代理 per-task wallclock(env > settings,无第三层默认;7200s 常量归 T2 manager)。
    subagent: {
      taskTimeoutMs:
        envOptionalInt({
          file,
          key: "IKNOW_SUBAGENT_TASK_TIMEOUT_MS",
        }) ?? mergedSettings.subagent?.taskTimeoutMs,
    },
    // ADR-0019 (T1): workspace-root per-root state anchor (D1.5 register at
    // env SSOT; `envOptional` canonical reader — empty/unset → undefined,
    // 消费方 resolver 对相对路径 / 目录不存在做 typed 校验)。
    workspaceRoot: envOptional({
      file,
      key: WORKSPACE_ROOT_ENV_KEY,
    }),
  };
}
