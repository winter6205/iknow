/**
 * T3: SessionHub env 源接缝 + adapter 热重建（settings-hot-reload）。
 *
 * 覆盖（plans/settings-hot-reload.md T3 验收，≥5 用例）：
 *  1. envProvider 注入后，ensureDeps 用其返回值建（不回落 loadIknowEnv）。
 *  2. reloadFromEnv 后下一次 postMessage 拿到新 adapter（走 createAdapterFromEnv
 *     最小面热重建）；registry / executor / maxTurns 引用保持稳定（不重建）。
 *  3. onEnvChange 在 env 变化时触发一次（连续 reload 同值不重复触发）。
 *  4. 不传 envProvider 行为零变化（向后兼容；既有 fixture 回归）。
 *  5. reload 抛错（model 缺失）→ cachedDeps 不动，process 不崩。
 *
 * 纪律：
 *  - 隔离 tmp store（mkdtemp + afterAll rm）；
 *  - capture-server 用例显式 close（避免端口泄漏）；
 *  - 框架 vitest（与 tests/session-api 既有测试一致）。
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
  startLlmCapture,
} from "./_helpers/llm-capture.ts";

// -- helpers -----------------------------------------------------------------

let baseDir: string;
let store: SessionStore;

afterAll(async () => {
  rmSync(baseDir, { recursive: true, force: true });
});

function makeStore(): SessionStore {
  if (!baseDir) {
    baseDir = mkdtempSync(join(tmpdir(), "iknow-hub-hot-reload-"));
    store = new SessionStore(baseDir);
  }
  return store;
}

/** 构造完整 IknowEnv（全字段，隔离 tmp home 读不到真实 settings）。 */
function makeFullEnv(overrides: {
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly stream?: "on" | "off";
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}): IknowEnv {
  return {
    llm: {
      baseUrl: overrides.baseUrl ?? "http://invalid",
      model: overrides.model ?? "test-model",
      fallback: [],
      // apiKey 缺省 "test-key"；仅在显式传 undefined 时透传 undefined（测试
      // apiKey 解析失败降级路径）。用 `in` 判断「显式传了 key」，避免与「未传
      // key 走默认」混淆。
      apiKey: "apiKey" in overrides ? overrides.apiKey : "test-key",
      maxOutputTokens: overrides.maxOutputTokens ?? 128,
      timeoutMs: 5000,
      temperature: overrides.temperature ?? 0,
      thinking: "off",
      thinkingEffort: "",
      // 默认 off（非流式臂）→ capture-server 单 JSON 响应即可解释；
      // on 走 client.messages.stream，要求 SSE 流，capture 不满足。
      stream: overrides.stream ?? "off",
      maxTurns: undefined,
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60000 },
  };
}

/** 最小 adapter（step 永不调用；仅验证「引用替换」语义）。 */
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
    // 注入 stub deps（reviewer minor：保持目录内其它测试同纪律 —— 不跑真实
    // buildHarnessEngine，避免污染真实 home）。envProvider 的唯一消费面是
    // reloadFromEnv（不经 ensureDeps 的 buildHarnessEngine）。
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
      // adapter 被替换为 createAdapterFromEnv 产物（AnthropicAdapter 形态）。
      const deps = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(typeof deps.adapter.step).toBe("function");
      expect(deps.adapter).not.toBe(baseDeps().adapter);
    } finally {
      // 无真实 LLM 调用，无需 close。
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

      // 改 model → reloadFromEnv → adapter 替换、其它字段稳定。
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
    // 注入 stub deps（reviewer minor：隔离真实 home）。首次 postMessage 用注入
    // stub（不联网）；reloadFromEnv 后才走 envProvider 重建真实 adapter —— 正是
    // T3 最小面热重建通路（不经 buildHarnessEngine 整链）。
    const hub = new SessionHub({
      store: store0,
      askUser: createNoAskUser(),
      envProvider,
      deps: baseDeps(),
    });
    try {
      const id = await createSessionId(hub);
      // reloadFromEnv（model-1）→ adapter 指向 capture。
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "hi" });
      expect(cap.bodies.length).toBe(1);
      // 改 model → reloadFromEnv → 下次 postMessage 的 wire model 变化。
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
      // 首次 ensureDeps 不触发（没有「变化」）。
      await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(changes.length).toBe(0);

      // env 变化 → reloadFromEnv → 触发一次。
      currentModel = "model-b";
      await hub.reloadFromEnv();
      expect(changes.length).toBe(1);
      expect(changes[0]).toBe("model-b");

      // 同值 reload → 不重复触发（reviewer major：settings 文件 touch 但内容
      // 没变 → 不重建 adapter、不触发 onEnvChange。EnvLoader.get() 每次返回新
      // 对象，靠关键字段值比较去重 —— 见 hub.ts sameHotReloadKeyFields）。
      await hub.reloadFromEnv();
      expect(changes.length).toBe(1);
      expect(changes[0]).toBe("model-b");

      // 值真正变化 → 再次触发一次。
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
      // reloadFromEnv 无 envProvider → no-op（不抛错）。
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

      // 模拟 reload 抛错：envProvider 抛（坏 JSON / model 缺失同路径）。
      const originalProvider = envProvider;
      (hub as unknown as { envProvider: () => IknowEnv }).envProvider = () => {
        // 复用原 provider 构造的 env，但把 model 清空 → createAdapterFromEnv
        // 仍可构造（Anthropic 接受空 model）；为模拟「model 缺失」守卫，直接抛。
        throw new Error("no LLM model configured in settings.llm.model");
      };
      await assert.rejects(
        () => hub.reloadFromEnv(),
        /no LLM model configured/
      );

      // cachedDeps 未动（adapter 仍是旧引用）。
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

      // settings `${VAR}` 解析不到 → loadIknowEnv 返回 apiKey=undefined（不抛错）；
      // reloadFromEnv 必须在此抛 ValidationError，cachedDeps 保持旧 adapter。
      apiKey = undefined;
      await assert.rejects(() => hub.reloadFromEnv(), /LLM mode needs API key/);

      const depsAfter = await (
        hub as unknown as { ensureDeps: () => Promise<LoopEngineDeps> }
      ).ensureDeps();
      expect(depsAfter.adapter).toBe(adapterBefore);

      // 修复 apiKey → reloadFromEnv 恢复重建。
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
    // 两个 capture server：reload 切换 baseUrl 后，下一个 postMessage 命中 cap2。
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
      // 首次 reload → adapter 指向 cap1。
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "first" });
      expect(cap1.bodies.length).toBe(1);
      expect(cap2.bodies.length).toBe(0);

      // 只改 baseUrl → reloadFromEnv → adapter 重建指向 cap2。
      currentBaseUrl = cap2.origin;
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "second" });
      expect(cap1.bodies.length).toBe(1); // cap1 不再被命中
      expect(cap2.bodies.length).toBe(1); // 新 adapter 命中 cap2
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
      // 首次 reload（temperature=0）→ adapter 重建。
      await hub.reloadFromEnv();
      await hub.postMessage({ conversationId: id, text: "cold" });
      expect(cap.bodies.length).toBe(1);
      expect((cap.bodies[0] as { temperature?: number }).temperature).toBe(0);

      // 只改 temperature → reloadFromEnv → adapter 重建、wire temperature 变化。
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
