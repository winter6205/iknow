/**
 * Runtime config for graphrag-memory MCP server.
 *
 * Loads from process.env + optional `.env` / `.env.local` (cwd).
 * Precedence: process.env > `.env.local` > `.env` (matching the root iknow
 * config convention at src/config/env.ts, but with a graphrag-namespaced
 * prefix to keep this package decoupled from iknow's env).
 *
 * Never logs secret values.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Storage backend selector.
 *
 * "memory"   — in-process MemoryBackend (dev/test; no persistence).
 * "pgvector" — Postgres + pgvector (T8); requires GRAPHRAG_MEMORY_DB_URL.
 */
export type StorageMode = "memory" | "pgvector";

const STORAGE_MODES: readonly StorageMode[] = ["memory", "pgvector"];

function isStorageMode(value: string): value is StorageMode {
  return (STORAGE_MODES as readonly string[]).includes(value);
}

/** Default embedding endpoint. Overridable for self-hosted / proxy setups. */
const DEFAULT_EMBED_BASE_URL = "https://api.9router.ai";

/** Default embedding model. Its output dim must match core/errors.ts EMBEDDING_DIM. */
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

/**
 * Env-var NAME for the embedding provider key. The name lives in source;
 * the value never does. Shared with the root iknow project's convention so
 * an operator sets one key for both (see iknow CLAUDE.md "9router key").
 */
const EMBED_API_KEY_VAR = "NINE_ROUTER_KEY";

/**
 * Startup configuration failure. Distinct from GraphragError (core/errors.ts),
 * which covers per-request tool failures: a ConfigError is unrecoverable and
 * aborts the process with EXIT_CODES.BAD_CONFIG before any transport opens.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface GraphragEnv {
  logLevel: LogLevel;
  /** Which StorageBackend to construct. */
  storage: StorageMode;
  /** Postgres connection string; required iff storage === "pgvector". */
  dbUrl: string | undefined;
  embedBaseUrl: string;
  embedModel: string;
  /** Value of NINE_ROUTER_KEY; undefined means "fall back to FakeEmbedder". */
  embedApiKey: string | undefined;
}

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

function readEnv(key: string): string | undefined {
  const file =
    process.env["GRAPHRAG_MEMORY_FROM_FILE"] === "1"
      ? parseEnvFile(join(process.cwd(), ".env.local"))
      : undefined;
  if (file && key in file) return file[key];
  return process.env[key];
}

/**
 * Read + validate the runtime environment.
 *
 * Throws ConfigError on any unusable combination. Failing loudly at startup
 * is deliberate: silently coercing an unknown storage mode to "memory" would
 * hand an operator a server that answers queries from an empty in-process
 * store while they believe it is talking to Postgres.
 */
export function loadEnv(): GraphragEnv {
  // Stage 0 is stdio-only (map #33 defers HTTP to T-005/#36). Transport is
  // hard-coded to stdio at the call site in src/index.ts; it is NOT a config
  // knob here. The previous `transport` field + no-op ternary was dead code
  // that silently coerced every value to "stdio" while pretending otherwise.
  const rawLog = readEnv("GRAPHRAG_MEMORY_LOG_LEVEL") ?? "info";
  const logLevel: LogLevel = isLogLevel(rawLog) ? rawLog : "info";

  const rawStorage = readEnv("GRAPHRAG_MEMORY_STORAGE") ?? "memory";
  if (!isStorageMode(rawStorage)) {
    throw new ConfigError(
      `GRAPHRAG_MEMORY_STORAGE must be one of ${STORAGE_MODES.join(" | ")}, got "${rawStorage}"`
    );
  }

  const dbUrl = readEnv("GRAPHRAG_MEMORY_DB_URL");
  if (rawStorage === "pgvector" && dbUrl === undefined) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_DB_URL is required when GRAPHRAG_MEMORY_STORAGE=pgvector"
    );
  }

  return {
    logLevel,
    storage: rawStorage,
    dbUrl,
    embedBaseUrl:
      readEnv("GRAPHRAG_MEMORY_EMBED_BASE_URL") ?? DEFAULT_EMBED_BASE_URL,
    embedModel: readEnv("GRAPHRAG_MEMORY_EMBED_MODEL") ?? DEFAULT_EMBED_MODEL,
    // Looked up by NAME — the secret value only ever exists in the process
    // environment, never in this file or in any log line.
    embedApiKey: readEnv(EMBED_API_KEY_VAR),
  };
}
