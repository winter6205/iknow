import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/client";

import type { ToolExecutionContext } from "../tools/types.js";
import type { AciToolDef } from "../aci/types.js";
import { ToolExecutionError } from "../errors.js";

interface CallOptions {
  readonly timeout?: number;
  readonly signal?: AbortSignal;
  readonly resetTimeoutOnProgress?: boolean;
}

export interface ToAciToolDefOptions {
  readonly server: string;
  readonly tool: McpTool;
  readonly call: (
    name: string,
    args: unknown,
    opts?: CallOptions
  ) => Promise<CallToolResult>;
  readonly timeoutMs: number;
}

const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} } as const;

// The host registry's Ajv bundles only the draft-07 meta-schema, while zod4 / MCP
// SDK 2.0 emit a top-level 2020-12 `$schema` that compile rejects. Strip only this
// top-level key; when absent, return the original reference to keep object identity
// and the EMPTY_INPUT_SCHEMA fallback semantics. Known limitation: other 2020-12-only
// keywords (e.g. tuple `prefixItems`) pass through and may be misread under a
// draft-07 view; current consumers (plain zod4 keywords) are unaffected.
function stripTopLevelSchemaKeyword(
  schema: Record<string, unknown>
): Record<string, unknown> {
  if (!("$schema" in schema)) {
    return schema;
  }
  const { $schema: _meta, ...rest } = schema;
  return Object.freeze(rest);
}

export function toAciToolDef(opts: ToAciToolDefOptions): AciToolDef {
  const { server, tool, call, timeoutMs } = opts;

  return Object.freeze({
    name: `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool.name)}`,
    description: tool.description ?? "",
    inputSchema: stripTopLevelSchemaKeyword(
      (tool.inputSchema ?? EMPTY_INPUT_SCHEMA) as Record<string, unknown>
    ),
    aci: {
      category: "write" as const,
      lazy: true,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "long" as const,
    },
    handler: async (
      input: unknown,
      ctx?: ToolExecutionContext
    ): Promise<string> => {
      let result: CallToolResult;
      try {
        result = await call(tool.name, input, {
          timeout: timeoutMs,
          resetTimeoutOnProgress: true,
          signal: ctx?.signal,
        });
      } catch (cause) {
        throw new ToolExecutionError(
          `MCP tool execution failed: ${errorMessage(cause)}`
        );
      }

      if (result.isError) {
        return extractText(result);
      }
      if (result.structuredContent !== undefined) {
        return JSON.stringify(result.structuredContent);
      }
      return extractText(result);
    },
  });
}

function sanitizeSegment(value: string): string {
  // Replace only characters invalid in a tool name; hyphens and dots are kept
  // because deps.ts `mcpServerOfToolName` reverse-parses the tool name to recover
  // the config server name (e.g. `codebase-memory`). Mapping `-` to `_` would make
  // the parsed name never match the panel's status.name, so the server would show
  // zero tools and a blank detail page.
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function extractText(result: CallToolResult): string {
  return result.content
    .filter(
      (
        block
      ): block is Extract<(typeof result.content)[number], { type: "text" }> =>
        block.type === "text"
    )
    .map((block) => block.text)
    .join("");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
