/**
 * ADR-0092 — the fs mode chosen at the TUI entry must also reach the **verify command surface**.
 *
 * Gap background: `createTuiBridge` did not hand the fs holder to `SessionHub`, so the
 * TUI bash tool surface (via buildTuiDeps) ran in workspace mode while the verify
 * surface (via hub's runVerifyLoop) stayed in global mode — two execution surfaces of
 * one session with inconsistent modes, leaving the workspace mode's home write
 * protection ineffective on the verify arm. The serve entry had long been wired the
 * same way (session-api/serve.ts); only the TUI was missing it.
 *
 * This test goes straight through `createTuiBridge → SessionHub` (skipping the TUI
 * render layer: OpenTUI rendering has pre-existing flakes and this contract is
 * render-independent), stubbing runVerifyLoop to capture the opts the hub actually
 * passes. Three assertions:
 *   1. holder present -> `fsMode` reaches runVerifyLoop with the holder's current value;
 *   2. after flipping the mode, the next call reads the new value (read per call, not an assembly-time snapshot);
 *   3. holder absent -> no `fsMode` key (V1 baseline argument shape).
 *
 * `hub-bridge.ts` imports neither OpenTUI nor React, so it loads in the vitest environment.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runVerifyLoopMock, getLastVerifyLoopOpts } = vi.hoisted(() => {
  let lastOpts: unknown = undefined;
  const fn = vi.fn(async (opts: unknown) => {
    lastOpts = opts;
    const o = opts as {
      runFn: (text: string, extra?: unknown) => Promise<unknown>;
    };
    const r = (await o.runFn("ignored", {})) as {
      result: unknown;
      trace: unknown;
    };
    return {
      result: r.result,
      trace: r.trace,
      rounds: 0,
      enabled: true,
      outcome: "passed",
      records: [],
    };
  });
  return { runVerifyLoopMock: fn, getLastVerifyLoopOpts: () => lastOpts };
});

vi.mock("../../src/harness/verify/index.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/harness/verify/index.ts")
  >("../../src/harness/verify/index.ts");
  return { ...actual, runVerifyLoop: runVerifyLoopMock };
});

import {
  createTuiBridge,
  createInflightRegistry,
} from "../../src/tui/hub-bridge.ts";
import { createFsModeContext } from "../../src/harness/sandbox/fs-mode.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

let baseDir: string;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-bridge-fsmode-"));
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

/** Assembles the TUI bridge; the fsMode holder is optionally injected. */
function makeBridge(fsMode?: ReturnType<typeof createFsModeContext>) {
  const verifyConfig: VerifyConfig = { command: "/bin/true" };
  return createTuiBridge({
    dataDir: baseDir,
    workspaceRoot: baseDir,
    deps: makeDeps([assistantResult({ texts: ["ok"] })], {}),
    inflight: createInflightRegistry(),
    verifyConfig,
    ...(fsMode ? { fsMode } : {}),
  });
}

function capturedOpts(): Record<string, unknown> {
  const opts = getLastVerifyLoopOpts() as Record<string, unknown> | undefined;
  assert.ok(opts !== undefined, "runVerifyLoop was not called");
  return opts;
}

describe("createTuiBridge — fs holder 到达 hub 的 verify 面 (ADR-0092 SC13)", () => {
  it("holder 在场 → verify 调用点读到当前值（与 bash 面同档）", async () => {
    const fsMode = createFsModeContext("workspace");
    const bridge = makeBridge(fsMode);
    const { session } = await bridge.hub.createSession();

    await bridge.hub.postMessage({
      conversationId: session.conversation_id,
      text: "q",
    });

    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedOpts()["fsMode"],
      "workspace",
      "TUI bridge 必须把 fs holder 交给 hub —— 否则 verify 面回落全局档，与 bash 面不一致"
    );
    await bridge.hub.shutdown();
  });

  it("翻档后下一次 verify 调用读到新值（per-call 现读，非装配期快照）", async () => {
    const fsMode = createFsModeContext("global");
    const bridge = makeBridge(fsMode);
    const { session } = await bridge.hub.createSession();

    await bridge.hub.postMessage({
      conversationId: session.conversation_id,
      text: "first",
    });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedOpts()["fsMode"], "global");

    // The TUI's `/config` flips this same holder instance.
    fsMode.set("workspace");
    await bridge.hub.postMessage({
      conversationId: session.conversation_id,
      text: "second",
    });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(2);
    assert.equal(
      capturedOpts()["fsMode"],
      "workspace",
      "翻档必须对下一次调用生效（holder per-call 现读）"
    );
    await bridge.hub.shutdown();
  });

  it("holder 缺席 → 不打 fsMode key（V1 baseline 入参形状）", async () => {
    const bridge = makeBridge();
    const { session } = await bridge.hub.createSession();

    await bridge.hub.postMessage({
      conversationId: session.conversation_id,
      text: "q",
    });

    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      "fsMode" in capturedOpts(),
      false,
      "未接 fs 档的入口不得凭空产出 fsMode key"
    );
    await bridge.hub.shutdown();
  });
});
