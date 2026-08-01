/**
 * Load iknow runtime config from process.env + optional `.env` / `.env.local` (cwd).
 * Precedence: process.env > `.env.local` > `.env`.
 * Never logs secret values.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "../shared/errors.js";

export type AgentMode = "deterministic" | "llm";
export type EmbeddingMode = "off" | "api";

export interface LlmEnv {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  apiKey: string | undefined;
  maxOutputTokens: number;
  contextWindowTokens: number;
  timeoutMs: number;
  temperature: number;
  toolProtocol: "openai_tools" | "anthropic_tools";
}

export interface EmbeddingEnv {
  mode: EmbeddingMode;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  apiKey: string | undefined;
  /**
   * Local expected vector size (`IKNOW_EMBEDDING_DIMS`).
   * Used to size the in-process index and as `dimsHint` on the embedding client.
   */
  dims: number;
  /**
   * Optional request-body truncation (`IKNOW_EMBEDDING_DIMENSIONS`).
   * Sent as `dimensions` when the provider supports reducing output size;
   * defaults to the same value as `dims` when unset.
   */
  dimensions: number;
  timeoutMs: number;
  cachePath: string;
}

export interface IknowEnv {
  agentMode: AgentMode;
  llm: LlmEnv;
  embedding: EmbeddingEnv;
  requireOffline: boolean;
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

/** Integer env values (tokens, timeouts, dims). Non-finite → fallback. */
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

/**
 * Fail closed when offline mode forbids network LLM / API embeddings.
 * Call sites: create-runtime, cli (not loadIknowEnv — avoids double validation).
 */
export interface AssertOfflineCompatibleOpts {
  readonly env: IknowEnv;
  readonly agentMode?: AgentMode;
}

export function assertOfflineCompatible(
  opts: AssertOfflineCompatibleOpts
): void {
  const { env, agentMode } = opts;
  if (!env.requireOffline) return;
  const mode = agentMode ?? env.agentMode;
  if (mode === "llm") {
    throw new ValidationError(
      "IKNOW_REQUIRE_OFFLINE=true forbids agentMode=llm (requires network LLM)",
      { agentMode: mode, requireOffline: true }
    );
  }
  if (env.embedding.mode === "api") {
    throw new ValidationError(
      "IKNOW_REQUIRE_OFFLINE=true forbids embedding mode=api (requires network embeddings)",
      { embeddingMode: env.embedding.mode, requireOffline: true }
    );
  }
}

/**
 * Fail closed: only openai_tools is implemented.
 * Call sites: cli LLM branch, LlmIknowAgent ctor (not loadIknowEnv).
 */
export function assertToolProtocolSupported(
  protocol: LlmEnv["toolProtocol"]
): void {
  if (protocol === "anthropic_tools") {
    throw new ValidationError(
      "anthropic_tools not implemented; use openai_tools",
      { toolProtocol: protocol }
    );
  }
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
  const embKeyEnv = envGet({
    file,
    key: "IKNOW_EMBEDDING_API_KEY_ENV",
    fallback: "NINE_ROUTER_KEY",
  });

  const embModeRaw = envGet({
    file,
    key: "IKNOW_EMBEDDING_MODE",
    fallback: "off",
  }).toLowerCase();
  const embApiKey = getApiKey({ envVarName: embKeyEnv, fileMap: file });
  // local treated as api HTTP for this project (network API profile)
  let embMode: EmbeddingMode =
    embModeRaw === "api" || embModeRaw === "local" ? "api" : "off";
  // No key → off (deterministic keyword baseline stays default)
  if (embMode === "api" && !embApiKey) {
    embMode = "off";
  }

  const agentRaw = envGet({
    file,
    key: "IKNOW_AGENT_MODE",
    fallback: "deterministic",
  }).toLowerCase();
  const agentMode: AgentMode = agentRaw === "llm" ? "llm" : "deterministic";

  const toolProto = envGet({
    file,
    key: "IKNOW_LLM_TOOL_PROTOCOL",
    fallback: "openai_tools",
  }).toLowerCase();

  const dims = envInt({ file, key: "IKNOW_EMBEDDING_DIMS", fallback: 2048 });

  return {
    agentMode,
    requireOffline:
      envGet({
        file,
        key: "IKNOW_REQUIRE_OFFLINE",
        fallback: "false",
      }).toLowerCase() === "true",
    llm: {
      provider: envGet({
        file,
        key: "IKNOW_LLM_PROVIDER",
        fallback: "9router",
      }),
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
      contextWindowTokens: envInt({
        file,
        key: "IKNOW_LLM_CONTEXT_WINDOW_TOKENS",
        fallback: 1_000_000,
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
      toolProtocol:
        toolProto === "anthropic_tools" ? "anthropic_tools" : "openai_tools",
    },
    embedding: {
      mode: embMode,
      provider: envGet({
        file,
        key: "IKNOW_EMBEDDING_PROVIDER",
        fallback: "9router",
      }),
      baseUrl: envGet({
        file,
        key: "IKNOW_EMBEDDING_BASE_URL",
        fallback: "http://localhost:20128/v1",
      }).replace(/\/$/, ""),
      // Intentional 9router route id (not a typo of "zhipu"/"zhipuai")
      model: envGet({
        file,
        key: "IKNOW_EMBEDDING_MODEL",
        fallback: "zhipueb/embedding-3",
      }),
      apiKeyEnv: embKeyEnv,
      apiKey: embApiKey,
      dims,
      dimensions: envInt({
        file,
        key: "IKNOW_EMBEDDING_DIMENSIONS",
        fallback: dims,
      }),
      timeoutMs: envInt({
        file,
        key: "IKNOW_EMBEDDING_TIMEOUT_MS",
        fallback: 30_000,
      }),
      cachePath: envGet({
        file,
        key: "IKNOW_EMBEDDING_CACHE_PATH",
        fallback: ".cache/iknow-embeddings",
      }),
    },
  };
}
