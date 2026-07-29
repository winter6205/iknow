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

import { loadEnv } from "./config.js";
import { createLogger } from "./logging.js";
import {
  buildRegistry,
  textResult,
  type ToolRegistration,
} from "./tools/registry.js";
import { echoTool } from "./tools/echo.js";

const SERVER_NAME = "graphrag-memory";
const SERVER_VERSION = "0.0.0";

export function createServer(): McpServer {
  const env = loadEnv();
  const logger = createLogger(env.logLevel);
  const registry = buildRegistry([echoTool]);

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
    transport: env.transport,
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
        const message = err instanceof Error ? err.message : String(err);
        logger.error("handler threw", { tool: tool.name, error: message });
        return textResult(`${tool.name} failed: ${message}`, true);
      }
    }
  );
}

export async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.logLevel);

  if (env.transport !== "stdio") {
    logger.error("only stdio transport is supported in stage 0", {
      transport: env.transport,
    });
    process.exit(2);
  }

  const server = createServer();
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
    process.exit(1);
  });
}
