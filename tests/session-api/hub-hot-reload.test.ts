/**
 * SessionHub env-source seam + adapter hot rebuild (settings hot-reload).
 *
 * Coverage (≥5 cases):
 *  1. With envProvider injected, ensureDeps builds from its return value
 *     (never falls back to loadIknowEnv).
 *  2. After reloadFromEnv, the next postMessage gets a new adapter (hot
 *     rebuild via the minimal createAdapterFromEnv surface); registry /
 *     executor / maxTurns references stay stable (not rebuilt).
 *  3. onEnvChange fires once on env change (repeat reloads with the same
 *     value do not refire).
 *  4. Omitting envProvider keeps behavior identical (backward compat;
 *     existing fixture regression).
 *  5. reload throws (model missing) → cachedDeps untouched, no crash.
 *
 * Discipline:
 *  - isolated tmp store (mkdtemp + afterAll rm);
 *  - capture-server cases closed explicitly (no port leaks);
 *  - vitest (consistent with the rest of tests/session-api).
 */
import { afterAll, describe, expect, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.js";
import { SessionStore } from "../../src/session-api/store/index.js";
import type { LoopEngineDeps, LoopAdapter } from "../../src/harness/index.js";
import type { IknowEnv } from "../../src/config/env.js";
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

afterAll(async () => {
  rmSync(baseDir, { recursive: true, force: true });
});

function makeStore(): SessionStore {
  if (!baseDir) {
    baseDir = mkdtempSync(join(tmpdir(), "iknow-hub-hot-reload-"));
    store = new SessionStore(baseDir, process.cwd());
  }
  return store;
}

/** Build a full IknowEnv (all fields; the isolated tmp home cannot read real settings). */
function makeFullEnv(overrides: {
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly stream?: "on" | "off";
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly headers?: Readonly<Record<string, string>>;
}): IknowEnv {
  return {
    llm: {
      baseUrl: overrides.baseUrl ?? "http://invalid",
      model: overrides.model ?? "test-model",
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
      timeoutMs: 5000,
      temperature: overrides.temperature ?? 0,
      thinking: "off",
      thinkingEffort: "",
      // Default off (non-streaming arm) → the capture-server's single JSON
      // response explains it; "on" uses client.messages.stream and requires
      // an SSE stream the capture server cannot satisfy.
      stream: overrides.stream ?? "off",
      maxTurns: undefined,
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60000 },
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
  test("envProvider 注入后被 hub 使用（reloadFromEnv 用其返回值重建 adapter）", async () => {
    const store0 = makeStore();
    let providerEnv: IknowEnv | undefined;
    const envProvider = () => {
      providerEnv = makeFullEnv({ model: "provider-model" });
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
      expect(providerEnv!.llm.model).toBe("provider-model");
      // adapter replaced by the createAdapterFromEnv product (AnthropicAdapter shape).
      const deps = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(typeof deps.adapter.step).toBe("function");
      expect(deps.adapter).not.toBe(baseDeps().adapter);
    } finally {
      // No real LLM call, no close needed.
    }
  });

  test("reloadFromEnv 替换 adapter；registry/executor/maxTurns 引用保持稳定", async () => {
    const store0 = makeStore();
    let currentModel = "model-a";
    const envProvider = () =>
      makeFullEnv({
        model: currentModel,
        apiKey: "test-key",
        baseUrl: "http://invalid",
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
      const adapterBefore = depsBefore.adapter;
      const executorBefore = depsBefore.executor;
      const registryBefore = depsBefore.registry;
      const maxTurnsBefore = depsBefore.maxTurns;

      // Change model → reloadFromEnv → adapter replaced, other fields stable.
      currentModel = "model-b";
      await hub.reloadFromEnv();
      const depsAfter = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(depsAfter.adapter).not.toBe(adapterBefore);
      expect(depsAfter.executor).toBe(executorBefore);
      expect(depsAfter.registry).toBe(registryBefore);
      expect(depsAfter.maxTurns).toBe(maxTurnsBefore);
      expect(depsAfter.timeoutMs).toBe(4321);
    } finally {
      // no-op
    }
  });

  test("reloadFromEnv 后下一次 postMessage 拿到新 adapter（capture-server 验证 model）", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const store0 = makeStore();
    let currentModel = "model-1";
    const envProvider = () =>
      makeFullEnv({
        model: currentModel,
        apiKey: "test-key",
        baseUrl: cap.origin,
      });
    // Inject stub deps (isolate the real home). The first postMessage uses
    // the injected stub (offline); only after reloadFromEnv does the
    // envProvider rebuild the real adapter — exactly the minimal hot-rebuild
    // path (bypassing the full buildHarnessEngine chain).
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    try {
      const id = await createSessionId(hub);
      // reloadFromEnv (model-1) → adapter points at the capture server.
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "hi" });
      expect(cap.bodies.length).toBe(1);
      // Change model → reloadFromEnv → the next postMessage's wire model changes.
      currentModel = "model-2";
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "hi again" });
      expect(cap.bodies.length).toBe(2);
      const models = cap.bodies.map((b) => (b as { model?: string }).model);
      expect(models[0]).toBe("model-1");
      expect(models[1]).toBe("model-2");
    } finally {
      await cap.close();
    }
  });

  test("onEnvChange 在 env 变化时触发一次；连续 reload 同值不重复触发", async () => {
    const store0 = makeStore();
    let currentModel = "model-a";
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
      currentModel = "model-b";
      await hub.reloadFromEnv();
      expect(changes.length).toBe(1);
      expect(changes[0]).toBe("model-b");

      // Same-value reload → no refire (touching the settings file without
      // changing content → no adapter rebuild, no onEnvChange).
      // EnvLoader.get() returns a new object every call, so dedup relies on
      // comparing key field values — see sameHotReloadKeyFields in hub.ts.
      await hub.reloadFromEnv();
      expect(changes.length).toBe(1);
      expect(changes[0]).toBe("model-b");

      // Value genuinely changed → fires once more.
      currentModel = "model-c";
      await hub.reloadFromEnv();
      expect(changes.length).toBe(2);
      expect(changes[1]).toBe("model-c");
    } finally {
      // no-op
    }
  });

  test("不传 envProvider 行为零变化（既有 fixture 回归）", async () => {
    const store0 = makeStore();
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
      // no-op
    }
  });

  test("reload 抛错（model 缺失）→ cachedDeps 不动，process 不崩", async () => {
    const store0 = makeStore();
    let currentModel = "model-a";
    const envProvider = () => makeFullEnv({ model: currentModel });
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
      const adapterBefore = depsBefore.adapter;

      // Simulate reload throwing: envProvider throws (bad JSON / missing model take the same path).
      const originalProvider = envProvider;
      (hub as unknown as { envProvider: () => IknowEnv }).envProvider = () => {
        // Reuse the env built by the original provider but blank the model →
        // createAdapterFromEnv would still construct (Anthropic accepts an
        // empty model); to simulate the "model missing" guard, throw directly.
        throw new Error("no LLM model configured in settings.llm.model");
      };
      await assert.rejects(
        () => hub.reloadFromEnv(),
        /no LLM model configured/
      );

      // cachedDeps untouched (adapter is still the old reference).
      const depsAfter = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(depsAfter.adapter).toBe(adapterBefore);
      void originalProvider;
    } finally {
      // no-op
    }
  });

  test("apiKey 解析失败（undefined）→ reloadFromEnv 抛错 + cachedDeps 不动（降级保留旧 env）", async () => {
    const store0 = makeStore();
    let currentModel = "model-a";
    let apiKey: string | undefined = "test-key";
    const envProvider = () => makeFullEnv({ model: currentModel, apiKey });
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
      const adapterBefore = depsBefore.adapter;

      // settings `${VAR}` fails to resolve → loadIknowEnv returns apiKey=undefined (no throw);
      // reloadFromEnv must throw ValidationError here while cachedDeps keeps the old adapter.
      apiKey = undefined;
      await assert.rejects(() => hub.reloadFromEnv(), /LLM mode needs API key/);

      const depsAfter = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(depsAfter.adapter).toBe(adapterBefore);

      // Fix apiKey → reloadFromEnv resumes rebuilding.
      apiKey = "test-key";
      await hub.reloadFromEnv();
      const depsFixed = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(depsFixed.adapter).not.toBe(adapterBefore);
    } finally {
      // no-op
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
        model: "baseurl-test",
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
        model: "temp-test",
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
  test("thinking override 路径用 envProvider 的最新 env（新 baseUrl + model），不用构造期快照", async () => {
    const capOld = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capNew = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const store0 = makeStore();
    // Construction-time snapshot = capOld; envProvider (production TUI's EnvLoader.get) returns the new env.
    const initial = makeFullEnv({
      model: "snapshot-model",
      apiKey: "test-key",
      baseUrl: capOld.origin,
    });
    let latest = makeFullEnv({
      model: "snapshot-model",
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
        model: "switched-model",
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
      expect((capNew.bodies[0] as { model?: string }).model).toBe(
        "switched-model"
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
    let currentHeaders: Readonly<Record<string, string>> = {
      "X-Foo": "bar",
    };
    const envProvider = () =>
      makeFullEnv({
        model: "headers-test",
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
      currentHeaders = undefined as unknown as Readonly<Record<string, string>>;
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
