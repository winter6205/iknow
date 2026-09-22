/**
 * ADR-0119 / specs/yolo-mode.md — the yolo holder at the TUI entry must reach the
 * **verify command face** as well (`createTuiBridge → SessionHub → runVerifyLoop`).
 *
 * Gap this closes (same family as `tui-bridge-fs-mode.test.ts`): the TUI's bash
 * tool face gets the holder via `buildTuiDeps → BuildEngineOpts.yolo`, while the
 * verify command face goes through `createTuiBridge → SessionHub.yolo`. Wiring
 * only the former means verify commands in a yolo session still run inside the
 * bwrap fence — two execution faces of one session disagreeing on fence state
 * (spec §6 four-route consistency).
 *
 * Technique: the real assembly chain (bridge → hub → runVerifyLoop →
 * makeDefaultRunVerify → createBwrapFence), mocking only `runInSandbox` from
 * `harness/sandbox/runner.ts` — the assertion surface is the real fence argv the
 * chain under test produces (bwrap is never actually spawned). `hub-bridge.ts`
 * imports no OpenTUI / React, so it loads on the vitest side.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/harness/sandbox/runner.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/sandbox/runner.ts")
    >();
  return { ...actual, runInSandbox: vi.fn() };
});

import * as sandboxRunner from "../../src/harness/sandbox/runner.ts";
import {
  createTuiBridge,
  createInflightRegistry,
} from "../../src/tui/hub-bridge.ts";
import { createYoloContext } from "../../src/harness/sandbox/yolo.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

let baseDir: string;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-yolo-"));
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const VERIFY_COMMAND = "echo tui-verify";
const capturedArgvs: string[][] = [];

beforeEach(() => {
  capturedArgvs.length = 0;
  vi.mocked(sandboxRunner.runInSandbox)
    .mockReset()
    .mockImplementation(async (opts) => {
      capturedArgvs.push([...opts.fence.argv]);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Assemble the TUI bridge; the yolo holder is injected optionally. */
function makeBridge(yolo?: ReturnType<typeof createYoloContext>) {
  const verifyConfig: VerifyConfig = { command: VERIFY_COMMAND };
  return createTuiBridge({
    dataDir: baseDir,
    workspaceRoot: baseDir,
    deps: makeDeps([
      assistantResult({ texts: ["ok"] }),
      assistantResult({ texts: ["ok"] }),
    ]),
    inflight: createInflightRegistry(),
    verifyConfig,
    ...(yolo ? { yolo } : {}),
  });
}

/** Run one postMessage; returns that run's verify fence argv. */
async function postAndCapture(
  bridge: ReturnType<typeof makeBridge>
): Promise<string[]> {
  const { session } = await bridge.hub.createSession();
  capturedArgvs.length = 0;
  await bridge.hub.postMessage({
    conversationId: session.conversation_id,
    text: "q",
  });
  expect(capturedArgvs.length).toBe(1);
  return capturedArgvs[0]!;
}

describe("createTuiBridge — the yolo holder reaches the hub's verify face (ADR-0119)", () => {
  it("holder reads true -> verify fence argv is bare (agrees with the bash face)", async () => {
    const bridge = makeBridge(createYoloContext(true));
    const argv = await postAndCapture(bridge);
    expect(argv).toEqual(["bash", "-c", VERIFY_COMMAND]);
    await bridge.hub.shutdown();
  });

  it("holder absent -> baseline bwrap argv (the V1 baseline shape)", async () => {
    const bridge = makeBridge();
    const argv = await postAndCapture(bridge);
    expect(argv[0]).toBe("bwrap");
    expect(argv.slice(-3)).toEqual(["bash", "-c", VERIFY_COMMAND]);
    await bridge.hub.shutdown();
  });

  it("flipping the holder after assembly -> the next verify call reads the new value (read fresh per call, not a snapshot)", async () => {
    const holder = createYoloContext(false);
    const bridge = makeBridge(holder);
    expect((await postAndCapture(bridge))[0]).toBe("bwrap");

    // The TUI's `/yolo` flips this same holder instance (run.tsx hands it to both
    // depsOpts and createTuiBridge) — the hub is not rebuilt, so the verify face
    // reads the new value on its very next call.
    const { session } = await bridge.hub.createSession();
    holder.set(true);
    capturedArgvs.length = 0;
    await bridge.hub.postMessage({
      conversationId: session.conversation_id,
      text: "q",
    });
    expect(capturedArgvs[0]).toEqual(["bash", "-c", VERIFY_COMMAND]);
    await bridge.hub.shutdown();
  });
});
