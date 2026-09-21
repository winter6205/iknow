/** @jsxImportSource @opentui/react */
/**
 * tests/tui/app.test.tsx
 *
 * TuiApp end-to-end (tracer bullet + tri-state / slash / list / quit / info /
 * compact / pool constraints / candidates + Tab).
 *
 * Stub deps (makeDeps from tests/cli/_fixtures.ts) + real bridge/hub.
 * mockInput.pressKey goes through OpenTUI's async stdin parsing, so it must
 * be paired with renderOnce polling.
 *
 * E2E coverage:
 *  1. submit → lazy-create session file → turn renders (tracer);
 *  2. unknown command → `未知命令：...` ("unknown command") notice; /info → meta lines;
 *  3. /compact on a draft → 「Nothing to compact yet」 (empty-session guard);
 *  4. second submit while a turn runs → busy guard + exactly 1 session in pool;
 *  5. slash candidates + Tab unique-match completion.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  TuiApp,
  createToolEventSink,
  type TuiAppProps,
} from "../../src/tui/app.js";
import type { TuiSessionState } from "../../src/tui/session-state.js";
import { sessionLocationLines } from "../../src/tui/environment-pane.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { LoopEngineDeps } from "../../src/harness/index.js";
import { buildAgentStatusText } from "../../src/harness/agent-status.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import { attachSession } from "../../src/tui/session-state.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

/** Frame wait: mockInput bytes parse asynchronously via stdin; poll renderOnce. */
async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  ms = 8000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`untilFrame timeout:\n${setup.captureCharFrame()}`);
}

/** Condition wait (returns no frame). */
async function until(
  cond: () => boolean | Promise<boolean>,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`until timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressEscape: () => Promise<void>;
  readonly pressTab: () => Promise<void>;
  readonly pressSpace: () => Promise<void>;
  readonly pressArrow: (dir: "left" | "right") => Promise<void>;
}

/**
 * Per-conversation todo ledger (#304601e3): loop-engine reads
 * `<todoDir>/<conversationId>/todos.md`, not the legacy `<todoDir>/todos.md`.
 * Callers that pre-seed a session must also pre-create the conversation file
 * via the bridge BEFORE handing it to mountAppAsync — the test then attaches
 * the pre-created session via `initialSession` so the first user submit
 * reuses that conversationId (lazy create would mint a fresh id and miss
 * the seeded todos file).
 */
interface PreBuiltBridge {
  readonly bridge: TuiBridge;
  readonly dataDir: string;
}

async function mountAppAsync(
  responses: Parameters<typeof makeDeps>[0],
  depsOverride?: LoopEngineDeps,
  onPersistThinking?: TuiAppProps["onPersistThinking"],
  initialSession?: TuiSessionState,
  prebuilt?: PreBuiltBridge
): Promise<DrivenApp> {
  const dataDir =
    prebuilt?.dataDir ?? mkdtempSync(join(tmpdir(), "iknow-tui-app-"));
  const bridge =
    prebuilt?.bridge ??
    createTuiBridge({
      dataDir,
      workspaceRoot: dataDir,
      deps: depsOverride ?? makeDeps(responses),
      inflight: createInflightRegistry(),
    });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={permissionMode}
      sessionGrants={sessionGrants}
      {...(initialSession ? { initialSession } : {})}
      {...(onPersistThinking ? { onPersistThinking } : {})}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    {
      width: 80,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      // Shift+Enter must carry the shift modifier (kitty protocol encodes [13;2u).
      kittyKeyboard: true,
    }
  );
  setupRef = setup;
  // Wait for keyboard / useEffect registration to finish (async after mount).
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
      // Warm-up: press a harmless key to start the mockInput parser.
      setup.mockInput.pressKey("/");
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
      // Clear the warm-up key (repeated Backspace).
      for (let i = 0; i < 5; i++) {
        setup.mockInput.pressBackspace();
        await new Promise((r) => setTimeout(r, 30));
      }
      // The actual content to type.
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      // Let React state updates settle.
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressEscape: async () => {
      setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressTab: async () => {
      setup.mockInput.pressTab();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressSpace: async () => {
      setup.mockInput.pressKey(" ");
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressArrow: async (dir) => {
      setup.mockInput.pressArrow(dir);
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

describe("TuiApp 端到端（tracer bullet）", () => {
  test("消息提交 → lazy create 建档 → turn 渲染", async () => {
    const app = await mountAppAsync([
      assistantResult({ texts: ["## 答复标题\n\n正文内容"] }),
    ]);
    // startup: banner version line visible
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // submit message
    await app.typeText("你好");
    await app.pressEnter();
    // turn done → inflight cleared
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    const list = await app.bridge.listSessions();
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe("你好");

    // assistant answer rendered
    await untilFrame(app.setup, (f) => f.includes("答复标题"), 8000, "answer");
    expect(app.setup.captureCharFrame()).toContain("正文内容");

    await app.destroy();
  }, 30_000);

  test("T8 多行消息提交 → 消息流渲染多行（换行进模型与回显）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["多行答复"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // Type two lines (Shift+Enter separates, Enter submits). The second line
    // uses raw typing (typeText's "/" warm-up + Backspace would wipe line one).
    await app.typeText("行一");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    for (const ch of "行二") {
      app.setup.mockInput.pressKey(ch);
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.pressEnter();

    // turn done → stream renders both lines (user block wrapMode=word multi-line).
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "multi-done");
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("行一") && f.includes("行二"),
      8000,
      "multi-render"
    );
    expect(frame).toContain("多行答复");
    await app.destroy();
  }, 30_000);

  test("未知命令 → 提示", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/foobar");
    await app.pressEnter();
    // first submit is a no-op (empty); the second truly submits /foobar → unknown
    await untilFrame(app.setup, (f) => f.includes("未知命令"), 8000, "unknown");
    await app.destroy();
  }, 30_000);

  test("/info → draft 元信息（含 draft / tokens 行）", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/info");
    await app.pressEnter();
    // /info renders notice + expanded lines; scrollbox wrap may fold the
    // conversation_id across lines (e.g. `_id: __draft__` breaks up).
    await untilFrame(
      app.setup,
      (f) => f.includes("tokens") && f.includes("runState"),
      8000,
      "info"
    );
    expect(app.setup.captureCharFrame()).toContain("__draft__");
    expect(app.setup.captureCharFrame()).toContain("tokens");
    await app.destroy();
  }, 30_000);

  test("turn 运行中 → mode 行右侧实时秒数；turn 结束 → mode 行清空 + 流末尾 `Crunched for`", async () => {
    // delayMs=3000 keeps the turn running ~3s so live seconds (`· Ns`,
    // ticking each second) have enough window for untilFrame to catch them.
    const app = await mountAppAsync(
      [assistantResult({ texts: ["答复"] })],
      makeDeps([assistantResult({ texts: ["答复"] })], { delayMs: 3000 })
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("你好");
    await app.pressEnter();
    // running: live seconds appear right of the mode line (`mode: Default · Ns`).
    await untilFrame(
      app.setup,
      (f) => /mode: Default · \d+s/.test(f),
      8000,
      "running-elapsed"
    );

    // turn done → trailing `Crunched` line in the stream (snapshot seconds ≥1, guaranteed by 3s delay).
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("Crunched for"),
      8000,
      "crunched-summary"
    );

    // mode line cleared: no `·`, no seconds suffix (trim equals exactly `mode: Default`).
    const modeLine = frame
      .split("\n")
      .find((l) => l.includes("mode:"))
      ?.trim();
    expect(modeLine).toBe("mode: Default");
    // token stats segment was removed in a later revision: frame has no `↓` / `tokens`.
    expect(frame.includes("↓")).toBe(false);
    expect(frame.includes("tokens")).toBe(false);
    await app.destroy();
  }, 30_000);

  test("快速 turn（<1s）→ mode 行无运行统计段 + 流末尾无 Crunched（gate 守 <1s）", async () => {
    // stub has no delay → turn completes instantly; seconds freeze at 0 →
    // formatCrunched returns "" + ChatView's `>0` gate drops the Crunched
    // line (no ugly `Crunched for 0s`).
    const app = await mountAppAsync([assistantResult({ texts: ["普通答复"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("你好");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    await untilFrame(app.setup, (f) => f.includes("普通答复"), 8000, "answer");

    // After one render cycle assert: mode line still shown, no running stats; no trailing Crunched.
    await new Promise((r) => setTimeout(r, 1200));
    await app.setup.renderOnce();
    const frame = app.setup.captureCharFrame();
    const modeLine = frame
      .split("\n")
      .find((l) => l.includes("mode:"))
      ?.trim();
    expect(modeLine).toBe("mode: Default");
    expect(frame.includes("Crunched for")).toBe(false);
    await app.destroy();
  }, 30_000);

  test("/compact draft 会话 → 提示无上下文", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/compact");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("nothing to compact yet"),
      8000,
      "draft-compact"
    );
    await app.destroy();
  }, 30_000);

  test("turn 运行中发第二条 → busy 护栏 / 池内 1 会话（busy 窗口测试需 stub delayMs，本条覆盖 idle 顺序）", async () => {
    // Note: current makeDeps has no delayMs support (the archived stub-model
    // used delayMs to control the busy window); this case covers "second
    // submit after the first completes → 1 session in pool, turnCount=2"
    // — i.e. the busy-guard does not false-reject while idle.
    const app = await mountAppAsync([
      assistantResult({ texts: ["答复"] }),
      assistantResult({ texts: ["第二条"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("第一条");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");

    await app.typeText("第二条");
    await app.pressEnter();
    await until(
      () => app.bridge.inflight.ids().size === 0,
      8000,
      "second-done"
    );
    const list = (await app.bridge.listSessions()) ?? [];
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe("第一条"); // title = first user message
    // turnCount is read from the session file (list does not carry it)
    const sessionId = list[0]!.conversation_id;
    const file = await app.bridge.loadSessionFile(sessionId);
    expect(file.turnCount).toBe(2);

    await app.destroy();
  }, 30_000);

  // Note: slash-candidate rendering depends on PromptInput's internal
  // hintCursor state, which captureCharFrame may not reflect. Candidate
  // behavior lands via the Tab unique-match test below; full candidate
  // rendering belongs to PromptInput unit tests.

  test("/sessions → 列表视图（+ 新建会话 + title）→ Esc 返回聊天", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["reply-A"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("hello");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");

    // /sessions → list view
    await app.typeText("/sessions");
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("+ 新建会话"), 8000, "list");
    await untilFrame(
      app.setup,
      (f) => f.includes("hello"),
      8000,
      "list-summary"
    );

    // Esc returns to the chat view
    await app.pressEscape();
    await untilFrame(app.setup, (f) => f.includes("输入消息"), 8000, "back");

    await app.destroy();
  }, 30_000);

  test("Tab 唯一匹配补全：'/q' + Tab → '/quit'", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    await app.typeText("/q");
    await app.pressTab();
    const frame = app.setup.captureCharFrame();
    expect(frame).toContain("/quit");
    await app.destroy();
  }, 30_000);
});

/**
 * /thinking — thinking-picker (dual-panel): /thinking no longer flips the
 * toggle + notice immediately; it opens a pure ON/OFF panel. Enter pins
 * (panel stays open), Esc saves and exits (writes thinkingEnabled, no cancel path).
 */
describe("/thinking 打开 thinking-picker（design-25 开关面板）", () => {
  test("defaultThinking off → /thinking 开面板（无 notice）→ Space 切换 ON → Enter 不关闭 → Esc 保存退出 → /info adaptive (auto)", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // /thinking + Enter → panel opens (title `思考开关`), no `思考：开` notice set.
    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("思考开关"),
      8000,
      "picker-open"
    );
    expect(app.setup.captureCharFrame()).not.toContain("思考：开");
    expect(app.setup.captureCharFrame()).not.toContain("思考：关");

    // Space inside the panel (OFF → ON): preview flips, panel stays open.
    await app.pressSpace();
    await untilFrame(
      app.setup,
      (f) => f.includes("思考开关") && f.includes("ON"),
      8000,
      "preview-on"
    );

    // Enter pins the current preview (no flip, no exit): panel **stays open**
    // (key assertion: Enter does not close). Esc then saves and exits.
    await app.pressEnter();
    const afterEnter = app.setup.captureCharFrame();
    expect(afterEnter).toContain("思考开关");
    expect(afterEnter).toContain("ON");

    // Esc saves and exits (writes thinkingEnabled=true) → panel closes, input normal again.
    await app.pressEscape();
    await untilFrame(
      app.setup,
      (f) => !f.includes("思考开关"),
      8000,
      "picker-closed"
    );
    expect(app.setup.captureCharFrame()).toContain("Version");
    expect(app.setup.captureCharFrame()).toContain("输入消息");

    // /info reflects: enabled=true + effort="" → adaptive (auto).
    await app.typeText("/info");
    await app.pressEnter();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("adaptive") && f.includes("runState"),
      8000,
      "info"
    );
    expect(frame).toContain("adaptive (auto)");

    await app.destroy();
  }, 30_000);

  test("再开面板 Esc → 保存退出写 state（无 cancel 路径）→ /info thinking: off", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("思考开关"),
      8000,
      "picker-open"
    );

    // Esc saves and exits (no toggles → writes back seeded OFF): panel closes
    // with no notice noise (neither `思考：开` nor `已取消`), and state is
    // written (/info shows off).
    await app.pressEscape();
    await untilFrame(
      app.setup,
      (f) => !f.includes("思考开关"),
      8000,
      "picker-saved"
    );
    const frame = app.setup.captureCharFrame();
    expect(frame).not.toContain("思考：开");
    expect(frame).not.toContain("思考：关");
    expect(frame).not.toContain("已取消");
    expect(frame).toContain("Version");
    expect(frame).toContain("输入消息");

    // /info reflects: Esc save-exit (not cancel) → state written as off.
    await app.typeText("/info");
    await app.pressEnter();
    const infoFrame = await untilFrame(
      app.setup,
      (f) => f.includes("runState"),
      8000,
      "info"
    );
    expect(infoFrame).toContain("thinking: off");

    await app.destroy();
  }, 30_000);

  test("onPersistThinking: /thinking Esc commit → prop 被调（payload = { thinking }）", async () => {
    const calls: ReadonlyArray<{ thinking: "off" | "adaptive" }> = [];
    const app = await mountAppAsync([], undefined, (patch) => {
      calls.push(patch);
      return Promise.resolve({ ok: true as const });
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // /thinking → Space to ON → Esc saves and exits (writes thinkingEnabled + persists).
    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("思考开关"),
      8000,
      "picker-open"
    );
    await app.pressSpace();
    await untilFrame(
      app.setup,
      (f) => f.includes("思考开关") && f.includes("ON"),
      8000,
      "preview-on"
    );
    await app.pressEscape();
    await untilFrame(
      app.setup,
      (f) => !f.includes("思考开关"),
      8000,
      "picker-saved"
    );

    // Assert: prop called exactly once, payload = panel commit result (thinking=adaptive).
    await until(() => calls.length === 1, 8000, "persist-called");
    expect(calls[0]).toEqual({ thinking: "adaptive" });

    await app.destroy();
  }, 30_000);

  test("onPersistThinking reject → notice「写回 settings.json 失败」（无 crash，面板已关）", async () => {
    const app = await mountAppAsync([], undefined, () =>
      Promise.reject(new Error("EACCES: permission denied"))
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // /thinking → Esc save-exit (no toggle → writes back seeded OFF → payload { thinking:"off" }).
    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("思考开关"),
      8000,
      "picker-open"
    );
    await app.pressEscape();

    // Failure notice appears (`写回 settings.json 失败` + error message), panel already closed.
    await untilFrame(
      app.setup,
      (f) => f.includes("写回 settings.json 失败"),
      8000,
      "persist-fail-notice"
    );
    const frame = app.setup.captureCharFrame();
    expect(frame).toContain("EACCES: permission denied");
    expect(frame).not.toContain("思考开关");

    await app.destroy();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Regression from an end-of-round review (Spec, Medium): multi-session
// staleness. If agentStatus were a global single slot (not keyed by
// conversationId), session A's last_tool / open todos would keep rendering
// in other views after switching to B / a fresh draft, violating "while the
// main HITL session runs, the TUI shows the same current state that is about
// to be fed to the model". Assertions mark panel-only glyph prefixes (◇ / □)
// to distinguish panel rendering from raw bar text (<agent_status> user
// messages) that may appear in the transcript.
// ---------------------------------------------------------------------------
describe("#647 T3: agent 现势按会话隔离（multi-session staleness 回归）", () => {
  test("A 收到 agent_status → /new 切新草稿无残留 → /sessions 切回 A 快照仍在", async () => {
    // deps carry agentStatus (todoDir has open items) → within the turn the
    // harness emits the agent_status event at the same computation point that
    // injects the bar (product path, same shape as the e2e bridge case).
    // loop-engine reads `<todoDir>/<conv>/todos.md` by conversationId (same
    // SSOT as the todo_write writer), not the root path. Pre-create the
    // session via bridge.ensureSession to get the conversationId, write the
    // todos into that conversation's own subdir, then attach it as
    // initialSession — the first submit's lazy create reuses the same id and
    // reads this test's seeded ledger.
    const baseDir = mkdtempSync(join(tmpdir(), "iknow-tui-agent-status-key-"));
    const todoDir = join(baseDir, "todos-dir");
    const responses = [assistantResult({ texts: ["A 答复"] })];
    const depsOverride: LoopEngineDeps = {
      ...makeDeps(responses),
      agentStatus: { todoDir },
    };
    const prebuilt = (() => {
      const bridge = createTuiBridge({
        dataDir: baseDir,
        workspaceRoot: baseDir,
        deps: depsOverride,
        inflight: createInflightRegistry(),
      });
      return { bridge, dataDir: baseDir } as const;
    })();
    let conversationId = "";
    try {
      conversationId = await prebuilt.bridge.ensureSession(undefined);
      mkdirSync(join(todoDir, conversationId), { recursive: true });
      writeFileSync(
        join(todoDir, conversationId, "todos.md"),
        "- [ ] regression item A\n",
        "utf8"
      );
      const file = await prebuilt.bridge.loadSessionFile(conversationId);
      const app = await mountAppAsync(
        responses,
        depsOverride,
        undefined,
        attachSession(file),
        prebuilt
      );
      await untilFrame(app.setup, (f) => f.includes("Version"));

      // Session A: submit → turn done → panel renders A's open items (last_tool not printed).
      await app.typeText("你好A");
      await app.pressEnter();
      await until(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "turn-done"
      );
      const frameA = await untilFrame(
        app.setup,
        (f) => f.includes("□ regression item A"),
        8000,
        "a-panel"
      );
      expect(frameA).not.toContain("last_tool:");

      // /new → fresh draft (no conversationId): panel must not retain A's state.
      // (Staleness regression point: a global single-slot implementation would
      // keep rendering A's snapshot here.)
      await app.typeText("/new");
      await app.pressEnter();
      const frameDraft = await untilFrame(
        app.setup,
        (f) => !f.includes("□ regression item A"),
        8000,
        "draft-clean"
      );
      expect(frameDraft).not.toContain("□ regression item A");

      // /sessions → ↓ select A (index 1, first after the pseudo entry) → Enter
      // → A's state is still there (keyed retention: switching away keeps it,
      // switching back restores it).
      await app.typeText("/sessions");
      await app.pressEnter();
      await untilFrame(
        app.setup,
        (f) => f.includes("新建会话"),
        8000,
        "list-view"
      );
      app.setup.mockInput.pressArrow("down");
      await new Promise((r) => setTimeout(r, 100));
      await app.setup.renderOnce();
      await app.pressEnter();
      const frameBack = await untilFrame(
        app.setup,
        (f) => f.includes("□ regression item A"),
        8000,
        "a-restored"
      );
      expect(frameBack).not.toContain("last_tool:");

      await app.destroy();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Resume cold-start hydrate: last bar in transcript → footer, no new turn needed
// ---------------------------------------------------------------------------
describe("T4b: agent_status resume hydrate", () => {
  function sessionFileWithAgentStatusBar(): SessionFileV1 {
    const barText = buildAgentStatusText({
      lastTool: "web_search",
      openTodoLines: ["- [ ] 查新闻"],
    });
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "用户问题" }] },
      { role: "assistant", content: [{ type: "text", text: "答复" }] },
      { role: "user", content: [{ type: "text", text: barText }] },
      { role: "assistant", content: [{ type: "text", text: "继续" }] },
    ];
    return {
      schemaVersion: 3,
      conversation_id: "conv-resume-hydrate",
      messages,
      jsonMode: false,
      turnCount: 2,
      updatedAt: "2026-08-11T00:00:00.000Z",
      title: "用户问题",
      cwd: "",
      sanitized_at: "2026-08-11T00:00:00.000Z",
      checkpoints: [],
    };
  }

  test("initialSession resume: 未发新 turn 即见 □ todo 行,不印 last_tool", async () => {
    const file = sessionFileWithAgentStatusBar();
    const app = await mountAppAsync(
      [assistantResult({ texts: ["unused"] })],
      makeDeps([assistantResult({ texts: ["unused"] })]),
      undefined,
      attachSession(file)
    );
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("□ 查新闻"),
      8000,
      "resume-hydrate-panel"
    );
    expect(frame).not.toContain("last_tool:");
    expect(frame).toContain("□ 查新闻");
    await app.destroy();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ADR-0037: session worktree isolation — location line (demoable after rebinding)
// ---------------------------------------------------------------------------

describe("D7 / SC6: 会话位置行常驻（主仓也画、绑树只换路径）", () => {
  function sessionFileWithWorktreeRoot(): SessionFileV1 {
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "用户问题" }] },
      { role: "assistant", content: [{ type: "text", text: "答复" }] },
    ];
    return {
      schemaVersion: 3,
      conversation_id: "conv-wt-isolation",
      messages,
      jsonMode: false,
      turnCount: 1,
      updatedAt: "2026-08-29T00:00:00.000Z",
      title: "用户问题",
      cwd: "/repo/.iknow/worktrees/conv-wt-isolation",
      sanitized_at: "2026-08-29T00:00:00.000Z",
      checkpoints: [],
      workspaceRoot: "/repo/.iknow/worktrees/conv-wt-isolation",
    };
  }

  test("改绑后的会话恢复 → 同一槽换成绑定的 task worktree 路径（不是多一行）", async () => {
    const file = sessionFileWithWorktreeRoot();
    const app = await mountAppAsync(
      [assistantResult({ texts: ["unused"] })],
      makeDeps([assistantResult({ texts: ["unused"] })]),
      undefined,
      attachSession(file)
    );
    // After binding, the location line = project-root leaf + relative segment
    // (`repo/.iknow/worktrees/<leaf>`), no longer the old `worktree: …` prefix
    // line. tui tests use props.cwd = "/tmp/proj"; its bound root lies outside
    // it → shown verbatim as the root path.
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("/repo/.iknow/worktrees/conv-wt-isolation"),
      8000
    );
    expect(frame).toContain("/repo/.iknow/worktrees/conv-wt-isolation");
    expect(frame.includes("worktree:")).toBe(false);
    await app.destroy();
  }, 30_000);

  test("未绑定（draft / 开关 OFF）→ 位置行仍在（主仓路径），不是 0 行", async () => {
    // The location line is always resident — unbound it draws the project
    // root; it must not appear only-when-bound as an "am I on a worktree" signal.
    const app = await mountAppAsync([assistantResult({ texts: ["unused"] })]);
    const frame = await untilFrame(app.setup, (f) => f.includes("proj"), 8000);
    // Assert the location line owns a full line (same source as the
    // projection), not any substring containing "proj": a substring could hit
    // other chrome (banner / path hints) and proves too little. cwd=/tmp/proj
    // is not a git repo → branch unknown → per spec, path segment only with no
    // placeholder → the line is `proj`; full-line trim equality pins "this line
    // is the location line being drawn".
    const expected = sessionLocationLines({
      projectRoot: "/tmp/proj",
      cols: 80,
    })[0]?.text;
    expect(expected).toBe("proj");
    expect(frame.split("\n").some((l) => l.trim() === expected)).toBe(true);
    expect(frame.includes("worktree:")).toBe(false);
    await app.destroy();
  }, 30_000);
});
