/**
 * A loopback Anthropic-compatible model server for real-`ask` evidence runs.
 *
 * Answers `/v1/messages` from a fixed script: each entry either returns text or
 * a tool_use block. The point is a *real* `iknow ask` process — real CLI parse,
 * real permission wall, real sandbox, real trace writer — with only the model
 * transport stubbed at its network boundary (test.md: stub an external model at
 * its boundary; keep the internal path under test real).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptedTurn {
  /** Text blocks to emit alongside the tool call. */
  readonly text?: string;
  readonly tool?: { readonly name: string; readonly input: unknown };
  /**
   * A `bash` command built from what THIS RUN already observed: every
   * `tool_result` text the model has been sent so far, in order.
   *
   * It exists because some evidence cannot be predicted by the fixture. The
   * run mints its own `conversationId` internally, so a test cannot name the
   * run's session scratch in advance — the only honest source for that path is
   * the run itself, which reports it through its own `$TMPDIR`. Naming it this
   * way is also what makes the case discriminating: a command the fixture
   * spelled out could be self-consistent with a wrong wiring, while one the run
   * hands back cannot be.
   */
  readonly bashCommandFrom?: (observed: readonly string[]) => string;
}

export interface LoopbackModel {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

/**
 * Append every `tool_result` text in a request's message history to `into`.
 *
 * The stub cannot assume the wire shape is well-formed (a real request only
 * ever costs a best-effort read here, never a failed run), so each level is
 * narrowed independently and anything unrecognised is skipped rather than
 * throwing.
 */
function collectToolResultTexts(body: unknown, into: string[]): void {
  const messages = (body as { messages?: unknown[] }).messages ?? [];
  for (const message of messages) {
    const blocks = (message as { content?: unknown[] }).content ?? [];
    for (const block of blocks) {
      const b = block as { type?: string; content?: unknown };
      if (b.type !== "tool_result") continue;
      for (const inner of Array.isArray(b.content) ? b.content : []) {
        const t = (inner as { text?: unknown }).text;
        if (typeof t === "string") into.push(t);
      }
    }
  }
}

/**
 * The assistant content blocks one scripted turn answers with, plus the tool
 * those blocks describe (so the caller can set `stop_reason` from the same
 * decision rather than re-deriving it).
 *
 * A derived turn (`bashCommandFrom`) and a fixed one are normalized to a single
 * `tool` here, which is why every downstream block reads this one value: the
 * arguments never appear in `content_block_start` (Anthropic's own wire shape —
 * they arrive in the following `input_json_delta`).
 */
function buildTurnContent(
  turn: ScriptedTurn,
  observed: readonly string[],
  index: number
): {
  readonly content: Array<Record<string, unknown>>;
  readonly tool: { readonly name: string; readonly input: unknown } | undefined;
} {
  const command = turn.bashCommandFrom?.(observed);
  const tool =
    command !== undefined
      ? { name: "bash", input: { command } }
      : turn.tool;
  const content: Array<Record<string, unknown>> = [];
  if (turn.text !== undefined) content.push({ type: "text", text: turn.text });
  if (tool !== undefined) {
    content.push({ type: "tool_use", id: `call_${index}`, name: tool.name, input: {} });
  }
  if (content.length === 0) content.push({ type: "text", text: "done" });
  return { content, tool };
}

export async function startLoopbackModel(
  script: ReadonlyArray<ScriptedTurn>
): Promise<LoopbackModel> {
  let index = 0;
  /** Every `tool_result` text this run has been sent, in arrival order. */
  const observed: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // count_tokens calls share the transport; only a real /v1/messages
      // request consumes a scripted turn, or the script would be exhausted
      // by token accounting before the model ever answered.
      if (req.url?.startsWith("/v1/messages/count_tokens") === true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      // The run's own history is the observation channel: a bash ok payload
      // carries `{code, stdout, stderr}` as its first text block, so the
      // fixture can read what a previous call actually produced instead of
      // assuming a path shape.
      try {
        collectToolResultTexts(JSON.parse(body), observed);
      } catch {
        // A body this stub cannot parse is still a real request: answer it
        // from the script rather than failing the run, so a parse gap shows
        // up as a wrong command in the evidence, not as a hung child.
      }
      const scripted = script[Math.min(index, script.length - 1)] ?? {};
      index += 1;
      const { content, tool } = buildTurnContent(scripted, observed, index);
      // The real adapter takes the SDK's `.stream()` arm, which is SSE — so the
      // stub must answer in SSE, not a bare JSON body.
      const events: Array<Record<string, unknown>> = [
        { type: "message_start", message: { id: `msg_${index}`, type: "message", role: "assistant", model: "stub-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      ];
      content.forEach((block, i) => {
        events.push({ type: "content_block_start", index: i, content_block: block });
        if (block["type"] === "tool_use") {
          // The SDK reads a tool_use block's arguments from
          // input_json_delta, not from content_block_start — a block that only
          // carried `input` would parse to {} and the tool would see no
          // command at all.
          events.push({
            type: "content_block_delta",
            index: i,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(tool.input),
            },
          });
        } else {
          events.push({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: block["text"] ?? "" } });
        }
        events.push({ type: "content_block_stop", index: i });
      });
      events.push({
        type: "message_delta",
        delta: { stop_reason: tool !== undefined ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      });
      events.push({ type: "message_stop" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      for (const e of events) {
        res.write(`event: ${e["type"]}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
