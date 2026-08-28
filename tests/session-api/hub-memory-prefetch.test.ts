/**
 * Per-root memory_prefetch isolation on SessionHub (ACR concurrent class).
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { LoopState } from "../../src/harness/model-adapter/types.ts";

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

function lastUserText(state: LoopState): string {
  const last = [...state.messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return last.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

describe("SessionHub — per-root memory prefetch", () => {
  it("uses each workspace's overlay, not the first-built process field", async () => {
    const store = new SessionStore(await tmpDir("iknow-prefetch-store-"));
    const rootA = await tmpDir("iknow-prefetch-a-");
    const rootB = await tmpDir("iknow-prefetch-b-");
    const seen: Record<string, string> = {};

    const hub = new SessionHub({
      store,
      askUser: createNoAskUser(),
      surface: "serve",
      buildEngine: async (engineRoot) => {
        const inner = makeDeps([
          assistantResult({ texts: [`from:${engineRoot}`] }),
        ]);
        return {
          deps: {
            ...inner,
            adapter: {
              ...inner.adapter,
              step: async (state, request, signal) => {
                seen[engineRoot] = lastUserText(state);
                return inner.adapter.step(state, request, signal);
              },
            },
          },
          overlayMemoryPrefetch: async () => `OVERLAY:${engineRoot}`,
        };
      },
    });

    await hub.bindWorkspace(rootA);
    const s1 = await hub.createSession();
    await hub.bindWorkspace(rootB);
    const s2 = await hub.createSession();

    await hub.postMessage({
      conversationId: s1.session.conversation_id,
      text: "query-a",
    });
    await hub.postMessage({
      conversationId: s2.session.conversation_id,
      text: "query-b",
    });

    assert.match(seen[rootA] ?? "", /OVERLAY:/);
    assert.match(seen[rootB] ?? "", /OVERLAY:/);
    assert.ok(
      (seen[rootA] ?? "").includes(`OVERLAY:${rootA}`),
      "session A must prefetch from root A"
    );
    assert.ok(
      (seen[rootB] ?? "").includes(`OVERLAY:${rootB}`),
      "session B must prefetch from root B"
    );
    assert.ok(!(seen[rootA] ?? "").includes(rootB));
    assert.ok(!(seen[rootB] ?? "").includes(rootA));
  });
});
