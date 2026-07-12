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

function envGet(
  file: Record<string, string>,
  key: string,
  fallback = "",
): string {
  const fromProc = process.env[key];
  if (fromProc !== undefined && fromProc !== "") return fromProc;
  if (file[key] !== undefined && file[key] !== "") return file[key]!;
  return fallback;
}

/** Integer env values (tokens, timeouts, dims). Non-finite → fallback. */
function envInt(
  file: Record<string, string>,
  key: string,
  fallback: number,
): number {
  const raw = envGet(file, key, "");
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Float env values (e.g. temperature 0.0–2.0). Non-finite → fallback. */
function envNumber(
  file: Record<string, string>,
  key: string,
  fallback: number,
): number {
  const raw = envGet(file, key, "");
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve an API key by name.
 * Precedence: `process.env[envVarName]` then optional `fileMap` (from dotenv merge).
 *
 * Values that are empty/whitespace, or the placeholder `"yes"` (case-insensitive),
 * are treated as unset so template/docs defaults like `API_KEY=yes` do not become
 * live credentials.
 */
export function getApiKey(
  envVarName: string,
  fileMap?: Record<string, string>,
): string | undefined {
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
 * @param agentMode effective mode (CLI may override env.agentMode)
 * Call sites: create-runtime, cli (not loadIknowEnv — avoids double validation).
 */
export function assertOfflineCompatible(
  env: IknowEnv,
  agentMode?: AgentMode,
): void {
  if (!env.requireOffline) return;
  const mode = agentMode ?? env.agentMode;
  if (mode === "llm") {
    throw new ValidationError(
      "IKNOW_REQUIRE_OFFLINE=true forbids agentMode=llm (requires network LLM)",
      { agentMode: mode, requireOffline: true },
    );
  }
  if (env.embedding.mode === "api") {
    throw new ValidationError(
      "IKNOW_REQUIRE_OFFLINE=true forbids embedding mode=api (requires network embeddings)",
      { embeddingMode: env.embedding.mode, requireOffline: true },
    );
  }
}

/**
 * Fail closed: only openai_tools is implemented.
 * Call sites: cli LLM branch, LlmIknowAgent ctor (not loadIknowEnv).
 */
export function assertToolProtocolSupported(
  protocol: LlmEnv["toolProtocol"],
): void {
  if (protocol === "anthropic_tools") {
    throw new ValidationError(
      "anthropic_tools not implemented; use openai_tools",
      { toolProtocol: protocol },
    );
  }
}

export function loadIknowEnv(cwd: string = process.cwd()): IknowEnv {
  // process.env still wins via envGet / getApiKey; among files, .env.local overrides .env
  const file = {
    ...parseEnvFile(join(cwd, ".env")),
    ...parseEnvFile(join(cwd, ".env.local")),
  };

  const llmKeyEnv = envGet(file, "IKNOW_LLM_API_KEY_ENV", "NINE_ROUTER_API_KEY");
  const embKeyEnv = envGet(
    file,
    "IKNOW_EMBEDDING_API_KEY_ENV",
    "NINE_ROUTER_API_KEY",
  );

  const embModeRaw = envGet(file, "IKNOW_EMBEDDING_MODE", "off").toLowerCase();
  const embApiKey = getApiKey(embKeyEnv, file);
  // local treated as api HTTP for this project (network API profile)
  let embMode: EmbeddingMode =
    embModeRaw === "api" || embModeRaw === "local" ? "api" : "off";
  // No key → off (deterministic keyword baseline stays default)
  if (embMode === "api" && !embApiKey) {
    embMode = "off";
  }

  const agentRaw = envGet(file, "IKNOW_AGENT_MODE", "deterministic").toLowerCase();
  const agentMode: AgentMode = agentRaw === "llm" ? "llm" : "deterministic";

  const toolProto = envGet(
    file,
    "IKNOW_LLM_TOOL_PROTOCOL",
    "openai_tools",
  ).toLowerCase();

  const dims = envInt(file, "IKNOW_EMBEDDING_DIMS", 2048);

  return {
    agentMode,
    requireOffline:
      envGet(file, "IKNOW_REQUIRE_OFFLINE", "false").toLowerCase() === "true",
    llm: {
      provider: envGet(file, "IKNOW_LLM_PROVIDER", "9router"),
      baseUrl: envGet(
        file,
        "IKNOW_LLM_BASE_URL",
        "http://localhost:20128/v1",
      ).replace(/\/$/, ""),
      model: envGet(file, "IKNOW_LLM_MODEL", "deepseek-flash-combo"),
      apiKeyEnv: llmKeyEnv,
      apiKey: getApiKey(llmKeyEnv, file),
      maxOutputTokens: envInt(file, "IKNOW_LLM_MAX_OUTPUT_TOKENS", 2048),
      contextWindowTokens: envInt(
        file,
        "IKNOW_LLM_CONTEXT_WINDOW_TOKENS",
        1_000_000,
      ),
      timeoutMs: envInt(file, "IKNOW_LLM_TIMEOUT_MS", 60_000),
      temperature: envNumber(file, "IKNOW_LLM_TEMPERATURE", 0),
      toolProtocol:
        toolProto === "anthropic_tools" ? "anthropic_tools" : "openai_tools",
    },
    embedding: {
      mode: embMode,
      provider: envGet(file, "IKNOW_EMBEDDING_PROVIDER", "9router"),
      baseUrl: envGet(
        file,
        "IKNOW_EMBEDDING_BASE_URL",
        "http://localhost:20128/v1",
      ).replace(/\/$/, ""),
      // Intentional 9router route id (not a typo of "zhipu"/"zhipuai")
      model: envGet(file, "IKNOW_EMBEDDING_MODEL", "zhipueb/embedding-3"),
      apiKeyEnv: embKeyEnv,
      apiKey: embApiKey,
      dims,
      dimensions: envInt(file, "IKNOW_EMBEDDING_DIMENSIONS", dims),
      timeoutMs: envInt(file, "IKNOW_EMBEDDING_TIMEOUT_MS", 30_000),
      cachePath: envGet(
        file,
        "IKNOW_EMBEDDING_CACHE_PATH",
        ".cache/iknow-embeddings",
      ),
    },
  };
}
