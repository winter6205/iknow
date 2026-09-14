/**
 * ADR-0092 / SC13 —— TUI 入口的 fs 档必须同时到达 **verify 命令面**。
 *
 * 缺口背景（Spec 轴 code-review Medium）：`createTuiBridge` 未把 fs holder
 * 交给 `SessionHub`，于是 TUI 的 bash 工具面（经 buildTuiDeps）是工作区档、
 * 而 verify 命令面（经 hub 的 runVerifyLoop）还是全局档 —— 同一会话两条执行
 * 面档位不一致，工作区档的 home 写保护在 verify 这条臂上失效。serve 入口
 * 早已按同款接线（session-api/serve.ts），TUI 独缺。
 *
 * 本测试直接走 `createTuiBridge → SessionHub`（不经 TUI 渲染层，OpenTUI 的
 * 渲染面有既有 flake，且这条契约与渲染无关），stub 掉 runVerifyLoop 捕获
 * hub 实际传入的 opts。断言三条：
 *   1. holder 在场 → `fsMode` 到达 runVerifyLoop 且为 holder 当前值；
 *   2. 翻档后下一次调用读到新值（per-call 现读，不是装配期快照）；
 *   3. holder 缺席 → 不打 `fsMode` key（V1 baseline 入参形状）。
 *
 * `hub-bridge.ts` 不 import OpenTUI / React，故可在 vitest 面加载。
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

/** 装配 TUI bridge；fsMode holder 可选注入。 */
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

    // TUI 的 `/config` 翻的是同一个 holder 实例。
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
