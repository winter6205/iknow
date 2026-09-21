/** @jsxImportSource @opentui/react */
/**
 * tests/tui/model-command.test.tsx
 *
 * TuiApp end-to-end for the /model command:
 *  - non-empty registry → /model opens the picker, ↑↓ move focus, Enter selects
 *    → onPersistModel receives `{ model: "<provider>/<model>" }` (persistence
 *    contract) and the picker closes;
 *  - empty / absent registry → notice contains 「未配置 providers」 ("no
 *    providers configured"), picker stays shut;
 *  - Esc → close only, no onPersistModel (no cancel semantics: focus moves
 *    stage nothing, so Esc is neither "save and quit" nor "discard");
 *  - /info prints `Model: <current model string>`.
 *
 * Real bridge/hub + stub deps (makeDeps) + real TUI renderer: the slash path
 * must be verified through real key delivery (pure-function tests cannot
 * cover app-level key routing).
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
  /** Publish point for the host-env-derived display snapshot (equivalent of run.tsx onEnvChange). */
  readonly store: ReturnType<typeof createEnvDisplayStore>;
  /** Simulate host env reload: publish only, do **not** rerender the React tree —
   *  the core regression pin (old wiring propagated the new model precisely by
   *  rerendering the whole tree). */
  readonly publish: (seed: EnvDisplaySeed) => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressEscape: () => Promise<void>;
  readonly pressSpace: () => Promise<void>;
  readonly pressArrow: (dir: "up" | "down") => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** thinking baseline: off + no tier (same shape as the old absent `props.defaultThinking`). */
const BASELINE_OFF: DefaultThinkingShape = { mode: "off", effort: "" };

async function mountAsync(opts: {
  readonly providers?: ReadonlyArray<IknowSettingsLlmProvider>;
  /** initial envDisplay snapshot (replaces the old `model` / `defaultThinking` props). */
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

/** Erase the pty cursor block (U+2588). Cursor blink is unrelated to env
 *  publish and must be neutralized before per-line diffing, otherwise it
 *  manufactures "changed lines" that have nothing to do with the change. */
function stripCursor(frame: string): string {
  return frame.replaceAll("█", " ");
}

/** Lines that **changed** between two frames (paired by row index; unequal
 *  length → all treated as changed). captureCharFrame yields the char plane
 *  only (no color), so pulsing colors create no false diffs. */
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
 * Host wiring from reducer → applyModelPickerKey (same shape as app.tsx's
 * onMove/onSelect): the focus index is driven only by the reducer's move
 * result, and Enter commits exactly that index.
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
    // only the first 12 entries render; clamping to entryCount-1 would make Enter commit model-12.
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
    // focus seeded on the current model (entry 0): cursor lands on that line.
    const focusedLine = opened
      .split("\n")
      .find((l) => l.includes("minimax-cn/MiniMax-M3"));
    expect(focusedLine).toContain("▸ ");

    // ↓ ↓ → entry 2 (volcengine-ark/deepseek-v3-250324).
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
    // persistence patch = the selected routing ID.
    expect(calls[0]).toEqual({ model: "volcengine-ark/deepseek-v3-250324" });
    // picker closed (selection is done; write-back is a background action).
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
    // write-back not triggered (Esc is not a save path).
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
    // picker not opened: no key hint, no title line.
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
    // wait until the status bar shows the display name (ContextBar is the first line below the prompt).
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("MiniMax M3") && f.includes("ctx"),
      8000,
      "contextbar-name"
    );
    const bar = frame
      .split("\n")
      .find((l) => l.includes("ctx") && l.includes("MiniMax M3"));
    // the status bar should show name, not the routing string (/info's Model line is not open).
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

    // simulate host env reload (run.tsx onEnvChange wiring): publish the new
    // snapshot only, do **not** rerender the React tree — subscribers
    // (ContextBar) re-project the new routing's name themselves.
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
    // the old name no longer appears on the status-bar line (picker closed in the same frame, no other source).
    expect(
      reloaded
        .split("\n")
        .find((l) => l.includes("ctx") && l.includes("DeepSeek V3"))
    ).not.toContain("MiniMax M3");

    // a model switch may only affect "the line that displays the model name"
    // — per-line diff, every other line must stay byte-identical. If the
    // change ever triggers a full-tree redraw (React remount / message-area
    // recompute), this fails first; it is the most direct regression pin for
    // "no user-visible flicker" (the input caret column is stripped before
    // comparing: caret blink is unrelated to this publish and
    // captureCharFrame's char plane cannot distinguish it).
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

    // baseline off → /thinking picker Esc commits ON (user hand-set; effort untouched).
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

    // env snapshot that changes only the model: thinking baseline stays off, but the user hand-set ON.
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
    // (a) the hand-set thinking override survives (old implementation would snap back to baseline off).
    expect(frame).toContain("thinking: adaptive (auto)");
    // the model itself did follow the new snapshot.
    expect(frame).toContain("Model: volcengine-ark/deepseek-v3-250324");

    // (b) the untouched effort field still follows baseline changes: new
    // baseline adaptive/high → thinking is held by the user, effort has no
    // override → takes the new value high.
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
