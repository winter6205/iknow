/**
 * Root cause of the lost-injection fork: injected messages (agent_status bar /
 * graph switch notice) were appended immutably to the in-memory authoritative
 * history as user messages but never passed through `commitMessages` onto the
 * JSONL chain. The host's post-run save (hub conditionalSave / chat
 * persistChatSessionCheckpoint) LCP-aligns the in-memory projection (which
 * contains injected messages) against the pure commit chain — diverging at the
 * first injected message — so `planSessionSave` judges it a fork and `parent`
 * falls back to an earlier chain event (observed in the field: parent=e0).
 * Once the forked projection becomes the new head, the next run's
 * `session.messages` projection loses the orphaned prefix and the model
 * replays the whole turn from the raw query.
 *
 * Pinned invariants (SSOT: loop-engine's commit discipline):
 *   1. injected messages must flush with the next assistant / tool_result
 *      commit batch (same shape as the loop-detected envelope precedent), so
 *      "in-memory authoritative history − query" == "on-disk commit chain −
 *      the query prefix lazily committed by the host".
 *   2. cancelled stop path: flush pending injections + system interrupt
 *      together before appendSystemInterrupt — the checkpoint save's
 *      projection then aligns with the chain; no fork.
 *   3. protocolError / emptyFinalResponse keep the existing ruling (that turn
 *      never enters history); pending injections are dropped with it, save
 *      still classifies a prefix and moves head back (existing semantics, no
 *      new fork surface).
 *   4. end-to-end (store level): a cancelled run with agentStatus present,
 *      followed by the closing save, leaves no orphan branch on disk (no
 *      fork); head chain == in-memory projection.
 */
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../src/harness/loop-engine.ts";
import type {
  AnthropicNativeMessage,
  LoopEngineDeps,
} from "../../src/harness/index.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  projectSessionLog,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { makeTodoDir } from "./_agent-status-fixtures.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  // Cleanup failure must fail afterAll directly (no empty catch swallowing errors).
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

function emptySessionFile(id: string, workspaceRoot: string): SessionFileV1 {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    title: "",
    cwd: workspaceRoot,
    sanitized_at: new Date().toISOString(),
    checkpoints: [],
    workspaceRoot,
  };
}

/** One run of the shape "model calls a tool once; abort after the first
 * commit lands → cancelled". abort is triggered synchronously inside the
 * first commitMessages batch, deterministically placing the cancel after
 * assistant/tool_result are committed and before the next model call —
 * exactly the timing where the save projection diverges from the on-disk
 * chain at an injected message. A setTimeout race could land before the
 * first commit (empty chain, no fork) and would fail to pin the invariant. */
function interruptAfterFirstCommitDeps(
  commitMessages: LoopEngineDeps["commitMessages"],
  todoDir: string,
  controller: AbortController
): LoopEngineDeps {
  const tool = createStubTool({ name: "alpha", next: () => "result-a" });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  const adapter = createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: [{ id: "a", name: "alpha", input: {} }],
      }),
      assistantResult({
        texts: ["never arrives"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
  let firstCommitSeen = false;
  return {
    adapter,
    executor,
    registry,
    maxTurns: 5,
    agentStatus: { todoDir },
    commitMessages: async (messages) => {
      await commitMessages?.(messages);
      if (!firstCommitSeen) {
        firstCommitSeen = true;
        controller.abort();
      }
    },
  };
}

// -- 1. completed run: injections ride the batch; flattened commits = history − query --

describe("#888 commit discipline: injected messages ride the next commit", () => {
  it("completed run: 展平 commit 批 == 权威历史（除 query），注入栏在批内", async () => {
    const todoDir = await makeTodoDir("- [ ] pending task\n");
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    const commitMessages = async (
      messages: ReadonlyArray<AnthropicNativeMessage>
    ): Promise<void> => {
      committed.push(messages);
    };
    const tool = createStubTool({ name: "alpha", next: () => "result-a" });
    const registry = createRegistry([tool]);
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "a", name: "alpha", input: {} }],
        }),
        assistantResult({ texts: ["done"], toolCalls: [] }),
      ],
    });
    const { result } = await run("go", {
      adapter,
      executor: createExecutor(registry),
      registry,
      maxTurns: 5,
      agentStatus: { todoDir },
      commitMessages,
    });
    assert.equal(result.stopReason, "completed");
    // Flattened commit batches = authoritative history minus the query
    // (the query is held by the host's lazy-commit discipline and never
    // enters run()'s commit stream; the comparison baseline drops the seed).
    const flat = committed.flat();
    const tail = result.messages.slice(1); // drop the seed query
    assert.deepEqual(
      flat,
      tail,
      "flattened commit batches must equal the authoritative history minus the query"
    );
  });

  it("cancelled run: pending 注入 + system interrupt 在停止路径 flush", async () => {
    const todoDir = await makeTodoDir();
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    const controller = new AbortController();
    const deps = interruptAfterFirstCommitDeps(
      async (messages) => {
        committed.push(messages);
      },
      todoDir,
      controller
    );
    const { result } = await run("x", deps, controller.signal);
    assert.equal(result.stopReason, "cancelled");
    // Authoritative history = [seed query, bar(idle), assistant(a), tool_result, bar(2nd), system interrupt]
    const tail = result.messages.slice(1);
    const flat = committed.flat();
    assert.deepEqual(
      flat,
      tail,
      "cancelled stop must flush pending injected messages + system interrupt so the persisted chain matches the checkpoint projection"
    );
    // The bar really appears in the flushed batches (not silently dropped).
    assert.ok(
      committed
        .flat()
        .some((m) =>
          m.content.some(
            (b) => b.type === "text" && b.text.startsWith("<agent_status>")
          )
        ),
      "status-bar messages must be present in the flushed batches"
    );
  });

  it("protocolError run: pending 注入随 #120 裁决丢弃，不进 commit 流", async () => {
    const todoDir = await makeTodoDir();
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    const tool = createStubTool({ name: "alpha", next: () => "result-a" });
    const registry = createRegistry([tool]);
    // Single response + agentStatus present: the first assistant consumes the
    // response; the queue is exhausted at the second model call → the stub
    // throws ProtocolError (stop; that turn never enters history).
    const adapter = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "a", name: "alpha", input: {} }],
        }),
      ],
    });
    const { result } = await run("go", {
      adapter,
      executor: createExecutor(registry),
      registry,
      maxTurns: 5,
      agentStatus: { todoDir },
      commitMessages: async (messages) => {
        committed.push(messages);
      },
    });
    assert.equal(result.stopReason, "protocolError");
    // The first assistant commit batch flushes the leading bar normally
    // (legitimate batch order [bar_idle, assistant] for a landed turn); the
    // second bar recorded before protocolError must not enter the commit
    // stream: the stop-path ruling keeps that turn out of history, save
    // classifies a strict prefix and moves head back — zero fork surface.
    const flat = committed.flat();
    assert.deepEqual(
      committed.map((b) => b.length),
      [2, 1],
      "batches are [bar_idle, assistant] then [tool_result]; second turn's pending bar must not commit"
    );
    assert.ok(
      !flat
        .slice(2)
        .some((m) =>
          m.content.some(
            (b) => b.type === "text" && b.text.startsWith("<agent_status>")
          )
        ),
      "second pending bar must be dropped on protocolError (no leak into commit stream)"
    );
    // Existing stop-path semantics: the turn never landed, but the in-memory
    // authoritative history keeps the pre-model injected bar (appended before
    // runModelPhase). The closing save rebuilds via fork-copy from the memory
    // projection (complete, lossless), matching the pre-existing shape when
    // nothing was injected. This assertion pins: the pending buffer leaks no
    // second commit — disk holds only [bar, assistant, tr].
    assert.ok(
      result.messages.some((m) =>
        m.content.some(
          (b) => b.type === "text" && b.text.startsWith("<agent_status>")
        )
      ),
      "in-memory history keeps the pre-model bar (existing #120 semantics, injected before runModelPhase)"
    );
  });
});

// -- 2. End-to-end (store level): no fork on disk after a cancelled run's closing save --

describe("#888 end-to-end: cancelled run with injected bars saves without fork", () => {
  it("收尾 save 投影与盘上链对齐：head 链 == 内存投影，无孤儿分支", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "iknow-888-e2e-"));
    tempDirs.push(tmp);
    const store = new SessionStore(tmp, process.cwd());
    const sessionDir = resolveProjectSessionDir(tmp, process.cwd());
    const id = "issue-888-e2e";
    const workspaceRoot = process.cwd();
    await store.save({ id, file: emptySessionFile(id, workspaceRoot) });

    const todoDir = await makeTodoDir();
    const controller = new AbortController();
    const committed: ReadonlyArray<AnthropicNativeMessage>[] = [];
    // Mirror the hub's lazy query-commit discipline (queryCommitPending
    // latch): the engine never commits the seed query; the host prepends the
    // query to the first commit batch and passes it through. The prefix must
    // be byte-identical to run()'s seed construction (encodeUserText("x")).
    let queryCommitPending = true;
    const deps: LoopEngineDeps = interruptAfterFirstCommitDeps(
      async (messages) => {
        const events = queryCommitPending
          ? [deps.adapter.encodeUserText("x"), ...messages]
          : messages;
        queryCommitPending = false;
        await store.appendEvents({ id, events });
        committed.push(events);
      },
      todoDir,
      controller
    );
    const { result } = await run("x", deps, controller.signal);
    assert.equal(result.stopReason, "cancelled");

    // Host closing save (the save shape of chat persistChatSessionCheckpoint /
    // hub conditionalSave: whole file.messages = run result projection).
    await store.save({
      id,
      file: {
        ...emptySessionFile(id, workspaceRoot),
        messages: result.messages,
        turnCount: result.turnCount,
      },
    });

    // On-disk projection must equal the memory projection — a fork means the
    // e1..eN prefix was lost.
    const raw = await readFile(
      join(
        resolveConversationDir({ projectDir: sessionDir, conversationId: id }),
        `${id}.jsonl`
      ),
      "utf8"
    );
    const log = parseSessionJsonl(raw);
    const projected = projectSessionLog(log).messages;
    assert.deepEqual(
      projected,
      [...result.messages],
      "persisted head-chain projection must equal the run's authoritative history (no fork, no orphaned prefix)"
    );

    // No orphan branches: every event sits on the head chain.
    const onChain = new Set<string>();
    let cur = log.head;
    while (cur !== null) {
      onChain.add(cur);
      const ev = log.events.find((e) => e.id === cur);
      if (!ev) break;
      cur = ev.parent;
    }
    const orphans = log.events.filter((e) => !onChain.has(e.id));
    assert.equal(
      orphans.length,
      0,
      `no orphan branch events expected, got: ${orphans.map((e) => e.id).join(", ")}`
    );
    void committed;
  });
});
