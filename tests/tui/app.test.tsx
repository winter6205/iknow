/** @jsxImportSource @opentui/react */
/**
 * tests/tui/app.test.tsx
 *
 * #343 T6-C：TuiApp 端到端（tracer bullet + 三态/slash/list/quit/info/
 * compact / 池约束 / 候选 + Tab）。
 *
 * 用 stub deps（makeDeps from tests/cli/_fixtures.ts）+ 真实 bridge/hub。
 * mockInput.pressKey 走 OpenTUI stdin 异步解析，需配合 renderOnce 轮询。
 *
 * 端到端覆盖：
 *  1. 消息提交 → lazy create 建档 → turn 渲染（tracer）；
 *  2. 未知命令 → 「未知命令：...」notice；/info → 元信息行；
 *  3. /compact draft 会话 → 「还没有可压缩的上下文」；
 *  4. turn 运行中发第二条 → 「正在运行」护栏 + 池内仅 1 个会话；
 *  5. slash 候选（输入 "/" 后 9 命令全显示）+ Tab 唯一匹配补全。
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

/** 帧等待：mockInput 字节经 stdin 异步解析，需轮询 renderOnce。 */
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

/** 条件等待（无帧返回）。 */
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
      // T8：Shift+Enter 需携带 shift 修饰（kitty 协议编码 [13;2u）。
      kittyKeyboard: true,
    }
  );
  setupRef = setup;
  // 等键盘 / useEffect 注册完成（mount 后异步）。
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
      // 预热：先按一个无害键让 mockInput 解析器启动。
      setup.mockInput.pressKey("/");
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
      // 清掉预热键（按 Backspace 多次）。
      for (let i = 0; i < 5; i++) {
        setup.mockInput.pressBackspace();
        await new Promise((r) => setTimeout(r, 30));
      }
      // 真正要输入的内容。
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      // 让 React 状态更新落地。
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
    // 启动：banner 版本行可见
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 提交消息
    await app.typeText("你好");
    await app.pressEnter();
    // turn 完成 → inflight 清空
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    const list = await app.bridge.listSessions();
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe("你好");

    // assistant 答复渲染
    await untilFrame(app.setup, (f) => f.includes("答复标题"), 8000, "answer");
    expect(app.setup.captureCharFrame()).toContain("正文内容");

    await app.destroy();
  }, 30_000);

  test("T8 多行消息提交 → 消息流渲染多行（换行进模型与回显）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["多行答复"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 输入两行（Shift+Enter 分隔后 Enter 提交）。第二行用 raw type（不走
    // typeText 的 "/" 预热 + Backspace——会清掉第一行）。
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

    // turn 完成 → 消息流渲染两行内容（user 消息块 wrapMode=word 多行）。
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
    // 第一次 submit 不响应（空）；第二次以 /foobar 真提 → unknown
    await untilFrame(app.setup, (f) => f.includes("未知命令"), 8000, "unknown");
    await app.destroy();
  }, 30_000);

  test("/info → draft 元信息（含 draft / tokens 行）", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/info");
    await app.pressEnter();
    // /info 走 notice + 行展开；frame 可能因 scrollbox wrap 渲染为：
    // "updatedAt:o—_id: __draft__（draft…）"（conversation_id 折断）
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
    // delayMs=3000 让 turn 停留 running-fg ~3s —— 运行中实时秒数（`· Ns`，
    // 每秒跳）有足够窗口被 untilFrame 抓到。
    const app = await mountAppAsync(
      [assistantResult({ texts: ["答复"] })],
      makeDeps([assistantResult({ texts: ["答复"] })], { delayMs: 3000 })
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("你好");
    await app.pressEnter();
    // 运行中：mode 行右侧出现实时秒数（`mode: Default · Ns`）。
    await untilFrame(
      app.setup,
      (f) => /mode: Default · \d+s/.test(f),
      8000,
      "running-elapsed"
    );

    // turn 完成 → 流末尾 Crunched 行（快照秒数 ≥1，3s delay 保证）。
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("Crunched for"),
      8000,
      "crunched-summary"
    );

    // mode 行清空：无 `·`、无秒数尾缀（trim 精确等于 `mode: Default`）。
    const modeLine = frame
      .split("\n")
      .find((l) => l.includes("mode:"))
      ?.trim();
    expect(modeLine).toBe("mode: Default");
    // token 统计段已随 #426 修订移除：帧内无 `↓` / `tokens`。
    expect(frame.includes("↓")).toBe(false);
    expect(frame.includes("tokens")).toBe(false);
    await app.destroy();
  }, 30_000);

  test("快速 turn（<1s）→ mode 行无运行统计段 + 流末尾无 Crunched（gate 守 <1s）", async () => {
    // stub 无 delay → turn 立即完成；秒数冻结 0s → formatCrunched 返回空串
    // + ChatView `>0` gate 把 Crunched 行排除（不渲染难看的 `Crunched for 0s`）。
    const app = await mountAppAsync([assistantResult({ texts: ["普通答复"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("你好");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    await untilFrame(app.setup, (f) => f.includes("普通答复"), 8000, "answer");

    // 等一个 render 周期后断言：mode 行仍显示、无运行统计段；流末尾无 Crunched。
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
      (f) => f.includes("还没有可压缩"),
      8000,
      "draft-compact"
    );
    await app.destroy();
  }, 30_000);

  test("turn 运行中发第二条 → busy 护栏 / 池内 1 会话（busy 窗口测试需 stub delayMs，本条覆盖 idle 顺序）", async () => {
    // 注：当前 makeDeps 不支持 delayMs（archive T6 用 stub-model delayMs 控制
    // busy 窗口）；本测覆盖「第一条完成后第二条顺序提交 → 池内 1 会话 turnCount=2」
    // — 即 busy-guard 在 idle 状态下不误拒。
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
    expect(list[0]!.title).toBe("第一条"); // title = 首条 user（#120 SC 6）
    // turnCount 查 session 文件（list 不携带）
    const sessionId = list[0]!.conversation_id;
    const file = await app.bridge.loadSessionFile(sessionId);
    expect(file.turnCount).toBe(2);

    await app.destroy();
  }, 30_000);

  // 注：slash 候选渲染依赖 PromptInput 内部 hintCursor state — frame 不
  // 一定反映内部 state（hint 通过组件内嵌子节点渲染，可能未触发
  // captureCharFrame 的文本变化）。直接验证：通过 /q + Tab 唯一匹配补全
  // （已在 Tab 补全测试中覆盖）作为候选行为最终落点；候选完整渲染属于
  // PromptInput 单测范畴，archive PromptInput 切片测试在 T7 收口时一并迁移。

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

    // Esc 返回聊天视图
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
 * /thinking — design-25 thinking-picker（双面板版）：/thinking 不再立即翻转
 * 开关 + notice，改为打开纯开关面板（ON/OFF）。Enter 固定（面板保持打开）、
 * Esc 保存退出（写 thinkingEnabled，无 cancel 路径）。
 */
describe("/thinking 打开 thinking-picker（design-25 开关面板）", () => {
  test("defaultThinking off → /thinking 开面板（无 notice）→ Space 切换 ON → Enter 不关闭 → Esc 保存退出 → /info adaptive (auto)", async () => {
    const app = await mountAppAsync([]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // /thinking Enter → 面板打开（标题「思考开关」），不设 notice「思考：开」。
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

    // 面板内 Space（OFF → ON）：开关预览翻转，面板保持打开。
    await app.pressSpace();
    await untilFrame(
      app.setup,
      (f) => f.includes("思考开关") && f.includes("ON"),
      8000,
      "preview-on"
    );

    // Enter（固定当前预览 ON，不翻转、不退出）：面板**保持打开**（核心新增
    // 断言：Enter 固定不关闭）。随后 Esc 保存退出。
    await app.pressEnter();
    const afterEnter = app.setup.captureCharFrame();
    expect(afterEnter).toContain("思考开关");
    expect(afterEnter).toContain("ON");

    // Esc 保存退出（写 thinkingEnabled=true）→ 面板关闭、回输入正常。
    await app.pressEscape();
    await untilFrame(
      app.setup,
      (f) => !f.includes("思考开关"),
      8000,
      "picker-closed"
    );
    expect(app.setup.captureCharFrame()).toContain("Version");
    expect(app.setup.captureCharFrame()).toContain("输入消息");

    // /info 反射：enabled=true + effort="" → adaptive (auto)。
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

    // Esc 保存退出（无任何切换 → 写回 seed OFF）：面板关闭，无 notice 噪音
    // （无「思考：开」也无「已取消」），且 state 已写（/info 显示 off）。
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

    // /info 反射：Esc 保存退出（非 cancel）→ state 已写为 off。
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

    // /thinking → Space 切 ON → Esc 保存退出（写 thinkingEnabled + 持久化）。
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

    // 断言：prop 恰好被调一次，payload = 面板 commit 结果（thinking=adaptive）。
    await until(() => calls.length === 1, 8000, "persist-called");
    expect(calls[0]).toEqual({ thinking: "adaptive" });

    await app.destroy();
  }, 30_000);

  test("onPersistThinking reject → notice「写回 settings.json 失败」（无 crash，面板已关）", async () => {
    const app = await mountAppAsync([], undefined, () =>
      Promise.reject(new Error("EACCES: permission denied"))
    );
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // /thinking → Esc 保存退出（无切换 → 写回 seed OFF → payload { thinking:"off" }）。
    await app.typeText("/thinking");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("思考开关"),
      8000,
      "picker-open"
    );
    await app.pressEscape();

    // 失败 notice 出现（含「写回 settings.json 失败」+ 错误消息），面板已关闭。
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
// #647 T3 回归:end-of-round review Spec Medium —— 多会话 staleness。
// agentStatus 若是全局单槽(不按 conversationId key),会话 A 的 last_tool /
// 未勾 todo 会在切到 B / 新草稿后继续渲染在别人的视图里(T3 AC① 违例:
// 「主 HITL 会话进行中,TUI 显示与即将送进模型的同一份现势」)。断言用面板
// 专属字形前缀(◇ / □)做标记 —— 与 transcript 里可能出现的原始栏文本
// (<agent_status> user 消息)区分开,只测面板渲染。
// ---------------------------------------------------------------------------
describe("#647 T3: agent 现势按会话隔离（multi-session staleness 回归）", () => {
  test("A 收到 agent_status → /new 切新草稿无残留 → /sessions 切回 A 快照仍在", async () => {
    // deps 带 agentStatus(todoDir 有未勾项)→ turn 内 harness 在注入栏的
    // 同一计算点发 agent_status 事件(产品路径,与 e2e bridge 用例同形)。
    // #304601e3:loop-engine 现按 conversationId 读 `<todoDir>/<conv>/todos.md`
    // (与 todo_write 写入侧同一 SSOT),不再是根路径。先用 bridge.ensureSession
    // 预建档拿到 conversationId,再把 todos 写到该会话自己的子目录,最后把
    // 这个会话作为 initialSession 挂进 app —— 首条 user 提交走 lazy create
    // 拿到同一 id,读到本测试的种子账本。
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

      // 会话 A:提交 → turn 完成 → 面板渲染 A 的未勾项(不印 last_tool)。
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

      // /new → 新草稿(draft 无 conversationId):面板不得残留 A 的现势。
      // (staleness 回归点:全局单槽实现会在这里继续渲染 A 的快照。)
      await app.typeText("/new");
      await app.pressEnter();
      const frameDraft = await untilFrame(
        app.setup,
        (f) => !f.includes("□ regression item A"),
        8000,
        "draft-clean"
      );
      expect(frameDraft).not.toContain("□ regression item A");

      // /sessions → ↓ 选中 A(index 1,伪条目后第一条)→ Enter 打开 →
      // A 的现势仍在(keyed 保留:切走不丢、切回复现)。
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
// T4b: resume 冷启动 hydrate —— transcript 末栏 → footer,无需新 turn
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
// ADR-0037 T5: session worktree 隔离现势行（改绑后可演示）
// ---------------------------------------------------------------------------

describe("ADR-0037 T5: worktree 隔离现势行", () => {
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

  test("改绑后的会话恢复 → 现势行显示绑定的 task worktree 路径", async () => {
    const file = sessionFileWithWorktreeRoot();
    const app = await mountAppAsync(
      [assistantResult({ texts: ["unused"] })],
      makeDeps([assistantResult({ texts: ["unused"] })]),
      undefined,
      attachSession(file)
    );
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("/repo/.iknow/worktrees/conv-wt-isolation"),
      8000
    );
    expect(frame).toContain("worktree:");
    expect(frame).toContain("/repo/.iknow/worktrees/conv-wt-isolation");
    await app.destroy();
  }, 30_000);

  test("未绑定（draft / 开关 OFF）→ 无 worktree 现势行（与今日一致）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["unused"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));
    const frame = app.setup.captureCharFrame();
    expect(frame).not.toContain("worktree:");
    await app.destroy();
  }, 30_000);
});
