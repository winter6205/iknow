/**
 * thinking-override tests (T2 / #complexity anti-drift gate).
 *
 * Boundary classes per arthurpower:defensive-contract-validator:
 *   - empty:    parseThinkingOverride(undefined/null) → undefined
 *   - normal:   valid mode/effort combinations round-trip; build deps replace
 *               adapter only and keep executor/registry/maxTurns/timeoutMs.
 *   - negative: invalid mode / invalid effort / non-object / missing mode →
 *               ValidationError (400 fail-loud surface)
 *   - overflow: long inputs are not affected (validator only)
 *   - exception: env without apiKey → ValidationError (mirrors ensureDeps)
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  parseThinkingOverride,
  withThinkingOverride,
} from "../../src/session-api/thinking-override.ts";
import { ValidationError } from "../../src/shared/errors.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";

// -- parseThinkingOverride: empty -----------------------------------------

describe("parseThinkingOverride — empty / absent", () => {
  it("undefined → undefined", () => {
    assert.equal(parseThinkingOverride(undefined), undefined);
  });

  it("null → undefined", () => {
    assert.equal(parseThinkingOverride(null), undefined);
  });
});

// -- parseThinkingOverride: normal ---------------------------------------

describe("parseThinkingOverride — valid inputs", () => {
  it("{mode:'off'} → {mode:'off'}", () => {
    assert.deepEqual(parseThinkingOverride({ mode: "off" }), { mode: "off" });
  });

  it("{mode:'adaptive', effort:'high'} → passthrough", () => {
    assert.deepEqual(
      parseThinkingOverride({ mode: "adaptive", effort: "high" }),
      { mode: "adaptive", effort: "high" }
    );
  });

  it("effort='' is valid (means no output_config)", () => {
    assert.deepEqual(parseThinkingOverride({ mode: "adaptive", effort: "" }), {
      mode: "adaptive",
      effort: "",
    });
  });

  it("each enum effort value is accepted", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      assert.deepEqual(parseThinkingOverride({ mode: "adaptive", effort }), {
        mode: "adaptive",
        effort,
      });
    }
  });
});

// -- parseThinkingOverride: negative / fail-loud -------------------------

describe("parseThinkingOverride — invalid values throw ValidationError", () => {
  it("non-object (string) → ValidationError field=thinking", () => {
    assert.throws(
      () => parseThinkingOverride("off"),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.details?.["field"] === "thinking" &&
        /object/.test(err.message)
    );
  });

  it("array → ValidationError field=thinking", () => {
    assert.throws(
      () => parseThinkingOverride(["off"]),
      (err: unknown) =>
        err instanceof ValidationError && err.details?.["field"] === "thinking"
    );
  });

  it("missing mode → ValidationError field=thinking.mode", () => {
    assert.throws(
      () => parseThinkingOverride({}),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.details?.["field"] === "thinking.mode"
    );
  });

  it("invalid mode 'loud' → ValidationError field=thinking.mode", () => {
    assert.throws(
      () => parseThinkingOverride({ mode: "loud" }),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.details?.["field"] === "thinking.mode" &&
        /off|adaptive/.test(err.message)
    );
  });

  it("invalid effort 'extreme' → ValidationError field=thinking.effort", () => {
    assert.throws(
      () => parseThinkingOverride({ mode: "adaptive", effort: "extreme" }),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.details?.["field"] === "thinking.effort"
    );
  });

  it("non-string effort (number) → ValidationError", () => {
    assert.throws(
      () => parseThinkingOverride({ mode: "adaptive", effort: 5 }),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.details?.["field"] === "thinking.effort"
    );
  });
});

// -- withThinkingOverride: construction behavior -----------------------

describe("withThinkingOverride — replaces adapter only, reuses other deps", () => {
  it("returned deps.executor / registry / maxTurns / timeoutMs identical to base", () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const baseDeps: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("nope");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor,
      registry,
      maxTurns: 7,
      timeoutMs: 4321,
    };
    const env = {
      llm: {
        baseUrl: "http://invalid",
        model: "x",
        apiKeyEnv: "K",
        apiKey: "k",
        maxOutputTokens: 64,
        timeoutMs: 1000,
        temperature: 0,
        thinking: "off" as const,
        thinkingEffort: "" as const,
      },
    };
    const result = withThinkingOverride({
      deps: baseDeps,
      override: { mode: "off" },
      env,
    });
    assert.equal(result.executor, baseDeps.executor);
    assert.equal(result.registry, baseDeps.registry);
    assert.equal(result.maxTurns, baseDeps.maxTurns);
    assert.equal(result.timeoutMs, baseDeps.timeoutMs);
    // adapter is replaced
    assert.notEqual(result.adapter, baseDeps.adapter);
  });

  it("env without apiKey → ValidationError (mirror of ensureDeps)", () => {
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const baseDeps: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("nope");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor,
      registry,
      maxTurns: 1,
    };
    const envNoKey = {
      llm: {
        baseUrl: "http://invalid",
        model: "x",
        apiKeyEnv: "K",
        apiKey: undefined,
        maxOutputTokens: 64,
        timeoutMs: 1000,
        temperature: 0,
        thinking: "off" as const,
        thinkingEffort: "" as const,
      },
    };
    assert.throws(
      () =>
        withThinkingOverride({
          deps: baseDeps,
          override: { mode: "adaptive" },
          env: envNoKey,
        }),
      (err: unknown) =>
        err instanceof ValidationError &&
        /IKNOW_LLM_API_KEY_ENV/.test(err.message)
    );
  });
});

// -- withThinkingOverride: real adapter request side --------------------
// Use a local HTTP capture server as the SDK's baseURL target. The server
// returns a minimal SdkMessage so the adapter step completes successfully,
// and we assert the captured request body contains the override-derived
// thinking / output_config fields. This directly verifies the wire-side
// contract ("adapter's request carries thinking").

interface CaptureServer {
  origin: string;
  capturedBodies: unknown[];
  close(): Promise<void>;
}

async function startCaptureServer(
  responseBody: unknown
): Promise<CaptureServer> {
  const capturedBodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) capturedBodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    capturedBodies,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      ),
  };
}

const minimalSdkMessage = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "test",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

let capture: CaptureServer | undefined;

afterEach(async () => {
  if (capture) {
    await capture.close();
    capture = undefined;
  }
});

describe("withThinkingOverride — request-side thinking fields via local capture server", () => {
  it("thinking=adaptive + effort=high → request carries thinking:{type:'adaptive'} + output_config:{effort:'high'}", async () => {
    capture = await startCaptureServer(minimalSdkMessage);
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const baseDeps: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("should be replaced by override adapter");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor,
      registry,
      maxTurns: 1,
    };
    const env = {
      llm: {
        baseUrl: capture.origin,
        model: "test",
        apiKeyEnv: "K",
        apiKey: "test-key",
        maxOutputTokens: 64,
        timeoutMs: 5000,
        temperature: 0,
        thinking: "off" as const,
        thinkingEffort: "" as const,
      },
    };
    const result = withThinkingOverride({
      deps: baseDeps,
      override: { mode: "adaptive", effort: "high" },
      env,
    });
    await result.adapter.step({ messages: [], turnCount: 0 }, { tools: [] });
    assert.equal(capture.capturedBodies.length, 1);
    const body = capture.capturedBodies[0] as Record<string, unknown>;
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.deepEqual(body.output_config, { effort: "high" });
  });

  it("thinking=off → request has no thinking / output_config fields", async () => {
    capture = await startCaptureServer(minimalSdkMessage);
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const baseDeps: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("should be replaced");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor,
      registry,
      maxTurns: 1,
    };
    const env = {
      llm: {
        baseUrl: capture.origin,
        model: "test",
        apiKeyEnv: "K",
        apiKey: "test-key",
        maxOutputTokens: 64,
        timeoutMs: 5000,
        temperature: 0,
        thinking: "off" as const,
        thinkingEffort: "" as const,
      },
    };
    const result = withThinkingOverride({
      deps: baseDeps,
      override: { mode: "off" },
      env,
    });
    await result.adapter.step({ messages: [], turnCount: 0 }, { tools: [] });
    const body = capture.capturedBodies[0] as Record<string, unknown>;
    assert.equal("thinking" in body, false);
    assert.equal("output_config" in body, false);
  });
});

// Suppress unused-import warning for mkdtempSync (kept for future
// file-based capture). ts/eslint cleanly omit it via the unused-prefix rule.
void mkdtempSync;
void tmpdir;
void join;
