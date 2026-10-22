/**
 * Per-conversation model route — the hub's runtime state (ADR-0145 §2/§4/§5,
 * spec §3 lifecycle table, invariants 3-4).
 *
 * Two arms:
 *  - state arm: the runtime route map, the creation snapshot, the attach
 *    restore / backfill, and the `setSessionModel` act;
 *  - read arm: which model a turn actually puts on the wire — a conversation
 *    runs on ITS OWN route (adapter / env / thinking override / compaction),
 *    an unresolvable route fails loud instead of falling back to the default,
 *    and the route adapter is cached per (route, default-env reference).
 *
 * Discipline:
 *  - isolated tmp store (mkdtemp + afterAll rm) — never the real ~/.iknow;
 *  - synthetic provider keys only: the env var names belong to this file and
 *    the values are literals that name no real service;
 *  - the default env is built through the production `loadIknowEnv` with an
 *    injected settings object, so the route registry travels with the env and
 *    `resolveLlmEnvForRoute` sees the same shape production sees;
 *  - the providers point at a local capture server, so a turn on a route puts
 *    a real request on the wire (the route adapter replaces the stub).
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.js";
import { SessionStore } from "../../src/session-api/store/index.js";
import {
  isLlmProviderConfigError,
  loadIknowEnv,
  type IknowEnv,
} from "../../src/config/env.js";
import type { IknowSettings } from "../../src/config/settings.js";
import type {
  AnthropicNativeMessage,
  LoopEngineDeps,
} from "../../src/harness/index.js";
import { currentSecretValues } from "../../src/harness/sandbox/env-isolation.js";
import { makeDeps, assistantResult } from "../cli/_fixtures.ts";
import {
  MINIMAL_SDK_MESSAGE,
  startLlmCapture,
  type LlmCapture,
} from "./_helpers/llm-capture.ts";
import {
  MINIMAL_MESSAGE_RESPONSE,
  startHttpCapture,
} from "../_helpers/http-capture.ts";

// -- synthetic provider registry ---------------------------------------------

const PRIMARY_KEY_ENV = "IKNOW_TEST_HUB_SESSION_MODEL_PRIMARY_KEY";
const SECONDARY_KEY_ENV = "IKNOW_TEST_HUB_SESSION_MODEL_SECONDARY_KEY";
const KEYLESS_KEY_ENV = "IKNOW_TEST_HUB_SESSION_MODEL_KEYLESS_KEY";

const PRIMARY_ROUTE = "primary/default-model";
const SECONDARY_ROUTE = "secondary/second-model";
/**
 * The tier's own route. It is NEITHER of the two conversation routes: a
 * conversation on the tier's route needs no overlay (the base adapter already
 * serves it), so a test that wants to observe a per-route transport has to
 * put the conversation on a DIFFERENT route.
 */
const TIER_ROUTE = "primary/base-model";
/** Registered provider id, but its api-key env var is never set. */
const KEYLESS_ROUTE = "keyless/k";
/** No such provider in the registry. */
const UNKNOWN_ROUTE = "ghost/ghost-model";

/**
 * The request output budget the harness pins on every model entry. The
 * Anthropic SDK's non-streaming arm refuses a budget whose expected duration
 * passes 10 minutes (the 32,000-token fallback does), and the capture server
 * answers with one JSON envelope — so the non-streaming arm is the only one
 * the wire tests can use.
 */
const REQUEST_BUDGET = 128;

let baseDir: string;
let envCwd: string;

/** The provider baseUrls the harness env points at. */
interface ProviderOrigins {
  readonly primary: string;
  readonly secondary: string;
}

/**
 * The shared capture server: the providers of the state-arm env point at it,
 * so a turn on a route really puts a request on the wire instead of hanging on
 * an unreachable host.
 */
let sharedCapture: LlmCapture;
let sharedOrigins: ProviderOrigins = { primary: "", secondary: "" };

beforeAll(async () => {
  baseDir = mkdtempSync(join(tmpdir(), "iknow-hub-session-model-"));
  // The env loader parses `.env` / `.env.local` from its cwd — an empty temp
  // dir keeps the read away from the repository.
  envCwd = mkdtempSync(join(tmpdir(), "iknow-hub-session-model-env-"));
  process.env[PRIMARY_KEY_ENV] = "test-key-primary";
  process.env[SECONDARY_KEY_ENV] = "test-key-secondary";
  delete process.env[KEYLESS_KEY_ENV];
  // The capture server answers with one JSON envelope; the streaming arm would
  // need an SSE stream it cannot satisfy.
  process.env.IKNOW_LLM_STREAM = "off";
  sharedCapture = await startLlmCapture(MINIMAL_SDK_MESSAGE);
  sharedOrigins = {
    primary: sharedCapture.origin,
    secondary: sharedCapture.origin,
  };
});

afterAll(async () => {
  await sharedCapture.close();
  rmSync(baseDir, { recursive: true, force: true });
  rmSync(envCwd, { recursive: true, force: true });
  delete process.env[PRIMARY_KEY_ENV];
  delete process.env[SECONDARY_KEY_ENV];
  delete process.env[KEYLESS_KEY_ENV];
  delete process.env.IKNOW_LLM_STREAM;
});

function settingsFor(
  defaultRoute: string,
  origins: ProviderOrigins = sharedOrigins
): IknowSettings {
  return {
    llm: {
      model: defaultRoute,
      providers: [
        {
          id: "primary",
          baseUrl: origins.primary,
          apiKeyEnv: PRIMARY_KEY_ENV,
          models: [
            { id: "default-model", maxTokens: REQUEST_BUDGET },
            { id: "base-model", maxTokens: REQUEST_BUDGET },
          ],
        },
        {
          id: "secondary",
          baseUrl: origins.secondary,
          apiKeyEnv: SECONDARY_KEY_ENV,
          models: [{ id: "second-model", maxTokens: REQUEST_BUDGET }],
        },
        {
          id: "keyless",
          // This provider never resolves (its api-key env var stays unset), so
          // the baseUrl is only a well-formed placeholder.
          baseUrl: origins.primary,
          apiKeyEnv: KEYLESS_KEY_ENV,
          models: [{ id: "k", maxTokens: REQUEST_BUDGET }],
        },
      ],
    },
  };
}

function envFor(defaultRoute: string): IknowEnv {
  return loadIknowEnv(envCwd, settingsFor(defaultRoute));
}

/** The env whose provider registry points at the given capture servers. */
function envForOrigins(
  defaultRoute: string,
  origins: ProviderOrigins
): IknowEnv {
  return loadIknowEnv(envCwd, settingsFor(defaultRoute, origins));
}

/** One store per case: conversations never share a directory. */
function makeStore(): SessionStore {
  return new SessionStore(mkdtempSync(join(baseDir, "store-")), process.cwd());
}

/**
 * The hub under test. `envProvider` returns a fresh env per call (the shape an
 * EnvLoader hands out after a reload), so the default route can change
 * between two calls.
 */
function makeHub(opts: {
  readonly store: SessionStore;
  readonly defaultRoute: () => string;
}): SessionHub {
  return new SessionHub({
    store: opts.store,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    envProvider: () => envFor(opts.defaultRoute()),
  });
}

/** The wire request body shape the read-path assertions read. */
interface WireBody {
  readonly model: string;
  readonly messages: ReadonlyArray<{
    readonly content: ReadonlyArray<{ readonly text: string }>;
  }>;
  readonly thinking?: unknown;
  readonly output_config?: unknown;
}

/**
 * The runtime route map (ADR-0145 §4) — the runtime truth under test.
 *
 * Only the map's SHAPE is read through here (an entry's presence / the map's
 * size): the effective route of a conversation has a public accessor
 * (`hub.getSessionModel`), and a reset / shutdown that empties the map has no
 * public observable — the session file keeps its route on purpose.
 */
function routesOf(hub: SessionHub): Map<string, string> {
  return (hub as unknown as { sessionRoutes: Map<string, string> })
    .sessionRoutes;
}

/**
 * The read-path hub. `env` hands out the CURRENT env object: the host's
 * EnvLoader keeps one reference until a reload hands out a new one, and that
 * reference is the route adapter cache's key half (ADR-0145 §5).
 *
 * The base deps are a stub — a turn on a route replaces the stub adapter with
 * the route's own, so a stub answer means "no route ran this turn".
 */
function makeRoutedHub(opts: {
  readonly store: SessionStore;
  readonly env: () => IknowEnv;
  readonly stubText?: string;
}): SessionHub {
  return new SessionHub({
    store: opts.store,
    deps: makeDeps([
      assistantResult({ texts: [opts.stubText ?? "stub-answer"] }),
    ]),
    envProvider: opts.env,
  });
}

/** The route → adapter cache (ADR-0145 §5) — the runtime truth under test. */
function routeAdaptersOf(hub: SessionHub): Map<
  string,
  {
    readonly envRef: unknown;
    readonly adapter: LoopEngineDeps["adapter"];
  }
> {
  return (
    hub as unknown as {
      routeAdapters: Map<
        string,
        {
          readonly envRef: unknown;
          readonly adapter: LoopEngineDeps["adapter"];
        }
      >;
    }
  ).routeAdapters;
}

async function createConversation(hub: SessionHub): Promise<string> {
  await hub.bindWorkspace(process.cwd());
  const created = await hub.createSession();
  return created.session.conversation_id;
}

/** Rewrite a stored session into the pre-route shape (no `model` field). */
async function stripStoredRoute(
  store: SessionStore,
  id: string
): Promise<void> {
  const stored = await store.load(id);
  await store.save({ id, file: { ...stored, model: undefined } });
}

/**
 * Run `body` with an empty HOME: the settings read inside the mask layer
 * finds no settings, so the mask set holds only what the routes contribute.
 */
async function withEmptyHome<T>(body: () => Promise<T>): Promise<T> {
  const prevHome = process.env.HOME;
  const emptyHome = mkdtempSync(
    join(tmpdir(), "iknow-hub-session-model-home-")
  );
  process.env.HOME = emptyHome;
  try {
    return await body();
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
}

// -- tests -------------------------------------------------------------------

describe("hub 会话模型路由 — 创建快照与附着恢复", () => {
  test("createSession → 文件写入当前默认路由，运行时 map 同步播种", async () => {
    const store = makeStore();
    const hub = makeHub({ store, defaultRoute: () => PRIMARY_ROUTE });
    const id = await createConversation(hub);

    const file = await store.load(id);
    expect(file.model).toBe(PRIMARY_ROUTE);
    expect(await hub.getSessionModel(id)).toBe(PRIMARY_ROUTE);
  });

  test("新 hub 重新打开同一会话 → 恢复持久化的路由，而不是当前默认", async () => {
    const store = makeStore();
    const first = makeHub({ store, defaultRoute: () => PRIMARY_ROUTE });
    const id = await createConversation(first);

    // A second hub over the same store, whose default has moved on.
    const second = makeHub({ store, defaultRoute: () => SECONDARY_ROUTE });
    await second.getSession(id);

    expect(await second.getSessionModel(id)).toBe(PRIMARY_ROUTE);
    // The durable copy is untouched by the attach.
    expect((await store.load(id)).model).toBe(PRIMARY_ROUTE);
  });

  test("旧文件（无 model）→ 回填当前默认；默认之后变化也不改写（map 条目不被重新快照）", async () => {
    const store = makeStore();
    const seed = makeHub({ store, defaultRoute: () => PRIMARY_ROUTE });
    const id = await createConversation(seed);
    await stripStoredRoute(store, id);

    let current = PRIMARY_ROUTE;
    const hub = makeHub({ store, defaultRoute: () => current });
    await hub.getSession(id);
    expect(await hub.getSessionModel(id)).toBe(PRIMARY_ROUTE);

    // The default moves on; the live entry is the conversation's own route
    // and is never re-snapshotted (spec invariant 4).
    current = SECONDARY_ROUTE;
    await hub.getSession(id);
    expect(await hub.getSessionModel(id)).toBe(PRIMARY_ROUTE);
  });

  test("回填在下一次保存时落盘；在此之前旧文件原样往返", async () => {
    const store = makeStore();
    const seed = makeHub({ store, defaultRoute: () => PRIMARY_ROUTE });
    const id = await createConversation(seed);
    await stripStoredRoute(store, id);

    const hub = makeHub({ store, defaultRoute: () => PRIMARY_ROUTE });
    await hub.postMessage({ conversationId: id, text: "hi" });

    expect((await store.load(id)).model).toBe(PRIMARY_ROUTE);
  });

  test("已存在的 map 条目不被后来的文件读替换（invariant 4）", async () => {
    const store = makeStore();
    const hub = makeHub({ store, defaultRoute: () => PRIMARY_ROUTE });
    const id = await createConversation(hub);

    await hub.setSessionModel(id, SECONDARY_ROUTE);
    expect(await hub.getSessionModel(id)).toBe(SECONDARY_ROUTE);

    // A later attach re-reads the file; the entry stays the conversation's.
    await hub.getSession(id);
    expect(await hub.getSessionModel(id)).toBe(SECONDARY_ROUTE);
  });
});

describe("hub 会话模型路由 — setSessionModel", () => {
  test("setSessionModel → map 与文件都写新路由", async () => {
    const store = makeStore();
    const hub = makeHub({ store, defaultRoute: () => PRIMARY_ROUTE });
    const id = await createConversation(hub);

    await hub.setSessionModel(id, SECONDARY_ROUTE);

    expect(await hub.getSessionModel(id)).toBe(SECONDARY_ROUTE);
    expect((await store.load(id)).model).toBe(SECONDARY_ROUTE);
  });

  test("setSessionModel 路由不可解析 → 抛 typed error，map 与文件都不变", async () => {
    const store = makeStore();
    const hub = makeHub({ store, defaultRoute: () => PRIMARY_ROUTE });
    const id = await createConversation(hub);

    for (const bad of [UNKNOWN_ROUTE, KEYLESS_ROUTE]) {
      let thrown: unknown;
      try {
        await hub.setSessionModel(id, bad);
      } catch (err) {
        thrown = err;
      }
      expect(isLlmProviderConfigError(thrown)).toBe(true);
      // Nothing changed: neither the runtime map nor the durable copy.
      expect(await hub.getSessionModel(id)).toBe(PRIMARY_ROUTE);
      expect((await store.load(id)).model).toBe(PRIMARY_ROUTE);
    }
  });

  test("setSessionModel 选中 tier 自己的路由 → 不经 provider 注册表解析，写入成功", async () => {
    const store = makeStore();
    const base = envFor(TIER_ROUTE);
    // A hand-made env: it carries NO provider registry, so the tier's own
    // route cannot be resolved through one — it IS the tier.
    const env: IknowEnv = {
      ...base,
      llm: { ...base.llm, providers: undefined },
    };
    const hub = makeRoutedHub({ store, env: () => env });
    const id = await createConversation(hub);

    // The model already in use: it must be selectable, not "not registered".
    await hub.setSessionModel(id, TIER_ROUTE);

    expect(await hub.getSessionModel(id)).toBe(TIER_ROUTE);
    expect((await store.load(id)).model).toBe(TIER_ROUTE);
  });
});

describe("hub 会话模型路由 — reset 与生命周期", () => {
  test("resetSession → 删除 map 条目；文件保留 model；下次附着恢复", async () => {
    const store = makeStore();
    const hub = makeHub({ store, defaultRoute: () => PRIMARY_ROUTE });
    const id = await createConversation(hub);

    await hub.resetSession(id);

    // The map entry is gone (the public accessor still reads the FILE's
    // route — a reset wipes the conversation, not its model).
    expect(routesOf(hub).has(id)).toBe(false);
    expect((await store.load(id)).model).toBe(PRIMARY_ROUTE);

    await hub.getSession(id);
    expect(await hub.getSessionModel(id)).toBe(PRIMARY_ROUTE);
  });

  test("shutdown → 清空 map", async () => {
    const store = makeStore();
    const hub = makeHub({ store, defaultRoute: () => PRIMARY_ROUTE });
    await createConversation(hub);
    expect(routesOf(hub).size).toBe(1);

    await hub.shutdown();

    expect(routesOf(hub).size).toBe(0);
  });
});

// -- 读路径 -------------------------------------------------------------------

describe("hub 会话模型路由 — 读路径：会话跑在自己的路由上", () => {
  test("两个会话两条路由：各自的回合打到各自的 provider，wire model 是路由的 model 尾巴", async () => {
    const capA = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capB = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const store = makeStore();
      const env = envForOrigins(TIER_ROUTE, {
        primary: capA.origin,
        secondary: capB.origin,
      });
      const hub = makeRoutedHub({ store, env: () => env });
      const idA = await createConversation(hub);
      const idB = await createConversation(hub);
      // Both conversations move OFF the tier's route, so each turn has to
      // resolve its own transport (a conversation on the tier's route would
      // ride the base adapter — which is that route's adapter already).
      await hub.setSessionModel(idA, PRIMARY_ROUTE);
      await hub.setSessionModel(idB, SECONDARY_ROUTE);

      const resA = await hub.postMessage({ conversationId: idA, text: "A" });
      expect(resA.turn.answer.finalText).toBe("ok");
      expect(capA.bodies.length).toBe(1);
      expect(capB.bodies.length).toBe(0);
      const bodyA = capA.bodies[0] as WireBody;
      expect(bodyA.model).toBe("default-model");
      expect(bodyA.messages[0]?.content[0]?.text).toBe("A");

      const resB = await hub.postMessage({ conversationId: idB, text: "B" });
      expect(resB.turn.answer.finalText).toBe("ok");
      expect(capB.bodies.length).toBe(1);
      expect(capA.bodies.length).toBe(1);
      const bodyB = capB.bodies[0] as WireBody;
      expect(bodyB.model).toBe("second-model");
      expect(bodyB.messages[0]?.content[0]?.text).toBe("B");
    } finally {
      await capA.close();
      await capB.close();
    }
  });

  test("路由不可解析 → 回合抛 typed error，不静默跑在默认模型上", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const store = makeStore();
      const env = envForOrigins(PRIMARY_ROUTE, {
        primary: cap.origin,
        secondary: cap.origin,
      });
      const seed = makeRoutedHub({ store, env: () => env });
      const id = await createConversation(seed);

      // An unregistered provider, and a registered one whose api-key env var
      // stays unset — the two ways a route fails to resolve.
      for (const [bad, kind] of [
        [UNKNOWN_ROUTE, "provider_model_not_registered"],
        [KEYLESS_ROUTE, "provider_api_key_missing"],
      ] as const) {
        // `setSessionModel` refuses an unresolvable route on the spot, so the
        // route lands in the file directly — a session that already carried it.
        await store.save({
          id,
          file: { ...(await store.load(id)), model: bad },
        });
        // A second hub over the same store: its route map is empty, so the
        // file's route is the one the turn restores.
        const hub = makeRoutedHub({ store, env: () => env });

        let thrown: unknown;
        try {
          await hub.postMessage({ conversationId: id, text: "hi" });
        } catch (err) {
          thrown = err;
        }
        expect(isLlmProviderConfigError(thrown)).toBe(true);
        expect(thrown).toMatchObject({ kind });
        // Nothing went on the wire: the turn did not fall back to the default.
        expect(cap.bodies.length).toBe(0);
      }
    } finally {
      await cap.close();
    }
  });

  test("thinking 覆写走会话路由的模型，覆写本身照常生效", async () => {
    const capA = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capB = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const store = makeStore();
      const env = envForOrigins(PRIMARY_ROUTE, {
        primary: capA.origin,
        secondary: capB.origin,
      });
      const hub = makeRoutedHub({ store, env: () => env });
      const id = await createConversation(hub);
      await hub.setSessionModel(id, SECONDARY_ROUTE);

      await hub.postMessage({
        conversationId: id,
        text: "hi",
        thinking: { mode: "adaptive", effort: "high" },
      });

      expect(capB.bodies.length).toBe(1);
      expect(capA.bodies.length).toBe(0);
      const body = capB.bodies[0] as WireBody;
      expect(body.model).toBe("second-model");
      expect(body.thinking).toEqual({ type: "adaptive" });
      expect(body.output_config).toEqual({ effort: "high" });
    } finally {
      await capA.close();
      await capB.close();
    }
  });

  test("thinking 覆写在适配器缓存命中后仍走会话路由的模型（第二轮）", async () => {
    const capTier = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capRoute = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const store = makeStore();
      const env = envForOrigins(TIER_ROUTE, {
        primary: capTier.origin,
        secondary: capRoute.origin,
      });
      const hub = makeRoutedHub({ store, env: () => env });
      const id = await createConversation(hub);
      await hub.setSessionModel(id, SECONDARY_ROUTE);

      await hub.postMessage({ conversationId: id, text: "one" });
      // The second turn hits the route adapter cache: the cached entry must
      // carry the RESOLVED route env, not the tier's — otherwise the thinking
      // override would run on the tier's model.
      await hub.postMessage({
        conversationId: id,
        text: "two",
        thinking: { mode: "adaptive", effort: "high" },
      });

      expect(capRoute.bodies.length).toBe(2);
      expect(capTier.bodies.length).toBe(0);
      const body = capRoute.bodies[1] as WireBody;
      expect(body.model).toBe("second-model");
      expect(body.thinking).toEqual({ type: "adaptive" });
    } finally {
      await capTier.close();
      await capRoute.close();
    }
  });

  test("同一路由复用同一个适配器；env 引用换新之后重建适配器并用上新凭据", async () => {
    const cap = await startHttpCapture(MINIMAL_MESSAGE_RESPONSE);
    try {
      const store = makeStore();
      let current = envForOrigins(TIER_ROUTE, {
        primary: cap.origin,
        secondary: cap.origin,
      });
      const hub = makeRoutedHub({ store, env: () => current });
      const id = await createConversation(hub);
      await hub.setSessionModel(id, PRIMARY_ROUTE);

      await hub.postMessage({ conversationId: id, text: "one" });
      const first = routeAdaptersOf(hub).get(PRIMARY_ROUTE);
      expect(first).toBeDefined();
      expect(cap.headers[0]?.["x-api-key"]).toBe("test-key-primary");

      // Same env reference → the same adapter object.
      await hub.postMessage({ conversationId: id, text: "two" });
      expect(routeAdaptersOf(hub).get(PRIMARY_ROUTE)?.adapter).toBe(
        first?.adapter
      );
      expect(cap.headers[1]?.["x-api-key"]).toBe("test-key-primary");

      // A new env reference (the host reloaded) → a new adapter, and the new
      // credentials reach the wire.
      process.env[PRIMARY_KEY_ENV] = "test-key-primary-rotated";
      current = envForOrigins(TIER_ROUTE, {
        primary: cap.origin,
        secondary: cap.origin,
      });
      await hub.postMessage({ conversationId: id, text: "three" });
      const third = routeAdaptersOf(hub).get(PRIMARY_ROUTE);
      expect(third?.adapter).not.toBe(first?.adapter);
      expect(cap.headers[2]?.["x-api-key"]).toBe("test-key-primary-rotated");
    } finally {
      process.env[PRIMARY_KEY_ENV] = "test-key-primary";
      await cap.close();
    }
  });

  test("压缩走会话自己的路由适配器", async () => {
    const capA = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capB = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const store = makeStore();
      const env = envForOrigins(PRIMARY_ROUTE, {
        primary: capA.origin,
        secondary: capB.origin,
      });
      const hub = makeRoutedHub({ store, env: () => env });
      const id = await createConversation(hub);
      await hub.setSessionModel(id, SECONDARY_ROUTE);

      await hub.postMessage({ conversationId: id, text: "hi" });
      expect(capB.bodies.length).toBe(1);
      expect(capA.bodies.length).toBe(0);

      const res = await hub.compactSession(id);

      expect(res.compacted).toBe(true);
      // The summary call is a model call for this conversation: it runs on the
      // conversation's route, not on the base adapter.
      expect(capB.bodies.length).toBe(2);
      expect(capA.bodies.length).toBe(0);
      const summaryBody = capB.bodies[1] as WireBody;
      expect(summaryBody.model).toBe("second-model");
      expect(JSON.stringify(summaryBody.messages)).toContain(
        "create a detailed summary"
      );
    } finally {
      await capA.close();
      await capB.close();
    }
  });

  test("没有路由的会话保持基础适配器（行为不变）", async () => {
    const cap = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const store = makeStore();
      const base = envForOrigins(PRIMARY_ROUTE, {
        primary: cap.origin,
        secondary: cap.origin,
      });
      // The default model is not a `provider/model` id → this conversation
      // owns no route.
      const env: IknowEnv = {
        ...base,
        llm: { ...base.llm, model: "bare-model" },
      };
      const hub = makeRoutedHub({
        store,
        env: () => env,
        stubText: "stub-answer",
      });
      const id = await createConversation(hub);
      // No route at all: neither the map nor the file carries one, and the
      // default is not a route id either.
      expect(routesOf(hub).has(id)).toBe(false);
      expect(await hub.getSessionModel(id)).toBeUndefined();

      const res = await hub.postMessage({ conversationId: id, text: "hi" });

      // The base (stub) adapter answered; no request went on the wire.
      expect(res.turn.answer.finalText).toBe("stub-answer");
      expect(cap.bodies.length).toBe(0);
    } finally {
      await cap.close();
    }
  });
});

// -- 证据测试（spec New test 1 / 3 / 4 与两条读路径）--------------------------

describe("hub 会话模型路由 — 证据：spec New test 1（一个会话换模型，另一个不动）", () => {
  test("A 选了 p/m2 之后，B 的下一条消息仍上线默认模型", async () => {
    const capTier = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capOther = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const store = makeStore();
      // The tier is the default route; the base adapter serves it.
      const env = envForOrigins(TIER_ROUTE, {
        primary: capTier.origin,
        secondary: capOther.origin,
      });
      const hub = makeRoutedHub({ store, env: () => env });
      // The base adapter becomes a real one, so the conversation that rides
      // it puts a request on the wire.
      await hub.reloadFromEnv();
      const idA = await createConversation(hub);
      const idB = await createConversation(hub);
      await hub.setSessionModel(idA, SECONDARY_ROUTE);

      await hub.postMessage({ conversationId: idA, text: "A" });
      expect(capOther.bodies.length).toBe(1);
      expect((capOther.bodies[0] as WireBody).model).toBe("second-model");
      expect(capTier.bodies.length).toBe(0);

      // B changed nothing: its route is the tier's own route, so it still
      // puts the DEFAULT model on the wire.
      await hub.postMessage({ conversationId: idB, text: "B" });
      expect(capTier.bodies.length).toBe(1);
      expect((capTier.bodies[0] as WireBody).model).toBe("base-model");
      expect(capOther.bodies.length).toBe(1);
    } finally {
      await capTier.close();
      await capOther.close();
    }
  });
});

describe("hub 会话模型路由 — 证据：spec New test 3（重开沿用文件里的路由）", () => {
  test("文件带 model 的会话被新 hub（默认不同）打开 → 该回合上线文件里的模型", async () => {
    const capDefault = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capFile = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const store = makeStore();
      const origins = {
        primary: capDefault.origin,
        secondary: capFile.origin,
      };
      // The first hub's default is the secondary route → the created file
      // carries it.
      const seedHub = makeRoutedHub({
        store,
        env: () => envForOrigins(SECONDARY_ROUTE, origins),
      });
      const id = await createConversation(seedHub);
      expect((await store.load(id)).model).toBe(SECONDARY_ROUTE);

      // A FRESH hub whose default is the primary route.
      const hub = makeRoutedHub({
        store,
        env: () => envForOrigins(PRIMARY_ROUTE, origins),
      });
      await hub.postMessage({ conversationId: id, text: "hi" });

      // The file's route wins over the fresh hub's default.
      expect(capFile.bodies.length).toBe(1);
      expect((capFile.bodies[0] as WireBody).model).toBe("second-model");
      expect(capDefault.bodies.length).toBe(0);
      // The durable copy is untouched.
      expect((await store.load(id)).model).toBe(SECONDARY_ROUTE);
    } finally {
      await capDefault.close();
      await capFile.close();
    }
  });
});

describe("hub 会话模型路由 — 证据：spec New test 4（两条路由两个 key 同时被掩码）", () => {
  test("两次回合后掩码集合同时含两条路由的 key（union，后一条不挤掉前一条）", async () => {
    // Key values of this case alone: the assertion is about the two routes
    // THIS test contributes, not a leftover of an earlier case.
    process.env[PRIMARY_KEY_ENV] = "mask-key-primary";
    process.env[SECONDARY_KEY_ENV] = "mask-key-secondary";
    const capA = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capB = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      await withEmptyHome(async () => {
        const store = makeStore();
        const env = envForOrigins(TIER_ROUTE, {
          primary: capA.origin,
          secondary: capB.origin,
        });
        const hub = makeRoutedHub({ store, env: () => env });
        const idA = await createConversation(hub);
        const idB = await createConversation(hub);
        await hub.setSessionModel(idA, PRIMARY_ROUTE);
        await hub.setSessionModel(idB, SECONDARY_ROUTE);

        const before = currentSecretValues();
        expect(before).not.toContain("mask-key-primary");
        expect(before).not.toContain("mask-key-secondary");

        await hub.postMessage({ conversationId: idA, text: "A" });
        const afterA = currentSecretValues();
        expect(afterA).toContain("mask-key-primary");
        expect(afterA).not.toContain("mask-key-secondary");

        // The reverse build order is the same code path: the mask set is keyed
        // per route owner, so the second build adds its own key and never
        // removes the first owner's.
        await hub.postMessage({ conversationId: idB, text: "B" });
        const afterB = currentSecretValues();
        expect(afterB).toContain("mask-key-primary");
        expect(afterB).toContain("mask-key-secondary");
      });
    } finally {
      await capA.close();
      await capB.close();
      process.env[PRIMARY_KEY_ENV] = "test-key-primary";
      process.env[SECONDARY_KEY_ENV] = "test-key-secondary";
    }
  });
});

describe("hub 会话模型路由 — 证据：路由不再被持有时资源被回收", () => {
  test("会话换走路由后：旧路由的适配器与掩码被回收，仍被别的会话持有的路由保留", async () => {
    process.env[PRIMARY_KEY_ENV] = "release-key-primary";
    const capA = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capB = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      await withEmptyHome(async () => {
        const store = makeStore();
        const env = envForOrigins(TIER_ROUTE, {
          primary: capA.origin,
          secondary: capB.origin,
        });
        const hub = makeRoutedHub({ store, env: () => env });
        const idA = await createConversation(hub);
        const idB = await createConversation(hub);
        await hub.setSessionModel(idA, PRIMARY_ROUTE);
        await hub.setSessionModel(idB, SECONDARY_ROUTE);
        await hub.postMessage({ conversationId: idA, text: "A" });
        await hub.postMessage({ conversationId: idB, text: "B" });

        expect(routeAdaptersOf(hub).has(PRIMARY_ROUTE)).toBe(true);
        expect(currentSecretValues()).toContain("release-key-primary");

        // A gives the primary route up: nobody owns it any more, so its
        // adapter and its mask contribution go with it.
        await hub.setSessionModel(idA, SECONDARY_ROUTE);
        expect(routeAdaptersOf(hub).has(PRIMARY_ROUTE)).toBe(false);
        expect(currentSecretValues()).not.toContain("release-key-primary");
        // The route B still owns keeps both.
        expect(routeAdaptersOf(hub).has(SECONDARY_ROUTE)).toBe(true);
      });
    } finally {
      await capA.close();
      await capB.close();
      process.env[PRIMARY_KEY_ENV] = "test-key-primary";
    }
  });
});

describe("hub 会话模型路由 — 证据：第二条读路径（continue）与等路由钉住", () => {
  test("continue 回合走会话自己的路由（wire model 是该路由的尾巴）", async () => {
    const capTier = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capRoute = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const store = makeStore();
      const env = envForOrigins(TIER_ROUTE, {
        primary: capTier.origin,
        secondary: capRoute.origin,
      });
      const hub = makeRoutedHub({ store, env: () => env });
      const id = await createConversation(hub);
      await hub.setSessionModel(id, SECONDARY_ROUTE);
      // A session whose last message is a user message is "continue pending".
      const stored = await store.load(id);
      const pending: AnthropicNativeMessage = {
        role: "user",
        content: [{ type: "text", text: "keep going" }],
      };
      await store.save({
        id,
        file: { ...stored, messages: [pending] },
      });

      await hub.continueSession(id);

      expect(capRoute.bodies.length).toBe(1);
      expect((capRoute.bodies[0] as WireBody).model).toBe("second-model");
      expect(capTier.bodies.length).toBe(0);
    } finally {
      await capTier.close();
      await capRoute.close();
    }
  });

  test("会话的路由等于 tier 自己的模型：默认改了之后它仍然上线那个模型", async () => {
    const capTier = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    const capOther = await startLlmCapture(MINIMAL_SDK_MESSAGE);
    try {
      const store = makeStore();
      const origins = {
        primary: capTier.origin,
        secondary: capOther.origin,
      };
      let current = envForOrigins(TIER_ROUTE, origins);
      const hub = makeRoutedHub({ store, env: () => current });
      await hub.reloadFromEnv();
      const id = await createConversation(hub);
      // The conversation's route IS the tier's own route.
      expect(await hub.getSessionModel(id)).toBe(TIER_ROUTE);

      await hub.postMessage({ conversationId: id, text: "one" });
      expect(capTier.bodies.length).toBe(1);
      expect((capTier.bodies[0] as WireBody).model).toBe("base-model");

      // The default moves on, and the base adapter is rebuilt for it.
      current = envForOrigins(SECONDARY_ROUTE, origins);
      await hub.reloadFromEnv();

      await hub.postMessage({ conversationId: id, text: "two" });
      // The conversation keeps its own route: the new default never moves it.
      expect(capTier.bodies.length).toBe(2);
      expect((capTier.bodies[1] as WireBody).model).toBe("base-model");
      expect(capOther.bodies.length).toBe(0);
    } finally {
      await capTier.close();
      await capOther.close();
    }
  });
});
