/**
 * 本地 HTTP 捕获 server（头 + body）。
 *
 * 与 `tests/session-api/_helpers/llm-capture.ts` 的分工：那份只看请求 **body**
 * （thinking / 消息体断言用）；本份看请求 **headers** —— provider.headers →
 * SDK `defaultHeaders` 透传（specs/tui-model-command.md SC9）只有在 wire 上才
 * 是黑盒可证的，body 捕获面看不到头。
 *
 * 用法：
 *   const cap = await startHttpCapture(MINIMAL_JSON_MESSAGE);
 *   ... 真发请求（SDK / adapter.step）...
 *   assert.equal(cap.headers[0]!["x-foo"], "bar");
 *   await cap.close();
 */
import * as http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface HttpCapture {
  /** SDK 应指向的 origin（http://127.0.0.1:<port>）。 */
  readonly origin: string;
  /** 按到达顺序记录的请求头（node 会把头名小写化）。 */
  readonly headers: ReadonlyArray<IncomingHttpHeaders>;
  /** 按到达顺序记录的请求 body（JSON 解析后的值）。 */
  readonly bodies: unknown[];
  /** 关闭底层 server；可重复调用。 */
  close(): Promise<void>;
}

/**
 * 起一个记录请求头 + JSON body 并以 `responseBody`（JSON, 200）作答的
 * http server。端口 0 = 内核分配，避免并发测试抢端口。
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

/** Anthropic Messages API 最小成功 envelope（非流式臂）。 */
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
