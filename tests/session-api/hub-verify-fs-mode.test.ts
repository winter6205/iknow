/**
 * ADR-0092 / SC11–SC13 + Amendment 2026-09-13 —— hub 的 verify 调用点必须
 * 把会话 fs 档与 homeRoot 透传给 `runVerifyLoop`。
 *
 * 缺口背景：`SessionHub` 已有 `opts.fsMode` holder（喂给 build-engine 的
 * bash 工厂），但 `postMessage` 里 `runVerifyLoop({...})` 的调用点漏了这两个
 * 字段 → 工作区档下 verify 命令（`config.command`）的围栏仍是全局档，而
 * bash 工具已是工作区档：同一会话两条执行面档位不一致。
 *
 * 本测试与 `tests/session-api/goal-seam.test.ts` 同款：stub 掉
 * `harness/verify/index.ts` 的 `runVerifyLoop`，捕获 hub 实际传入的 opts。
 * 锁两条契约：
 *   1. holder 在场 → 传 `fsMode: holder.get()` 的**当前值**（每次调用现读，
 *      不是装配期快照 —— 与 `/config` 翻转「下一次 bash 调用生效」同语义）；
 *   2. `homeRoot` 恒在（与 build-engine 装配 `opts.homeRoot ?? userHome
 *      (= homedir())` 同源）—— 工作区档 home ro-bind 源端必须落在与 bash
 *      工具同一个 home 上，否则两条执行面的 home 可见面会漂移。
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

/** 装配带 verifyConfig 的 hub；fsMode holder 可选注入。 */
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

    // `/config` 翻 holder（serve 走 POST /api/v1/fs-mode，同一 holder 实例）
    // → 下一次 postMessage 的 verify 调用点读到新档，无需重建引擎。
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
    // 上一条用例断言 hub 的 homeRoot === homedir()，而 build-engine 的 home
    // ro-bind 源端是 `opts.userHome ?? homedir()`。两者只在**没有任何生产
    // caller 注入 userHome** 时同源 —— 这是 hub.ts verify 调用点注释记载的
    // 「已知同源假设」，不是巧合。
    //
    // 可达的漂移路径是 `buildTuiDeps` 的 `opts.userHome` 缝（src/tui/deps.ts：
    // `...(opts.userHome ? { userHome } : {})`）。TUI 启动路径若开始传它，
    // 工作区档下 bash 的 home ro-bind 会指向注入 home、而 hub 的 verify 仍指
    // 真 homedir() —— 两条执行面的 home 可见面分裂。
    //
    // 本用例把「启动路径不传」钉成可执行断言：届时红，提示按 hub.ts 调用点
    // 注释的收口方案（SessionHubOptions 加 home 并改现读）一并处理。
    // 只查**启动路径** run.tsx —— deps.ts 自身的测试缝保持可用（测试注入
    // userHome 不经 hub 的 verify 面，不受此约束）。
    const src = readFileSync(join(process.cwd(), "src/tui/run.tsx"), "utf8");
    assert.equal(
      /\buserHome\s*:/.test(src),
      false,
      "TUI 启动路径开始注入 userHome 了 —— hub 的 verify homeRoot 会与引擎 bash 面分裂，须同步收口"
    );
  });

  it("tmpDir = <projectDir>/<convId>/fence-tmp（ADR-0092 SC12，与 bash 面同一 helper）", async () => {
    // 判别力：修复前该 key 根本不在 —— verify 面 `$TMPDIR` 缺席且工作区档
    // 写白名单是进程 tmpdir()，会话 tmp 落在 home 下反被 `--ro-bind <home>`
    // 盖住（EROFS）。本用例钉调用点解析出的路径形状与来源。
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
