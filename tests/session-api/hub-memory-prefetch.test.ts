/**
 * Per-root memory_prefetch isolation on SessionHub (ACR concurrent class).
 * T1: session-level (per-conversation) injection dedup lives on the host.
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import {
  MEMORY_ADVISORY_PREFIX,
  MEMORY_PREFETCH_END,
} from "../../src/harness/memory/index.ts";
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

function userTextOf(message: {
  role: string;
  content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function lastUserText(state: LoopState): string {
  const last = [...state.messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return userTextOf(last);
}

/** Real advisory block shape so extractInjectedMemoryIds can parse the ids. */
function overlayWithId(id: string): string {
  return (
    `${MEMORY_ADVISORY_PREFIX}\n\n### T\nid: ${id}\ntype: note\n` +
    `importance: 1\nttl_days: 0\ndisabled: false\nsupersedes: null\n` +
    `updated_at: 2026-01-01T00:00:00.000Z\n\nbody for ${id}`
  );
}

interface OverlayCall {
  readonly query: string;
  readonly excluded: string[];
}

/** Hub whose per-root overlay offers exactly `candidateIds`, honoring excludeIds. */
async function makeDedupHub(opts: {
  readonly store: SessionStore;
  readonly root: string;
  readonly candidateIds: string[];
  readonly overlayCalls: OverlayCall[];
  readonly onEngineStep?: (state: LoopState) => void;
}): Promise<SessionHub> {
  return new SessionHub({
    store: opts.store,
    askUser: createNoAskUser(),
    surface: "serve",
    buildEngine: async () => {
      const inner = makeDeps([
        assistantResult({ texts: ["a1"] }),
        assistantResult({ texts: ["a2"] }),
      ]);
      return {
        deps: {
          ...inner,
          adapter: {
            ...inner.adapter,
            step: async (state, request, signal) => {
              opts.onEngineStep?.(state);
              return inner.adapter.step(state, request, signal);
            },
          },
        },
        overlayMemoryPrefetch: async (query, prefetchOpts) => {
          opts.overlayCalls.push({
            query,
            excluded: [...(prefetchOpts?.excludeIds ?? [])],
          });
          const remaining = opts.candidateIds.filter(
            (id) => !prefetchOpts?.excludeIds?.has(id)
          );
          return remaining.map(overlayWithId).join("\n\n");
        },
      };
    },
  });
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

describe("SessionHub — session-level prefetch dedup", () => {
  it("does not re-inject the same memory on a second query in the same conversation while the first block stays in history", async () => {
    const store = new SessionStore(await tmpDir("iknow-dedup-store-"));
    const root = await tmpDir("iknow-dedup-root-");
    const overlayCalls: OverlayCall[] = [];
    /** User texts visible to the engine, one entry per postMessage turn. */
    const turnUserTexts: string[][] = [];
    const hub = await makeDedupHub({
      store,
      root,
      candidateIds: ["mem-1"],
      overlayCalls,
      onEngineStep: (state) => {
        turnUserTexts.push(
          state.messages.filter((m) => m.role === "user").map(userTextOf)
        );
      },
    });
    await hub.bindWorkspace(root);
    const s1 = await hub.createSession();
    const conversationId = s1.session.conversation_id;

    await hub.postMessage({ conversationId, text: "same query" });
    await hub.postMessage({ conversationId, text: "same query" });

    // Turn 1 offered the memory; turn 2 saw it excluded (already injected).
    assert.equal(overlayCalls.length, 2);
    assert.deepEqual(overlayCalls[0]!.excluded, []);
    assert.ok(overlayCalls[1]!.excluded.includes("mem-1"));

    // Turn 2's own user message carries no advisory block.
    const turn2Texts = turnUserTexts[1]!;
    const turn2Own = turn2Texts[turn2Texts.length - 1]!;
    assert.ok(
      !turn2Own.includes(MEMORY_ADVISORY_PREFIX),
      "second turn must not re-inject"
    );
    assert.ok(turn2Own.includes("same query"));
    // History is append-only: turn 1's injected block is still visible.
    assert.ok(
      turn2Texts.some(
        (t) => t.includes(MEMORY_ADVISORY_PREFIX) && t.includes("mem-1")
      ),
      "turn 1 advisory block must stay in history"
    );
  });

  it("keeps same-query conversations independent, including concurrent turns, and re-injects for a new conversation", async () => {
    const store = new SessionStore(await tmpDir("iknow-dedup-iso-store-"));
    const root = await tmpDir("iknow-dedup-iso-root-");
    const overlayCalls: OverlayCall[] = [];
    const hub = await makeDedupHub({
      store,
      root,
      candidateIds: ["mem-1"],
      overlayCalls,
    });
    await hub.bindWorkspace(root);
    const s1 = await hub.createSession();
    const s2 = await hub.createSession();

    // Concurrent same-query turns in two conversations both inject.
    await Promise.all([
      hub.postMessage({
        conversationId: s1.session.conversation_id,
        text: "same query",
      }),
      hub.postMessage({
        conversationId: s2.session.conversation_id,
        text: "same query",
      }),
    ]);
    assert.equal(overlayCalls.length, 2);
    assert.deepEqual(
      overlayCalls.map((c) => c.excluded),
      [[], []],
      "each conversation starts with its own empty injected set"
    );

    // Conversation 1 is now deduped…
    await hub.postMessage({
      conversationId: s1.session.conversation_id,
      text: "same query",
    });
    assert.ok(overlayCalls[2]!.excluded.includes("mem-1"));
    // …while a brand-new conversation with the same query injects again.
    const s3 = await hub.createSession();
    await hub.postMessage({
      conversationId: s3.session.conversation_id,
      text: "same query",
    });
    assert.deepEqual(overlayCalls[3]!.excluded, []);
  });

  it("does not re-inject memories recovered from resumed history (cold start)", async () => {
    const store = new SessionStore(await tmpDir("iknow-dedup-resume-store-"));
    const root = await tmpDir("iknow-dedup-resume-root-");
    const conversationId = "resume-prefetch-1";
    const now = "2026-01-01T00:00:00.000Z";
    const file: SessionFileV1 = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: conversationId,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${overlayWithId("mem-9")}${MEMORY_PREFETCH_END}earlier question`,
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "earlier answer" }],
        },
      ],
      jsonMode: false,
      turnCount: 1,
      updatedAt: now,
      title: "",
      cwd: process.cwd(),
      sanitized_at: now,
      checkpoints: [],
      workspaceRoot: root,
    };
    await store.save({ id: conversationId, file });

    const overlayCalls: OverlayCall[] = [];
    const turnUserTexts: string[][] = [];
    const hub = await makeDedupHub({
      store,
      root,
      candidateIds: ["mem-9"],
      overlayCalls,
      onEngineStep: (state) => {
        turnUserTexts.push(
          state.messages.filter((m) => m.role === "user").map(userTextOf)
        );
      },
    });
    await hub.bindWorkspace(root);
    await hub.postMessage({ conversationId, text: "resumed query" });

    assert.equal(overlayCalls.length, 1);
    assert.ok(
      overlayCalls[0]!.excluded.includes("mem-9"),
      "resumed advisory ids must reach the overlay as excludeIds"
    );
    // The new turn's own user message carries no advisory block.
    const turn1Texts = turnUserTexts[0]!;
    const turn1Own = turn1Texts[turn1Texts.length - 1]!;
    assert.ok(
      !turn1Own.includes(MEMORY_ADVISORY_PREFIX),
      "resumed conversation must not re-inject"
    );
    assert.ok(turn1Own.includes("resumed query"));
  });
});
