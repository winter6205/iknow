/**
 * Echo tool — MVP stage 0 placeholder.
 *
 * Why echo: the smallest honest demonstration of the tool round-trip.
 * Stage 0 nails down the MCP wiring (server lifecycle, tool registration,
 * JSON-RPC framing) without committing to any retrieval semantics. Stage 1
 * (ticket #36) replaces this with the real GraphRAG memory tool.
 *
 * The pure `echoHandler` is what the tests exercise. The MCP wiring
 * (zod-schema → JSON Schema → handler) lives in `src/index.ts`.
 */
import { z } from "zod";
import {
  textResult,
  type ToolRegistration,
  type ToolResult,
} from "./registry.js";

export const EchoInputSchema = z.object({
  message: z.string().min(1, "message must be a non-empty string"),
});

export type EchoInput = z.infer<typeof EchoInputSchema>;

export function echoHandler(input: EchoInput): ToolResult {
  // The schema is the source of truth; `input` here is already validated.
  return textResult(input.message);
}

export const echoTool: ToolRegistration = {
  name: "echo",
  description:
    "MVP stage 0 placeholder: returns the message back as text. " +
    "Stage 1 will replace this with real GraphRAG memory tools.",
  inputSchema: EchoInputSchema,
  handler: echoHandler as unknown as ToolRegistration["handler"],
};
