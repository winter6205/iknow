/**
 * ADR-0150: a rebind keeps the pre-rebind managers registered, so their
 * terminal generations stay deliverable — and each generation is delivered
 * exactly once, across the rebind, across the old manager's shutdown, and
 * across a resume (same taskId, new terminal generation).
 *
 * The fake manager is NOT a mock of the delivery seam: it delegates to the
 * real `createDeliveryLedger()`, so claim / acknowledge / release are the
 * production semantics.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createDeliveryLedger } from "../../src/harness/subagent/delivery-ledger.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import { createSubAgentMailbox } from "../../src/harness/subagent/mailbox.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

type Completion = {
  readonly taskId: string;
  readonly envelope: SubAgentEnvelope;
};

/** The digest prefix the parent-visible projection puts in front of a result. */
const digestNeedle = (taskId: string): string =>
  `## Sub-agent ${taskId} result`;

interface FakeEntry {
  readonly conversationId: string;
  readonly taskId: string;
  readonly terminalSeq: number;
  readonly envelope: SubAgentEnvelope;
}

function makeManager(label: string): {
  readonly manager: SubAgentManager;
  /** Publish a terminal generation; a second call for the same taskId is a resume. */
  complete: (
    conversationId: string,
    opts?: { readonly taskId?: string; readonly summary?: string }
  ) => void;
} {
  const mailbox = createSubAgentMailbox();
  const ledger = createDeliveryLedger();
  const entries: FakeEntry[] = [];
  let terminalSeq = 0;
  const scoped = (conversationId?: string): FakeEntry[] =>
    entries.filter(
      (entry) =>
        conversationId === undefined || entry.conversationId === conversationId
    );
  const manager: SubAgentManager = {
    spawn: () => ({ taskId: `${label}-spawned` }),
    queryBuffer: () => ({ status: "not_found" }),
    waitFor: async () => {
      throw new Error("unused");
    },
    // The production manager clears its tasks and its ledger on shutdown.
    shutdown: async () => {
      entries.length = 0;
      ledger.clear();
    },
    drainCompleted: (conversationId, opts) => {
      const rows = scoped(conversationId);
      const visible =
        opts?.includeDelivered === true ? rows : ledger.undelivered(rows);
      return visible.map((entry) => ({
        taskId: entry.taskId,
        envelope: entry.envelope,
      }));
    },
    claimCompleted: (conversationId) => ledger.claim(scoped(conversationId)),
    acknowledgeDeliveries: (claims) => ledger.acknowledge(claims),
    releaseDeliveries: (claims) => ledger.release(claims),
    listActive: () => [],
    abortTask: () => false,
    getCapacity: () => 15,
    listSubagents: () => [],
    subscribe: mailbox.subscribe,
  };

  return {
    manager,
    complete: (conversationId, opts) => {
      const taskId = opts?.taskId ?? `${label}-task`;
      const summary = opts?.summary ?? `${label} summary`;
      terminalSeq += 1;
      const completion: Completion = {
        taskId,
        envelope: { status: "ok", summary, result: summary },
      };
      entries.push({
        conversationId,
        taskId,
        terminalSeq,
        envelope: completion.envelope,
      });
      mailbox.publish({
        taskId: completion.taskId,
        conversationId,
        status: completion.envelope.status,
        summary: completion.envelope.summary,
        result: completion.envelope.result,
      });
    },
  };
}

/** How often `needle` appears in the persisted history, counted per text block. */
async function textCountOnDisk(
  store: SessionStore,
  id: string,
  needle: string
): Promise<number> {
  const file = await store.load(id);
  let count = 0;
  for (const message of file.messages) {
    for (const block of message.content) {
      if (block.type === "text" && block.text.includes(needle)) count += 1;
    }
  }
  return count;
}

const digestCountOnDisk = (
  store: SessionStore,
  id: string,
  taskId: string
): Promise<number> => textCountOnDisk(store, id, digestNeedle(taskId));

function ensureDeps(hub: SessionHub, root: string): Promise<unknown> {
  return (
    hub as unknown as {
      ensureDeps: (sessionRoot?: string) => Promise<unknown>;
    }
  ).ensureDeps(root);
}

async function prepareReboundHub(): Promise<{
  readonly baseDir: string;
  readonly store: SessionStore;
  readonly hub: SessionHub;
  readonly conversationId: string;
  readonly oldManager: ReturnType<typeof makeManager>;
  readonly newManager: ReturnType<typeof makeManager>;
  readonly reboundRoot: string;
}> {
  const baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-subagent-rebind-"));
  const store = new SessionStore(baseDir, process.cwd());
  const oldManager = makeManager("before");
  const newManager = makeManager("after");
  // One scripted reply per wake the tests drive (each delivery is its own
  // silent turn).
  const reboundDeps = makeDeps([
    assistantResult({ texts: ["woken"] }),
    assistantResult({ texts: ["woken again"] }),
    assistantResult({ texts: ["woken once more"] }),
    assistantResult({ texts: ["woken a third time"] }),
    assistantResult({ texts: ["woken a fourth time"] }),
  ]);
  const hub = new SessionHub({
    store,
    deps: makeDeps([assistantResult({ texts: ["initial"] })]),
    subagentManager: oldManager.manager,
    surface: "serve",
    injectedEngineRoot: baseDir,
    buildEngine: async () => ({
      deps: reboundDeps,
      subagentManager: newManager.manager,
    }),
  });
  await hub.bindWorkspace(baseDir);
  const created = await hub.createSession();
  await hub.postMessage({
    conversationId: created.session.conversation_id,
    text: "start",
  });

  const reboundRoot = join(baseDir, "rebound");
  await mkdir(reboundRoot);
  const file = await store.load(created.session.conversation_id);
  await store.save({
    id: created.session.conversation_id,
    file: { ...file, workspaceRoot: reboundRoot },
  });
  await ensureDeps(hub, reboundRoot);

  return {
    baseDir,
    store,
    hub,
    conversationId: created.session.conversation_id,
    oldManager,
    newManager,
    reboundRoot,
  };
}

const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path !== undefined) {
      // A wake that is still finishing its turn can write into the session
      // directory while the temp tree is removed; retry so the cleanup does not
      // race the background write.
      await rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    }
  }
});

describe("SessionHub subagent manager aggregation across rebind", () => {
  it("wakes the host for a result emitted by the manager after rebind", async () => {
    const setup = await prepareReboundHub();
    cleanup.push(setup.baseDir);

    setup.newManager.complete(setup.conversationId);

    await expect
      .poll(
        async () => {
          const file = await setup.store.load(setup.conversationId);
          return file.messages.some((message) =>
            message.content.some(
              (block) =>
                block.type === "text" &&
                block.text.includes("## Sub-agent after-task result")
            )
          );
        },
        { timeout: 2_000 }
      )
      .toBe(true);
  });

  it("keeps draining a running task from before rebind instead of only using the latest manager", async () => {
    const setup = await prepareReboundHub();
    cleanup.push(setup.baseDir);

    setup.oldManager.complete(setup.conversationId);

    await expect
      .poll(
        async () => {
          const file = await setup.store.load(setup.conversationId);
          return file.messages.some((message) =>
            message.content.some(
              (block) =>
                block.type === "text" &&
                block.text.includes("## Sub-agent before-task result")
            )
          );
        },
        { timeout: 2_000 }
      )
      .toBe(true);
  });

  it("delivers each manager's result exactly once across the rebind", async () => {
    const setup = await prepareReboundHub();
    cleanup.push(setup.baseDir);

    setup.oldManager.complete(setup.conversationId);
    await expect
      .poll(
        async () =>
          digestCountOnDisk(setup.store, setup.conversationId, "before-task"),
        { timeout: 5_000 }
      )
      .toBe(1);

    setup.newManager.complete(setup.conversationId);
    await expect
      .poll(
        async () =>
          digestCountOnDisk(setup.store, setup.conversationId, "after-task"),
        { timeout: 5_000 }
      )
      .toBe(1);

    // Another wake / turn must not duplicate either delivery.
    await setup.hub
      .wakeFromSubagent({ conversationId: setup.conversationId })
      .catch(() => undefined);

    expect(
      await digestCountOnDisk(setup.store, setup.conversationId, "before-task")
    ).toBe(1);
    expect(
      await digestCountOnDisk(setup.store, setup.conversationId, "after-task")
    ).toBe(1);
  });

  it("does not replay a delivered result after the old manager shuts down", async () => {
    const setup = await prepareReboundHub();
    cleanup.push(setup.baseDir);

    setup.oldManager.complete(setup.conversationId);
    await expect
      .poll(
        async () =>
          digestCountOnDisk(setup.store, setup.conversationId, "before-task"),
        { timeout: 5_000 }
      )
      .toBe(1);
    expect(
      setup.oldManager.manager.drainCompleted(setup.conversationId)
    ).toHaveLength(0);

    await setup.oldManager.manager.shutdown();

    // The shutdown clears the manager's buffer and its ledger; a delivered
    // generation is never resurrected by it.
    expect(
      setup.oldManager.manager.drainCompleted(setup.conversationId)
    ).toHaveLength(0);
    setup.newManager.complete(setup.conversationId);
    await expect
      .poll(
        async () =>
          digestCountOnDisk(setup.store, setup.conversationId, "after-task"),
        { timeout: 5_000 }
      )
      .toBe(1);
    await setup.hub
      .wakeFromSubagent({ conversationId: setup.conversationId })
      .catch(() => undefined);

    expect(
      await digestCountOnDisk(setup.store, setup.conversationId, "before-task")
    ).toBe(1);
  });

  it("delivers a resumed task's new generation once and does not replay the old one", async () => {
    const setup = await prepareReboundHub();
    cleanup.push(setup.baseDir);

    setup.oldManager.complete(setup.conversationId, {
      taskId: "resumed-task",
      summary: "first generation",
    });
    await expect
      .poll(
        async () =>
          textCountOnDisk(
            setup.store,
            setup.conversationId,
            "first generation"
          ),
        { timeout: 5_000 }
      )
      .toBe(1);

    // A resume keeps the taskId but produces a NEW terminal generation.
    setup.oldManager.complete(setup.conversationId, {
      taskId: "resumed-task",
      summary: "second generation",
    });
    await expect
      .poll(
        async () =>
          textCountOnDisk(
            setup.store,
            setup.conversationId,
            "second generation"
          ),
        { timeout: 5_000 }
      )
      .toBe(1);

    await setup.hub
      .wakeFromSubagent({ conversationId: setup.conversationId })
      .catch(() => undefined);

    expect(
      await textCountOnDisk(
        setup.store,
        setup.conversationId,
        "first generation"
      )
    ).toBe(1);
    expect(
      await textCountOnDisk(
        setup.store,
        setup.conversationId,
        "second generation"
      )
    ).toBe(1);
    expect(
      await digestCountOnDisk(setup.store, setup.conversationId, "resumed-task")
    ).toBe(2);
  });

  it("does not wake the most recent session for another session's terminal notice", async () => {
    const baseDir = await mkdtemp(
      join(tmpdir(), "iknow-hub-subagent-wake-scope-")
    );
    cleanup.push(baseDir);
    const mailbox = createSubAgentMailbox();
    const manager: SubAgentManager = {
      spawn: () => ({ taskId: "unused" }),
      queryBuffer: () => ({ status: "not_found" }),
      getCapacity: () => 15,
      waitFor: async () => {
        throw new Error("unused");
      },
      shutdown: async () => {},
      drainCompleted: () => [],
      listActive: () => [],
      abortTask: () => false,
      listSubagents: () => [],
      subscribe: mailbox.subscribe,
      // This manager's buffer is always empty, so the delivery seam never
      // has a generation to take.
      claimCompleted: () => [],
      acknowledgeDeliveries: () => {},
      releaseDeliveries: () => {},
    };
    const hub = new SessionHub({
      store: new SessionStore(baseDir, process.cwd()),
      deps: makeDeps([]),
      subagentManager: manager,
      surface: "serve",
    });
    const wake = vi.spyOn(hub, "wakeFromSubagent").mockResolvedValue(undefined);
    (hub as unknown as { lastConversationId: string }).lastConversationId =
      "session-b";

    mailbox.publish({
      taskId: "session-a-task",
      conversationId: "session-a",
      status: "ok",
      summary: "A done",
      result: "A result",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(wake).not.toHaveBeenCalled();
    await hub.shutdown();
  });
});
