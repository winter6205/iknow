/**
 * SessionHub env-source seam + adapter hot rebuild (settings hot-reload).
 *
 * Coverage (≥5 cases):
 *  1. With envProvider injected, ensureDeps builds from its return value
 *     (never falls back to loadIknowEnv) — observed on the wire: a NEW
 *     conversation's request carries the provider model.
 *  2. After reloadFromEnv, a live conversation keeps its OWN route; only a
 *     NEW conversation follows the new default (ADR-0145). registry /
 *     executor / maxTurns references stay stable (not rebuilt).
 *  3. onEnvChange fires once on env change (repeat reloads with the same
 *     value do not refire).
 *  4. Omitting envProvider keeps behavior identical (backward compat;
 *     existing fixture regression).
 *  5. reload throws (model missing) → cachedDeps untouched, no crash; the
 *     next turn still goes out with the model the conversation already had.
 *
 * ADR-0145 的两种 env 形态（本文件按用例选用）：
 *  - 路由形态 `p/model-1`：会话创建时快照当前默认，之后只走自己的路由；
 *    turn 走 `routeTurnDeps` 的路由 adapter，wire model = 路由尾段
 *    （`model-1`，见 `wireModelFromRoute`），transport 来自 env 携带的
 *    provider 注册表（`LlmEnv.providers`）。
 *  - 裸 model（`model-a`，不带 `/`）：会话没有路由 → turn 走 base deps 的
 *    adapter，即凭据 / 限额热生效那条路径（invariant 7）。凭据降级那两条
 *    用例走的就是这条路径：路由解析要先拿到 tier，tier 坏掉时 turn 根本
 *    发不出去，谈不上"wire 仍带旧模型"。
 *
 * Discipline:
 *  - isolated tmp store (mkdtemp + afterAll rm);
 *  - capture-server cases closed explicitly (no port leaks);
 *  - 合成 provider key：api key 只从本文件自有的环境变量名读，值是占位串；
 *  - vitest (consistent with the rest of tests/session-api).
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.js";
import { SessionStore } from "../../src/session-api/store/index.js";
import type { LoopEngineDeps, LoopAdapter } from "../../src/harness/index.js";
import type { IknowEnv } from "../../src/config/env.js";
import { LLM_MODEL_MISSING_MESSAGE } from "../../src/config/messages.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { makeDeps, assistantResult } from "../cli/_fixtures.ts";
import {
  MINIMAL_SDK_MESSAGE,
  makeTestLlmEnv,
  startLlmCapture,
} from "./_helpers/llm-capture.ts";
import {
  MINIMAL_MESSAGE_RESPONSE,
  startHttpCapture,
} from "../_helpers/http-capture.ts";

// -- helpers -----------------------------------------------------------------

let baseDir: string;
let store: SessionStore;

/** 合成 provider id：本文件的路由都是 `p/<model>` 形态。 */
const PROVIDER_ID = "p";
/** 合成 provider 的 api-key 环境变量名（值是占位串，不指向任何真实服务）。 */
const PROVIDER_KEY_ENV = "IKNOW_TEST_HUB_HOT_RELOAD_KEY";
/**
 * provider 注册表里登记的 wire model 尾段。路由解析（`resolveLlmEnvForRoute`）
 * 按路由尾段找 provider 的 models[] 条目：命中才有该路由自己的输出预算，
 * 没命中就退回 32,000（非流式请求会被 SDK 拒），所以本文件用到的每个路由
 * 尾段都要登记。
 */
const PROVIDER_MODEL_IDS: readonly string[] = [
  "model-1",
  "model-2",
  "provider-model",
  "baseurl-test",
  "temp-test",
  "headers-test",
  "snapshot-model",
  "switched-model",
];

beforeAll(() => {
  // provider 的 api key 只从 process.env 读（`resolveProviderApiKey`）。
  process.env[PROVIDER_KEY_ENV] = "test-key";
});

afterAll(async () => {
  rmSync(baseDir, { recursive: true, force: true });
  delete process.env[PROVIDER_KEY_ENV];
});

function makeStore(): SessionStore {
  if (!baseDir) {
    baseDir = mkdtempSync(join(tmpdir(), "iknow-hub-hot-reload-"));
    store = new SessionStore(baseDir, process.cwd());
  }
  return store;
}

/**
 * Build a full IknowEnv (all fields; the isolated tmp home cannot read real settings).
 *
 * `model` 默认是路由形态（`p/model-1`）：ADR-0145 之后会话创建时快照当前
 * 默认，之后只走自己的路由，wire model = 路由尾段。
 *
 * `providers` 是路由的解析依据：provider 的 baseUrl 决定路由 transport 的
 * 落点，apiKey 从 `PROVIDER_KEY_ENV` 读，models[] 给出该路由的输出预算。
 * provider 的 headers 与 tier 的 headers 同源（生产里 headers 就是 provider
 * 带出来的），路由解析出来的 env 用 provider 的那份。
 */
function makeFullEnv(overrides: {
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly stream?: "on" | "off";
  readonly maxOutputTokens?: number;
  readonly routeMaxTokens?: number;
  readonly temperature?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** provider 注册表的 baseUrl（路由 transport 的落点）；默认跟 baseUrl 走。 */
  readonly providerBaseUrl?: string;
}): IknowEnv {
  const baseUrl = overrides.baseUrl ?? "http://invalid";
  return {
    llm: {
      baseUrl,
      model: overrides.model ?? "p/model-1",
      // headers absent ⇔ key not emitted (same shape as production env's "key present only when set").
      ...(overrides.headers !== undefined
        ? { headers: overrides.headers }
        : {}),
      fallback: [],
      // apiKey defaults to "test-key"; undefined passes through only when
      // explicitly given (to test the apiKey-resolution downgrade path).
      // `in` detects "key explicitly passed", so it is not confused with
      // "key omitted → default".
      apiKey: "apiKey" in overrides ? overrides.apiKey : "test-key",
      maxOutputTokens: overrides.maxOutputTokens ?? 128,
      routeMaxTokens: overrides.routeMaxTokens ?? 128,
      timeoutMs: 5000,
      temperature: overrides.temperature ?? 0,
      thinking: "off",
      thinkingEffort: "",
      // Default off (non-streaming arm) → the capture-server's single JSON
      // response explains it; "on" uses client.messages.stream and requires
      // an SSE stream the capture server cannot satisfy.
      stream: overrides.stream ?? "off",
      maxTurns: undefined,
      // ADR-0145：路由形态的 model 由这份 provider 注册表解析。
      providers: [
        {
          id: PROVIDER_ID,
          baseUrl: overrides.providerBaseUrl ?? baseUrl,
          apiKeyEnv: PROVIDER_KEY_ENV,
          models: PROVIDER_MODEL_IDS.map((id) => ({ id, maxTokens: 128 })),
          ...(overrides.headers !== undefined
            ? { headers: overrides.headers }
            : {}),
        },
      ],
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

/** Minimal adapter (step never called; only pins "reference replacement" semantics). */
const stubAdapter: LoopAdapter = {
  step: async () => {
    throw new Error("not invoked");
  },
  encodeUserText: (text: string) => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
  encodeToolResults: () => [],
};

function baseDeps(): LoopEngineDeps {
  return {
    adapter: stubAdapter,
    executor: makeDeps([]).executor,
    registry: makeDeps([]).registry,
    maxTurns: 7,
    timeoutMs: 4321,
  };
}

async function createSessionId(hub: SessionHub): Promise<string> {
  await hub.bindWorkspace(process.cwd());
  return (await hub.createSession()).session.conversation_id;
}

// -- tests -------------------------------------------------------------------

describe("SessionHub envProvider + reloadFromEnv（T3）", () => {
  test("envProvider 注入后被 hub 使用（新会话的 wire model 来自 provider 路由）", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const store0 = makeStore();
    let providerEnv: IknowEnv | undefined;
    const envProvider = () => {
      providerEnv = makeFullEnv({
        model: "p/provider-model",
        baseUrl: cap.origin,
      });
      return providerEnv;
    };
    // Inject stub deps (same discipline as other tests in this directory:
    // do not run the real buildHarnessEngine, keeping the real home
    // unpolluted). envProvider's only consumer surface is reloadFromEnv
    // (not ensureDeps' buildHarnessEngine).
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    try {
      await hub.reloadFromEnv();
      expect(providerEnv).toBeDefined();
      expect(providerEnv!.llm.model).toBe("p/provider-model");
      // base adapter 由 envProvider 的 env 重建（AnthropicAdapter 形态）。
      const deps = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(typeof deps.adapter.step).toBe("function");
      // ADR-0145：新会话快照当前默认 → 拥有 `p/provider-model` 路由；
      // wire model = 路由尾段（provider 前缀不上线）。
      const id = await createSessionId(hub);
      await hub.postMessage({ conversationId: id, text: "hi" });
      expect(cap.bodies.length).toBe(1);
      expect((cap.bodies[0] as { model?: string }).model).toBe(
        "provider-model"
      );
    } finally {
      await cap.close();
    }
  });

  test("reloadFromEnv 后已有会话保留自己的路由、新会话跟随新默认；registry/executor/maxTurns 引用保持稳定", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const store0 = makeStore();
    let currentModel = "p/model-1";
    const envProvider = () =>
      makeFullEnv({
        model: currentModel,
        apiKey: "test-key",
        baseUrl: cap.origin,
      });
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    try {
      const depsBefore = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      const executorBefore = depsBefore.executor;
      const registryBefore = depsBefore.registry;
      const maxTurnsBefore = depsBefore.maxTurns;

      // 会话 A 在默认还是 p/model-1 时创建 → 快照自己的路由。
      const idA = await createSessionId(hub);
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: idA, text: "a1" });
      expect((cap.bodies[0] as { model?: string }).model).toBe("model-1");

      // 改默认 → reloadFromEnv：A 的路由不动，新会话用新默认。
      currentModel = "p/model-2";
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: idA, text: "a2" });
      expect((cap.bodies[1] as { model?: string }).model).toBe("model-1");

      const idB = await createSessionId(hub);
      await hub.postMessage({ conversationId: idB, text: "b1" });
      expect((cap.bodies[2] as { model?: string }).model).toBe("model-2");

      // base deps 只换 adapter，registry / executor / maxTurns 引用不动。
      const depsAfter = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(depsAfter.executor).toBe(executorBefore);
      expect(depsAfter.registry).toBe(registryBefore);
      expect(depsAfter.maxTurns).toBe(maxTurnsBefore);
      expect(depsAfter.timeoutMs).toBe(4321);
    } finally {
      await cap.close();
    }
  });

  test("reloadFromEnv 后同一会话的下一条消息仍走自己的路由（wire model 不变）", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const store0 = makeStore();
    let currentModel = "p/model-1";
    const envProvider = () =>
      makeFullEnv({
        model: currentModel,
        apiKey: "test-key",
        baseUrl: cap.origin,
      });
    // Inject stub deps (isolate the real home). The postMessage uses the
    // route overlay (the conversation owns its route), so the request goes to
    // the capture server the env's provider registry points at.
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    try {
      const id = await createSessionId(hub);
      // reloadFromEnv (p/model-1) → 路由 adapter 指向 capture server。
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "hi" });
      expect(cap.bodies.length).toBe(1);
      expect((cap.bodies[0] as { model?: string }).model).toBe("model-1");

      // 改默认 → reloadFromEnv：会话的路由不动，下一条消息仍是 model-1。
      currentModel = "p/model-2";
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "hi again" });
      expect(cap.bodies.length).toBe(2);
      const models = cap.bodies.map((b) => (b as { model?: string }).model);
      expect(models[0]).toBe("model-1");
      expect(models[1]).toBe("model-1");
    } finally {
      await cap.close();
    }
  });

  test("reloadFromEnv 后新建会话的 wire model 跟随新默认", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const store0 = makeStore();
    let currentModel = "p/model-1";
    const envProvider = () =>
      makeFullEnv({
        model: currentModel,
        apiKey: "test-key",
        baseUrl: cap.origin,
      });
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    try {
      await hub.reloadFromEnv();
      // 默认改到 p/model-2 之后创建的会话 → 起点就是新默认。
      currentModel = "p/model-2";
      await hub.reloadFromEnv();
      const id = await createSessionId(hub);
      await hub.postMessage({ conversationId: id, text: "hi" });
      expect(cap.bodies.length).toBe(1);
      expect((cap.bodies[0] as { model?: string }).model).toBe("model-2");
    } finally {
      await cap.close();
    }
  });

  test("onEnvChange 在 env 变化时触发一次；连续 reload 同值不重复触发", async () => {
    const store0 = makeStore();
    let currentModel = "p/model-a";
    const envProvider = () => makeFullEnv({ model: currentModel });
    const changes: string[] = [];
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
      onEnvChange: (env) => changes.push(env.llm.model),
    });
    try {
      // First ensureDeps does not fire (no "change" yet).
      await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(changes.length).toBe(0);

      // env changes → reloadFromEnv → fires once.
      currentModel = "p/model-b";
      await hub.reloadFromEnv();
      expect(changes.length).toBe(1);
      expect(changes[0]).toBe("p/model-b");

      // Same-value reload → no refire (touching the settings file without
      // changing content → no adapter rebuild, no onEnvChange).
      // EnvLoader.get() returns a new object every call, so dedup relies on
      // comparing key field values — see sameHotReloadKeyFields in hub.ts.
      await hub.reloadFromEnv();
      expect(changes.length).toBe(1);
      expect(changes[0]).toBe("p/model-b");

      // Value genuinely changed → fires once more.
      currentModel = "p/model-c";
      await hub.reloadFromEnv();
      expect(changes.length).toBe(2);
      expect(changes[1]).toBe("p/model-c");
    } finally {
      // no-op
    }
  });

  test("不传 envProvider 行为零变化（既有 fixture 回归）", async () => {
    const store0 = makeStore();
    // ADR-0145：ambient 默认的 model 是路由形态时，会话会拥有自己的路由 →
    // 路由 overlay 接管 adapter，注入的 fixture 就不再被使用。本用例钉住
    // ambient 默认（HOME 指向空目录 → 没有 model → 没有路由），回归点不变：
    // 注入的 fixture 仍然生效。
    const prevHome = process.env.HOME;
    const emptyHome = mkdtempSync(join(tmpdir(), "iknow-hub-hot-reload-home-"));
    process.env.HOME = emptyHome;
    const hub = new SessionHub({
      store: store0,
      deps: makeDeps([assistantResult({ texts: ["cached reply"] })]),
    });
    try {
      const id = await createSessionId(hub);
      const res = await hub.postMessage({ conversationId: id, text: "q" });
      expect(res.turn.answer.finalText).toBe("cached reply");
      // reloadFromEnv without envProvider → no-op (no throw).
      await hub.reloadFromEnv();
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  test("reload 抛错（model 缺失）→ cachedDeps 不动，process 不崩；下一条消息仍带旧模型", async () => {
    const cap = await startHttpCapture(MINIMAL_MESSAGE_RESPONSE);
    const store0 = makeStore();
    // 裸 model → 会话没有路由 → turn 走 base deps 的 adapter（凭据路径）。
    let currentModel = "model-a";
    const envProvider = () =>
      makeFullEnv({
        model: currentModel,
        apiKey: "test-key",
        baseUrl: cap.origin,
      });
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    try {
      // 先成功 reload 一次：base adapter 指向 capture server。
      await hub.reloadFromEnv();
      const id = await createSessionId(hub);
      await hub.postMessage({ conversationId: id, text: "before" });
      expect(cap.bodies.length).toBe(1);
      expect((cap.bodies[0] as { model?: string }).model).toBe("model-a");

      // Simulate reload throwing: envProvider throws (bad JSON / missing model take the same path).
      (hub as unknown as { envProvider: () => IknowEnv }).envProvider = () => {
        // The exact error `loadIknowEnv` throws when `settings.llm.model` is
        // absent. The hub's default-route read absorbs THIS failure (a hub
        // that cannot name a default tier) and rethrows every other one, so
        // the turn below still runs on the base adapter.
        throw new Error(LLM_MODEL_MISSING_MESSAGE);
      };
      await assert.rejects(
        () => hub.reloadFromEnv(),
        /no LLM model configured/
      );

      // cachedDeps untouched → 下一条消息仍然带着旧模型上线。
      await hub.postMessage({ conversationId: id, text: "after" });
      expect(cap.bodies.length).toBe(2);
      expect((cap.bodies[1] as { model?: string }).model).toBe("model-a");
    } finally {
      await cap.close();
    }
  });

  test("apiKey 解析失败（undefined）→ reloadFromEnv 抛错 + 旧 env 降级保留（wire 仍带旧 key）；修好后 wire 带修好的 key", async () => {
    const cap = await startHttpCapture(MINIMAL_MESSAGE_RESPONSE);
    const store0 = makeStore();
    // 裸 model → 会话没有路由 → turn 走 base deps 的 adapter（凭据路径）。
    let currentModel = "model-a";
    let apiKey: string | undefined = "old-key";
    const envProvider = () =>
      makeFullEnv({ model: currentModel, apiKey, baseUrl: cap.origin });
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    try {
      // 先成功 reload 一次：base adapter 带旧 key 指向 capture server。
      await hub.reloadFromEnv();
      const id = await createSessionId(hub);
      await hub.postMessage({ conversationId: id, text: "before" });
      expect(cap.bodies.length).toBe(1);
      expect((cap.bodies[0] as { model?: string }).model).toBe("model-a");
      expect(cap.headers[0]!["x-api-key"]).toBe("old-key");

      // settings `${VAR}` fails to resolve → loadIknowEnv returns apiKey=undefined (no throw);
      // reloadFromEnv must throw ValidationError here while cachedDeps keeps the old adapter.
      apiKey = undefined;
      await assert.rejects(() => hub.reloadFromEnv(), /LLM mode needs API key/);

      // 降级保留：cachedDeps 仍是旧 adapter → 下一条消息仍带旧模型 / 旧 key。
      await hub.postMessage({ conversationId: id, text: "degraded" });
      expect(cap.bodies.length).toBe(2);
      expect((cap.bodies[1] as { model?: string }).model).toBe("model-a");
      expect(cap.headers[1]!["x-api-key"]).toBe("old-key");

      // Fix apiKey → reloadFromEnv resumes rebuilding → wire 带修好的 key。
      apiKey = "new-key";
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "fixed" });
      expect(cap.bodies.length).toBe(3);
      expect((cap.bodies[2] as { model?: string }).model).toBe("model-a");
      expect(cap.headers[2]!["x-api-key"]).toBe("new-key");
    } finally {
      await cap.close();
    }
  });

  test("只改 baseUrl → 触发 adapter 重建（新 adapter 指向新 origin）", async () => {
    // Two capture servers: after reload switches baseUrl, the next postMessage hits cap2.
    const cap1 = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const cap2 = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const store0 = makeStore();
    let currentBaseUrl = cap1.origin;
    const envProvider = () =>
      makeFullEnv({
        model: "p/baseurl-test",
        apiKey: "test-key",
        baseUrl: currentBaseUrl,
      });
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    try {
      const id = await createSessionId(hub);
      // First reload → adapter points at cap1.
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "first" });
      expect(cap1.bodies.length).toBe(1);
      expect(cap2.bodies.length).toBe(0);

      // Change only baseUrl → reloadFromEnv → adapter rebuilt pointing at cap2.
      currentBaseUrl = cap2.origin;
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "second" });
      expect(cap1.bodies.length).toBe(1); // cap1 no longer hit
      expect(cap2.bodies.length).toBe(1); // new adapter hits cap2
      expect((cap2.bodies[0] as { model?: string }).model).toBe("baseurl-test");
    } finally {
      await cap1.close();
      await cap2.close();
    }
  });

  test("只改 temperature → 触发 adapter 重建（wire temperature 字段变化）", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const store0 = makeStore();
    let currentTemperature = 0;
    const envProvider = () =>
      makeFullEnv({
        model: "p/temp-test",
        apiKey: "test-key",
        baseUrl: cap.origin,
        temperature: currentTemperature,
      });
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    try {
      const id = await createSessionId(hub);
      // First reload (temperature=0) → adapter rebuilt.
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "cold" });
      expect(cap.bodies.length).toBe(1);
      expect((cap.bodies[0] as { temperature?: number }).temperature).toBe(0);

      // Change only temperature → reloadFromEnv → adapter rebuilt, wire temperature changes.
      currentTemperature = 0.7;
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "warm" });
      expect(cap.bodies.length).toBe(2);
      expect((cap.bodies[1] as { temperature?: number }).temperature).toBe(0.7);
    } finally {
      await cap.close();
    }
  });
});

// -- env freshness on the thinking-override path + headers hot-reload comparison --

// Observation strategy (why these choices):
//   - The override side is observed on the **wire**: withThinkingOverride
//     never hands the client back to the caller, and baseUrl/model are the
//     only two observable surfaces; the capture server records exactly
//     "where the SDK actually sent the request, with what model" — blacker
//     box than stubs/spies, and it also proves the request really went out.
//   - The headers side must stay on the **real adapter's construction
//     surface**: the SDK freezes defaultHeaders in client._options; headers
//     are visible on the wire too, but a "headers-only change" assertion
//     must first prove the client is newly constructed (an existing client
//     never changes its headers), so grab the client reference and compare.
//     Both references are readable from hub's cachedDeps — no new seam needed.
describe("hub override 路径取最新 env（SC10）+ headers 热重载（SC9）", () => {
  test("thinking override 路径用 envProvider 的最新 env（新 baseUrl），model 走会话自己的路由", async () => {
    const capOld = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capNew = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const store0 = makeStore();
    // Construction-time snapshot = capOld; envProvider (production TUI's EnvLoader.get) returns the new env.
    const initial = makeFullEnv({
      model: "p/snapshot-model",
      apiKey: "test-key",
      baseUrl: capOld.origin,
    });
    let latest = makeFullEnv({
      model: "p/snapshot-model",
      apiKey: "test-key",
      baseUrl: capOld.origin,
    });
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      deps: baseDeps(),
      overrideEnv: { llm: initial.llm },
      envProvider: () => latest,
    });
    try {
      const id = await createSessionId(hub);
      // State after a /model switch: envProvider returns the new provider's baseUrl + model.
      latest = makeFullEnv({
        model: "p/switched-model",
        apiKey: "test-key",
        baseUrl: capNew.origin,
      });
      await hub.postMessage({
        conversationId: id,
        text: "think hard",
        thinking: { mode: "adaptive", effort: "high" },
      });
      // The override branch must not read a construction-time snapshot env
      // (that bug would send this request to capOld).
      expect(capOld.bodies.length).toBe(0);
      expect(capNew.bodies.length).toBe(1);
      // ADR-0145：会话拥有自己的路由 → wire model 是路由尾段，不是当前默认的 model。
      expect((capNew.bodies[0] as { model?: string }).model).toBe(
        "snapshot-model"
      );
    } finally {
      await capOld.close();
      await capNew.close();
    }
  });

  test("只传 overrideEnv（无 envProvider）时 override 路径仍用该快照（测试缝语义不变）", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const store0 = makeStore();
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      deps: baseDeps(),
      overrideEnv: makeTestLlmEnv({ baseUrl: cap.origin }),
    });
    try {
      const id = await createSessionId(hub);
      await hub.postMessage({
        conversationId: id,
        text: "think hard",
        thinking: { mode: "off" },
      });
      expect(cap.bodies.length).toBe(1);
    } finally {
      await cap.close();
    }
  });

  test("仅 headers 变化 → reloadFromEnv 重建 adapter；headers 相同 → 不重建", async () => {
    const cap = await startHttpCapture(MINIMAL_MESSAGE_RESPONSE);
    const store0 = makeStore();
    let currentHeaders: Readonly<Record<string, string>> | undefined = {
      "X-Foo": "bar",
    };
    const envProvider = () =>
      makeFullEnv({
        model: "p/headers-test",
        apiKey: "test-key",
        baseUrl: cap.origin,
        headers: currentHeaders,
      });
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    // The adapter reference observes "was it rebuilt"; request headers on
    // the wire black-box that headers truly pass through (one client never
    // changes its headers, so a header-value change ⟺ a new client).
    const readAdapter = async () => {
      const deps = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      return deps.adapter;
    };
    try {
      const id = await createSessionId(hub);
      // First reload (headers present) → adapter rebuilt.
      await hub.reloadFromEnv();
      const adapterA = await readAdapter();
      expect(adapterA).not.toBe(stubAdapter);

      // Same value (new object, key-for-key equal) → judged "content unchanged" → no rebuild, adapter reference unchanged.
      currentHeaders = { "X-Foo": "bar" };
      await hub.reloadFromEnv();
      const adapterB = await readAdapter();
      expect(adapterB).toBe(adapterA);

      // Headers-only change → the key-field comparison must notice → adapter rebuilt; the wire carries the new header.
      currentHeaders = { "X-Foo": "baz" };
      await hub.reloadFromEnv();
      const adapterC = await readAdapter();
      expect(adapterC).not.toBe(adapterB);
      await hub.postMessage({ conversationId: id, text: "h1" });
      expect(cap.headers.length).toBe(1);
      expect(cap.headers[0]!["x-foo"]).toBe("baz");

      // Headers disappearing entirely (provider switching to a headers-less
      // tier) also counts as a change → rebuild again, and the wire no
      // longer carries the header.
      currentHeaders = undefined;
      await hub.reloadFromEnv();
      const adapterE = await readAdapter();
      expect(adapterE).not.toBe(adapterC);
      await hub.postMessage({ conversationId: id, text: "h2" });
      expect(cap.headers.length).toBe(2);
      expect("x-foo" in cap.headers[1]!).toBe(false);
    } finally {
      await cap.close();
    }
  });
});
