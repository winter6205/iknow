/**
 * T2: SessionHub per-root engine cache + serve unbound postMessage reject.
 *
 * Acceptance (plans/serve-workspace.md T2):
 *   - surface serve + session without workspaceRoot → ValidationError field
 *     workspaceRoot, before ensureDeps / buildHarnessEngine(cwd)
 *   - after bindWorkspace, createSession writes the root; engine factory sees
 *     cwd === workspaceRoot === sandboxRoot (same absolute path)
 *   - two roots → two cache entries; concurrent postMessage both succeed
 *   - constructor deps without surface serve keep the default chat path
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { ValidationError } from "../../src/shared/errors.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function tmpDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function makeStore(): Promise<SessionStore> {
  return new SessionStore(await tmpDir("iknow-ws-bind-store-"));
}

describe("serve unbound postMessage", () => {
  it("rejects before ensureDeps when session has no workspaceRoot", async () => {
    const store = await makeStore();
    let stepCalls = 0;
    const inner = makeDeps([assistantResult({ texts: ["should-not-run"] })]);
    const deps: typeof inner = {
      ...inner,
      adapter: {
        ...inner.adapter,
        step: async (...args) => {
          stepCalls += 1;
          return inner.adapter.step(...args);
        },
      },
    };
    const hub = new SessionHub({
      store,
      deps,
      surface: "serve",
    });
    const { session } = await hub.createSession();
    const file = await store.load(session.conversation_id);
    assert.equal(file.workspaceRoot, undefined);

    await assert.rejects(
      () =>
        hub.postMessage({
          conversationId: session.conversation_id,
          text: "hi",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.["field"], "workspaceRoot");
        return true;
      }
    );
    assert.equal(stepCalls, 0, "must not run the loop when unbound");
  });
});

describe("default surface (chat) with injected deps", () => {
  it("postMessage succeeds without session.workspaceRoot", async () => {
    const store = await makeStore();
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    });
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    assert.equal(res.turn.answer.finalText, "ok");
  });
});

describe("bindWorkspace + three anchors", () => {
  it("createSession writes bound root; buildEngine root equals all three anchors", async () => {
    const store = await makeStore();
    const root = await tmpDir("iknow-ws-bind-root-");
    const recorded: string[] = [];
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      buildEngine: async (engineRoot) => {
        recorded.push(engineRoot);
        return { deps: makeDeps([assistantResult({ texts: ["bound"] })]) };
      },
    });
    const bound = await hub.bindWorkspace(root);
    assert.equal(bound, root);
    const { session } = await hub.createSession();
    const file = await store.load(session.conversation_id);
    assert.equal(file.workspaceRoot, root);
    assert.equal(file.cwd, root);

    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    assert.equal(res.turn.answer.finalText, "bound");
    assert.deepEqual(recorded, [root]);
    // Test seam is a single root; production passes it as cwd/workspaceRoot/sandboxRoot.
    assert.equal(recorded[0], file.workspaceRoot);
    assert.equal(recorded[0], file.cwd);
  });

  it("postMessage Map key is session.workspaceRoot, not later picker bind", async () => {
    const store = await makeStore();
    const rootA = await tmpDir("iknow-ws-bind-a-");
    const rootB = await tmpDir("iknow-ws-bind-b-");
    const recorded: string[] = [];
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      buildEngine: async (engineRoot) => {
        recorded.push(engineRoot);
        return { deps: makeDeps([assistantResult({ texts: [engineRoot] })]) };
      },
    });
    await hub.bindWorkspace(rootA);
    const { session } = await hub.createSession();
    await hub.bindWorkspace(rootB);
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    assert.equal(res.turn.answer.finalText, rootA);
    assert.deepEqual(recorded, [rootA]);
  });
});

describe("two roots two engines", () => {
  it("concurrent postMessage on two sessions uses isolated engines", async () => {
    const store = await makeStore();
    const rootA = await tmpDir("iknow-ws-two-a-");
    const rootB = await tmpDir("iknow-ws-two-b-");
    const recorded: string[] = [];
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      buildEngine: async (engineRoot) => {
        recorded.push(engineRoot);
        return {
          deps: makeDeps([assistantResult({ texts: [`from:${engineRoot}`] })]),
        };
      },
    });
    await hub.bindWorkspace(rootA);
    const s1 = await hub.createSession();
    await hub.bindWorkspace(rootB);
    const s2 = await hub.createSession();

    const [r1, r2] = await Promise.all([
      hub.postMessage({
        conversationId: s1.session.conversation_id,
        text: "one",
      }),
      hub.postMessage({
        conversationId: s2.session.conversation_id,
        text: "two",
      }),
    ]);
    assert.equal(r1.turn.answer.finalText, `from:${rootA}`);
    assert.equal(r2.turn.answer.finalText, `from:${rootB}`);
    assert.equal(recorded.length, 2);
    assert.ok(recorded.includes(rootA));
    assert.ok(recorded.includes(rootB));
    assert.notEqual(rootA, rootB);
  });

  it("shutdown iterates Map engines plus legacy cachedDeps", async () => {
    const store = await makeStore();
    const rootA = await tmpDir("iknow-ws-shut-a-");
    const rootB = await tmpDir("iknow-ws-shut-b-");
    const shutdowns: string[] = [];
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      buildEngine: async (engineRoot) => {
        return {
          deps: makeDeps([assistantResult({ texts: ["x"] })]),
          shutdown: async () => {
            shutdowns.push(engineRoot);
          },
        };
      },
    });
    await hub.bindWorkspace(rootA);
    const s1 = await hub.createSession();
    await hub.bindWorkspace(rootB);
    const s2 = await hub.createSession();
    await hub.postMessage({
      conversationId: s1.session.conversation_id,
      text: "a",
    });
    await hub.postMessage({
      conversationId: s2.session.conversation_id,
      text: "b",
    });
    await hub.shutdown();
    assert.equal(shutdowns.length, 2);
    assert.ok(shutdowns.includes(rootA));
    assert.ok(shutdowns.includes(rootB));
  });
});

// -- serve-workspace T3: recents/trust wiring on the hub ---------------------

describe("bindWorkspace trust + recents (T3)", () => {
  it("rejects an untrusted root without confirmTrust (ValidationError field=path)", async () => {
    const store = await makeStore();
    const home = await tmpDir("iknow-ws-trust-home-");
    const root = await tmpDir("iknow-ws-trust-root-");
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["x"] })]),
      surface: "serve",
      recentsHome: home,
    });
    await assert.rejects(
      () => hub.bindWorkspace(root),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.["field"], "path");
        return true;
      }
    );
    // Still unbound after the rejection.
    assert.equal(hub.getWorkspaceState().bound, false);
  });

  it("confirmTrust=true binds, persists recents, and allows a second bind without confirmTrust", async () => {
    const store = await makeStore();
    const home = await tmpDir("iknow-ws-trust-home2-");
    const root = await tmpDir("iknow-ws-trust-root2-");
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["x"] })]),
      surface: "serve",
      recentsHome: home,
    });
    const bound = await hub.bindWorkspace(root, { confirmTrust: true });
    assert.equal(bound, root);
    assert.deepEqual(hub.getWorkspaceState(), { bound: true, root });
    assert.deepEqual(await hub.listTrustedWorkspaces(), [root]);

    // A fresh hub sharing the same recentsHome sees the trusted root.
    const hub2 = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["x"] })]),
      surface: "serve",
      recentsHome: home,
    });
    const bound2 = await hub2.bindWorkspace(root);
    assert.equal(bound2, root);
  });

  it("recentsHome absent → T2 behavior preserved (no trust gate)", async () => {
    const store = await makeStore();
    const root = await tmpDir("iknow-ws-nohome-");
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["x"] })]),
      surface: "serve",
    });
    const bound = await hub.bindWorkspace(root);
    assert.equal(bound, root);
  });
});
