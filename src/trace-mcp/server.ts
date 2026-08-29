import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  createQueryTraceCore,
  QUERY_TRACE_DEFAULT_LIMIT,
  QUERY_TRACE_MAX_LIMIT,
  TRACE_RECORD_TYPES,
} from "../traceserver/index.js";

const queryTraceInputSchema = z
  .object({
    conversation_id: z.string().optional(),
    record_type: z.enum(TRACE_RECORD_TYPES).optional(),
    status: z.enum(["ok", "error"]).optional(),
    task_id: z.string().optional(),
    parent_turn_id: z.string().optional(),
    turn_id: z.string().optional(),
    limit: z.number().int().min(1).max(QUERY_TRACE_MAX_LIMIT).optional(),
    record_id: z.string().optional(),
    detail: z.enum(["tool_results", "messages"]).optional(),
    resume_offset: z.number().int().min(0).optional(),
  })
  .strict();

const QUERY_TRACE_DESCRIPTION =
  "Query local JSONL trace records with filters. Normal llm_call results are projection-only (message count, first/last previews, tool_result projection from llm_call.messages, and error); use record_id to drill into one record. By default drill-down returns tool_results; use detail=messages for messages. If the model ends the turn without a following llm_call, that last round's tool_results are not visible in the projection. Results are capped at 4000 characters.";

export interface TraceMcpServerOptions {
  readonly traceDir: string;
}

export function createTraceMcpServer(
  options: TraceMcpServerOptions
): McpServer {
  const queryTrace = createQueryTraceCore(options);
  const server = new McpServer({
    name: "iknow-trace-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "query_trace",
    {
      description: QUERY_TRACE_DESCRIPTION,
      inputSchema: queryTraceInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        return {
          content: [{ type: "text", text: await queryTrace(input) }],
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

  return server;
}

export { QUERY_TRACE_DEFAULT_LIMIT };
