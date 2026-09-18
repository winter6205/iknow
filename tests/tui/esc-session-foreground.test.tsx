/** @jsxImportSource @opentui/react */
/**
 * plans/session-fg-handoff-interrupt Locked sentence 3 / T5 的 app 层接线测：
 * Esc = 当前会话**前台一切**（父 `running-fg` turn + 本会话所有前景子代理），
 * 前台有活时打断赢过双 Esc 回退判定；后景 `wait:false` 与其它会话不动。
 * 2026-09-18 键位迁移：打断自 Ctrl+C 迁入 Esc（Ctrl+C 只剩选区复制，复制
 * 用例保留在本文件作对照）。
 *
 * 分层：
 *   - 扇出语义（conversationId / foreground / live / 返回值）的 SSOT 层归
 *     tests/session-api/hub-abort-session-foreground.test.ts（真 SessionHub +
 *     fake manager）；
 *   - 本文件钉 app 的**键位→调用**与**顺序**：Esc 必须调到
 *     `bridge.abortSessionForegroundWork(本会话)` 且父 aborter 同时 abort；
 *     前台活时打断不落双 Esc picker；无前台活时 Ctrl+C 选区复制行为不变。
 *   - 「不复制」的观测面是**复制通道调用点**（mountApp 的 OSC52/fallback
 *     seam，同 tests/tui/copy-osc52-gate.test.tsx），不是 notice 文案：前台
 *     在跑时 turn 收尾会用「已打断…」覆盖复制 notice，帧上恒无「已复制」，
 *     拿它当判据等于没判（复制真的发生也绿）。seam 的可证伪性由阳性对照
 *     用例（Ctrl+C + 有选区 → 计数 = 1）钉住。
 *   - 「abort 真的抵达 wait 链」的下游一半（SubAgentAbortError 拒绝 waitFor）
 *     归 tests/tui/wait-cancel-abort.test.tsx。
 *
 * 为什么用 fake bridge：本测的命题是「按键 → 调谁、什么顺序」，真 manager
 * 的 SIGTERM→SIGKILL 与 hub 过滤已有各自覆盖面（见上）。fake bridge 只把
 * 出口换成可观测的计数/字符串，其余字段与产品 TuiBridge 同形。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import type { TuiBridge } from "../../src/tui/hub-bridge.js";
import { createInflightRegistry } from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import {
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import { captureStderr } from "../_helpers/capture-stderr.ts";

const COLS = 80;
const ROWS = 30;
const CONVERSATION_ID = "conv-fg-c";

interface ForegroundRig {
  readonly setup: TestRendererSetup;
  readonly abortCalls: string[];
  readonly abortSessionCalls: string[];
  readonly wakeCalls: string[];
  /** 由 coordinator 注入的「本会话是否有在飞前景子代理」（扇出返回值）。 */
  readonly abortedByFanOut: string[];
  /** postMessage 被调用次数（真 turn 已启动的观测面）。 */
  readonly postCount: () => number;
  /**
   * 复制通道被走过的次数：`doCopy` 的两条出口（OSC52 命中 / 原生 fallback）
   * 各记一次。**渲染无关**的观测面 —— 见 `mountApp` 的 seam 说明。
   */
  readonly copyCalls: () => number;
  readonly stderr: ReturnType<typeof captureStderr>;
  readonly dispose: () => Promise<void>;
}

function makeSessionFile(dataDir: string): SessionFileV1 {
  return {
    id: CONVERSATION_ID,
    workspaceRoot: dataDir,
    messages: [],
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
  };
}

interface MountOptions {
  readonly session: TuiSessionState;
  /** 扇出返回值（真实 hub 的形态 = 本会话 live 前景 taskId）。 */
  readonly fanOutResult?: ReadonlyArray<string>;
  /** 观测出口：真实 manager 的 listSubagents 投影（本测不按键时用）。 */
  readonly subagents?: ReadonlyArray<SubagentInfo>;
}

async function mountApp(opts: MountOptions): Promise<ForegroundRig> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-ctrl-c-fg-"));
  const file = makeSessionFile(dataDir);
  const abortCalls: string[] = [];
  let posts = 0;
  const abortSessionCalls: string[] = [];
  const wakeCalls: string[] = [];
  const abortedByFanOut = [...(opts.fanOutResult ?? [])];
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? CONVERSATION_ID,
    // 挂起不返回：turn 停在 running-fg，父 aborter 留在登记簿（abort 后
    // promise 由 abort signal 收尾，但本测只观测 abort 是否发出）。
    postMessage: ({ signal }) =>
      new Promise((_resolve, reject) => {
        posts += 1;
        signal?.addEventListener("abort", () => {
          abortCalls.push(CONVERSATION_ID);
          reject(new Error("aborted"));
        });
      }),
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("unused");
    },
    rewindSession: async () => file,
    listRewindTargets: async () => [],
    inflight: createInflightRegistry(),
    contextWindow: 200_000,
    getCapacity: () => 15,
    listSubagents: () => opts.subagents ?? [],
    abortSubagentTask: () => true,
    abortSessionForegroundWork: (conversationId) => {
      abortSessionCalls.push(conversationId);
      return abortedByFanOut;
    },
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async (conversationId) => {
      wakeCalls.push(conversationId);
    },
  };
  const stderr = captureStderr();
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
      initialSession={opts.session}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  // attachSession 经 bridge.ensureSession(conversationId) 走真 store 判定
  // 已建档（有 id 即已存在），首帧后落 active；initialSession 的 runState 由
  // 下方测试驱动（真跑 turn 挂起），不靠注入伪造。
  await setup.waitForVisualIdle();

  // ── 复制通道 seam（观测点 = 调用点，不是 notice） ────────────────────
  // 本文件的命题含「前台活时 Ctrl+C 不得复制」。notice 不是判据：turn 收尾
  // 会 `setNotice({lines:["已打断…"]})` 覆盖掉复制 notice，故「帧上无『已
  // 复制』」在 running-fg 用例里恒真 —— 复制真的发生了也照样绿（空洞）。
  // 与 tests/tui/copy-osc52-gate.test.tsx 同款 seam：在真 renderer 上替换
  // `doCopy` 的两条出口（OSC52 与原生 fallback），任一被调即计数。计数与
  // 渲染顺序无关，无法被 setNotice 掩盖。
  const r = setup.renderer as unknown as {
    isOsc52Supported(): boolean;
    copyToClipboardOSC52(text: string): boolean;
  };
  const realOsc52Copy = r.copyToClipboardOSC52;
  let copyCalls = 0;
  (r as unknown as { isOsc52Supported: () => boolean }).isOsc52Supported = () =>
    true;
  (
    r as unknown as { copyToClipboardOSC52: (t: string) => boolean }
  ).copyToClipboardOSC52 = (text: string) => {
    copyCalls += 1;
    return realOsc52Copy.call(setup.renderer, text);
  };

  return {
    setup,
    postCount: () => posts,
    abortCalls,
    abortSessionCalls,
    wakeCalls,
    abortedByFanOut,
    copyCalls: () => copyCalls,
    stderr,
    dispose: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      stderr.restore();
    },
  };
}

function fakeSelection(text: string): {
  getSelectedText(): string;
  touchedRenderables: unknown[];
} {
  return { getSelectedText: () => text, touchedRenderables: [] };
}

/** 已建档会话（draft 会话 conversationId undefined → 扇出无会话可传）。 */
function session(): TuiSessionState {
  return Object.freeze({
    ...createDraftSession(),
    conversationId: CONVERSATION_ID,
  });
}

/** 逐键发一条消息启动真 turn（连发会丢键：mockInput 走 stdin 异步解析）。 */
async function sendMessage(
  setup: TestRendererSetup,
  text: string
): Promise<void> {
  for (const ch of text) {
    setup.mockInput.pressKey(ch);
    await new Promise((r) => setTimeout(r, 60));
  }
  setup.mockInput.pressEnter();
}

/** 条件轮询（按键落地 + React commit 都有延迟）。 */
async function until(
  cond: () => boolean,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`until timeout: ${label}`);
}

async function settle(setup: TestRendererSetup): Promise<void> {
  await setup.waitForVisualIdle();
  await new Promise((r) => setTimeout(r, 30));
  await setup.waitForVisualIdle();
}

/**
 * 挂起一个真 turn：bridge.postMessage 永不 settle（模拟前景 turn 在飞），
 * 父 aborter 因此在册 → `canInterrupt(active)` 为真。
 *
 * 两段等待都是必须的：
 *  1. postMessage 被调 = turn 已启动（输入落地 / 建档都过了）；
 *  2. 帧上出现 mode 行的实时秒数段（` · Xs`，runState 由 turnStarted 置
 *     running-fg 后 1Hz tick 递增）—— 只有 runState 真的进了 React 态，
 *     Esc 才落到前台打断臂；不等这一格，按键可能赶在 commit 前
 *     发出而走 idle 分支（abort 永不发出 = 空洞绿灯）。
 */
async function startPendingTurn(app: ForegroundRig): Promise<void> {
  await sendMessage(app.setup, "hi");
  await until(
    () => app.postCount() > 0,
    8000,
    "turn 未启动（postMessage 未调）"
  );
  await until(
    () => /· \d+s/.test(app.setup.captureCharFrame()),
    8000,
    "会话未进入 running-fg（mode 行无实时秒数）"
  );
}

describe("Esc = 当前会话前台一切（Locked sentence 3 / T5，2026-09-18 键位迁移）", () => {
  test("running-fg：父 aborter 触发 + 本会话扇出被调用一次", async () => {
    const app = await mountApp({ session: session(), fanOutResult: ["t-fg"] });
    try {
      await startPendingTurn(app);
      app.setup.mockInput.pressEscape();
      await until(() => app.abortCalls.length > 0, 8000, "父 turn 未被 abort");

      expect(app.abortSessionCalls).toEqual([CONVERSATION_ID]);
      expect(app.abortCalls).toEqual([CONVERSATION_ID]);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("父 idle + 前景子代理 live：扇出被调用，且不落双 Esc picker", async () => {
    const app = await mountApp({
      session: session(),
      fanOutResult: ["t-late"],
    });
    try {
      // 不跑 turn：父 runState 停在 idle，只有 hub 侧有在飞前景子代理。
      app.setup.mockInput.pressEscape();
      await until(() => app.abortSessionCalls.length > 0, 8000, "扇出未被调用");

      expect(app.abortSessionCalls).toEqual([CONVERSATION_ID]);
      // 父无 aborter（无 in-flight postMessage）→ 不崩、不误报。
      expect(app.abortCalls).toEqual([]);
      await settle(app.setup);
      // 打断臂赢过双 Esc 回退判定：picker 没被打开（无标题行）。
      expect(app.setup.captureCharFrame()).not.toContain("回退到更早的回合");
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("父 idle + 前景子代理 live + 有选区：仍然打断，不复制", async () => {
    // Locked sentence 3 的顺序条款在**父已 idle** 时同样成立：前台活在子代
    // 理身上，Esc 的意图仍是打断。判据必须来自扇出的新鲜账（hub 现拉），
    // 不能是 TUI 1Hz 投影 —— 本测用 fanOutResult 模拟 hub 的新鲜回答。
    const app = await mountApp({
      session: session(),
      fanOutResult: ["t-late"],
    });
    try {
      const selectedText = "父 idle 时的选区";
      (
        app.setup.renderer as unknown as { currentSelection: unknown }
      ).currentSelection = fakeSelection(selectedText);
      app.setup.renderer.emit("selection", fakeSelection(selectedText));
      await settle(app.setup);

      app.setup.mockInput.pressEscape();
      await until(() => app.abortSessionCalls.length > 0, 8000, "扇出未被调用");

      expect(app.abortSessionCalls).toEqual([CONVERSATION_ID]);
      await settle(app.setup);
      // 复制通道零调用 = Esc 无复制语义（复制只归 Ctrl+C）。
      expect(app.copyCalls()).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("running-fg + 有选区：打断优先（Esc 无复制臂），不复制", async () => {
    const app = await mountApp({ session: session(), fanOutResult: ["t-fg"] });
    try {
      await startPendingTurn(app);
      const selectedText = "被选中的正文";
      (
        app.setup.renderer as unknown as { currentSelection: unknown }
      ).currentSelection = fakeSelection(selectedText);
      app.setup.renderer.emit("selection", fakeSelection(selectedText));
      await settle(app.setup);

      app.setup.mockInput.pressEscape();
      await until(() => app.abortCalls.length > 0, 8000, "父 turn 未被 abort");

      expect(app.abortCalls).toEqual([CONVERSATION_ID]);
      expect(app.abortSessionCalls).toEqual([CONVERSATION_ID]);
      await settle(app.setup);
      // 复制通道零调用 = Esc 无复制臂（与旧 Ctrl+C「打断优先」同判据面）。
      expect(app.copyCalls()).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("running-fg + 扇出空返回：仍以父 turn 为前台活 → 打断", async () => {
    // 顺序判据必须是「canInterrupt(父) OR 扇出非空」，不是只看扇出。本测把
    // 扇出压成空（无子代理可停）+ running-fg —— 若实现只信扇出返回值，
    // 这里会落进双 Esc 回退判定而漏 abort 父 turn。
    const app = await mountApp({ session: session(), fanOutResult: [] });
    try {
      await startPendingTurn(app);
      app.setup.mockInput.pressEscape();
      await until(() => app.abortCalls.length > 0, 8000, "父 turn 未被 abort");

      expect(app.abortCalls).toEqual([CONVERSATION_ID]);
      await settle(app.setup);
      expect(app.copyCalls()).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("Ctrl+C 复制臂保留：有选区复制（seam 阳性对照），打断不误触", async () => {
    // 2026-09-18 键位迁移后 Ctrl+C 只剩复制：有选区 → 复制，不打断。
    // 同一 seam 在复制真的发生时必须计数 > 0；若不架这条阳性对照，seam
    // 本身失效（比如 doCopy 换了出口）会让「零调用」永远绿。
    const app = await mountApp({ session: session(), fanOutResult: [] });
    try {
      const selectedText = "阳性对照：这段必须被复制";
      (
        app.setup.renderer as unknown as { currentSelection: unknown }
      ).currentSelection = fakeSelection(selectedText);
      app.setup.renderer.emit("selection", fakeSelection(selectedText));
      await settle(app.setup);

      app.setup.mockInput.pressCtrlC();
      await until(() => app.copyCalls() > 0, 8000, "复制通道未被调用");

      expect(app.copyCalls()).toBe(1);
      expect(app.abortCalls).toEqual([]);
      expect(app.abortSessionCalls).toEqual([]);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("idle + 无前景子代理 + 有选区：Ctrl+C 复制行为不变（回归）", async () => {
    const app = await mountApp({ session: session(), fanOutResult: [] });
    try {
      const selectedText = "idle 会话的选区";
      (
        app.setup.renderer as unknown as { currentSelection: unknown }
      ).currentSelection = fakeSelection(selectedText);
      app.setup.renderer.emit("selection", fakeSelection(selectedText));
      await settle(app.setup);

      app.setup.mockInput.pressCtrlC();
      await settle(app.setup);

      const frame = app.setup.captureCharFrame();
      expect(frame).toMatch(/已复制|已写入/);
      expect(app.copyCalls()).toBe(1);
      expect(app.abortCalls).toEqual([]);
      expect(app.abortSessionCalls).toEqual([]);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("idle + 无选区 + Ctrl+C：提示复制用法（不再指向打断）", async () => {
    const app = await mountApp({ session: session(), fanOutResult: [] });
    try {
      app.setup.mockInput.pressCtrlC();
      await until(
        () => app.setup.captureCharFrame().includes("无选区"),
        8000,
        "复制提示未出现"
      );

      expect(app.abortSessionCalls).toEqual([]);
      expect(app.abortCalls).toEqual([]);
      expect(app.stderr.lines.join("")).toBe("");
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("双 Esc 回退（idle）：第二击在窗口内 → 走到 openRewindPicker", async () => {
    // 门禁 input-contract 缺口：app 层「双 Esc → picker」此前只有
    // isDoubleEsc 纯函数覆盖（tests/tui/rewind.test.ts），无端到端接线用例。
    // 本测钉：两击都落 idle 臂（记时间戳 / 命中窗口）→ openRewindPicker 被调。
    // fake bridge 无锚点（listRewindTargets → []）→ L0 空态 notice 上屏，
    // 它是 openRewindPicker 的独有出口，足以证明双 Esc 路径被走到。
    // 每击 Esc 都先空转一趟扇出（hub 只读枚举，空闲返回空无副作用）。
    const app = await mountApp({ session: session(), fanOutResult: [] });
    try {
      app.setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 100));
      app.setup.mockInput.pressEscape();
      await until(
        () =>
          app.setup.captureCharFrame().includes("Nothing to rewind to yet."),
        8000,
        "rewind 空态 notice 未出现"
      );

      expect(app.abortCalls).toEqual([]);
      expect(app.abortSessionCalls).toEqual([CONVERSATION_ID, CONVERSATION_ID]);
    } finally {
      await app.dispose();
    }
  }, 30_000);
});
