/**
 * Minimal stdio MCP server fixture for real-connection e2e
 * (archive/tests-real-llm/model-prefix-layering-e2e.test.ts it 2).
 *
 * Hand-rolled JSON-RPC 2.0 over newline-delimited stdio — no SDK dependency:
 *   - `initialize`  → echoes the client's requested protocolVersion back
 *     (safest across SDK minor versions), advertises the `tools` capability.
 *   - `tools/list`  → exactly one tool `echo`.
 *   - `tools/call`  → returns `echo: <arguments.text>` as a text content block.
 * Notifications (no id) get no response. Unknown requests get an empty
 * result so the client never hangs.
 */
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line.length > 0) handleLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg.id;
  const method = msg.method;
  let result;
  switch (method) {
    case "initialize":
      result = {
        protocolVersion:
          (msg.params && msg.params.protocolVersion) || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "layering-e2e", version: "0.0.1" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "echo",
            description:
              "Echo the given text back verbatim. Used by the layering e2e to prove a real MCP round-trip.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      };
      break;
    case "tools/call": {
      const text =
        msg.params && msg.params.arguments && msg.params.arguments.text !==
          undefined
          ? String(msg.params.arguments.text)
          : "";
      result = {
        content: [{ type: "text", text: `echo: ${text}` }],
        isError: false,
      };
      break;
    }
    case "ping":
      result = {};
      break;
    default:
      // Request (has id) for an unknown method → empty result, never hang.
      result = msg.id !== undefined && msg.id !== null ? {} : undefined;
  }
  if (result !== undefined && id !== undefined && id !== null) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
}
