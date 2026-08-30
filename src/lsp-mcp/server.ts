import { McpServer } from "@modelcontextprotocol/server";

import {
  createSymbolQueryToolSet,
  SYMBOL_QUERY_ZOD_SCHEMAS,
} from "../harness/aci/tools/symbol.js";
import {
  createLspClientPool,
  DEFAULT_LSP_IDLE_TIMEOUT_MS,
  type LspClientPool,
} from "../harness/lsp/client.js";
import { startLspWarmup } from "../harness/lsp/warmup.js";
import type { LspCtx } from "../harness/lsp/types.js";

export interface LspMcpServerOptions {
  readonly directory: string;
  readonly pool?: LspClientPool;
  readonly warmup?: boolean;
}

export function createLspMcpServer(options: LspMcpServerOptions): {
  readonly server: McpServer;
  readonly pool: LspClientPool;
  readonly close: () => Promise<void>;
} {
  const pool = options.pool ?? createLspClientPool();
  const ctx: LspCtx = {
    directory: options.directory,
    pool,
    idleTimeoutMs: DEFAULT_LSP_IDLE_TIMEOUT_MS,
  };
  if (options.warmup === true) startLspWarmup(ctx);

  const aciTools = createSymbolQueryToolSet(ctx);
  const server = new McpServer({
    name: "iknow-lsp-mcp",
    version: "0.1.0",
  });

  for (const def of aciTools) {
    const inputSchema = SYMBOL_QUERY_ZOD_SCHEMAS[def.name];
    if (inputSchema === undefined) {
      throw new Error(`iknow-lsp-mcp: no Zod schema for ACI tool ${def.name}`);
    }
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema,
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        try {
          const text = await def.handler(input);
          return {
            content: [
              {
                type: "text",
                text: typeof text === "string" ? text : String(text),
              },
            ],
          };
        } catch (error: unknown) {
          return {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  return {
    server,
    pool,
    close: async () => {
      await pool.disposeAll();
      await server.close();
    },
  };
}
