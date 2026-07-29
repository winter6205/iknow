/**
 * Tool registry contract for graphrag-memory.
 *
 * The MCP server wires the registered tools into the JSON-RPC `tools/list`
 * and `tools/call` handlers. Each tool is independent: validation, schema,
 * and handler. The registry is a thin map; no dynamic loading (per
 * Principle of Least Astonishment — tools are explicit).
 *
 * `ToolResult` re-uses the SDK's `CallToolResult` so handlers return
 * exactly what `McpServer.registerTool`'s callback expects — no shape
 * translation layer. The adapter only wraps thrown errors.
 */
import type { z } from "zod";
import type { CallToolResult, TextContent } from "@modelcontextprotocol/server";

export type { CallToolResult, TextContent };

/** Handler return type = SDK's CallToolResult (content + optional isError/_meta). */
export type ToolResult = CallToolResult;

/**
 * Tool registration. Generic over the Zod schema so each tool's `input`
 * is typed end-to-end; the registry boundary (`buildRegistry`) erases the
 * generic to a single `ToolRegistrationAny` to keep `Map<string, T>` simple.
 */
export interface ToolRegistration<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Stable tool name exposed over MCP `tools/call`. */
  name: string;
  /** Human-readable description for `tools/list`. */
  description: string;
  /** Zod schema for the input object; converted to JSON Schema by the SDK. */
  inputSchema: TSchema;
  /**
   * Pure handler. Throws on validation/internal errors; the adapter
   * translates thrown errors into `isError: true` results.
   */
  handler: (input: z.infer<TSchema>) => Promise<ToolResult> | ToolResult;
}

export type ToolRegistrationAny = ToolRegistration<z.ZodTypeAny>;

export type ToolRegistry = ReadonlyMap<string, ToolRegistrationAny>;

export function buildRegistry(
  tools: readonly ToolRegistrationAny[]
): ToolRegistry {
  const map = new Map<string, ToolRegistrationAny>();
  for (const t of tools) {
    if (map.has(t.name)) {
      throw new Error(
        `duplicate tool registration: ${t.name} (tools must have unique names)`
      );
    }
    map.set(t.name, t);
  }
  return map;
}

/** Build a text-only ToolResult. Centralizes the content-block shape. */
export function textResult(text: string, isError = false): ToolResult {
  const content: TextContent[] = [{ type: "text", text }];
  return isError ? { content, isError } : { content };
}
