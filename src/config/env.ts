/**
 * Load iknow runtime config from process.env + optional `.env` / `.env.local` (cwd)
 * + `.iknow/settings.json` (#353, loop 配置的单一事实源)。
 *
 * #353 loop-config 三个字段的 precedence:
 * `process.env > .env.local > .env > settings.json (project > user) > hardcoded defaults`
 * （其它字段保持既有 `process.env > .env.local > .env > hardcoded defaults`，不引入 settings 回退）。
 *
 * Never logs secret values.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadIknowSettings, type IknowSettings } from "./settings.js";

export interface LlmEnv {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  apiKey: string | undefined;
  maxOutputTokens: number;
  timeoutMs: number;
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

export interface IknowEnv {
  llm: LlmEnv;
  /** #152 T5:thinking 可见面控制臂。 */
  chat: ChatEnv;
  /** ACI Web 类工具配置臂（web_search 端点覆写）。 */
  web: WebEnv;
  /** #119 T1: 自动压缩配置臂(透传至 harness/compress/)。 */
  compress: IknowCompressEnv;
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
 * #151 T4: 解析 IKNOW_LLM_THINKING 值域 "off" | "adaptive"(大小写不敏感)。
 * 非法值 → 回退 "off",不抛错。
 */
function envThinkingMode(opts: EnvFileKeyOpts): "off" | "adaptive" {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  if (raw === "off" || raw === "adaptive") return raw;
  return "off";
}

/**
 * #151 T4: 解析 IKNOW_LLM_THINKING_EFFORT 值域 "" | "low" | "medium" |
 * "high" | "xhigh" | "max"。非法值 → 视同空(不发送 output_config)。
 */
function envThinkingEffort(
  opts: EnvFileKeyOpts
): "" | "low" | "medium" | "high" | "xhigh" | "max" {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  switch (raw) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return raw;
    default:
      return "";
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
 * Resolve an API key by name.
 * Precedence: `process.env[envVarName]` then optional `fileMap` (from dotenv merge).
 *
 * Values that are empty/whitespace, or the placeholder `"yes"` (case-insensitive),
 * are treated as unset so template/docs defaults like `API_KEY=yes` do not become
 * live credentials.
 */
export interface GetApiKeyOpts {
  readonly envVarName: string;
  readonly fileMap?: Record<string, string>;
}

export function getApiKey(opts: GetApiKeyOpts): string | undefined {
  const { envVarName, fileMap } = opts;
  if (!envVarName) return undefined;
  const fromProc = process.env[envVarName];
  const raw =
    fromProc !== undefined && fromProc !== ""
      ? fromProc
      : fileMap?.[envVarName];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (API_KEY_PLACEHOLDERS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

export function loadIknowEnv(
  cwd: string = process.cwd(),
  settings?: IknowSettings
): IknowEnv {
  // process.env still wins via envGet / getApiKey; among files, .env.local overrides .env.
  // settings 参数是测试注入缝；不传时自动读取真实 settings 文件（project > user 合并）。
  const mergedSettings = settings ?? loadIknowSettings({ cwd });

  const file = {
    ...parseEnvFile(join(cwd, ".env")),
    ...parseEnvFile(join(cwd, ".env.local")),
  };

  // SSOT: key 变量名默认 = ANTHROPIC_AUTH_TOKEN（对齐实际部署 + 通用生态命名）。
  // .env.local 只需持有密钥值本身；如需指向别的变量名，仍可设 IKNOW_LLM_API_KEY_ENV 覆盖。
  const llmKeyEnv = envGet({
    file,
    key: "IKNOW_LLM_API_KEY_ENV",
    fallback: "ANTHROPIC_AUTH_TOKEN",
  });

  return {
    llm: {
      baseUrl: envGet({
        file,
        key: "IKNOW_LLM_BASE_URL",
        fallback: "http://localhost:20128/v1",
      }).replace(/\/$/, ""),
      // SSOT: 项目主模型 = m3-combo (9router 路由 ID)
      model: envGet({ file, key: "IKNOW_LLM_MODEL", fallback: "m3-combo" }),
      apiKeyEnv: llmKeyEnv,
      apiKey: getApiKey({ envVarName: llmKeyEnv, fileMap: file }),
      maxOutputTokens: envInt({
        file,
        key: "IKNOW_LLM_MAX_OUTPUT_TOKENS",
        fallback: 2048,
      }),
      timeoutMs: envInt({
        file,
        key: "IKNOW_LLM_TIMEOUT_MS",
        fallback: 60_000,
      }),
      temperature: envNumber({
        file,
        key: "IKNOW_LLM_TEMPERATURE",
        fallback: 0,
      }),
      thinking: envThinkingMode({
        file,
        key: "IKNOW_LLM_THINKING",
      }),
      thinkingEffort: envThinkingEffort({
        file,
        key: "IKNOW_LLM_THINKING_EFFORT",
      }),
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
  };
}
