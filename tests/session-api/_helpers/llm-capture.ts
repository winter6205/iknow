/**
 * Local HTTP capture-server helper for tests/session-api/.
 *
 * Three LLM-bound test files (hub.test.ts, http.test.ts,
 * thinking-override.test.ts) each used to define their own ~80-line capture
 * server + the same 10-field LlmEnv literal + a near-identical SdkMessage
 * body. M4 / code-review 双轴整改 consolidates those into one helper so
 * the test surface stays single-source for the helper shape (the wire
 * assertions still belong to the call sites).
 *
 * Usage:
 *   const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
 *   const env = makeTestLlmEnv({ baseUrl: cap.origin });
 *   ... do work ...
 *   await cap.close();
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

/** Anthropic Messages API minimal success envelope (text reply). */
export const MINIMAL_SDK_MESSAGE = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "test",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

export type LlmCapture = {
  /** Origin URL the SDK should target (http://127.0.0.1:<port>). */
  readonly origin: string;
  /** Bodies captured from the SDK, in arrival order. */
  readonly bodies: unknown[];
  /** Close the underlying HTTP server. Safe to call multiple times. */
  close(): Promise<void>;
};

/**
 * Start an http server that captures request bodies and replies with
 * `responseBody` (JSON, 200). Use with `MINIMAL_SDK_MESSAGE` for the
 * default Anthropic shape, or pass `{ ...MINIMAL_SDK_MESSAGE, content:
 * [{type:'text',text:'override ok'}] }` to vary the assistant text.
 */
export async function startLlmCapture(
  responseBody: unknown = MINIMAL_SDK_MESSAGE
): Promise<LlmCapture> {
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const addr = server.address() as AddressInfo;
  let closed = false;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    bodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

/** Defaults match the 10-field env literal that hub/http/thinking-override
 * tests each declared inline. Any field can be overridden (including setting
 * `apiKey` to `undefined` to assert the missing-key failure path). */
export const DEFAULT_TEST_LLM_ENV: TestLlmEnv = {
  baseUrl: "http://invalid",
  model: "test-model",
  fallback: [],
  apiKeyEnv: "IKNOW_TEST_KEY",
  apiKey: "test-key",
  maxOutputTokens: 128,
  timeoutMs: 5000,
  temperature: 0,
  thinking: "off",
  thinkingEffort: "",
};

/**
 * Build a 10-field LlmEnv. Any field on `overrides` replaces the default —
 * spread semantics preserve explicit `undefined` (so the no-key test path
 * still works) and leave omitted fields at the default value.
 */
export function makeTestLlmEnv(overrides: Partial<TestLlmEnv> = {}): {
  readonly llm: TestLlmEnv;
} {
  return { llm: { ...DEFAULT_TEST_LLM_ENV, ...overrides } };
}

/**
 * Subset of `LlmEnv` we use in tests — a separate alias keeps the helper
 * independent of the live `LlmEnv` type's evolution while still being
 * assignable (each field's value type matches).
 */
export type TestLlmEnv = {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly apiKey: string | undefined;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly temperature: number;
  readonly thinking: "off" | "adaptive";
  readonly thinkingEffort: "" | "low" | "medium" | "high" | "xhigh" | "max";
};
