/**
 * Per-route request output budgets on the wire.
 *
 * Ground truth = the `max_tokens` field of the body the Anthropic-compatible
 * SDK actually sends, captured on local servers (the streaming arm, which is
 * what production configures): the value must come from the model entry the
 * effective route matched (SC1/SC2/SC3), a separately routed sub-agent must
 * carry its own route's value (SC12), and two routes configured at once must
 * each send their own (SC18). The generic harness never clamps a configured
 * positive safe integer to an inferred supplier maximum (SC15); a supplier that
 * rejects the value surfaces as the ordinary provider error, unretried and
 * never recorded as completion (SC16).
 *
 * Assembly is real: settings fixture → `loadIknowEnv` → `createAdapterFromEnv`
 * / `createWorkerDeps` → SDK. Only the model service is stubbed.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { APIError } from "@anthropic-ai/sdk";
import { createAdapterFromEnv } from "../../src/harness/build-engine.ts";
import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { withThinkingOverride } from "../../src/session-api/thinking-override.ts";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  loadIknowEnv,
  type IknowEnv,
} from "../../src/config/env.ts";
import type { IknowSettings } from "../../src/config/settings.ts";
import type { LoopAdapter, LoopEngineDeps } from "../../src/harness/index.ts";
import type { CreateWorkerDepsOptions } from "../../src/harness/subagent/worker.ts";

const MAIN_KEY_ENV = "IKNOW_TEST_ROUTE_BUDGET_MAIN_KEY";
const SUB_KEY_ENV = "IKNOW_TEST_ROUTE_BUDGET_SUB_KEY";
const STREAM_ENV_KEY = "IKNOW_LLM_STREAM";

/** Entries as an operator would write them; `quiet` deliberately omits a budget. */
const MAIN_MODELS = [
  { id: "opus", maxTokens: 72_000 },
  { id: "quiet" },
  { id: "MiniMax-M3", maxTokens: 131_072 },
  // above the documented M3 maximum: must still go out verbatim
  { id: "m3-over", maxTokens: 524_289 },
];
const SUB_MODELS = [
  { id: "sub-model", maxTokens: 64_000 },
  { id: "sub-quiet" },
];

/**
 * A complete SSE body for one short assistant reply. Each event is terminated
 * by a blank line: without the terminator after `message_stop` the SDK's stream
 * accumulator never settles, so the last event would silently vanish.
 */
const SSE_OK = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

type Capture = {
  readonly origin: string;
  readonly bodies: Record<string, unknown>[];
  close(): Promise<void>;
};

/**
 * Body-capturing server answering either a normal stream or a supplier
 * rejection, so one case can pin both the sent `max_tokens` and the answer.
 */
async function startCapture(
  answer:
    | { readonly kind: "ok" }
    | { readonly kind: "reject"; readonly body: unknown } = { kind: "ok" }
): Promise<Capture> {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) bodies.push(JSON.parse(raw) as Record<string, unknown>);
      if (answer.kind === "reject") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE_OK);
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

let root: string;
const captures: Capture[] = [];

async function track(capture: Capture): Promise<Capture> {
  captures.push(capture);
  return capture;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iknow-route-budget-wire-"));
  process.env[MAIN_KEY_ENV] = "main-key";
  process.env[SUB_KEY_ENV] = "sub-key";
  // Explicit rather than defaulted: a stray ambient value would switch arms.
  // The streaming arm is also the one a >= 21,334-token budget can use at all.
  process.env[STREAM_ENV_KEY] = "on";
});

afterEach(async () => {
  while (captures.length > 0) {
    await captures.pop()!.close();
  }
  delete process.env[MAIN_KEY_ENV];
  delete process.env[SUB_KEY_ENV];
  delete process.env[STREAM_ENV_KEY];
  rmSync(root, { recursive: true, force: true });
});

/** Main route resolved against one specific capture server (one provider only). */
function envForMainRoute(
  model: string,
  capture: Capture,
  fallback: readonly string[] = []
): IknowEnv {
  const settings = {
    llm: {
      model,
      fallback: [...fallback],
      providers: [
        {
          id: "main",
          baseUrl: `${capture.origin}/v1`,
          apiKeyEnv: MAIN_KEY_ENV,
          models: MAIN_MODELS,
        },
      ],
    },
  } as unknown as IknowSettings;
  return loadIknowEnv(root, settings);
}

/** Main route on its own capture server, optional separate sub-agent route. */
async function loadRouteEnv(opts: {
  readonly mainModel: string;
  readonly mainAnswer?:
    | { readonly kind: "ok" }
    | { readonly kind: "reject"; readonly body: unknown };
  readonly subagentModel?: string;
}): Promise<{
  readonly env: IknowEnv;
  readonly mainCapture: Capture;
  readonly subCapture: Capture;
}> {
  const mainCapture = await track(
    await startCapture(opts.mainAnswer ?? { kind: "ok" })
  );
  const subCapture = await track(await startCapture());
  const settings = {
    llm: {
      model: opts.mainModel,
      providers: [
        {
          id: "main",
          baseUrl: `${mainCapture.origin}/v1`,
          apiKeyEnv: MAIN_KEY_ENV,
          models: MAIN_MODELS,
        },
        {
          id: "sub",
          baseUrl: `${subCapture.origin}/v1`,
          apiKeyEnv: SUB_KEY_ENV,
          models: SUB_MODELS,
        },
      ],
    },
    ...(opts.subagentModel === undefined
      ? {}
      : { subagent: { model: opts.subagentModel } }),
  } as unknown as IknowSettings;
  return { env: loadIknowEnv(root, settings), mainCapture, subCapture };
}

function sentMaxTokens(body: Record<string, unknown> | undefined): unknown {
  return body?.["max_tokens"];
}

/** Drive one real adapter request (empty history is a valid request body). */
async function stepOnce(adapter: LoopAdapter): Promise<void> {
  await adapter.step(
    { messages: [], turnCount: 0 } as Parameters<LoopAdapter["step"]>[0],
    {}
  );
}

/** The worker never returns its deps handles, so assemble and read `adapter`. */
async function workerAdapter(env: IknowEnv): Promise<LoopAdapter> {
  const opts: CreateWorkerDepsOptions = {
    env,
    sandboxRoot: root,
    cwd: root,
    userHome: root,
    skillCatalog: createSkillCatalog([]),
    system: async () => undefined,
    trace: createNoopTraceService(),
  };
  const deps = await createWorkerDeps(opts);
  return deps.adapter;
}

describe("main-session requests carry the effective route's budget", () => {
  it("SC1: 条目 maxTokens 72000 → 请求 max_tokens = 72000", async () => {
    const { env, mainCapture } = await loadRouteEnv({ mainModel: "main/opus" });
    await stepOnce(createAdapterFromEnv(env).adapter);
    assert.equal(mainCapture.bodies.length, 1);
    assert.equal(sentMaxTokens(mainCapture.bodies[0]), 72_000);
  });

  it("SC2: 条目省略 maxTokens → 请求 max_tokens = 32000 fallback", async () => {
    const { env, mainCapture } = await loadRouteEnv({
      mainModel: "main/quiet",
    });
    await stepOnce(createAdapterFromEnv(env).adapter);
    assert.equal(
      sentMaxTokens(mainCapture.bodies[0]),
      DEFAULT_MAX_OUTPUT_TOKENS
    );
    assert.equal(sentMaxTokens(mainCapture.bodies[0]), 32_000);
  });

  it("SC3: 换选中模型 → 下一次请求经再次解析取新条目值，不保留上一个帽", async () => {
    const capture = await track(await startCapture());
    await stepOnce(
      createAdapterFromEnv(envForMainRoute("main/opus", capture)).adapter
    );
    assert.equal(sentMaxTokens(capture.bodies[0]), 72_000);

    // the same seam a model switch / config reload goes through: re-resolve,
    // then rebuild the adapter
    await stepOnce(
      createAdapterFromEnv(envForMainRoute("main/MiniMax-M3", capture)).adapter
    );
    assert.equal(capture.bodies.length, 2);
    assert.equal(sentMaxTokens(capture.bodies[1]), 131_072);
    assert.notEqual(sentMaxTokens(capture.bodies[1]), 72_000);
  });

  it("SC3: 生效模型换成配置的 fallback 条目 → 该条目自身的值（省略则 32000）", async () => {
    const capture = await track(await startCapture());
    await stepOnce(
      createAdapterFromEnv(envForMainRoute("main/opus", capture)).adapter
    );
    // the entry that the configured fallback list names is now the effective one
    await stepOnce(
      createAdapterFromEnv(
        envForMainRoute("main/quiet", capture, ["main/quiet"])
      ).adapter
    );
    assert.equal(capture.bodies.length, 2);
    assert.equal(sentMaxTokens(capture.bodies[1]), 32_000);
  });

  it("thinking 覆盖路径沿用生效路由的预算（同一装配工厂，无第二张字段表）", async () => {
    const { env, mainCapture } = await loadRouteEnv({
      mainModel: "main/MiniMax-M3",
    });
    const base: LoopEngineDeps = {
      adapter: {
        step: async () => {
          throw new Error("base adapter must not be called");
        },
        encodeUserText: () => ({ role: "user", content: [] }),
        encodeToolResults: () => [],
      },
      executor: {} as LoopEngineDeps["executor"],
      registry: {} as LoopEngineDeps["registry"],
    };
    const overridden = withThinkingOverride({
      deps: base,
      override: { mode: "adaptive", effort: "high" },
      env,
    });
    await stepOnce(overridden.adapter);
    assert.equal(sentMaxTokens(mainCapture.bodies[0]), 131_072);
    assert.ok(
      JSON.stringify(mainCapture.bodies[0]).includes("adaptive"),
      "the thinking override itself still reaches the request"
    );
  });
});

describe("no clamping in the generic harness (SC15 / SC16)", () => {
  it("SC15: M3 配置 131072 → 原样发送", async () => {
    const { env, mainCapture } = await loadRouteEnv({
      mainModel: "main/MiniMax-M3",
    });
    await stepOnce(createAdapterFromEnv(env).adapter);
    assert.equal(sentMaxTokens(mainCapture.bodies[0]), 131_072);
  });

  it("SC15: 高于文档上限的正安全整数也原样发送", async () => {
    const { env, mainCapture } = await loadRouteEnv({
      mainModel: "main/m3-over",
    });
    await stepOnce(createAdapterFromEnv(env).adapter);
    assert.equal(sentMaxTokens(mainCapture.bodies[0]), 524_289);
  });

  it("SC16: supplier 拒绝该值 → 原 provider/API error 上抛，单次请求，不记成功", async () => {
    const supplierMessage =
      "max_tokens: 524289 > 524288, which is the maximum allowed number of output tokens";
    const { env, mainCapture } = await loadRouteEnv({
      mainModel: "main/m3-over",
      mainAnswer: {
        kind: "reject",
        body: {
          type: "error",
          error: { type: "invalid_request_error", message: supplierMessage },
        },
      },
    });
    const { adapter } = createAdapterFromEnv(env);

    await assert.rejects(
      () => stepOnce(adapter),
      (err: unknown) => {
        assert.ok(err instanceof APIError, `expected APIError, got ${err}`);
        assert.equal(err.status, 400);
        // the supplier's own rejection travels on the error, not a rewrite
        assert.equal(
          (err.error as { error?: { message?: string } })?.error?.message,
          supplierMessage
        );
        assert.match(err.message, /max_tokens/);
        return true;
      }
    );
    // terminal for this call: exactly one request out, nothing retried as success
    assert.equal(mainCapture.bodies.length, 1);
    assert.equal(sentMaxTokens(mainCapture.bodies[0]), 524_289);
  });
});

describe("separately routed sub-agent requests (SC12 / SC18)", () => {
  it("SC12: subagent 条目 64000 → 子请求 max_tokens = 64000，主路由 72000 不参与", async () => {
    const { env, mainCapture, subCapture } = await loadRouteEnv({
      mainModel: "main/opus",
      subagentModel: "sub/sub-model",
    });
    await stepOnce(await workerAdapter(env));

    assert.equal(subCapture.bodies.length, 1);
    assert.equal(sentMaxTokens(subCapture.bodies[0]), 64_000);
    // the worker's client came from the sub-agent provider triple
    assert.equal(mainCapture.bodies.length, 0);
    assert.equal(
      (subCapture.bodies[0] as { model?: string }).model,
      "sub-model"
    );
  });

  it("SC12: subagent 条目省略 maxTokens → 子请求落 32000，而非主路由的 72000", async () => {
    const { env, subCapture } = await loadRouteEnv({
      mainModel: "main/opus",
      subagentModel: "sub/sub-quiet",
    });
    await stepOnce(await workerAdapter(env));
    assert.equal(
      sentMaxTokens(subCapture.bodies[0]),
      DEFAULT_MAX_OUTPUT_TOKENS
    );
  });

  it("无 subagent 路由 → worker 用主路由条目预算，主条目省略时落 32000", async () => {
    const routed = await loadRouteEnv({ mainModel: "main/opus" });
    await stepOnce(await workerAdapter(routed.env));
    assert.equal(routed.subCapture.bodies.length, 0);
    assert.equal(sentMaxTokens(routed.mainCapture.bodies[0]), 72_000);

    const silent = await loadRouteEnv({ mainModel: "main/quiet" });
    await stepOnce(await workerAdapter(silent.env));
    assert.equal(sentMaxTokens(silent.mainCapture.bodies[0]), 32_000);
  });

  it("SC18: 两条路由同时配置不同值 → 并发各自发送自身值，互不继承", async () => {
    const { env, mainCapture, subCapture } = await loadRouteEnv({
      mainModel: "main/opus",
      subagentModel: "sub/sub-model",
    });
    const mainAdapter = createAdapterFromEnv(env).adapter;
    const worker = await workerAdapter(env);

    await Promise.all([stepOnce(mainAdapter), stepOnce(worker)]);

    assert.equal(sentMaxTokens(mainCapture.bodies[0]), 72_000);
    assert.equal(sentMaxTokens(subCapture.bodies[0]), 64_000);
    assert.equal(mainCapture.bodies.length, 1);
    assert.equal(subCapture.bodies.length, 1);
  });

  it("SC18: 一侧缺值 → 该侧 32000，另一侧仍是自身配置值", async () => {
    const { env, mainCapture, subCapture } = await loadRouteEnv({
      mainModel: "main/MiniMax-M3",
      subagentModel: "sub/sub-quiet",
    });
    const mainAdapter = createAdapterFromEnv(env).adapter;
    const worker = await workerAdapter(env);

    await Promise.all([stepOnce(mainAdapter), stepOnce(worker)]);

    assert.equal(sentMaxTokens(mainCapture.bodies[0]), 131_072);
    assert.equal(sentMaxTokens(subCapture.bodies[0]), 32_000);
  });
});

describe("retired global snapshot field no longer assembles requests", () => {
  /** Hand-written env literal — the shape tests and scripts write. */
  function makeEnvLiteral(opts: {
    readonly baseUrl: string;
    readonly maxOutputTokens: number;
    readonly routeMaxTokens?: number;
  }): IknowEnv {
    return {
      llm: {
        apiKey: "test-key",
        baseUrl: opts.baseUrl,
        model: "main/opus",
        fallback: [],
        maxOutputTokens: opts.maxOutputTokens,
        ...(opts.routeMaxTokens === undefined
          ? {}
          : { routeMaxTokens: opts.routeMaxTokens }),
        timeoutMs: 2_000,
        temperature: 0,
        thinking: "off",
        thinkingEffort: "",
        stream: "on",
      },
      chat: { showThinking: false },
      web: { searchUrl: undefined, proxy: undefined },
      compress: { contextWindow: 200_000, thresholdTokens: undefined },
      mcp: { connectTimeoutMs: 60_000 },
      subagent: { taskTimeoutMs: undefined },
      workspaceRoot: undefined,
      productRoot: undefined,
    };
  }

  it("旧字段值 64 不上 wire：无路由预算 → 32000", async () => {
    const capture = await track(await startCapture());
    const env = makeEnvLiteral({
      baseUrl: `${capture.origin}/v1`,
      maxOutputTokens: 64,
    });
    await stepOnce(createAdapterFromEnv(env).adapter);
    assert.equal(sentMaxTokens(capture.bodies[0]), 32_000);
  });

  it("路由预算在场时以它为准，旧字段完全忽略", async () => {
    const capture = await track(await startCapture());
    const env = makeEnvLiteral({
      baseUrl: `${capture.origin}/v1`,
      maxOutputTokens: 64,
      routeMaxTokens: 72_000,
    });
    await stepOnce(createAdapterFromEnv(env).adapter);
    assert.equal(sentMaxTokens(capture.bodies[0]), 72_000);
  });
});
