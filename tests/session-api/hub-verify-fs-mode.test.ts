/**
 * ADR-0092: hub's verify call point must pass the session fs mode and
 * homeRoot through to `runVerifyLoop`.
 *
 * Gap background: `SessionHub` already carries an `opts.fsMode` holder (fed
 * to build-engine's bash factory), but the `runVerifyLoop({...})` call site
 * in `postMessage` omitted these two fields → under workspace mode the verify
 * command's (`config.command`) fence stayed on the global mode while the bash
 * tool was already workspace mode: two execution planes disagreeing in one
 * session.
 *
 * Same pattern as `tests/session-api/goal-seam.test.ts`: stub
 * `runVerifyLoop` from `harness/verify/index.ts` and capture the opts hub
 * actually passes. Pins two contracts:
 *   1. holder present → pass `fsMode: holder.get()`'s **current value**
 *      (read fresh per call, not an assembly-time snapshot — same semantics
 *      as a `/config` flip taking "effect on the next bash call");
 *   2. `homeRoot` always present (same source as build-engine's
 *      `opts.homeRoot ?? userHome (= homedir())`) — the workspace-mode home
 *      ro-bind source must sit on the same home the bash tool uses, or the
 *      two planes' home visibility drifts apart.
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
import { homedir, tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Stub runVerifyLoop BEFORE importing the hub (vi.mock is hoisted). The mock
// runs the delegated runFn once and reports passed — the assertions only
// inspect the captured opts.
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

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { createFsModeContext } from "../../src/harness/sandbox/fs-mode.ts";
import { ensureMainSessionFenceTmpForConversation } from "../../src/harness/sandbox/fence-tmp.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

let baseDir: string;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-verify-fsmode-"));
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

/** Assemble a hub with verifyConfig; fsMode holder injected optionally. */
function makeHub(fsMode?: ReturnType<typeof createFsModeContext>): SessionHub {
  const store = new SessionStore(baseDir, process.cwd());
  const verifyConfig: VerifyConfig = { command: "/bin/true" };
  return new SessionHub({
    store,
    workspaceRoot: process.cwd(),
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    verifyConfig,
    ...(fsMode ? { fsMode } : {}),
  });
}

function capturedOpts(): Record<string, unknown> {
  const opts = getLastVerifyLoopOpts() as Record<string, unknown> | undefined;
  assert.ok(opts !== undefined, "runVerifyLoop was not called");
  return opts;
}

describe("hub verify 调用点透传 fs 档 (ADR-0092 SC11)", () => {
  it("holder 缺席 → 不打 fsMode key（V1 baseline 入参形状）", async () => {
    const hub = makeHub();
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "q",
    });

    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    const opts = capturedOpts();
    assert.equal("fsMode" in opts, false, "no fsMode key when holder absent");
  });

  it("holder 在场 → 传当前值；翻档后下一次调用读到新值", async () => {
    const fsMode = createFsModeContext("workspace");
    const hub = makeHub(fsMode);
    const { session } = await hub.createSession();

    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "first",
    });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedOpts()["fsMode"],
      "workspace",
      "holder 当前值必须到达 runVerifyLoop 调用点"
    );

    // `/config` flips the holder (serve uses POST /api/v1/fs-mode, same holder
    // instance) → the next postMessage's verify call reads the new mode with
    // no engine rebuild.
    fsMode.set("global");
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "second",
    });
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(2);
    assert.equal(
      capturedOpts()["fsMode"],
      "global",
      "每次调用现读 holder（不是装配期快照）"
    );
  });

  it("homeRoot 恒在且 = homedir()（与 build-engine 缺省 homeRoot 同源）", async () => {
    const hub = makeHub(createFsModeContext());
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "q",
    });

    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedOpts()["homeRoot"],
      homedir(),
      "homeRoot 必须落在与 bash 工具同一个 home（build-engine 缺省 userHome）"
    );
  });

  it("前提守卫：TUI 生产启动路径不注入 userHome（否则 home 面会分裂）", () => {
    // The previous case asserts hub homeRoot === homedir(), while build-engine's
    // home ro-bind source is `opts.userHome ?? homedir()`. They agree only when
    // **no production caller injects userHome** — a known same-source
    // assumption documented at the hub.ts verify call point, not a coincidence.
    //
    // The reachable drift path is `buildTuiDeps`'s `opts.userHome` seam
    // (src/tui/deps.ts: `...(opts.userHome ? { userHome } : {})`). If the TUI
    // startup path ever passes it, workspace-mode bash home ro-binds the
    // injected home while hub's verify still points at the real homedir() —
    // the two planes' home visibility splits.
    //
    // This case pins "startup path doesn't pass it" as an executable
    // assertion: it turns red then, pointing to the closure plan in the hub.ts
    // call-point comment (add home to SessionHubOptions and read it fresh).
    // Checks **only the startup path** run.tsx — deps.ts's own test seam stays
    // usable (test-injected userHome never reaches hub's verify plane).
    const src = readFileSync(join(process.cwd(), "src/tui/run.tsx"), "utf8");
    assert.equal(
      /\buserHome\s*:/.test(src),
      false,
      "TUI 启动路径开始注入 userHome 了 —— hub 的 verify homeRoot 会与引擎 bash 面分裂，须同步收口"
    );
  });

  it("tmpDir = <projectDir>/<convId>/fence-tmp（ADR-0092 SC12，与 bash 面同一 helper）", async () => {
    // Discriminating power: before the fix this key was absent at all — the
    // verify plane had no `$TMPDIR`, and the workspace-mode write allowlist
    // was the process tmpdir(), so session tmp under home was covered by
    // `--ro-bind <home>` (EROFS). This case pins the call point's resolved
    // path shape and origin.
    const hub = makeHub(createFsModeContext("workspace"));
    const { session } = await hub.createSession();
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "q",
    });

    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    const expected = ensureMainSessionFenceTmpForConversation(
      new SessionStore(baseDir, process.cwd()).getProjectDir(),
      session.conversation_id
    );
    assert.equal(
      capturedOpts()["tmpDir"],
      expected,
      "tmpDir 必须是与 bash 面同源的会话 tmp 宿主真路径"
    );
  });
});
