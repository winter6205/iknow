/**
 * Activity-reader wiring in the TUI assembly layer (`src/tui/deps.ts`) —
 * specs/subagent-card-title.md.
 *
 * The spawn card's line-2 in-flight tool name only exists if the manager got
 * its reader: `readInFlightTool` absent → `SubagentInfo.inFlightTool` never
 * appears and every live card stays on its placeholder slot forever. The TUI
 * builds its engine through build-engine directly (not the CLI wrapper), so
 * the wiring must be pinned at this assembly point.
 *
 * Test shape mirrors tui-deps-subagent-trace-factory.test.ts: mock
 * createSubAgentManager to capture the opts the assembly actually passes, then
 * assert identity with the store-layer reader (same function the hub's
 * rebuild path injects — one reader, no per-surface fork).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockState = vi.hoisted(() => ({
  capturedReadInFlightTool: undefined as unknown,
}));

vi.mock("../../src/harness/subagent/manager.ts", async (importActual) => {
  const actual =
    await importActual<
      typeof import("../../src/harness/subagent/manager.ts")
    >();
  const realCreate = actual.createSubAgentManager;
  return {
    ...actual,
    createSubAgentManager: vi.fn((opts: Parameters<typeof realCreate>[0]) => {
      mockState.capturedReadInFlightTool = opts.readInFlightTool;
      return realCreate(opts);
    }),
  };
});

import { buildTuiDeps } from "../../src/tui/deps.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { readWorkerInFlightToolName } from "../../src/session-api/store/index.ts";
import type { RuntimeBundle } from "../../src/cli/runtime.ts";
import type { IknowEnv } from "../../src/config/env.ts";

function makeBundle(apiKey: string): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    subagent: { taskTimeoutMs: 60_000 },
    mcp: { connectTimeoutMs: 60_000 },
    secrets: { mode: "roundtrip" },
    sandbox: { enabled: false },
    verify: { enabled: false },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
  };
  return { env, settings: {} as RuntimeBundle["settings"] };
}

let fixtureRoot: string;
let shutdown: (() => Promise<void>) | undefined;

beforeEach(() => {
  mockState.capturedReadInFlightTool = undefined;
  fixtureRoot = mkdtempSync(join(tmpdir(), "iknow-tui-reader-"));
});

afterEach(async () => {
  if (shutdown) {
    await shutdown();
    shutdown = undefined;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("buildTuiDeps — subagent activity reader 接线 (card line 2)", () => {
  it("TUI 装配必须把 store 层 reader 交给 manager（同一函数引用，不 fork）", async () => {
    const deps = await buildTuiDeps(makeBundle("sk-test-tui-reader"), {
      askUser: createNoAskUser(),
      conversationId: "tui-conv-reader-1",
      userHome: join(fixtureRoot, "home"),
      cwd: fixtureRoot,
    });
    shutdown = deps.shutdown;

    expect(mockState.capturedReadInFlightTool).toBe(readWorkerInFlightToolName);
  });
});
