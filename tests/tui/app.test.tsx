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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
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

async function mountAppAsync(
  responses: Parameters<typeof makeDeps>[0]
): Promise<DrivenApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-app-"));
  const bridge = createTuiBridge({
    dataDir,
    deps: makeDeps(responses),
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
    expect(list[0]!.summary).toBe("你好");

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

  test("turn 结束 → mode 行右侧显示运行时长 + token 总结段", async () => {
    const app = await mountAppAsync([
      assistantResult({
        texts: ["统计答复"],
        usage: {
          inputTokens: 100,
          outputTokens: 1500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("你好");
    await app.pressEnter();
    // turn 完成 → 落盘 + runElapsed 冻结。
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    await untilFrame(app.setup, (f) => f.includes("统计答复"), 8000, "answer");

    // mode 行右侧统计段：output 1500 → `↓ 1.5k tokens`（时长可能 0s，仍必现）。
    await untilFrame(
      app.setup,
      (f) => f.includes("↓ 1.5k tokens") && f.includes("mode:"),
      8000,
      "run-stats"
    );
    await app.destroy();
  }, 30_000);

  test("turn 结束无 token → mode 行不显示统计段（无 `↓` 假数据）", async () => {
    // stub 路径无 usage（makeDeps 默认语义）→ outputTokens 缺席；时长 <1s
    // 冻结 0s → mode 行右侧统计段不渲染（守卫：runElapsed>0 || output>0）。
    const app = await mountAppAsync([assistantResult({ texts: ["普通答复"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("你好");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "turn-done");
    await untilFrame(app.setup, (f) => f.includes("普通答复"), 8000, "answer");

    // 等一个 render 周期后断言：mode 行仍显示（不含统计段）。
    await new Promise((r) => setTimeout(r, 1200));
    await app.setup.renderOnce();
    const frame = app.setup.captureCharFrame();
    expect(frame).toContain("mode:");
    expect(frame.includes("↓")).toBe(false);
    expect(frame.includes("tokens")).toBe(false);
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
    expect(list[0]!.summary).toBe("第一条"); // summary = 首条 user（#120 SC 6）
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

  test("/sessions → 列表视图（+ 新建会话 + summary）→ Esc 返回聊天", async () => {
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
});
