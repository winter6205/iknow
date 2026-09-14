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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { createRoot } from "@opentui/react";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  TuiApp,
  applyModelPickerKey,
  createToolEventSink,
  modelDisplayName,
  modelFocusIndexFor,
  modelPickerEntries,
  type TuiAppProps,
} from "../../src/tui/app.js";
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
  /** 模拟宿主 env reload 后的重渲染（run.tsx onEnvChange 形状）。 */
  readonly rerenderWith: (patch: {
    model?: string;
    envVersion?: number;
  }) => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressEscape: () => Promise<void>;
  readonly pressArrow: (dir: "up" | "down") => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function mountAsync(opts: {
  readonly providers?: ReadonlyArray<IknowSettingsLlmProvider>;
  readonly model?: string;
  readonly envVersion?: number;
  readonly onPersistModel?: TuiAppProps["onPersistModel"];
}): Promise<Mounted> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-model-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([]),
    inflight: createInflightRegistry(),
  });
  let setupRef: TestRendererSetup | undefined;
  let currentOpts = opts;
  const appNode = (renderOpts: typeof opts) => (
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      {...(renderOpts.providers !== undefined
        ? { providers: renderOpts.providers }
        : {})}
      {...(renderOpts.model !== undefined ? { model: renderOpts.model } : {})}
      {...(renderOpts.envVersion !== undefined
        ? { envVersion: renderOpts.envVersion }
        : {})}
      {...(renderOpts.onPersistModel !== undefined
        ? { onPersistModel: renderOpts.onPersistModel }
        : {})}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />
  );
  const setup = await testRender(appNode(currentOpts), {
    width: 90,
    height: 30,
    exitOnCtrlC: false,
    consoleMode: "disabled",
  });
  setupRef = setup;
  // 同一 root 二次 render = re-render（testRender 内部即 createRoot + render，
  // 这里取公开 createRoot 造一个同 renderer 的 root 供 rerenderWith 使用）。
  const rootRef = createRoot(setup.renderer);
  await sleep(500);
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    destroy: () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    // 模拟宿主 env reload 后的重渲染（run.tsx onEnvChange 形状）：同一 root
    // 上以新 props 二次 render（createRoot.render 可重入 = re-render）。
    rerenderWith: async (patch: { model?: string; envVersion?: number }) => {
      currentOpts = { ...currentOpts, ...patch };
      rootRef.render(appNode(currentOpts));
      await sleep(300);
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
      model: "minimax-cn/MiniMax-M3",
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
      model: "minimax-cn/MiniMax-M3",
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
    const app = await mountAsync({ model: "minimax-cn/MiniMax-M3" });
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
    const app = await mountAsync({ model: "minimax/MiniMax-M3" });
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
      model: "minimax-cn/MiniMax-M3",
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
      model: "minimax-cn/MiniMax-M2",
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
    const app = await mountAsync({ model: "minimax/MiniMax-M3" });
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("minimax/MiniMax-M3") && f.includes("ctx"),
      8000,
      "contextbar-noprov"
    );
    expect(frame).toContain("minimax/MiniMax-M3");

    app.destroy();
  }, 30_000);

  test("settings 热更新切路由 → 状态栏跟随新条目的 name（SC13 重投影）", async () => {
    const app = await mountAsync({
      providers: PROVIDERS,
      model: "minimax-cn/MiniMax-M3",
      envVersion: 0,
    });
    await untilFrame(
      app.setup,
      (f) => f.includes("MiniMax M3") && f.includes("ctx"),
      8000,
      "contextbar-before-reload"
    );

    // 模拟宿主 env reload：envVersion 递增 + 新 model prop（run.tsx 的
    // onEnvChange 接线形状）。`[envVersion]` effect 同步 modelName 后，
    // ContextBar 必须重投影为新路由的 name。
    await app.rerenderWith({
      model: "volcengine-ark/deepseek-v3-250324",
      envVersion: 1,
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

    app.destroy();
  }, 30_000);
});
