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

/**
 * Env-var NAME for the embedding provider key. The name lives in source;
 * the value never does. Shared with the root iknow project's convention so
 * an operator sets one key for both (see iknow CLAUDE.md "9router key").
 */
const EMBED_API_KEY_VAR = "NINE_ROUTER_KEY";

/** Env-var name for the required embedding dimension integer. */
const EMBED_DIMENSIONS_VAR = "GRAPHRAG_MEMORY_EMBED_DIMENSIONS";

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
  /**
   * Embedding endpoint base URL (trailing slash stripped). Convention
   * includes /v1 — only /embeddings is appended at call time. Undefined
   * when no embedding API key is configured (FakeEmbedder path).
   */
  embedBaseUrl: string | undefined;
  /**
   * Embedding model id (provider-specific, e.g. "zhipueb/embedding-3").
   * Undefined when no embedding API key is configured.
   */
  embedModel: string | undefined;
  /** Vector dimension. Always set — every code path (real + fake) needs it. */
  embedDimensions: number;
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
 * Read an env var and normalize: trim whitespace, treat empty/whitespace-only
 * as absent (undefined). Keeps config.ts and index.ts in agreement — both
 * treat a blank NINE_ROUTER_KEY as "no key" (FakeEmbedder path) without
 * relying on JS truthiness semantics at the consumption site.
 */
function readTrimmed(key: string): string | undefined {
  const raw = readEnv(key);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse and validate GRAPHRAG_MEMORY_EMBED_DIMENSIONS.
 *
 * Always required — every code path (real + FakeEmbedder, MemoryBackend,
 * PgvectorBackend DDL) needs the dimension as a positive integer. We
 * reject empty strings, 0, negatives, non-integers, and decimal values
 * at startup rather than letting a surprising 0-length vector hit the
 * DDL or the embedding provider downstream.
 */
function parseEmbedDimensions(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigError(
      `${EMBED_DIMENSIONS_VAR} is required (positive integer)`
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(
      `${EMBED_DIMENSIONS_VAR} must be a positive integer, got "${raw}"`
    );
  }
  return n;
}

/**
 * Read + validate the runtime environment.
 *
 * Throws ConfigError on any unusable combination. Failing loudly at startup
 * is deliberate: silently coercing an unknown storage mode to "memory" would
 * hand an operator a server that answers queries from an empty in-process
 * store while they believe it is talking to Postgres. Same logic applies to
 * missing embedding config: the operator's mental model and the running
 * server must agree or the server must refuse to start.
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

  // Embedding config: dimensions is ALWAYS required (every backend needs it);
  // baseUrl and model are only required when NINE_ROUTER_KEY is set, because
  // the FakeEmbedder path takes the operator offline without one. All three
  // string fields are normalized through readTrimmed so empty / whitespace-
  // only values collapse to undefined — a blank key does not silently drag
  // an operator into the real-embedder path.
  const embedDimensions = parseEmbedDimensions(readEnv(EMBED_DIMENSIONS_VAR));
  const embedApiKey = readTrimmed(EMBED_API_KEY_VAR);

  const embedBaseUrl = readTrimmed("GRAPHRAG_MEMORY_EMBED_BASE_URL");
  if (embedApiKey !== undefined && embedBaseUrl === undefined) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_EMBED_BASE_URL is required when NINE_ROUTER_KEY is set"
    );
  }
  const embedModel = readTrimmed("GRAPHRAG_MEMORY_EMBED_MODEL");
  if (embedApiKey !== undefined && embedModel === undefined) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_EMBED_MODEL is required when NINE_ROUTER_KEY is set"
    );
  }

  return {
    logLevel,
    storage: rawStorage,
    dbUrl,
    embedDimensions,
    embedBaseUrl: embedBaseUrl?.replace(/\/$/, ""),
    embedModel,
    // Looked up by NAME — the secret value only ever exists in the process
    // environment, never in this file or in any log line.
    embedApiKey,
  };
}
