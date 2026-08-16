/** @jsxImportSource @opentui/react */
/**
 * tests/tui/keyboard.test.tsx
 *
 * #343 T5：键盘 / 粘贴接线回归测试，覆盖 OpenTUI
 * `useKeyboard` + `usePaste` 协议：
 *  - 普通键（press key "a"）→ 走 T6 状态机路径，**T5 暂不消费**；
 *    仅断言不崩 + 帧稳定。
 *  - 修饰键组合：ctrl+c 在 useKeyboard handler 中分流到
 *    各自的处理函数（Ctrl+C → notice）；
 *  - Bracketed paste：mockInput.pasteBracketedText(text) → usePaste
 *    触发 → 受控 inputValue 更新 → 输入框显示文本（不再显示
 *    「输入消息…」placeholder）。
 *  - Kitty 协议：testRender 默认 kittyKeyboard: true 启 Kitty 解析
 *    路径（OpenTUI 内置），不测协议字节。
 *
 * 异步纪律：setup.waitForVisualIdle() 是唯一异步等待入口。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import { TuiHarness } from "./_fixtures.js";

const COLS = 80;
const ROWS = 30;

async function renderApp() {
  const setup = await testRender(<TuiHarness />, {
    width: COLS,
    height: ROWS,
    exitOnCtrlC: false,
    consoleMode: "disabled",
  });
  await setup.waitForVisualIdle();
  return setup;
}

/**
 * 键事件落地 + 渲染稳定：mockInput 字节经 stdin 异步解析，OpenTUI 对快速连
 * 键可能在同一渲染批内派发多事件 — 先等 visualIdle，再小延迟让 state 更新
 * 落地，再等一次 idle 收敛。键盘类测试的统一等待入口（避免各处散写）。
 */
async function settle(
  setup: Awaited<ReturnType<typeof testRender>>
): Promise<void> {
  await setup.waitForVisualIdle();
  await new Promise((r) => setTimeout(r, 20));
  await setup.waitForVisualIdle();
}

/**
 * 条件轮询帧（picker 面板打开时动效常驻，waitForVisualIdle 永不 idle —— 用
 * renderOnce + captureCharFrame 轮询，与 thinking-picker.test.tsx 的
 * untilFrame 同构）。pred 命中返回该帧。
 */
async function waitFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  pred: (frame: string) => boolean,
  ms = 8000,
  label = ""
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (pred(frame)) return frame;
  }
  throw new Error(`waitFrame timeout (${label}):\n${setup.captureCharFrame()}`);
}

/** T8 多行输入专用装配：完整 mount（TuiApp + bridge + stub deps 单轮回复）。
 *  可选 width：窄终端场景（窄于 COLS，但须 ≥ app 层 cols 下限 40）。 */
async function renderMultilineApp(opts: { readonly width?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-multiline-"));
  const bridge = createTuiBridge({
    dataDir,
    deps: makeDeps([assistantResult({ texts: ["多行回复"] })]),
    inflight: createInflightRegistry(),
  });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: Awaited<ReturnType<typeof testRender>> | undefined;
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
      width: opts.width ?? COLS,
      height: ROWS,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      // T8：Shift+Enter 需携带 shift 修饰 —— 走 kitty 协议（encodeKittySequence
      // 会编码 [13;2u = shift+return）；legacy 模式 shift 修饰丢失。
      kittyKeyboard: true,
    }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return { setup, bridge };
}

/** T8 多行输入专用 typeText：不走「/」预热（会触发 slash 候选），直接逐字符。 */
async function typeMultilineText(
  setup: Awaited<ReturnType<typeof testRender>>,
  text: string
): Promise<void> {
  for (const ch of text) {
    setup.mockInput.pressKey(ch);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
}

/** 完整 mount + 含 thinking 块的一轮 turn：供 Ctrl+O toggle 可见态断言。 */
async function renderAppWithThinking() {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-kbd-"));
  const bridge = createTuiBridge({
    dataDir,
    deps: makeDeps([
      assistantResult({
        texts: ["正式回答"],
        thinkingBlocks: [{ type: "thinking", thinking: "链上推理" }],
      }),
    ]),
    inflight: createInflightRegistry(),
  });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: Awaited<ReturnType<typeof testRender>> | undefined;
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
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  // 提交一条消息走一轮 turn（含 thinking 块）。
  setup.mockInput.pressKey("/");
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
  for (let i = 0; i < 5; i++) {
    setup.mockInput.pressBackspace();
    await new Promise((r) => setTimeout(r, 30));
  }
  for (const ch of "请推理") {
    setup.mockInput.pressKey(ch);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  // 等 turn 落盘 → 消息渲染含 thinking 折叠行。
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    if (bridge.inflight.ids().size === 0) break;
  }
  await setup.waitForVisualIdle();
  await setup.waitForVisualIdle();
  return { setup };
}

test("首帧渲染：占位「输入消息…」可见，notice 区域为空", async () => {
  const setup = await renderApp();
  const frame = setup.captureCharFrame();
  // 输入框（PromptInput）边框可见 + 占位符存在（#377 起中文占位）。
  expect(frame).toContain("╭");
  expect(frame).toContain("输入消息");
  await setup.renderer.destroy();
});

test("普通键（pressKey 'a'）：T6 PromptInput 消费，渲染仍稳定不崩", async () => {
  const setup = await renderApp();
  // T6 PromptInput 字符插入：a 进入 inputValue → 输入框显示。
  setup.mockInput.pressKey("a");
  await settle(setup);
  expect(() => setup.captureCharFrame()).not.toThrow();
  // 输入框里能看到 a 字符（替换占位；border/padding 让 "❯" 与 "a" 之间有视觉分隔）。
  const frame = setup.captureCharFrame();
  expect(frame).toMatch(/❯.*a/);
  await setup.renderer.destroy();
});

test("修饰键 ctrl+c：useKeyboard handler 分流到 Ctrl+C 分支（notice 显示）", async () => {
  const setup = await renderApp();
  setup.mockInput.pressCtrlC();
  await settle(setup);
  const frame = setup.captureCharFrame();
  // notice 触发「Ctrl+C：无前台运行中的 turn；/quit 退出。」
  expect(frame).toContain("Ctrl+C");
  expect(frame).toContain("/quit");
  await setup.renderer.destroy();
});

test("其他修饰键（shift+tab、meta+c）：不触发 Ctrl+C/Y 分支，无 notice", async () => {
  const setup = await renderApp();
  // shift+tab：测试 T5 状态机外键被吞、不产生 notice（完整状态机归 T6）。
  setup.mockInput.pressTab({ shift: true });
  await settle(setup);
  const frame = setup.captureCharFrame();
  // 不应出现 Ctrl+C notice（Ctrl+Y 已移除）
  expect(frame).not.toContain("Ctrl+C：无前台");
  expect(frame).not.toContain("无选区");
  await setup.renderer.destroy();
});

test("bracketed paste：pasteBracketedText → 输入框显示粘贴文本", async () => {
  const setup = await renderApp();
  const text = "粘贴的文本";
  await setup.mockInput.pasteBracketedText(text);
  await settle(setup);
  const frame = setup.captureCharFrame();
  // 粘贴的文本应出现在输入框（替代「输入消息…」占位）。
  expect(frame).toContain(text);
  await setup.renderer.destroy();
});

test("bracketed paste CJK：UTF-8 多字节文本正确解码（不破编码）", async () => {
  const setup = await renderApp();
  const cjk = "粘贴中文 — 你好世界";
  await setup.mockInput.pasteBracketedText(cjk);
  await settle(setup);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("粘贴中文");
  expect(frame).toContain("你好世界");
  await setup.renderer.destroy();
});

test("pressEnter：T6 PromptInput 提交空输入 no-op，渲染稳定不崩", async () => {
  const setup = await renderApp();
  setup.mockInput.pressEnter();
  await setup.waitForVisualIdle();
  expect(() => setup.captureCharFrame()).not.toThrow();
  await setup.renderer.destroy();
});

test("pressEscape：T5 不消费，渲染稳定不崩（modal 关闭归 T6）", async () => {
  const setup = await renderApp();
  setup.mockInput.pressEscape();
  await setup.waitForVisualIdle();
  expect(() => setup.captureCharFrame()).not.toThrow();
  await setup.renderer.destroy();
});

test("pressArrow(方向键)：不崩不消费", async () => {
  const setup = await renderApp();
  setup.mockInput.pressArrow("up");
  await setup.waitForVisualIdle();
  setup.mockInput.pressArrow("down");
  await setup.waitForVisualIdle();
  setup.mockInput.pressArrow("left");
  await setup.waitForVisualIdle();
  setup.mockInput.pressArrow("right");
  await setup.waitForVisualIdle();
  expect(() => setup.captureCharFrame()).not.toThrow();
  await setup.renderer.destroy();
});

test("pressBackspace：T6 PromptInput 消费，输入框删除最后一个字符", async () => {
  const setup = await renderApp();
  // 先 paste 文本，再 backspace：T6 PromptInput 接 backspace，文本删一字符。
  await setup.mockInput.pasteBracketedText("to-keep");
  await settle(setup);
  setup.mockInput.pressBackspace();
  await setup.waitForVisualIdle();
  const frame = setup.captureCharFrame();
  // 删掉了最后一个字符 "p"，剩下 "to-kee"
  expect(frame).toContain("to-kee");
  await setup.renderer.destroy();
});

test("Ctrl+O：toggle 思考面板（折叠→展开→折叠）", async () => {
  // 需要含 thinking 块的 assistant 答复：折叠态显示 `[思考]`，展开态显示
  // thinking 全文。用完整 mount（TuiApp + bridge）走一轮 turn，然后 Ctrl+O
  // 两次断言可见态翻转。
  const { setup } = await renderAppWithThinking();
  // 折叠态：思考全文不可见，仅 [思考] 摘要行。
  let frame = setup.captureCharFrame();
  expect(frame).toContain("[思考]");
  expect(frame).not.toContain("链上推理");
  // 第一次 Ctrl+O → 展开（toggleThinking false → true）：思考全文可见。
  setup.mockInput.pressKey("o", { ctrl: true });
  await settle(setup);
  frame = setup.captureCharFrame();
  expect(frame).toContain("链上推理");
  // 第二次 Ctrl+O → 折叠（true → false）：思考全文再次不可见。
  setup.mockInput.pressKey("o", { ctrl: true });
  await settle(setup);
  frame = setup.captureCharFrame();
  expect(frame).toContain("[思考]");
  expect(frame).not.toContain("链上推理");
  await setup.renderer.destroy();
});

/** /effort 测试专用装配：含 pre-warm 打字的 TuiApp mount。 */
async function renderEffortApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-effort-"));
  const bridge = createTuiBridge({
    dataDir,
    deps: makeDeps([assistantResult({ texts: [] })]),
    inflight: createInflightRegistry(),
  });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  let setupRef: Awaited<ReturnType<typeof testRender>> | undefined;
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
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 500));
  await setup.waitForVisualIdle();
  return setup;
}

/** pre-warm 打字（对齐 app.test.tsx / renderAppWithThinking 模式：
 *  先按一个无害键启动 mockInput 解析器，再 Backspace 清掉，再真正输入，
 *  避免首字符被吞）。 */
async function typeEffortText(
  setup: Awaited<ReturnType<typeof testRender>>,
  text: string
): Promise<void> {
  setup.mockInput.pressKey("/");
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
  for (let i = 0; i < 5; i++) {
    setup.mockInput.pressBackspace();
    await new Promise((r) => setTimeout(r, 30));
  }
  for (const ch of text) {
    setup.mockInput.pressKey(ch);
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
}

describe("/effort 思考强度调整", () => {
  test("/effort high → 打开档位面板并直接固定 high；Enter 不关闭；Esc 保存退出", async () => {
    const setup = await renderEffortApp();
    await typeEffortText(setup, "/effort high");
    setup.mockInput.pressEnter();
    // 面板打开后动效常驻 → 用 waitFrame 轮询（waitForVisualIdle 永不 idle）。
    const frame = await waitFrame(
      setup,
      (f) => f.includes("思考强度"),
      8000,
      "panel-open"
    );
    // /effort high → 档位面板打开（seed focus=fixed=high → ▸ high ◂）。
    expect(frame).toContain("▸ high ◂");
    // 不再设「思考档位设为 …（已启用）」notice。
    expect(frame).not.toContain("思考档位");

    // Enter：固定（focus 已固定为 high），面板保持打开（核心新增断言）。
    setup.mockInput.pressEnter();
    const afterEnter = await waitFrame(
      setup,
      (f) => f.includes("思考强度"),
      8000,
      "after-enter"
    );
    expect(afterEnter).toContain("思考强度");

    // Esc：保存退出（写 thinkingEffort=high + 隐式 enabled），面板关闭。
    setup.mockInput.pressEscape();
    await waitFrame(setup, (f) => !f.includes("思考强度"), 8000, "saved-exit");
    await setup.renderer.destroy();
  });

  test("/effort auto → notice 含可用档位列表 + 状态不变", async () => {
    const setup = await renderEffortApp();
    await typeEffortText(setup, "/effort auto");
    setup.mockInput.pressEnter();
    await settle(setup);
    const frame = setup.captureCharFrame();
    // 非法档位 → 提示可用档位（low medium high xhigh max）+ 用法。
    expect(frame).toContain("low");
    expect(frame).toContain("high");
    expect(frame).toContain("xhigh");
    expect(frame).toContain("max");
    expect(frame).toContain("/effort <level>");
    await setup.renderer.destroy();
  });

  test("/effort 无参（当前 auto）→ 打开档位面板呈自适应态（不提示可用档位）", async () => {
    const setup = await renderEffortApp();
    await typeEffortText(setup, "/effort");
    setup.mockInput.pressEnter();
    // 无参 → 打开档位面板（标题「思考强度」可见），不再走 notice；当前
    // thinkingEffort="" → 面板呈自适应态（AUTO · 自适应，无档位游标）。
    const frame = await waitFrame(
      setup,
      (f) => f.includes("思考强度"),
      8000,
      "panel-open"
    );
    expect(frame).not.toContain("/effort <level>"); // 不提示可用档位
    expect(frame).toContain("自适应");
    expect(frame).toContain("AUTO");
    await setup.renderer.destroy();
  });
});

test("同一 tick 快速连发两个字符：输入框同时含两字", async () => {
  const setup = await renderApp();
  // 无中间 await，模拟同一 tick 连发；原生 input onInput 回报全量字符串，
  // 从根上消除旧实现「首字被吃」的竞态。
  setup.mockInput.pressKey("你");
  setup.mockInput.pressKey("好");
  await settle(setup);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("❯");
  expect(frame).toContain("你好");
  await setup.renderer.destroy();
});

test("bracketed paste 不双写：粘贴文本只出现一次", async () => {
  const setup = await renderApp();
  const text = "粘贴测试";
  await setup.mockInput.pasteBracketedText(text);
  await settle(setup);
  const frame = setup.captureCharFrame();
  expect(frame).toContain(text);
  expect(frame).not.toContain(text + text);
  await setup.renderer.destroy();
});

test("T8 Shift+Enter：换行不提交，输入框保留两行文本", async () => {
  const { setup } = await renderMultilineApp();
  await typeMultilineText(setup, "第一行");
  setup.mockInput.pressEnter({ shift: true });
  await settle(setup);
  await typeMultilineText(setup, "第二行");
  // 未提交：帧里两行文本仍可见（Shift+Enter 只换行不提交）。
  const frame = setup.captureCharFrame();
  expect(frame).toContain("第一行");
  expect(frame).toContain("第二行");
  await setup.renderer.destroy();
});

test("T8 Enter：提交多行文本 → 消息落盘含换行", async () => {
  const { setup, bridge } = await renderMultilineApp();
  await typeMultilineText(setup, "第一行");
  setup.mockInput.pressEnter({ shift: true });
  await settle(setup);
  await typeMultilineText(setup, "第二行");
  setup.mockInput.pressEnter();
  // 等 turn 落盘 → 会话 summary 含换行分隔的两行文本。
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    if (bridge.inflight.ids().size === 0) break;
  }
  const list = await bridge.listSessions();
  expect(list.length).toBe(1);
  expect(list[0]!.summary).toBe("第一行\n第二行");
  await setup.renderer.destroy();
});

describe("T8 回归：程序写入后光标重置（Backspace no-op / 前插）", () => {
  /**
   * 根因（T8 迁移回归，prompt-input.tsx 受控同步 effect）：`ta.setText()` 会
   * 完全重置 buffer 并把光标挪到 offset 0 —— 旧 `<input>` value setter 自带
   * 的 `cursorOffset = newValue.length` 恢复步骤在迁移时被丢掉。↑ 历史召回 /
   * Tab 补全 / rewind 回填等程序写入后：Backspace 在 offset 0 是原生 no-op
   * （「删不掉」），继续输入前插到开头（「光标跳到首字符」）。
   *
   * 观察手段：消息流会渲染用户消息全文（转录一份），输入框再渲染一份 ——
   * 用帧内出现次数的变化区分两份（转录份恒在，输入框份随编辑变化）；追加
   * 场景用「行尾紧跟新字符」的独占子串断言（转录里行尾后无该字符）。
   */

  /** 帧内子串出现次数（区分消息流转录份与输入框渲染份）。 */
  function countOccurrences(frame: string, needle: string): number {
    let count = 0;
    let idx = frame.indexOf(needle);
    while (idx !== -1) {
      count++;
      idx = frame.indexOf(needle, idx + 1);
    }
    return count;
  }

  /** 等 turn 落盘（inflight 清空），同上方 T8 Enter 提交用例的轮询。 */
  async function waitTurnDone(
    setup: Awaited<ReturnType<typeof testRender>>,
    bridge: ReturnType<typeof createTuiBridge>
  ): Promise<void> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      await setup.renderOnce();
      if (bridge.inflight.ids().size === 0) return;
    }
    throw new Error("waitTurnDone timeout: inflight 未清空");
  }

  test("多行召回后 Backspace 删掉末字符（不是 offset 0 处 no-op）", async () => {
    const { setup, bridge } = await renderMultilineApp();
    await typeMultilineText(setup, "第一行");
    setup.mockInput.pressEnter({ shift: true });
    await settle(setup);
    await typeMultilineText(setup, "第二行");
    setup.mockInput.pressEnter();
    await waitTurnDone(setup, bridge);
    // 提交后输入框清空：占位符（输入消息或 /help）重新可见。
    await waitFrame(setup, (f) => f.includes("输入消息"), 8000, "cleared");
    // ↑ 召回：占位符消失（输入框恢复完整多行文本，光标位置不影响帧）。
    setup.mockInput.pressArrow("up");
    await waitFrame(setup, (f) => !f.includes("输入消息"), 8000, "recall");
    // 基线：消息流转录 1 份 + 输入框 1 份（≥2 同时防「召回失败」的空转通过）。
    const before = countOccurrences(setup.captureCharFrame(), "第二行");
    expect(before).toBeGreaterThanOrEqual(2);
    // Backspace：光标应在末尾 → 删掉「行」，输入框那份消失（计数 -1）。
    // 修复前光标被 setText 重置到 offset 0 → 原生 backspace no-op，计数不变。
    setup.mockInput.pressBackspace();
    await waitFrame(
      setup,
      (f) => countOccurrences(f, "第二行") === before - 1,
      8000,
      "backspace-deletes-last-char"
    );
    await setup.renderer.destroy();
  }, 30_000);

  test("多行召回后输入字符追加到末尾（不前插到开头）", async () => {
    const { setup, bridge } = await renderMultilineApp();
    await typeMultilineText(setup, "第一行");
    setup.mockInput.pressEnter({ shift: true });
    await settle(setup);
    await typeMultilineText(setup, "第二行");
    setup.mockInput.pressEnter();
    await waitTurnDone(setup, bridge);
    await waitFrame(setup, (f) => f.includes("输入消息"), 8000, "cleared");
    setup.mockInput.pressArrow("up");
    await waitFrame(setup, (f) => !f.includes("输入消息"), 8000, "recall");
    // 输入 X：光标在末尾 → X 追加在「第二行」之后。转录份行尾后无 X，
    // 「第二行X」只能来自输入框的追加位；修复前 X 前插成「X第一行」。
    setup.mockInput.pressKey("X");
    await waitFrame(setup, (f) => f.includes("第二行X"), 8000, "append-at-end");
    expect(setup.captureCharFrame()).not.toContain("X第一行");
    await setup.renderer.destroy();
  }, 30_000);

  test("窄终端 CJK：wrap 超长中文行召回后 Backspace 删掉末字符（setCursor 视觉列 clamp 到真实行尾）", async () => {
    // spec 回归：prompt-input setText 后的光标恢复是「窄终端 CJK」承重场景 —
    // 修复前若直接 `cursorOffset = value.length`，视觉列口径下（CJK 计 2 列）
    // 会把光标设到行中，Backspace 删错字符；此处 width=44（窄但高于 app 层
    // cols 下限 40 → 输入框内宽 38）验证 setCursor 越界自动 clamp 到真实行尾。
    // 24 字中文 = 48 视觉列 > 38 → wrap 2 行，触发 wrap-aware ↑ 历史召回 +
    // 末行行尾光标恢复路径。
    const { setup, bridge } = await renderMultilineApp({ width: 44 });
    const wrapped = "我是一段超过窄终端列宽需要折行的中文输入内容显示";
    await typeMultilineText(setup, wrapped);
    setup.mockInput.pressEnter();
    await waitTurnDone(setup, bridge);
    await waitFrame(setup, (f) => f.includes("输入消息"), 8000, "cleared");
    // ↑ 召回 wrap 长行（wrap-aware 越界判定 → 历史召回）。
    setup.mockInput.pressArrow("up");
    await waitFrame(setup, (f) => !f.includes("输入消息"), 8000, "recall");
    const before = countOccurrences(
      setup.captureCharFrame(),
      wrapped.slice(-2)
    );
    // Backspace 应删掉末字符（光标 clamp 在末行行尾）；若光标停行中会删错
    // 字符 → 末两字份数不变 → waitFrame 超时。
    setup.mockInput.pressBackspace();
    await waitFrame(
      setup,
      (f) => countOccurrences(f, wrapped.slice(-2)) === before - 1,
      8000,
      "narrow-cjk-backspace-deletes-last-char"
    );
    await setup.renderer.destroy();
  }, 30_000);

  test("单行召回后 Backspace 删掉 'o'（hello → hell，简单场景回归护栏）", async () => {
    const { setup, bridge } = await renderMultilineApp();
    await typeMultilineText(setup, "hello");
    setup.mockInput.pressEnter();
    await waitTurnDone(setup, bridge);
    await waitFrame(setup, (f) => f.includes("输入消息"), 8000, "cleared");
    setup.mockInput.pressArrow("up");
    await waitFrame(setup, (f) => !f.includes("输入消息"), 8000, "recall");
    const before = countOccurrences(setup.captureCharFrame(), "hello");
    expect(before).toBeGreaterThanOrEqual(2);
    // Backspace：删掉末尾 'o' → 输入框变 "hell"，"hello" 计数 -1（转录份保留）。
    setup.mockInput.pressBackspace();
    await waitFrame(
      setup,
      (f) => countOccurrences(f, "hello") === before - 1,
      8000,
      "backspace-deletes-o"
    );
    await setup.renderer.destroy();
  }, 30_000);
});
