/**
 * Regression coverage for the interactive chat host's busy → idle transition.
 *
 * A terminal notice received during a parent turn must remain pending and
 * start the silent wake as soon as that turn becomes idle, without another
 * user line.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnthropicNativeMessage,
  AssistantTurnResult,
} from "../../src/harness/index.ts";
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentTerminalNotice } from "../../src/harness/subagent/mailbox.ts";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import {
  assistantResult as fixtureAssistantResult,
  makeDeps,
} from "./_fixtures.ts";

const mockState = vi.hoisted(() => ({
  readline: {
    createInterface: vi.fn(),
  },
  sessionIo: {
    clearErrLine: vi.fn(),
    isInteractive: vi.fn(() => true),
    writeErr: vi.fn(),
    writeOut: vi.fn(),
  },
}));

vi.mock("node:readline", () => mockState.readline);
vi.mock("../../src/cli/session-io.ts", () => mockState.sessionIo);

class FakeReadline extends EventEmitter {
  readonly pause = vi.fn();
  readonly prompt = vi.fn();
  readonly resume = vi.fn();
  readonly setPrompt = vi.fn();

  close(): void {
    this.emit("close");
  }
}

function assistantResult(text: string): AssistantTurnResult {
  const nativeMessage: AnthropicNativeMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
  };
  return {
    nativeMessage,
    projection: { nativeMessage, texts: [text], toolCalls: [] },
    supplierStop: "success",
    needsTools: false,
    isEmptyFinalResponse: false,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function managerWithTerminalNotice(): {
  readonly manager: SubAgentManager;
  readonly publish: (notice: SubAgentTerminalNotice) => void;
  readonly markTerminal: () => void;
} {
  const subscribers = new Set<(notice: SubAgentTerminalNotice) => void>();
  let terminal = false;
  const manager = {
    spawn: () => ({ taskId: "unused" }),
    queryBuffer: () => ({ status: "not_found" as const }),
    waitFor: async () => {
      throw new Error("unused");
    },
    shutdown: async () => {},
    drainCompleted: () =>
      terminal
        ? [
            {
              taskId: "child-1",
              envelope: {
                status: "ok" as const,
                summary: "child complete",
                result: "child result",
              },
            },
          ]
        : [],
    listActive: () => [],
    abortTask: () => false,
    getCapacity: () => 15,
    listSubagents: () => [],
    subscribe: (subscriber: (notice: SubAgentTerminalNotice) => void) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  } as SubAgentManager;
  return {
    manager,
    markTerminal: () => {
      terminal = true;
    },
    publish: (notice) => {
      for (const subscriber of [...subscribers]) subscriber(notice);
    },
  };
}

describe("interactive chat subagent wake", () => {
  let baseDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    // Fresh temp store root + workspace so the wake run commits into a temp
    // tree, never ~/.iknow or the real repo project slug.
    baseDir = await mkdtemp(join(tmpdir(), "iknow-chat-wake-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "iknow-chat-wake-root-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("flushes a pending terminal wake when the parent turn becomes idle", async () => {
    const readline = new FakeReadline();
    mockState.readline.createInterface.mockReturnValue(readline);

    const firstStepStarted = deferred<void>();
    const releaseFirstStep = deferred<AssistantTurnResult>();
    const managerFixture = managerWithTerminalNotice();
    const deps = makeDeps([
      fixtureAssistantResult({ texts: ["unused"] }),
      fixtureAssistantResult({ texts: ["unused"] }),
    ]);
    let stepCalls = 0;
    const baseAdapter = deps.adapter;
    deps.adapter = {
      ...baseAdapter,
      step: async () => {
        stepCalls += 1;
        if (stepCalls === 1) {
          firstStepStarted.resolve();
          return releaseFirstStep.promise;
        }
        return assistantResult("silent wake answer");
      },
    };

    const { runChatSession } = await import("../../src/cli/chat-session.ts");
    const conversationId = randomUUID();
    const sessionPromise = runChatSession({
      deps,
      session: {},
      jsonMode: false,
      subagentManager: managerFixture.manager,
      dataDir: baseDir,
      conversationId,
      workspaceRoot,
    });
    await vi.waitFor(() =>
      expect(mockState.readline.createInterface).toHaveBeenCalledTimes(1)
    );
    readline.emit("line", "parent question");
    await firstStepStarted.promise;

    managerFixture.markTerminal();
    managerFixture.publish({
      taskId: "child-1",
      status: "ok",
      summary: "child complete",
      result: "child result",
    });
    releaseFirstStep.resolve(assistantResult("parent answer"));

    await vi.waitFor(() => expect(stepCalls).toBe(2));
    await vi.waitFor(() =>
      expect(mockState.sessionIo.writeOut).toHaveBeenCalledWith(
        expect.stringContaining("silent wake answer")
      )
    );

    readline.close();
    await sessionPromise;

    // Positive isolation proof (issue #1197 cause 1): the wake session
    // committed into the temp dataDir namespace — the exact
    // (resolveServeDataDir(dataDir), deriveProjectIdentityRoot({ cwd })) pair
    // chat-session.ts builds, not ~/.iknow or the real repo project slug.
    // load() is title-agnostic, so this asserts persistence without leaning on
    // list()'s #1197 blank-title filter.
    const reader = new SessionStore(
      baseDir,
      deriveProjectIdentityRoot({ cwd: workspaceRoot })
    );
    const persisted = await reader.load(conversationId);
    const transcriptText = persisted.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("\n");
    expect(transcriptText).toContain("parent answer");
    expect(transcriptText).toContain("silent wake answer");
  });
});
