/**
 * graphrag-memory MCP server entry.
 *
 * Stage 0 scaffold: wires the tool registry into a stdio MCP server with
 * one placeholder tool (`echo`). Stage 1 (ticket #36) replaces the
 * registry with real GraphRAG memory tools.
 *
 * Decoupling contract (per map #33 / ticket #35):
 *   - No import from iknow (`src/shared/schema.ts`, `src/config/`, etc.).
 *   - Provider key env-var names are looked up by NAME, never stored
 *     in code (this scaffold doesn't yet need any keys, but the pattern
 *     is established).
 *   - All logging goes to stderr; stdout is reserved for the MCP
 *     stdio JSON-RPC transport.
 *
 * SDK: `@modelcontextprotocol/server@^2.0.0` (v2 split-package line) +
 * `@modelcontextprotocol/client@^2.0.0` (for the host-smoke test harness).
 * Uses the high-level `McpServer.registerTool` API. The low-level `Server`
 * + `setRequestHandler` and the deprecated `tool(...)` method are
 * deliberately avoided.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { ConfigError, loadEnv, type GraphragEnv } from "./config.js";
import { createLogger } from "./logging.js";
import {
  buildRegistry,
  textResult,
  type ToolRegistration,
} from "./tools/registry.js";
import { echoTool } from "./tools/echo.js";
import { ingestTool } from "./tools/ingest.js";
import { retrieveTool } from "./tools/retrieve.js";
import {
  FakeEmbedder,
  NineRouterEmbedder,
  type EmbeddingClient,
} from "./core/embedder.js";
import { MemoryBackend } from "./core/storage/memory-backend.js";
import type { StorageBackend } from "./core/types.js";

const SERVER_NAME = "graphrag-memory";
const SERVER_VERSION = "0.0.0";

/**
 * Process exit codes (single source of truth — referenced by the fatal-error
 * catch in the isMain block). Anything outside this table is a bug;
 * documenting it here makes host-side scripts (Claude Code, systemd, k8s)
 * able to reason about what kind of failure happened without parsing stderr.
 *
 *   FATAL_RUNTIME    1   uncaught exception in main() — see stderr stack
 *   BAD_CONFIG       2   loadEnv() rejected the environment (ConfigError)
 *
 * BAD_CONFIG returned in T7 alongside the first real config-rejection
 * surface (unknown storage mode / pgvector without a DB URL). It had been
 * removed in stage 0 when the transport knob went away — see
 * `tests/config.test.ts` and
 * `docs/handoff/2026-07-29-graphrag-mcp-host-acceptance.md`.
 */
const EXIT_CODES = {
  FATAL_RUNTIME: 1,
  BAD_CONFIG: 2,
} as const;

/** Everything the ingest/retrieve handlers need, built once per server. */
interface ServerDeps {
  embedder: EmbeddingClient;
  storage: StorageBackend;
}

/**
 * Build the storage + embedding dependencies for one server instance.
 *
 * Embedder selection is key-presence-driven rather than an explicit mode
 * knob: an operator who supplies NINE_ROUTER_KEY wants real embeddings, and
 * one who does not cannot get them anyway. FakeEmbedder is deterministic and
 * offline, which is what dev/test/CI need — but its vectors are meaningless
 * for cross-text semantics, so the choice is logged at construction.
 *
 * Storage selection: pgvector (T8) is dynamically imported so a memory-mode
 * user never pays for the `pg` dependency. The dynamic import is wrapped in
 * a try so a missing optional dependency surfaces as ConfigError with a
 * clear "install pg" hint instead of an opaque module-not-found at startup.
 */
async function buildDeps(env: GraphragEnv): Promise<ServerDeps> {
  let storage: StorageBackend;
  if (env.storage === "pgvector") {
    if (env.dbUrl === undefined) {
      // config.loadEnv already enforces this, but defense-in-depth:
      // buildDeps is also exported-style callable for tests.
      throw new ConfigError(
        "GRAPHRAG_MEMORY_DB_URL is required when GRAPHRAG_MEMORY_STORAGE=pgvector"
      );
    }
    let mod: typeof import("./core/storage/pgvector-backend.js");
    try {
      mod = await import("./core/storage/pgvector-backend.js");
    } catch (err) {
      throw new ConfigError(
        `GRAPHRAG_MEMORY_STORAGE=pgvector requires the optional "pg" dependency — \`npm install pg\` (${(err as Error).message})`
      );
    }
    storage = new mod.PgvectorBackend(env.dbUrl);
  } else {
    storage = new MemoryBackend();
  }

  const embedder: EmbeddingClient = env.embedApiKey
    ? new NineRouterEmbedder(env.embedBaseUrl, env.embedModel, env.embedApiKey)
    : new FakeEmbedder();

  return { embedder, storage };
}

export async function createServer(): Promise<McpServer> {
  const env = loadEnv();
  const logger = createLogger(env.logLevel);
  const deps = await buildDeps(env);
  const registry = buildRegistry([
    echoTool,
    ingestTool(deps),
    retrieveTool(deps),
  ]);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  for (const tool of registry.values()) {
    registerOne(server, tool, logger);
  }

  logger.info("server constructed", {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: Array.from(registry.keys()),
    storage: env.storage,
    // Never log the key itself — only whether one was supplied.
    embedder: env.embedApiKey ? "9router" : "fake",
  });
  return server;
}

function registerOne(
  server: McpServer,
  tool: ToolRegistration,
  logger: ReturnType<typeof createLogger>
): void {
  // The SDK accepts a Zod object schema directly via McpServer.registerTool;
  // it converts to JSON Schema internally. We pass the full schema (not
  // `.shape`) so the SDK's own validation stays the source of truth.
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    async (input) => {
      try {
        return await tool.handler(input);
      } catch (err) {
        // Mirror v2's internal `createToolError` shape: a plain text
        // content block with isError:true. v2's SDK would do this for us
        // (server/src/server/mcp.ts createToolError), but we keep the
        // try/catch to also surface stderr via the logger — hosts without
        // structured logging benefit from the observation.
        const message = err instanceof Error ? err.message : String(err);
        logger.error("handler threw", { tool: tool.name, error: message });
        return textResult(message, true);
      }
    }
  );
}

export async function main(): Promise<void> {
  // Config first, and on its own: a ConfigError is an operator mistake, not
  // a crash, so it exits with BAD_CONFIG and a one-line message rather than
  // the stack trace the FATAL_RUNTIME path prints. createServer() re-reads
  // the env (it is a pure function of process.env), so this call both
  // validates early and gives us a logger before the transport opens.
  let env: GraphragEnv;
  try {
    env = loadEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      // stderr only; stdout is reserved for the MCP transport.
      process.stderr.write(`graphrag-memory config error: ${err.message}\n`);
      process.exit(EXIT_CODES.BAD_CONFIG);
    }
    throw err;
  }
  const logger = createLogger(env.logLevel);

  // Stage 0 is stdio-only (map #33 defers HTTP to T-005/#36). Transport is
  // not a runtime knob, so there is no transport-rejection path here.
  let server: McpServer;
  try {
    server = await createServer();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`graphrag-memory config error: ${err.message}\n`);
      process.exit(EXIT_CODES.BAD_CONFIG);
    }
    throw err;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("stdio transport connected", { server: SERVER_NAME });
}

// Run only when invoked directly (not when imported for tests).
const isMain = (() => {
  if (typeof process === "undefined") return false;
  const arg1 = process.argv[1];
  if (!arg1) return false;
  // ESM entry path ends with /src/index.ts (dev) or /dist/index.js (prod).
  return arg1.endsWith("index.ts") || arg1.endsWith("index.js");
})();

if (isMain) {
  main().catch((err) => {
    // stderr only; never write to stdout (reserved for MCP transport).
    process.stderr.write(
      `graphrag-memory fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(EXIT_CODES.FATAL_RUNTIME);
  });
}
