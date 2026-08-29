import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TraceFixture {
  readonly traceDir: string;
  readonly cleanup: () => void;
}

export function createTraceFixture(): TraceFixture {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-trace-mcp-"));
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(
    join(traceDir, "conversation-1.jsonl"),
    [
      {
        conversation_id: "conversation-1",
        record_type: "llm_call",
        llm_call_id: "llm-1",
        status: "ok",
        messages: [{ role: "user", content: "private prompt" }],
      },
      {
        conversation_id: "conversation-1",
        record_type: "llm_call",
        llm_call_id: "llm-2",
        status: "error",
        error: { type: "execution_failed", message: "provider failed" },
        messages: [
          { role: "user", content: "private prompt" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu-1",
                name: "lookup",
                input: { query: "private input" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu-1",
                content: "private tool output",
              },
            ],
          },
        ],
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
    "utf8"
  );

  return {
    traceDir,
    cleanup: () => rmSync(traceDir, { recursive: true, force: true }),
  };
}
