import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { createLspToolSet } from "../harness/aci/tools/lsp.js";
import {
  createLspClientPool,
  DEFAULT_LSP_IDLE_TIMEOUT_MS,
  type LspClientPool,
} from "../harness/lsp/client.js";
import { startLspWarmup } from "../harness/lsp/warmup.js";
import type { LspCtx } from "../harness/lsp/types.js";

const positionSchema = z
  .object({
    file: z.string(),
    line: z.number().int().min(1),
    character: z.number().int().min(0),
  })
  .strict();

const fileOnlySchema = z.object({ file: z.string() }).strict();

const workspaceSchema = z
  .object({
    file: z.string().optional(),
    query: z.string().optional(),
  })
  .strict();

const diagnosticsSchema = z
  .object({
    file: z.string().optional(),
    files: z.array(z.string()).min(1).max(10).optional(),
  })
  .strict();

const TOOL_SCHEMAS: Record<string, z.ZodType> = {
  lsp_definition: positionSchema,
  lsp_references: positionSchema,
  lsp_hover: positionSchema,
  lsp_document_symbol: fileOnlySchema,
  lsp_workspace_symbol: workspaceSchema,
  lsp_go_to_implementation: positionSchema,
  lsp_prepare_call_hierarchy: positionSchema,
  lsp_incoming_calls: positionSchema,
  lsp_outgoing_calls: positionSchema,
  lsp_diagnostics: diagnosticsSchema,
};

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

  const aciTools = createLspToolSet(ctx);
  const server = new McpServer({
    name: "iknow-lsp-mcp",
    version: "0.1.0",
  });

  for (const def of aciTools) {
    const inputSchema = TOOL_SCHEMAS[def.name];
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
