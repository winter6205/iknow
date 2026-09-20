/**
 * ADR-0108 — disk / load / prior three-face alignment for interrupt frozen
 * prefix keep.
 *
 * Certifies specs/interrupt-frozen-prefix-keep.md SC3/SC4 and the
 * input-contract table's persist/load rows:
 *  - cancelled with freeze prefix → load yields [user, assistant(prefix), interrupt];
 *  - cancelled without prefix (only a still-growing block) → load yields [user, interrupt];
 *  - the next ordinary turn's model prior carries prefix and interrupt;
 *  - `/continue` drops the trailing interrupt from this turn's prior, the
 *    prefix stays, and the on-disk interrupt is kept.
 *
 * Integration discipline (project test.md): real SessionStore (temp dir) +
 * real conversationId (fresh-session end-to-end walk, no pre-stored session
 * file).
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import type {
  AnthropicNativeMessage,
  LoopAdapter,
  LoopEngineDeps,
} from "../../src/harness/index.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import {
  makeStreamKeepAdapter,
  textOf,
} from "../_helpers/stream-keep-fixtures.ts";

const INTERRUPT_TEXT = "Interrupted by user.";
/** Byte-identical to the harness fixture: two pinned blocks + one still growing. */
const FROZEN_PREFIX = "## Head\n\nFirst paragraph.\n\n";
const GROWING_TAIL = "Second parag";

function isInterrupt(msg: AnthropicNativeMessage): boolean {
  return (
    msg.role === "system" &&
    msg.content.length === 1 &&
    textOf(msg) === INTERRUPT_TEXT
  );
}

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-t4-frozen-"));
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function makeHub(adapter: LoopAdapter): SessionHub {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  const deps: LoopEngineDeps = {
    adapter,
    executor: createExecutor(registry),
    registry,
    maxTurns: 5,
  };
  return new SessionHub({ store, deps, workspaceRoot: process.cwd() });
}

describe("ADR-0108 T4 persist/load — cancelled 盘面形状", () => {
  it("SC3: 有 freeze 前缀 → fresh session load 出 user + assistant(prefix) + interrupt", async () => {
    let fireStream!: () => void;
    const streamSeen = new Promise<void>((resolve) => {
      fireStream = () => resolve();
    });
    const { adapter } = makeStreamKeepAdapter(
      [{ deltas: [FROZEN_PREFIX, GROWING_TAIL] }],
      {
        onFirstStream: () => {
          fireStream();
        },
      }
    );
    const hub = makeHub(adapter);
    // Fresh conversationId (no pre-stored session file), end-to-end walk.
    const { session } = await hub.createSession();
    const controller = new AbortController();
    const p = hub.postMessage({
      conversationId: session.conversation_id,
      text: "write for me",
      signal: controller.signal,
    });
    await streamSeen;
    controller.abort();
    const res = await p;
    assert.equal(res.turn.answer.stopReason, "cancelled");
    assert.equal(res.turn.answer.interrupted, true);

    // Load face (reopen = store.load): disk shape identical across the three faces.
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 3);
    assert.equal(loaded.messages[0]!.role, "user");
    assert.equal(loaded.messages[1]!.role, "assistant");
    assert.equal(textOf(loaded.messages[1]!), FROZEN_PREFIX);
    assert.ok(isInterrupt(loaded.messages[2]!));
    // The checkpoint records the interrupted turn.
    assert.equal(loaded.checkpoints?.[0]?.interruptReason, "cancelled");
    assert.equal(loaded.checkpoints?.[0]?.messagesCount, 3);
  });

  it("persist 表 empty 行: 仅还在长的块（无 prefix）→ load = user + interrupt，无 assistant", async () => {
    let fireStream!: () => void;
    const streamSeen = new Promise<void>((resolve) => {
      fireStream = () => resolve();
    });
    const { adapter } = makeStreamKeepAdapter(
      [{ deltas: ["only one still-growing block"] }],
      {
        onFirstStream: () => {
          fireStream();
        },
      }
    );
    const hub = makeHub(adapter);
    const { session } = await hub.createSession();
    const controller = new AbortController();
    const p = hub.postMessage({
      conversationId: session.conversation_id,
      text: "q",
      signal: controller.signal,
    });
    await streamSeen;
    controller.abort();
    const res = await p;
    assert.equal(res.turn.answer.stopReason, "cancelled");
    const loaded = await store.load(session.conversation_id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0]!.role, "user");
    assert.ok(isInterrupt(loaded.messages[1]!));
    assert.ok(
      !loaded.messages.some((m) => m.role === "assistant"),
      "无 prefix 不得落 assistant"
    );
  });
});

describe("ADR-0108 T4 prior — 下一句与 /continue", () => {
  it("SC4: 普通下一句 model prior 带 freeze 前缀与 interrupt", async () => {
    let fireStream!: () => void;
    const streamSeen = new Promise<void>((resolve) => {
      fireStream = () => resolve();
    });
    const { adapter, stepPriors } = makeStreamKeepAdapter(
      [
        { deltas: [FROZEN_PREFIX, GROWING_TAIL] },
        { result: assistantResult({ texts: ["resumed"] }) },
      ],
      {
        onFirstStream: () => {
          fireStream();
        },
      }
    );
    const hub = makeHub(adapter);
    const { session } = await hub.createSession();
    const controller = new AbortController();
    const p = hub.postMessage({
      conversationId: session.conversation_id,
      text: "write for me",
      signal: controller.signal,
    });
    await streamSeen;
    controller.abort();
    await p;

    const res2 = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "keep going with this",
    });
    assert.equal(res2.turn.answer.stopReason, "completed");
    // 2nd step's received prior = full disk state + the new user line.
    const prior = stepPriors[1] ?? [];
    assert.ok(prior.length >= 4);
    const assistantWithPrefix = prior.filter(
      (m) => m.role === "assistant" && textOf(m) === FROZEN_PREFIX
    );
    assert.equal(assistantWithPrefix.length, 1);
    assert.ok(
      prior.some(isInterrupt),
      "普通下一句 prior 必须带 interrupt（invariant 7）"
    );
    const last = prior[prior.length - 1]!;
    assert.equal(last.role, "user");
    assert.equal(textOf(last), "keep going with this");
    // Relative order of interrupt and prefix: assistant(prefix) precedes interrupt.
    const idxAssistant = prior.findIndex(
      (m) => m.role === "assistant" && textOf(m) === FROZEN_PREFIX
    );
    const idxInterrupt = prior.findIndex(isInterrupt);
    assert.ok(idxAssistant >= 0 && idxInterrupt > idxAssistant);
  });

  it("SC4: /continue 本次 prior 去掉末尾 interrupt、前缀仍在；盘上 interrupt 保留", async () => {
    let fireStream!: () => void;
    const streamSeen = new Promise<void>((resolve) => {
      fireStream = () => resolve();
    });
    const { adapter, stepPriors } = makeStreamKeepAdapter(
      [
        { deltas: [FROZEN_PREFIX, GROWING_TAIL] },
        { result: assistantResult({ texts: ["continue answer"] }) },
      ],
      {
        onFirstStream: () => {
          fireStream();
        },
      }
    );
    const hub = makeHub(adapter);
    const { session } = await hub.createSession();
    const controller = new AbortController();
    const p = hub.postMessage({
      conversationId: session.conversation_id,
      text: "write for me",
      signal: controller.signal,
    });
    await streamSeen;
    controller.abort();
    await p;

    const res = await hub.continueSession(session.conversation_id);
    assert.equal(res.turn.answer.stopReason, "completed");
    assert.equal(res.turn.answer.finalText, "continue answer");
    // /continue's model prior for this turn: trailing interrupt dropped, prefix kept.
    const prior = stepPriors[1] ?? [];
    assert.ok(
      !prior.some(isInterrupt),
      "/continue model prior 不得带末尾 interrupt"
    );
    assert.ok(
      prior.some(
        (m) => m.role === "assistant" && textOf(m) === FROZEN_PREFIX
      ),
      "/continue prior 必须保留 freeze 前缀 assistant"
    );
    // On disk: the interrupt persists, sandwiched between the prefix and this turn's new assistant.
    const loaded = await store.load(session.conversation_id);
    const idxInterrupt = loaded.messages.findIndex(isInterrupt);
    const idxPrefix = loaded.messages.findIndex(
      (m) => m.role === "assistant" && textOf(m) === FROZEN_PREFIX
    );
    assert.ok(idxPrefix >= 0);
    assert.ok(
      idxInterrupt > idxPrefix,
      "盘上 interrupt 必须仍在前缀之后（未被 continue 抹掉）"
    );
    const tail = loaded.messages[loaded.messages.length - 1]!;
    assert.equal(tail.role, "assistant");
    assert.equal(textOf(tail), "continue answer");
  });
});
