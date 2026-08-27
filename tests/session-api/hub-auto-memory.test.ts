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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  SessionStore,
  resolveProjectSessionDir,
} from "../../src/session-api/store/index.ts";
import type { AutoMemoryTurn } from "../../src/harness/memory/index.ts";
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
});
