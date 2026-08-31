import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import { createSubAgentMailbox } from "../../src/harness/subagent/mailbox.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

type Completion = {
  readonly taskId: string;
  readonly envelope: SubAgentEnvelope;
};

function makeManager(label: string): {
  readonly manager: SubAgentManager;
  complete: (conversationId: string) => void;
} {
  const mailbox = createSubAgentMailbox();
  let completed: ReadonlyArray<Completion> = [];
  const manager: SubAgentManager = {
    spawn: () => ({ taskId: `${label}-spawned` }),
    queryBuffer: () => ({ status: "not_found" }),
    waitFor: async () => {
      throw new Error("unused");
    },
    shutdown: async () => {},
    drainCompleted: () => completed,
    listActive: () => [],
    abortTask: () => false,
    listSubagents: () => [],
    subscribe: mailbox.subscribe,
  };

  return {
    manager,
    complete: (conversationId) => {
      const completion: Completion = {
        taskId: `${label}-task`,
        envelope: {
          status: "ok",
          summary: `${label} summary`,
          result: `${label} result`,
        },
      };
      completed = [completion];
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
  const store = new SessionStore(baseDir);
  const oldManager = makeManager("before");
  const newManager = makeManager("after");
  const reboundDeps = makeDeps([assistantResult({ texts: ["woken"] })]);
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
    if (path !== undefined) await rm(path, { recursive: true, force: true });
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

  it("does not wake the most recent session for another session's terminal notice", async () => {
    const baseDir = await mkdtemp(
      join(tmpdir(), "iknow-hub-subagent-wake-scope-")
    );
    cleanup.push(baseDir);
    const mailbox = createSubAgentMailbox();
    const manager: SubAgentManager = {
      spawn: () => ({ taskId: "unused" }),
      queryBuffer: () => ({ status: "not_found" }),
      waitFor: async () => {
        throw new Error("unused");
      },
      shutdown: async () => {},
      drainCompleted: () => [],
      listActive: () => [],
      abortTask: () => false,
      listSubagents: () => [],
      subscribe: mailbox.subscribe,
    };
    const hub = new SessionHub({
      store: new SessionStore(baseDir),
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
