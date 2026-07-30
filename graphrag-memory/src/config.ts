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
 * Embedding API key resolution — host-agnostic, no provider knowledge.
 *
 * config.ts is a pure consumer: it decides NOTHING about which key to use.
 * The choice is declared entirely in the MCP registration layer (the
 * `.mcp.json` / `~/.claude.json` env block), via two knobs, resolved in
 * order (first non-blank wins):
 *   1. GRAPHRAG_MEMORY_EMBED_API_KEY     — the secret VALUE itself. Only
 *      ever set in a host-local, untracked registration (e.g. Claude Code's
 *      `~/.claude.json` local scope). NEVER in a git-tracked `.mcp.json`.
 *   2. GRAPHRAG_MEMORY_EMBED_API_KEY_ENV — the NAME of an env var holding
 *      the secret (e.g. "NINE_ROUTER_KEY" for the iknow 9router convention,
 *      or any other var a generic host uses). config.ts just reads whatever
 *      name it is handed.
 *
 * Neither set → undefined → FakeEmbedder path. There is deliberately NO
 * default var name here — a default would re-hardcode a provider choice
 * into config, which is exactly what this indirection removes. The secret
 * VALUE never lives in source; the var NAME is supplied by the operator.
 */
const EMBED_API_KEY_VALUE_VAR = "GRAPHRAG_MEMORY_EMBED_API_KEY";
const EMBED_API_KEY_NAME_VAR = "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV";

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
  /**
   * Resolved embedding API key value; undefined means "fall back to
   * FakeEmbedder". See the EMBED_API_KEY_* constants for resolution order.
   */
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
 * treat a blank key as "no key" (FakeEmbedder path) without relying on JS
 * truthiness semantics at the consumption site.
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
  // baseUrl and model are only required when a key resolves, because the
  // FakeEmbedder path takes the operator offline without one. All string
  // fields are normalized through readTrimmed so empty / whitespace-only
  // values collapse to undefined — a blank key does not silently drag an
  // operator into the real-embedder path.
  const embedDimensions = parseEmbedDimensions(readEnv(EMBED_DIMENSIONS_VAR));
  const embedApiKey = resolveEmbedApiKey();

  const embedBaseUrl = readTrimmed("GRAPHRAG_MEMORY_EMBED_BASE_URL");
  if (embedApiKey !== undefined && embedBaseUrl === undefined) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_EMBED_BASE_URL is required when an embedding API key is configured (GRAPHRAG_MEMORY_EMBED_API_KEY or the var named by GRAPHRAG_MEMORY_EMBED_API_KEY_ENV)"
    );
  }
  const embedModel = readTrimmed("GRAPHRAG_MEMORY_EMBED_MODEL");
  if (embedApiKey !== undefined && embedModel === undefined) {
    throw new ConfigError(
      "GRAPHRAG_MEMORY_EMBED_MODEL is required when an embedding API key is configured (GRAPHRAG_MEMORY_EMBED_API_KEY or the var named by GRAPHRAG_MEMORY_EMBED_API_KEY_ENV)"
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

/**
 * Resolve the embedding API key value.
 *
 * Order (first non-blank wins):
 *   1. GRAPHRAG_MEMORY_EMBED_API_KEY      — direct secret value
 *   2. process.env[GRAPHRAG_MEMORY_EMBED_API_KEY_ENV] — indirect by the
 *      var NAME the operator supplied (no default — see the constant block)
 *   3. undefined → FakeEmbedder path
 *
 * Both sources go through readTrimmed, so a blank value or blank var-name
 * collapses to undefined rather than selecting an empty-string key.
 */
function resolveEmbedApiKey(): string | undefined {
  const direct = readTrimmed(EMBED_API_KEY_VALUE_VAR);
  if (direct !== undefined) return direct;
  const keyEnvName = readTrimmed(EMBED_API_KEY_NAME_VAR);
  if (keyEnvName === undefined) return undefined;
  return readTrimmed(keyEnvName);
}
