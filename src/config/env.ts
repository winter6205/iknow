/**
 * Load iknow runtime config from process.env + optional `.env` / `.env.local` (cwd).
 * Precedence: process.env > `.env.local` > `.env`.
 * Never logs secret values.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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

export interface IknowEnv {
  llm: LlmEnv;
  /** #152 T5:thinking 可见面控制臂。 */
  chat: ChatEnv;
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

export function loadIknowEnv(cwd: string = process.cwd()): IknowEnv {
  // process.env still wins via envGet / getApiKey; among files, .env.local overrides .env
  const file = {
    ...parseEnvFile(join(cwd, ".env")),
    ...parseEnvFile(join(cwd, ".env.local")),
  };

  // SSOT: iknow 钉死 9router 栈 - key 变量名 NINE_ROUTER_KEY、主模型 m3-combo。
  // .env.local 只需持有密钥值本身，无需再设 IKNOW_LLM_API_KEY_ENV / IKNOW_LLM_MODEL。
  const llmKeyEnv = envGet({
    file,
    key: "IKNOW_LLM_API_KEY_ENV",
    fallback: "NINE_ROUTER_KEY",
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
    },
    chat: {
      // #152 T5:默认 off（不显示 thinking，保持现状）。
      showThinking: envShowThinking({
        file,
        key: "IKNOW_CHAT_SHOW_THINKING",
      }),
    },
  };
}
