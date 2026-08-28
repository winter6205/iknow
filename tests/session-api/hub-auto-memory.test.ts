/**
 * auto-memory T4: serve / TUI host wiring (SessionHub).
 *
 * Spec: specs/auto-memory.md D1/D4; ADR-0031 Decision 1/5. The hub is the
 * shared host for `serve` and the TUI, so wiring it once covers both. What is
 * pinned: every finished turn reaches the hook, a hook failure never fails
 * postMessage, and an unwired hub behaves exactly as before.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  SessionStore,
  resolveProjectSessionDir,
} from "../../src/session-api/store/index.ts";
import {
  createAutoMemoryHook,
  type AutoMemoryHook,
  type AutoMemoryTurn,
} from "../../src/harness/memory/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-auto-memory-"));
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const recorder = (): {
  readonly hook: {
    onTurnComplete: (t: AutoMemoryTurn) => void;
    drain: () => Promise<void>;
  };
  readonly seen: AutoMemoryTurn[];
} => {
  const seen: AutoMemoryTurn[] = [];
  return {
    hook: { onTurnComplete: (t) => seen.push(t), drain: async () => {} },
    seen,
  };
};

const trackedAutoMemoryHook = (memoryDir: string): {
  readonly hook: AutoMemoryHook;
  readonly calls: () => number;
} => {
  let callCount = 0;
  const hook = createAutoMemoryHook({
    memoryDir,
    llm: {
      complete: async () =>
        JSON.stringify([
          {
            title: "Workspace memory",
            body: "The workspace keeps durable project conventions.",
            type: "note",
            importance: 3,
          },
        ]),
    },
    enabled: true,
  });
  return {
    hook: {
      onTurnComplete: (turn) => {
        callCount++;
        hook.onTurnComplete(turn);
      },
      drain: () => hook.drain(),
    },
    calls: () => callCount,
  };
};

async function sourceAutoFiles(memoryDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(memoryDir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".md") && name !== "MEMORY.md")
      .map((name) => readFile(join(memoryDir, name), "utf8"))
  );
  return files.filter((file) => file.includes("source: auto"));
}

describe("SessionHub — auto-memory hook", () => {
  it("hands a completed turn to the hook with the rendered transcript", async () => {
    const { hook, seen } = recorder();
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["bar() is thread-safe."] })]),
      autoMemory: hook,
    });
    const { session } = await hub.createSession();
    const out = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "which entry point is thread-safe?",
    });

    assert.equal(out.turn.answer.stopReason, "completed");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.stopReason, "completed");
    assert.match(seen[0]!.transcript, /which entry point is thread-safe\?/);
    assert.match(seen[0]!.transcript, /bar\(\) is thread-safe\./);
  });

  it("keeps postMessage successful when the hook throws", async () => {
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["reply"] })]),
      autoMemory: {
        onTurnComplete: () => {
          throw new Error("hook exploded");
        },
        drain: async () => {},
      },
    });
    const { session } = await hub.createSession();
    const out = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hello",
    });
    assert.equal(out.turn.answer.stopReason, "completed");
    assert.equal(out.turn.answer.finalText, "reply");
  });

  it("behaves exactly as before when no hook is wired", async () => {
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["reply"] })]),
    });
    const { session } = await hub.createSession();
    const out = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hello",
    });
    assert.equal(out.turn.answer.finalText, "reply");
  });

  it("keeps auto-memory hooks isolated by session workspaceRoot", async () => {
    const rootA = await mkdtemp(join(baseDir, "root-a-"));
    const rootB = await mkdtemp(join(baseDir, "root-b-"));
    const memoryA = join(rootA, "memory");
    const memoryB = join(rootB, "memory");
    const trackedA = trackedAutoMemoryHook(memoryA);
    const trackedB = trackedAutoMemoryHook(memoryB);
    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      buildEngine: async (root) => ({
        deps: makeDeps([
          assistantResult({ texts: [`reply from ${root}`] }),
        ]),
        autoMemory: root === rootA ? trackedA.hook : trackedB.hook,
      }),
    });

    await hub.bindWorkspace(rootA);
    const sessionA = await hub.createSession();
    await hub.bindWorkspace(rootB);
    const sessionB = await hub.createSession();

    await hub.postMessage({
      conversationId: sessionA.session.conversation_id,
      text: "root A turn",
    });
    await hub.postMessage({
      conversationId: sessionB.session.conversation_id,
      text: "root B turn",
    });
    await trackedA.hook.drain();
    await trackedB.hook.drain();

    assert.equal(trackedA.calls(), 1);
    assert.equal(trackedB.calls(), 1);
    assert.deepEqual(await sourceAutoFiles(memoryA), []);
    assert.deepEqual(await sourceAutoFiles(memoryB), []);
  });
});
