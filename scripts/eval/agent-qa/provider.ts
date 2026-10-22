/**
 * Scripted provider: the single external boundary the offline evaluation path is
 * allowed to fake. Everything behind `baseUrl` is the real production Anthropic
 * SDK talking to a real local HTTP server, so dispatch counts, request bodies and
 * stop reasons stay externally provable.
 *
 * Why an HTTP server instead of a stub adapter object: a stubbed adapter proves
 * nothing about the wire, and the whole point of this capability is that a claimed
 * trajectory is witnessed outside the model's own narration.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

import { ioFailure, ProviderFailure } from "./failures.ts";
import type { ScriptedStep } from "./types.ts";

/** Anthropic Messages API path; the only route this server answers. */
const MESSAGES_PATH = "/v1/messages";

/** Synthetic, secret-free key. The provider never checks it; nothing real is sent. */
export const SYNTHETIC_API_KEY = "sk-eval-synthetic-not-a-credential";

export type ScriptedProviderOptions = {
  /**
   * `absent` omits the `usage` object from every response. That is how unknown
   * usage is witnessed: the only honest reading of a response that never stated a
   * count is "unobserved", never zero.
   */
  readonly usage?: "reported" | "absent";
  /** Model id echoed back so a response can be attributed to one route. */
  readonly model?: string;
};

export type ScriptedProvider = {
  readonly baseUrl: string;
  readonly port: number;
  /** Parsed request bodies in arrival order — external proof of dispatch count. */
  readonly requests: ReadonlyArray<unknown>;
  readonly requestCount: number;
  /** True once a call arrived with no scripted step left to serve. */
  readonly scriptExhausted: boolean;
  stop(): Promise<void>;
};

function contentOf(step: ScriptedStep): ReadonlyArray<Record<string, unknown>> {
  if (step.kind === "text") {
    return [{ type: "text", text: step.text }];
  }
  return [
    {
      type: "tool_use",
      id: step.toolCallId,
      name: step.toolName,
      input: step.input,
    },
  ];
}

function stopReasonOf(step: ScriptedStep): string {
  // EXIT: a tool step must land `tool_use` or the loop would treat the call as a
  // final answer and never dispatch it; nothing to clean; the run continues.
  return step.kind === "tool" ? "tool_use" : "end_turn";
}

function responseBody(
  step: ScriptedStep,
  index: number,
  options: ScriptedProviderOptions
): Record<string, unknown> {
  const usageReported = (options.usage ?? "reported") === "reported";
  return {
    id: `msg_scripted_${index}`,
    type: "message",
    role: "assistant",
    model: options.model ?? "scripted-model",
    content: contentOf(step),
    stop_reason: stopReasonOf(step),
    stop_sequence: null,
    // Omitted key, not `null`: a present-but-null usage object would let a reader
    // invent zeros, which is the exact false fact this record must avoid.
    ...(usageReported ? { usage: { input_tokens: 11, output_tokens: 7 } } : {}),
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * A script that runs out is a failed measurement, not a licence to repeat the last
 * step: a repeat would manufacture a turn the case never declared.
 */
function exhaustedBody(steps: readonly ScriptedStep[]): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: `scripted provider served ${steps.length} step(s); no step remains`,
    },
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        // EXIT: the request body is not JSON — recorded as raw text so a malformed
        // client call is still externally visible; nothing to clean; serving stops.
        resolve({ unparsed: raw.slice(0, 512) });
      }
    });
    req.on("error", reject);
  });
}

export async function startScriptedProvider(
  steps: readonly ScriptedStep[],
  options: ScriptedProviderOptions = {}
): Promise<ScriptedProvider> {
  const requests: unknown[] = [];
  let cursor = 0;
  let exhausted = false;

  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== MESSAGES_PATH) {
        // EXIT: unrouted request — never served from the script, so a stray call
        // cannot silently consume a step; nothing to clean; serving stops.
        writeJson(res, 404, {
          type: "error",
          error: { type: "not_found_error", message: `no route ${req.url}` },
        });
        return;
      }
      requests.push(await readBody(req));
      const step = steps[cursor];
      if (step === undefined) {
        exhausted = true;
        // EXIT: script exhausted — 400 is non-retryable by the SDK, so the fault
        // reaches the adapter instead of being retried away; nothing to clean;
        // the run ends in a provider error.
        writeJson(res, 400, exhaustedBody(steps));
        return;
      }
      cursor += 1;
      writeJson(res, 200, responseBody(step, cursor, options));
    })().catch(() => {
      // EXIT: the handler itself threw — a 500 keeps the failure loud rather than
      // hanging the socket; the server stays up for stop(); serving stops.
      writeJson(res, 500, {
        type: "error",
        error: { type: "api_error", message: "scripted provider handler fault" },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) =>
      // EXIT: the loopback socket never opened, so no request was served and nothing
      // real was reachable; the failed handle is already closed and no run starts.
      reject(ioFailure(error, "dispatch", "scripted provider listen on 127.0.0.1"))
    );
    // Ephemeral port on loopback only: nothing here can reach a real endpoint.
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  let stopped = false;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    get requestCount(): number {
      return requests.length;
    },
    get scriptExhausted(): boolean {
      return exhausted;
    },
    stop: async () => {
      if (stopped) {
        // EXIT: double stop — the socket is already closed, so a second close would
        // report a success the server never gave; nothing further to clean.
        throw new ProviderFailure("scripted provider stop() called twice");
      }
      stopped = true;
      // The SDK holds a keep-alive socket, so `close()` alone would wait for the
      // client to finish and teardown would report unconfirmed cleanup.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * Proof that a run consumed exactly its declared script: fewer calls than steps
 * means the trajectory the case describes never happened.
 */
export function assertScriptConsumed(
  provider: ScriptedProvider,
  steps: readonly ScriptedStep[],
  attemptId?: string
): void {
  if (provider.requestCount !== steps.length) {
    // EXIT: dispatch count and script length disagree — the attempt is not a
    // measurement of the declared trajectory; the caller owns server teardown.
    throw new ProviderFailure(
      `scripted provider served ${provider.requestCount} of ${steps.length} declared step(s)`,
      attemptId
    );
  }
}
