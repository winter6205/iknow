/**
 * ADR-0119 / specs/yolo-mode.md — the verify chain inside SessionHub: the yolo
 * holder reaches the default executor from the hub call site (a real closed
 * loop, no stubbed broken chain).
 *
 * Gap this closes: the hub's bash tool face (yolo holder forwarded through each
 * entry point) and its verify command face (via the hub's `runVerifyLoop`) must
 * agree, otherwise verify commands inside a yolo session still run under the
 * bwrap fence (spec §6 four-route consistency).
 *
 * Technique: do not stub `runVerifyLoop` (stubbing it breaks the chain); mock
 * only `runInSandbox` from `harness/sandbox/runner.ts` — the argv under
 * assertion is the real argv produced by the real assembly chain
 * `SessionHub → runVerifyLoop → makeDefaultRunVerify → createBwrapFence`
 * (bwrap is never actually spawned).
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
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createYoloContext } from "../../src/harness/sandbox/yolo.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

let baseDir: string;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-verify-yolo-"));
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const VERIFY_COMMAND = "echo verify-ran";
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

/** Assemble a hub carrying verifyConfig; the yolo holder is injected optionally. */
function makeHub(
  responses: number,
  yolo?: ReturnType<typeof createYoloContext>
): SessionHub {
  const store = new SessionStore(baseDir, process.cwd());
  const verifyConfig: VerifyConfig = { command: VERIFY_COMMAND };
  return new SessionHub({
    store,
    workspaceRoot: process.cwd(),
    deps: makeDeps(
      Array.from({ length: responses }, () =>
        assistantResult({ texts: ["ok"] })
      )
    ),
    verifyConfig,
    ...(yolo ? { yolo } : {}),
  });
}

/** Run one postMessage (this is what triggers the verify command face); returns that run's verify fence argv. */
async function postAndCapture(hub: SessionHub, text = "q"): Promise<string[]> {
  const { session } = await hub.createSession();
  const before = capturedArgvs.length;
  await hub.postMessage({ conversationId: session.conversation_id, text });
  expect(capturedArgvs.length).toBe(before + 1);
  return capturedArgvs[before]!;
}

/**
 * Erase the session-level fence tmp host path (`<projectDir>/<conversationId>/fence-tmp`) —
 * every `createSession()` gets a fresh conversationId, so that element necessarily
 * differs run over run and has nothing to do with the yolo axis. After normalization
 * any remaining argv difference can only come from the axis under test.
 */
function normalizeSessionTmp(argv: ReadonlyArray<string>): string[] {
  return argv.map((a) => (a.includes("fence-tmp") ? "<session-tmp>" : a));
}

describe("SessionHub verify chain — the yolo holder reaches the default executor (ADR-0119)", () => {
  it("holder reads true -> verify fence argv is bare (the fence retires wholesale; one of the four routes)", async () => {
    const hub = makeHub(1, createYoloContext(true));
    const argv = await postAndCapture(hub);
    expect(argv).toEqual(["bash", "-c", VERIFY_COMMAND]);
    await hub.shutdown();
  });

  it("holder absent -> the verify fence still gets the baseline bwrap argv (fail-closed)", async () => {
    const hub = makeHub(1);
    const argv = await postAndCapture(hub);
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("--unshare-net");
    // The command itself is still at the argv tail (only wrapped by the bwrap
    // prefix, not retired).
    expect(argv.slice(-3)).toEqual(["bash", "-c", VERIFY_COMMAND]);
    await hub.shutdown();
  });

  it("holder reading false gives byte-identical argv to absent (after session-tmp normalization; fail-closed, same shape)", async () => {
    const absentHub = makeHub(1);
    const absent = await postAndCapture(absentHub);
    await absentHub.shutdown();

    const falseHub = makeHub(1, createYoloContext(false));
    const explicitFalse = await postAndCapture(falseHub);
    expect(normalizeSessionTmp(explicitFalse)).toEqual(
      normalizeSessionTmp(absent)
    );
    await falseHub.shutdown();
  });

  it("flipping the holder after hub assembly -> the next verify call reads the new value (read fresh per call)", async () => {
    const holder = createYoloContext(false);
    const hub = makeHub(2, holder);
    expect((await postAndCapture(hub, "first"))[0]).toBe("bwrap");

    // In-session `/yolo` flips this same holder instance — the hub is not rebuilt
    // and the chain is not re-assembled.
    holder.set(true);
    const after = await postAndCapture(hub, "second");
    expect(after).toEqual(["bash", "-c", VERIFY_COMMAND]);
    await hub.shutdown();
  });
});
