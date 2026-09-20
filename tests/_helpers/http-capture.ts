/**
 * Local HTTP capture server (headers + body).
 *
 * Division of labour with `tests/session-api/_helpers/llm-capture.ts`: that
 * one records only request **bodies** (for thinking / message assertions);
 * this one records request **headers** — provider.headers → SDK
 * `defaultHeaders` pass-through is only black-box provable on the wire, and
 * the body-capture side cannot see headers.
 *
 * Usage:
 *   const cap = await startHttpCapture(MINIMAL_JSON_MESSAGE);
 *   ... issue a real request (SDK / adapter.step) ...
 *   assert.equal(cap.headers[0]!["x-foo"], "bar");
 *   await cap.close();
 */
import * as http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface HttpCapture {
  /** Origin the SDK should point at (http://127.0.0.1:<port>). */
  readonly origin: string;
  /** Request headers in arrival order (node lowercases header names). */
  readonly headers: ReadonlyArray<IncomingHttpHeaders>;
  /** Request bodies in arrival order (JSON-parsed values). */
  readonly bodies: unknown[];
  /** Close the underlying server; repeatable. */
  close(): Promise<void>;
}

/**
 * Start an http server that records request headers + JSON body and answers
 * with `responseBody` (JSON, 200). Port 0 = kernel-assigned, so concurrent
 * tests never fight over a port.
 */
export async function startHttpCapture(
  responseBody: unknown
): Promise<HttpCapture> {
  const headers: IncomingHttpHeaders[] = [];
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      headers.push({ ...req.headers });
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
    headers,
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

/** Minimal Anthropic Messages API success envelope (non-streaming arm). */
export const MINIMAL_MESSAGE_RESPONSE = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "test",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
