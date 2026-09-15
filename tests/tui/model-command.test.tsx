/** @jsxImportSource @opentui/react */
/**
 * tests/tui/model-command.test.tsx
 *
 * /model 命令的 TuiApp 端到端（specs/tui-model-command.md SC8 / SC10 / SC11）：
 *  - 注册表非空 → /model 打开面板，↑↓ 移焦点，Enter 选定 → onPersistModel 收到
 *    `{ model: "<provider>/<model>" }`（spec SC5 持久化契约）且面板关闭；
 *  - 注册表空 / 缺省 → notice 含「未配置 providers」，面板不打开；
 *  - Esc → 只关闭，不触发 onPersistModel（无 cancel 语义，焦点移动不产生 staged
 *    状态，故既非保存退出也非放弃修改）；
 *  - /info 输出 `Model: <当前 model 串>`（SC11）。
 *
 * 用真实 bridge/hub + stub deps（makeDeps）+ 真实 TUI 渲染器：slash 路径必须
 * 经真实按键投递验证（纯函数测试覆盖不到 app 层键路由）。
 */
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  TuiApp,
  applyModelPickerKey,
  createToolEventSink,
  modelFocusIndexFor,
  modelPickerEntries,
  type TuiAppProps,
} from "../../src/tui/app.js";
import { modelDisplayName } from "../../src/tui/model-picker.js";
import {
  createEnvDisplayStore,
  type EnvDisplaySeed,
} from "../../src/tui/env-display-store.js";
import type { DefaultThinkingShape } from "../../src/tui/thinking-gate.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { ModelPickerEntry } from "../../src/tui/model-picker.js";
import type { ModalKeyEvent } from "../../src/tui/modal.js";
import type { IknowSettingsLlmProvider } from "../../src/config/settings.js";
import { makeDeps } from "../cli/_fixtures.ts";

const noKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  tab: false,
  space: false,
  return: false,
  escape: false,
  ctrl: false,
  meta: false,
};

function entry(providerId: string, modelId: string) {
  return { providerId, modelId };
}

const PROVIDERS: ReadonlyArray<IknowSettingsLlmProvider> = [
  {
    id: "minimax-cn",
    baseUrl: "https://api.minimax.chat/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    models: [{ id: "MiniMax-M3", name: "MiniMax M3" }, { id: "MiniMax-M2" }],
  },
  {
    id: "volcengine-ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "ARK_API_KEY",
    models: [{ id: "deepseek-v3-250324", name: "DeepSeek V3" }],
  },
];

interface Mounted {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => void;
  /** 宿主 env 派生显示快照的发布口（run.tsx onEnvChange 的等价物）。 */
  readonly store: ReturnType<typeof createEnvDisplayStore>;
  /** 模拟宿主 env reload：只 publish，**不**重渲染 React 树（#1021 的核心
   *  回归钉 —— 旧接线正是靠重渲染整树把新 model 传下去的）。 */
  readonly publish: (seed: EnvDisplaySeed) => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressEscape: () => Promise<void>;
  readonly pressSpace: () => Promise<void>;
  readonly pressArrow: (dir: "up" | "down") => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** thinking 基线：off + 无档位（与旧 `props.defaultThinking` 缺省同形）。 */
const BASELINE_OFF: DefaultThinkingShape = { mode: "off", effort: "" };

async function mountAsync(opts: {
  readonly providers?: ReadonlyArray<IknowSettingsLlmProvider>;
  /** envDisplay 初始快照（等价旧 `model` / `defaultThinking` prop）。 */
  readonly env?: EnvDisplaySeed;
  readonly onPersistModel?: TuiAppProps["onPersistModel"];
}): Promise<Mounted> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-model-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([]),
    inflight: createInflightRegistry(),
  });
  const store = createEnvDisplayStore(
    opts.env ?? { model: undefined, defaultThinking: undefined }
  );
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      envDisplay={store}
      {...(opts.providers !== undefined ? { providers: opts.providers } : {})}
      {...(opts.onPersistModel !== undefined
        ? { onPersistModel: opts.onPersistModel }
        : {})}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    {
      width: 90,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
    }
  );
  setupRef = setup;
  await sleep(500);
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    store,
    destroy: () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    publish: async (seed) => {
      await act(async () => {
        store.publish(seed);
      });
      await setup.renderOnce();
    },
    typeText: async (text: string) => {
      setup.mockInput.pressKey("/");
      await sleep(100);
      await setup.renderOnce();
      for (let i = 0; i < 5; i++) {
        setup.mockInput.pressBackspace();
        await sleep(30);
      }
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await sleep(30);
      }
      await sleep(100);
      await setup.renderOnce();
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await sleep(100);
      await setup.renderOnce();
    },
    pressEscape: async () => {
      setup.mockInput.pressEscape();
      await sleep(100);
      await setup.renderOnce();
    },
    pressSpace: async () => {
      setup.mockInput.pressKey(" ");
      await sleep(100);
      await setup.renderOnce();
    },
    pressArrow: async (dir) => {
      setup.mockInput.pressArrow(dir);
      await sleep(100);
      await setup.renderOnce();
    },
  };
}

async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000,
  label = ""
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await sleep(50);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(
    `untilFrame timeout (${label}):\n${setup.captureCharFrame()}`
  );
}

async function until(
  cond: () => boolean,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`until timeout: ${label}`);
    await sleep(50);
  }
}

/** 抹掉 pty 光标渲染块（U+2588）。光标闪烁与 env publish 无关，逐行 diff 前
 *  必须中和它，否则会造出与本次变更无关的「变化行」。 */
function stripCursor(frame: string): string {
  return frame.replaceAll("█", " ");
}

/** 两帧间**发生变化的行**（按行下标配对；长度不等 → 全部视为变化）。
 *  captureCharFrame 只取字符面（不含颜色），脉动色不会制造假差异。 */
function diffLines(before: string, after: string): ReadonlyArray<string> {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) return b;
  return b.filter((line, i) => line !== a[i]);
}

describe("modelPickerEntries / modelFocusIndexFor（注册表投影）", () => {
  test("provider × models 扁平展开，name → label", () => {
    const entries = modelPickerEntries(PROVIDERS);
    expect(entries).toEqual([
      { providerId: "minimax-cn", modelId: "MiniMax-M3", label: "MiniMax M3" },
      { providerId: "minimax-cn", modelId: "MiniMax-M2" },
      {
        providerId: "volcengine-ark",
        modelId: "deepseek-v3-250324",
        label: "DeepSeek V3",
      },
    ]);
  });

  test("空 / 缺省注册表 → 空数组（/model 走 notice 不打开面板）", () => {
    expect(modelPickerEntries(undefined)).toEqual([]);
    expect(modelPickerEntries([])).toEqual([]);
  });

  test("焦点初值 = 当前 model 的下标；找不到 / 未接线 → 0", () => {
    const entries = modelPickerEntries(PROVIDERS);
    expect(
      modelFocusIndexFor(entries, "volcengine-ark/deepseek-v3-250324")
    ).toBe(2);
    expect(modelFocusIndexFor(entries, "minimax-cn/MiniMax-M2")).toBe(1);
    expect(modelFocusIndexFor(entries, "unknown/model")).toBe(0);
    expect(modelFocusIndexFor(entries, undefined)).toBe(0);
  });
});

describe("modelDisplayName（状态栏显示名投影）", () => {
  test("命中注册表且有 name → 显示 name；无 name → 回退路由串", () => {
    expect(modelDisplayName("minimax-cn/MiniMax-M3", PROVIDERS)).toBe(
      "MiniMax M3"
    );
    expect(modelDisplayName("minimax-cn/MiniMax-M2", PROVIDERS)).toBe(
      "minimax-cn/MiniMax-M2"
    );
  });

  test("未命中 / 注册表缺席或空 / model 未接线 → 原样回退", () => {
    expect(modelDisplayName("unknown/model", PROVIDERS)).toBe("unknown/model");
    expect(modelDisplayName("minimax-cn/MiniMax-M3", undefined)).toBe(
      "minimax-cn/MiniMax-M3"
    );
    expect(modelDisplayName("minimax-cn/MiniMax-M3", [])).toBe(
      "minimax-cn/MiniMax-M3"
    );
    expect(modelDisplayName(undefined, PROVIDERS)).toBeUndefined();
  });
});

/**
 * reducer → applyModelPickerKey 的宿主链路（与 app.tsx 的 onMove/onSelect 接线
 * 同形）：焦点下标只由 reducer 的 move 结果驱动，Enter 提交的正是该下标。
 */
function driveKeys(
  entries: ReadonlyArray<ModelPickerEntry>,
  keys: ReadonlyArray<Partial<ModalKeyEvent["key"]>>
): { readonly selected: ReadonlyArray<string>; readonly closed: number } {
  const selected: string[] = [];
  let closed = 0;
  let focusedIndex = 0;
  const event = (patch: Partial<ModalKeyEvent["key"]>): ModalKeyEvent => ({
    input: "",
    key: { ...noKey, ...patch },
  });
  for (const patch of keys) {
    applyModelPickerKey(event(patch), {
      entries,
      focusedIndex,
      onMove: (index) => {
        focusedIndex = index;
      },
      onSelect: (routeId) => selected.push(routeId),
      onClose: () => {
        closed += 1;
      },
    });
  }
  return { selected, closed };
}

describe("applyModelPickerKey 的 fix 落地（宿主提交面）", () => {
  test("13 条注册表：一路 ↓ 到底后 Enter 提交的是**可见**条目（不是隐藏的第 13 项）", () => {
    const entries: ModelPickerEntry[] = [];
    for (let i = 0; i < 13; i++) entries.push(entry("prov", `model-${i}`));
    // 渲染只出前 12 项；若 clamp 到 entryCount-1，Enter 会提交 model-12。
    const { selected, closed } = driveKeys(entries, [
      ...Array.from({ length: 20 }, () => ({ downArrow: true })),
      { return: true },
    ]);
    expect(selected).toEqual(["prov/model-11"]);
    expect(closed).toBe(1);
  });

  test("Enter 提交当前焦点项（↓ 一次 → 第 2 项）", () => {
    const entries = modelPickerEntries(PROVIDERS);
    expect(driveKeys(entries, [{ downArrow: true }, { return: true }])).toEqual(
      {
        selected: ["minimax-cn/MiniMax-M2"],
        closed: 1,
      }
    );
  });

  test("焦点下标越界（条目重载后失效）→ 不提交、只关闭（不抛错）", () => {
    const selected: string[] = [];
    let closed = 0;
    applyModelPickerKey(
      { input: "", key: { ...noKey, return: true } },
      {
        entries: modelPickerEntries(PROVIDERS),
        focusedIndex: 99,
        onMove: () => {},
        onSelect: (routeId) => selected.push(routeId),
        onClose: () => {
          closed += 1;
        },
      }
    );
    expect(selected).toEqual([]);
    expect(closed).toBe(1);
  });
});

describe("/model 端到端（真实键盘投递）", () => {
  test("↑↓ 移焦点 + Enter → onPersistModel 收到 {model} 且面板关闭", async () => {
    const calls: Array<{ model: string }> = [];
    const app = await mountAsync({
      providers: PROVIDERS,
      env: { model: "minimax-cn/MiniMax-M3", defaultThinking: BASELINE_OFF },
      onPersistModel: (patch) => {
        calls.push(patch);
        return Promise.resolve({ ok: true as const });
      },
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/model");
    await app.pressEnter();
    const opened = await untilFrame(
      app.setup,
      (f) => f.includes("模型") && f.includes("minimax-cn/MiniMax-M3"),
      8000,
      "picker-open"
    );
    expect(opened).toContain("volcengine-ark/deepseek-v3-250324");
    // 焦点 seed 到当前 model（第 0 项）：游标落在该行。
    const focusedLine = opened
      .split("\n")
      .find((l) => l.includes("minimax-cn/MiniMax-M3"));
    expect(focusedLine).toContain("▸ ");

    // ↓ ↓ → 第 2 项（volcengine-ark/deepseek-v3-250324）。
    await app.pressArrow("down");
    await app.pressArrow("down");
    const moved = await untilFrame(
      app.setup,
      (f) => {
        const line = f
          .split("\n")
          .find((l) => l.includes("volcengine-ark/deepseek-v3-250324"));
        return line !== undefined && line.includes("▸ ");
      },
      8000,
      "focus-moved"
    );
    expect(moved).toContain("模型");

    await app.pressEnter();
    await until(() => calls.length === 1, 8000, "persist-called");
    // spec SC5：持久化 patch = 选中的路由 ID。
    expect(calls[0]).toEqual({ model: "volcengine-ark/deepseek-v3-250324" });
    // 面板关闭（选定动作完成，写回是后台行为）。
    await untilFrame(
      app.setup,
      (f) => !f.includes("模型选择中"),
      8000,
      "closed"
    );
    expect(app.setup.captureCharFrame()).not.toContain("…1 more");

    app.destroy();
  }, 30_000);

  test("Esc → 只关闭，不调 onPersistModel（焦点移动不产生 staged 状态）", async () => {
    const calls: Array<{ model: string }> = [];
    const app = await mountAsync({
      providers: PROVIDERS,
      env: { model: "minimax-cn/MiniMax-M3", defaultThinking: BASELINE_OFF },
      onPersistModel: (patch) => {
        calls.push(patch);
        return Promise.resolve({ ok: true as const });
      },
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/model");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("minimax-cn/MiniMax-M3"),
      8000,
      "picker-open"
    );
    await app.pressArrow("down");
    await app.pressEscape();
    await untilFrame(
      app.setup,
      (f) => !f.includes("volcengine-ark/deepseek-v3-250324"),
      8000,
      "picker-closed"
    );
    // 写回未被触发（Esc 不是保存路径）。
    await sleep(300);
    expect(calls).toEqual([]);

    app.destroy();
  }, 30_000);

  test("注册表缺省（可选 prop 缺席）→ notice「未配置 providers」，面板不打开", async () => {
    const app = await mountAsync({});
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/model");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("未配置 providers"),
      8000,
      "notice"
    );
    // 面板未打开：无键位提示、无标题行。
    expect(frame).not.toContain("[Enter] 切换");
    expect(frame).not.toContain("模型选择中");

    app.destroy();
  }, 30_000);

  test("注册表显式空数组 → 同一 notice 路径", async () => {
    const app = await mountAsync({ providers: [] });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/model");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("未配置 providers"),
      8000,
      "notice-empty"
    );
    expect(frame).not.toContain("[Enter] 切换");

    app.destroy();
  }, 30_000);

  test("onPersistModel 返回 {ok:false} → notice 呈现 reason，面板已关", async () => {
    const app = await mountAsync({
      providers: PROVIDERS,
      onPersistModel: () =>
        Promise.resolve({ ok: false as const, reason: "EACCES: 只读文件系统" }),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/model");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("minimax-cn/MiniMax-M3"),
      8000,
      "picker-open"
    );
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("failed to write settings.json"),
      8000,
      "persist-fail"
    );
    expect(frame).toContain("EACCES: 只读文件系统");
    expect(frame).not.toContain("模型选择中");

    app.destroy();
  }, 30_000);

  test("onPersistModel {ok:false, stage:reload} → English reload-fail notice, not write-fail", async () => {
    const app = await mountAsync({
      providers: PROVIDERS,
      onPersistModel: () =>
        Promise.resolve({
          ok: false as const,
          stage: "reload" as const,
          reason:
            "provider_api_key_missing: volcengine-ark (env VOLCENGINE_ARK_API_KEY unset)",
        }),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/model");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("minimax-cn/MiniMax-M3"),
      8000,
      "picker-open"
    );
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("failed to reload runtime"),
      8000,
      "persist-reload-fail"
    );
    expect(frame).toContain("provider_api_key_missing");
    expect(frame).toContain("volcengine-ark");
    expect(frame).toContain("VOLCENGINE_ARK_API_KEY");
    expect(frame).not.toContain("failed to write settings.json");
    expect(frame).not.toContain("模型选择中");

    app.destroy();
  }, 30_000);
});

describe("/info 的 Model 行（spec SC11）", () => {
  test("有 model prop → 输出 `Model: <provider>/<model>`，原样不改写", async () => {
    const app = await mountAsync({
      env: { model: "minimax-cn/MiniMax-M3", defaultThinking: BASELINE_OFF },
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/info");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("runState"),
      8000,
      "info"
    );
    expect(frame).toContain("Model: minimax-cn/MiniMax-M3");

    app.destroy();
  }, 30_000);

  test("无 providers 段（只有裸 model 串）→ 同一行原样输出，不伪造 provider 前缀", async () => {
    const app = await mountAsync({
      env: { model: "minimax/MiniMax-M3", defaultThinking: BASELINE_OFF },
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/info");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("runState"),
      8000,
      "info-noprov"
    );
    expect(frame).toContain("Model: minimax/MiniMax-M3");
    expect(frame).not.toContain("Model: undefined");

    app.destroy();
  }, 30_000);
});

describe("状态栏模型名（注册表 name → ContextBar）", () => {
  test("当前 model 命中注册表且有 name → 状态栏显示 name 而非路由串", async () => {
    const app = await mountAsync({
      providers: PROVIDERS,
      env: { model: "minimax-cn/MiniMax-M3", defaultThinking: BASELINE_OFF },
    });
    // 等状态栏渲染出显示名（ContextBar 在 prompt 之下第一行）。
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("MiniMax M3") && f.includes("ctx"),
      8000,
      "contextbar-name"
    );
    const bar = frame
      .split("\n")
      .find((l) => l.includes("ctx") && l.includes("MiniMax M3"));
    // 状态栏里出现的应是 name，不是路由串（/info 的 Model 行未打开）。
    expect(bar).toBeDefined();
    expect(bar).not.toContain("minimax-cn/MiniMax-M3");

    app.destroy();
  }, 30_000);

  test("无 name 的条目 → 状态栏回退显示路由串", async () => {
    const app = await mountAsync({
      providers: PROVIDERS,
      env: { model: "minimax-cn/MiniMax-M2", defaultThinking: BASELINE_OFF },
    });
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("minimax-cn/MiniMax-M2") && f.includes("ctx"),
      8000,
      "contextbar-fallback"
    );
    expect(frame).toContain("minimax-cn/MiniMax-M2");

    app.destroy();
  }, 30_000);

  test("无注册表 → 状态栏原样显示 model 串", async () => {
    const app = await mountAsync({
      env: { model: "minimax/MiniMax-M3", defaultThinking: BASELINE_OFF },
    });
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("minimax/MiniMax-M3") && f.includes("ctx"),
      8000,
      "contextbar-noprov"
    );
    expect(frame).toContain("minimax/MiniMax-M3");

    app.destroy();
  }, 30_000);

  test("env store 切路由 → 状态栏跟随新条目的 name（重投影），且只有 model 行变化", async () => {
    const app = await mountAsync({
      providers: PROVIDERS,
      env: { model: "minimax-cn/MiniMax-M3", defaultThinking: BASELINE_OFF },
    });
    const before = await untilFrame(
      app.setup,
      (f) => f.includes("MiniMax M3") && f.includes("ctx"),
      8000,
      "contextbar-before-reload"
    );

    // 模拟宿主 env reload（run.tsx onEnvChange 接线）：只 publish 新快照，
    // **不**重渲染 React 树 —— 订阅方（ContextBar）自行重投影为新路由的 name。
    await app.publish({
      model: "volcengine-ark/deepseek-v3-250324",
      defaultThinking: BASELINE_OFF,
    });
    const reloaded = await untilFrame(
      app.setup,
      (f) => f.includes("DeepSeek V3") && f.includes("ctx"),
      8000,
      "contextbar-after-reload"
    );
    // 旧 name 不再出现在状态栏行上（同帧 picker 未开，无其他来源）。
    expect(
      reloaded
        .split("\n")
        .find((l) => l.includes("ctx") && l.includes("DeepSeek V3"))
    ).not.toContain("MiniMax M3");

    // #1021 (c)：model 切换只允许影响「显示模型名的那一行」—— 逐行 diff，
    // 其余行必须逐字节不变。走到全树重绘（React 树 remount / 消息区重算）时
    // 这里会先失败，是「没有用户可见闪烁」最直接的回归钉（比较前抹掉输入框
    // 光标列：光标闪烁与本次 publish 无关，且 captureCharFrame 不含颜色面，
    // 无法把它从字符里区分出来）。
    const changedLines = diffLines(stripCursor(before), stripCursor(reloaded));
    expect(changedLines).toHaveLength(1);
    expect(changedLines[0]).toContain("DeepSeek V3");

    app.destroy();
  }, 30_000);

  test("用户碰过 thinking 后 model-only publish 不覆盖覆盖值；未碰过的字段仍跟随基线", async () => {
    const app = await mountAsync({
      providers: PROVIDERS,
      env: { model: "minimax-cn/MiniMax-M3", defaultThinking: BASELINE_OFF },
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 基线 off → /thinking 面板 Esc 提交 ON（用户手改，effort 未碰）。
    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("思考开关"),
      8000,
      "picker-open"
    );
    await app.pressSpace();
    await app.pressEscape();
    await untilFrame(
      app.setup,
      (f) => !f.includes("思考开关"),
      8000,
      "picker-saved"
    );

    // 只换模型的 env 快照：thinking 基线仍为 off，但用户已手改为 ON。
    await app.publish({
      model: "volcengine-ark/deepseek-v3-250324",
      defaultThinking: BASELINE_OFF,
    });

    await app.typeText("/info");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("runState"),
      8000,
      "info-after-model-publish"
    );
    // (a) 手改的 thinking 覆盖存活（旧实现会被基线 off 拽回去）。
    expect(frame).toContain("thinking: adaptive (auto)");
    // 模型本身确实跟着新快照走了。
    expect(frame).toContain("Model: volcengine-ark/deepseek-v3-250324");

    // (b) 未碰过的 effort 字段仍跟随基线变化：新基线 adaptive/high →
    // thinking 已被用户占住，effort 无覆盖 → 取新值 high。
    await app.publish({
      model: "volcengine-ark/deepseek-v3-250324",
      defaultThinking: { mode: "adaptive", effort: "high" },
    });
    await app.typeText("/info");
    await app.pressEnter();
    const followed = await untilFrame(
      app.setup,
      (f) => f.includes("thinking: adaptive (high)"),
      8000,
      "info-after-baseline-publish"
    );
    expect(followed).toContain("Model: volcengine-ark/deepseek-v3-250324");

    app.destroy();
  }, 30_000);
});
