/**
 * tests/tui/app.test.tsx
 *
 * #146 TuiApp 组件测试（ink render + 假 TTY stdin/stdout 驱动，仓库新增基建）：
 * 端到端走查 tracer bullet——输入消息 → Enter 提交 → lazy create 建档 →
 * stub turn 完成 → markdown 渲染 → /sessions 列表 → Esc 返回 → /help →
 * /quit 退出；另测 turn 运行中第二条消息的排队拒绝。
 *
 * ink 输入链路前提：stdin.isTTY && stdout.isTTY 才启 raw mode（ink build
 * ink.js raw-mode 守卫）；PassThrough 补最小 TTY 假面即可驱动。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import type { Instance } from "ink";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.js";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** 轮询等待条件成立（真实时钟，上限 timeoutMs；支持 async 条件）。 */
async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timeout: ${label}`);
    }
    await delay(50);
  }
}

/**
 * 假 TTY 流：ink 输入链路需要 isTTY + columns/rows（窗口尺寸）+
 * setRawMode + ref/unref（App.tsx 挂 input listener 时调 stdin.ref()，
 * probe 实测确认四项缺一不可）。
 */
function fakeTtyStream(): PassThrough & {
  isTTY: boolean;
  columns: number;
  rows: number;
  setRawMode: (v: boolean) => void;
  ref: () => void;
  unref: () => void;
} {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
    setRawMode: (v: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stream.isTTY = true;
  stream.columns = 100;
  stream.rows = 30;
  stream.setRawMode = (): void => {
    /* 测试驱动不需要真实 raw mode */
  };
  stream.ref = (): void => {
    /* 测试驱动不保活进程 */
  };
  stream.unref = (): void => {
    /* 测试驱动不保活进程 */
  };
  return stream;
}

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly instance: Instance;
  readonly lastOutput: () => string;
  readonly type: (text: string) => Promise<void>;
  readonly ready: () => Promise<void>;
}

describe("TuiApp 端到端（tracer bullet）", () => {
  // 真实时钟轮询 + stub delayMs，放宽单测预算。
  // eslint-disable-next-line no-magic-numbers
  const LONG_TIMEOUT = 30_000;
  let baseDir: string;
  let stdout: ReturnType<typeof fakeTtyStream>;
  let stdin: ReturnType<typeof fakeTtyStream>;
  const instances: Instance[] = [];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-app-"));
    stdout = fakeTtyStream();
    stdin = fakeTtyStream();
  }, LONG_TIMEOUT);
  afterEach(async () => {
    for (const instance of instances) instance.unmount();
    instances.length = 0;
    await rm(baseDir, { recursive: true, force: true });
  }, LONG_TIMEOUT);

  function mountApp(bridge: TuiBridge): DrivenApp {
    const askBridge = createTuiAskUserBridge();
    const toolEventSink = createToolEventSink();
    const out: string[] = [];
    stdout.on("data", (chunk) => out.push(String(chunk)));
    const instance = render(
      <TuiApp
        bridge={bridge}
        askBridge={askBridge}
        toolEventSink={toolEventSink}
        cwd="/tmp/proj"
        dataDir={baseDir}
      />,
      {
        stdout,
        stdin,
        exitOnCtrlC: false,
        interactive: true,
        // 测试驱动无终端应答 kitty 探测；禁用避免 200ms 探测窗口吞输入。
        kittyKeyboard: { mode: "disabled" },
      }
    );
    instances.push(instance);
    return {
      bridge,
      instance,
      lastOutput: (): string => strip(out.join("")),
      type: async (text: string): Promise<void> => {
        // ink 输入解析按 chunk 处理；逐字符写入并让出事件循环，贴近真实
        // 键盘逐键节奏（整块写入时 chunk 尾部 \r 不被解析为 return，实测确认）。
        for (const ch of text) {
          stdin.write(ch);
          await delay(10);
        }
      },
      /** 等 ink useInput 监听注册完成（挂载后异步 effect）。 */
      ready: async (): Promise<void> => {
        await delay(400);
      },
    };
  }

  function makeApp(responses: Parameters<typeof makeDeps>[0]): DrivenApp {
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps(responses),
      inflight: createInflightRegistry(),
    });
    return mountApp(bridge);
  }

  it(
    "消息提交 → lazy create 建档 → turn 渲染 → /sessions → /quit 退出",
    async () => {
      const app = makeApp([
        assistantResult({ texts: ["## 答复标题\n\n正文内容"] }),
      ]);
      await app.ready();

      // 启动画面：banner 或输入框
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 提交消息（\r = Enter）
      await app.type("你好\r");
      // turn 完成 → 建档落盘（lazy create 验证点）
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "turn-done"
      );
      await waitFor(async () => {
        const list = await app.bridge.listSessions();
        return list.length === 1;
      });
      const list = await app.bridge.listSessions();
      expect(list[0]!.summary).toBe("你好");
      // 渲染出 assistant 文本（markdown 内容）
      await waitFor(
        () => app.lastOutput().includes("答复标题"),
        8000,
        "answer-rendered"
      );
      expect(app.lastOutput()).toContain("正文内容");

      // /sessions → 列表视图
      await app.type("/sessions\r");
      await waitFor(
        () => app.lastOutput().includes("+ 新建会话"),
        8000,
        "list-view"
      );
      await waitFor(
        () => app.lastOutput().includes("你好"),
        8000,
        "list-summary"
      );

      // 等 ListView 的 useInput effect 挂载（渲染后异步生效）
      await delay(300);
      // Esc → 返回聊天视图（重新出现输入框占位）
      await app.type("\u001b");
      await waitFor(
        () => app.lastOutput().includes("输入消息"),
        8000,
        "esc-back"
      );

      // 等 PromptInput 重新挂载后 useInput effect 生效
      await delay(300);
      // /help → 词表面板
      await app.type("/help\r");
      await waitFor(
        () => app.lastOutput().includes("/new"),
        8000,
        "help-panel"
      );

      // /quit → 退出（无 running-bg，直接退）
      let exited = false;
      void app.instance.waitUntilExit().then(() => {
        exited = true;
      });
      await app.type("/quit\r");
      await waitFor(() => exited, 8000, "quit-exit");
    },
    LONG_TIMEOUT
  );

  it(
    "未知命令 → 提示行；/info → 元信息（draft 未建档）",
    async () => {
      const app = makeApp([]);
      await app.ready();
      await app.type("/foobar\r");
      await waitFor(
        () => app.lastOutput().includes("未知命令"),
        8000,
        "unknown-cmd"
      );
      await app.type("/info\r");
      await waitFor(
        () => app.lastOutput().includes("conversation_id"),
        8000,
        "info-panel"
      );
      expect(app.lastOutput()).toContain("draft");
    },
    LONG_TIMEOUT
  );

  it(
    "turn 运行中发第二条消息 → 提示等待，不重复建档",
    async () => {
      const { createStubModel } =
        await import("../../src/harness/stubs/stub-model.js");
      const { createStubTool } =
        await import("../../src/harness/stubs/stub-tool.js");
      const { createRegistry } =
        await import("../../src/harness/tools/registry.js");
      const { createExecutor } =
        await import("../../src/harness/tools/executor.js");
      const tool = createStubTool({ name: "noop", next: () => ({}) });
      const registry = createRegistry([tool]);
      const executor = createExecutor(registry);
      const adapter = createStubModel({
        responses: [
          assistantResult({ texts: ["慢答复"] }),
          assistantResult({ texts: ["第二条答复"] }),
        ],
        delayMs: 400,
      });
      const inflight = createInflightRegistry();
      const bridge = createTuiBridge({
        dataDir: baseDir,
        deps: { adapter, executor, registry, maxTurns: 5 },
        inflight,
      });
      const app = mountApp(bridge);
      await app.ready();

      await app.type("第一条\r");
      await waitFor(() => inflight.ids().size === 1, 8000, "running-window");
      await app.type("第二条\r");
      await waitFor(
        () => app.lastOutput().includes("正在运行"),
        8000,
        "busy-reject"
      );
      // 第一条正常完成
      await waitFor(
        () => app.lastOutput().includes("慢答复"),
        8000,
        "slow-done"
      );
      // 第二条被拒绝未建档第二个会话：池内始终 1 个会话
      const list = await app.bridge.listSessions();
      expect(list).toHaveLength(1);
    },
    LONG_TIMEOUT
  );

  it(
    "SC5：turn 运行中切走 → running-bg 后台跑完落盘 + 状态栏后台指示",
    async () => {
      // 慢 stub（delayMs）制造可切入的运行窗口；两个会话：先建 A，再在 B
      // 起跑后切回 A，断言 B 转 running-bg、后台完成落盘、状态栏出现后台指示。
      const { createStubModel } =
        await import("../../src/harness/stubs/stub-model.js");
      const { createStubTool } =
        await import("../../src/harness/stubs/stub-tool.js");
      const { createRegistry } =
        await import("../../src/harness/tools/registry.js");
      const { createExecutor } =
        await import("../../src/harness/tools/executor.js");
      const tool = createStubTool({ name: "noop", next: () => ({}) });
      const registry = createRegistry([tool]);
      const executor = createExecutor(registry);
      const adapter = createStubModel({
        responses: [
          assistantResult({ texts: ["第一答复"] }),
          assistantResult({ texts: ["慢答复"] }),
        ],
        delayMs: 1800,
      });
      const inflight = createInflightRegistry();
      const bridge = createTuiBridge({
        dataDir: baseDir,
        deps: { adapter, executor, registry, maxTurns: 5 },
        inflight,
      });
      const app = mountApp(bridge);
      await app.ready();

      // 会话 A：发「hello」，等完成落盘（列表出现 1 条）
      await app.type("hello\r");
      await waitFor(() => inflight.ids().size === 0, 8000, "A-turn-done");
      await waitFor(
        async () => (await bridge.listSessions()).length === 1,
        8000,
        "A-written"
      );

      // 新会话 B（draft），发慢问题起跑 running-fg
      await app.type("/new\r");
      await delay(200);
      await app.type("慢问题\r");
      await waitFor(() => inflight.ids().size === 1, 8000, "B-running-fg");

      // 运行中切走：/sessions → ↓ 选中 A（index 1）→ Enter 打开 A
      await app.type("/sessions\r");
      await waitFor(
        () => app.lastOutput().includes("+ 新建会话"),
        8000,
        "list-view"
      );
      await delay(300); // 等 ListView useInput effect 挂载
      stdin.write("\u001b[B"); // ↓（整段单 chunk 写，ink 解析为 downArrow）
      await delay(60);
      stdin.write("\r"); // Enter → openSessionAt(1)：B running-fg → running-bg
      // B 转后台：状态栏出现「后台运行中」
      await waitFor(
        () => app.lastOutput().includes("后台运行中"),
        8000,
        "bg-status"
      );

      // B 后台跑完落盘：inflight 清空，列表出现 2 条（A + B 均含 summary）
      await waitFor(() => inflight.ids().size === 0, 8000, "B-bg-done");
      const list = await bridge.listSessions();
      expect(list).toHaveLength(2);
      expect(list.map((e) => e.summary).sort()).toEqual(["hello", "慢问题"]);
    },
    LONG_TIMEOUT
  );

  it(
    'slash 提示："/" 出现 8 条候选；"/q" + Tab → 提交 /quit 退出',
    async () => {
      const app = makeApp([]);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 输入 \"/\" → 输入框下方出现 8 条候选（按词表顺序）
      await app.type("/");
      for (const cmd of [
        "sessions",
        "new",
        "quit",
        "exit",
        "help",
        "info",
        "thinking",
        "profile",
      ]) {
        await waitFor(
          () => app.lastOutput().includes(`/${cmd}`),
          8000,
          `hint-${cmd}`
        );
      }

      // Tab 在多匹配下无动作（hint 继续展示）
      stdin.write("\t");
      await delay(150);
      expect(app.lastOutput()).toContain("/quit");

      // 继续输入 \"q\" 缩窄到唯一匹配
      await app.type("q");
      await waitFor(
        () => app.lastOutput().includes("/quit"),
        8000,
        "hint-narrowed"
      );

      // Tab 唯一匹配 → 输入框 value = \"/quit \"（补全 + 尾随空格）
      stdin.write("\t");
      await delay(150);

      // 提交后 handleSubmit 收到 \"/quit\"；无 running-bg 直接 exit
      let exited = false;
      void app.instance.waitUntilExit().then(() => {
        exited = true;
      });
      stdin.write("\r");
      await waitFor(() => exited, 8000, "quit-after-tab");
    },
    LONG_TIMEOUT
  );

  // 任务 A：聊天区域行级滚动（PgUp → scrollRows += viewportRows/2，
  // 顶部 dim 指示「↑ N 行历史（End 回到底部）」；End → 回到底部）。
  it(
    "任务 A：发 5 条消息 → 渲染出 5 条 → PgUp → 行级滚动指示出现；End → 全部回归",
    async () => {
      // 用长文本（每条 6 行）确保 totalRows > viewportRows（≈22），PgUp 后
      // maxScroll > 0 才能验证行级滚动指示。短消息填不满 viewport 会被 clamp 到 0。
      const longBody = (tag: string) =>
        `${tag} 行1内容占位\n${tag} 行2内容占位\n${tag} 行3内容占位\n${tag} 行4内容占位\n${tag} 行5内容占位\n${tag} 行6内容占位`;
      const app = makeApp([
        assistantResult({ texts: [longBody("a0")] }),
        assistantResult({ texts: [longBody("a1")] }),
        assistantResult({ texts: [longBody("a2")] }),
        assistantResult({ texts: [longBody("a3")] }),
        assistantResult({ texts: [longBody("a4")] }),
      ]);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 顺序发 5 条（每条多行 user 文本，进一步撑满 viewport）：等 turn 落盘 +
      // runState 回 idle（避免下条消息被「正在运行」拒绝）
      for (let i = 0; i < 5; i++) {
        await app.type(`m${i} 第一行 m${i} 第二行 m${i} 第三行\r`);
        await waitFor(
          () => app.bridge.inflight.ids().size === 0,
          8000,
          `m${i}-turn-done`
        );
        // 多等一帧：等 setSessions(turnFinished) 提交，否则下条会撞 running-fg
        await delay(50);
      }
      // 等所有 5 条 user 消息渲染出来
      for (let i = 0; i < 5; i++) {
        await waitFor(
          () => app.lastOutput().includes(`m${i}`),
          8000,
          `m${i}-rendered`
        );
      }
      // 等所有 5 条 assistant 渲染出来
      for (let i = 0; i < 5; i++) {
        await waitFor(
          () => app.lastOutput().includes(`a${i}`),
          8000,
          `a${i}-rendered`
        );
      }
      // 滚动前：m4 应可见
      expect(app.lastOutput()).toContain("m4");

      // PgUp → scrollRows += viewportRows/2（行级滚动，按 viewport 半页跳）
      stdin.write("[5~"); // PgUp ANSI sequence
      await delay(500);
      await waitFor(
        () => app.lastOutput().includes("行历史"),
        8000,
        "scroll-indicator"
      );
      // 顶部 dim 指示「↑ N 行历史（End 回到底部）」— 验证 scrollRows > 0
      expect(app.lastOutput()).toMatch(/↑ \d+ 行历史/);

      // End → scroll 重置为 0，等 a4 重新出现在最近帧
      stdin.write("[F"); // End ANSI sequence
      await delay(500);
      // 直接查~；lastOutput 最近几帧是否包含 a4
      // （lastOutput 累积 buffer，原 PgUp 帧不包含 a4）
      await waitFor(
        () => app.lastOutput().slice(-1500).includes("a4"),
        8000,
        "a4-restored-after-end"
      );
    },
    LONG_TIMEOUT
  );

  // #189 Commit 1: openSessionAt 必须重置行级滚动偏移。
  it(
    "#189 Commit 1：openSessionAt → scrollRows 重置为 0（会话切换不再保留旧 scroll）",
    async () => {
      // 新 clamp：maxScroll = max(0, messageCursor - budget(24))。
      // A 必须 <= 24（切回 A 后 scroll=0 窗口含 msg-A + aA 且无指示）；
      // B 必须 > 24（PgUp 才真有滚动余量出现指示）。
      const lines = (tag: string, n: number): string =>
        Array.from({ length: n }, (_, i) => `${tag} 行${i + 1}内容占位`).join(
          "\n"
        );
      const app = makeApp([
        // A：user(2) + assistant(16+2) = 20 <= 24 → 不可滚
        assistantResult({ texts: [lines("aA", 16)] }),
        // B：user(2) + assistant(24+2) = 28 > 24 → maxScroll=4
        assistantResult({ texts: [lines("aB", 24)] }),
      ]);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 建档会话 A：发 "msg-A"
      await app.type("msg-A 第一行 msg-A 第二行 msg-A 第三行\r");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "A-turn-done"
      );
      await waitFor(() => app.lastOutput().includes("aA"), 8000, "A-rendered");
      await delay(50);

      // 建档会话 B：/new 建 draft，再发 "msg-B"
      await app.type("/new\r");
      await delay(200);
      await app.type("msg-B 第一行 msg-B 第二行 msg-B 第三行\r");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "B-turn-done"
      );
      await waitFor(() => app.lastOutput().includes("aB"), 8000, "B-rendered");
      await delay(50);

      // B 上 PgUp → scrollRows > 0，顶部出现「↑ N 行历史」（看最近帧避免旧帧干扰）
      stdin.write("[5~"); // PgUp
      await waitFor(
        () => app.lastOutput().slice(-1500).includes("4 行历史"),
        8000,
        "B-pgup-scrolled"
      );

      // 切到 list 视图，↓ 选中 A，Enter 打开 A
      await app.type("/sessions\r");
      await waitFor(
        () => app.lastOutput().includes("+ 新建会话"),
        8000,
        "list-view"
      );
      await delay(300);
      // 列表 sorted by updatedAt desc → [B, A]，cursor 0=+新建会话。
      // ↓↓ 移到 cursor 2 = A（entries[1]），Enter → openSessionAt(2)
      stdin.write("[B");
      await delay(80);
      stdin.write("[B");
      await delay(80);
      // 锚定在 Enter 之前：B 的 chat frame（含「↑ 4 行历史」）在进入 list
      // 视图前已写入，排除在窗口外；list 视图帧与打开 A 后的帧都不含
      // 「行历史」。
      const beforeOpen = app.lastOutput().length;
      stdin.write("\r");
      await waitFor(
        () => {
          const after = app.lastOutput().slice(beforeOpen);
          return (
            after.includes("aA") &&
            after.includes("msg-A") &&
            !after.includes("行历史")
          );
        },
        8000,
        "A-active-and-scroll-reset"
      );
    },
    LONG_TIMEOUT
  );

  // #189 行为反转回归保险：app 已移除鼠标捕获（DECSET 1000/1006），鼠标
  // 滚轮交由终端原生 scrollback 接管。在 render 前就挂 raw 监听，断言
  // stdout 从挂载到一次交互全过程中从未收到 DECSET 启用序列
  // \x1b[?1000h / \x1b[?1006h（旧实现会在挂载 useEffect 里写）。
  it(
    "#189：鼠标截胡已移除 —— stdout 不写 DECSET 1000/1006 启用序列",
    async () => {
      const bridge = createTuiBridge({
        dataDir: baseDir,
        deps: makeDeps([assistantResult({ texts: ["no-mouse"] })]),
        inflight: createInflightRegistry(),
      });
      const askBridge = createTuiAskUserBridge();
      const toolEventSink = createToolEventSink();
      const rawWrites: string[] = [];
      // render 前挂 raw 监听（保留 ESC 序列，不用 strip）
      const rawListener = (chunk: Buffer | string): void =>
        rawWrites.push(typeof chunk === "string" ? chunk : chunk.toString());
      stdout.on("data", rawListener);
      const instance = render(
        <TuiApp
          bridge={bridge}
          askBridge={askBridge}
          toolEventSink={toolEventSink}
          cwd="/tmp/proj"
          dataDir={baseDir}
        />,
        {
          stdout,
          stdin,
          exitOnCtrlC: false,
          interactive: true,
          kittyKeyboard: { mode: "disabled" },
        }
      );
      instances.push(instance);
      await delay(400); // 等 mount + useEffect（旧代码在此阶段写 DECSET）
      await waitFor(
        () => strip(rawWrites.join("")).includes("iknow"),
        8000,
        "startup"
      );
      // 触发一次提交，覆盖交互路径（旧代码 stdin.on('data') 常驻监听）
      for (const ch of "hi\r") {
        stdin.write(ch);
        await delay(10);
      }
      await waitFor(() => bridge.inflight.ids().size === 0, 8000, "turn-done");
      await delay(300);
      stdout.removeListener("data", rawListener);
      const joined = rawWrites.join("");
      expect(joined).not.toContain("\x1b[?1000h");
      expect(joined).not.toContain("\x1b[?1006h");
    },
    LONG_TIMEOUT
  );

  // 任务 B：slash 候选 ↑/↓ 选中 + Enter 触发 onSelectHint（不走 raw 文本解析）
  it(
    '任务 B："/" 出现候选 → ↓ → Enter 触发 /new（不退出，验证选中索引非 0）',
    async () => {
      // 关键点：cursor 默认 0 = sessions；如果 ↓ + Enter 触发的是 sessions
      // → 切到 list 视图；如果是 new → 切到新 draft。我们断言：↓ + Enter
      // 之后应用未退出、也未切到列表视图（list 视图特征 = "+ 新建会话"），
      // 而是新 draft 创建（inputValue 清空，可继续发消息）。
      const app = makeApp([assistantResult({ texts: ["new-draft-reply"] })]);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 1) 输入 "/" → 6 条候选出现
      await app.type("/");
      for (const cmd of ["sessions", "new", "quit", "exit", "help", "info"]) {
        await waitFor(
          () => app.lastOutput().includes(`/${cmd}`),
          8000,
          `hint-${cmd}`
        );
      }

      // 2) ↓ 一次 → cursor 从 0 (sessions) 移到 1 (new)
      stdin.write("[B");
      await delay(150);

      // 3) Enter → onSelectHint("new") 触发 → handleSubmit("/new") → newSession()
      stdin.write("\r");
      await delay(300);
      // 不应进入 list 视图（"+ 新建会话" 不会出现）；也不应退出
      const after = app.lastOutput();
      expect(after).not.toContain("+ 新建会话");
      // newSession 后 active = draft，input 清空，placeholder 仍可见
      expect(after).toContain("输入消息");

      // 4) 后续发消息：落盘到新 session，bridge 列表出现 1 条
      await app.type("new-draft-msg\r");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "new-turn-done"
      );
      // 多等一帧：inflight.unmark 和 store.save 写入盖半
      await delay(100);
      const list = await app.bridge.listSessions();
      expect(list).toHaveLength(1);
      expect(list[0]!.summary).toBe("new-draft-msg");
      // 5) assistant 答复 "new-draft-reply" 渲染出来
      await waitFor(
        () => app.lastOutput().includes("new-draft-reply"),
        8000,
        "new-reply"
      );
    },
    LONG_TIMEOUT
  );

  // #189 Spec Low：`initialSession`（`iknow tui <id>` resume）恢复路径未测。
  // 挂载即生成既有会话内容，行级滚动应从 scrollRows=0（auto-follow 底）
  // 起步：初始无「行历史」顶部指示；PgUp 后指示出现且 clamp 到 maxScroll。
  it(
    "Spec Low：initialSession resume 从 scrollRows=0 起步；PgUp 后指示出现",
    async () => {
      const { attachSession } = await import("../../src/tui/session-state.js");
      // 新 clamp：budget=24。需 messageCursor > 24 才能滚；user(2) +
      // assistant(content+2) > 24 → content ≥ 21。用 24 行：messageCursor=28，
      // maxScroll=4。viewportRows ≈ 26 → PgUp step = floor(26/2)=13，clamp 到
      // maxScroll=4 →「↑ 4 行历史」，滚到顶后 resumed-q 重新进入窗口。
      const longBody = Array.from(
        { length: 24 },
        (_, i) => `A0 resume 内容第${i + 1}行`
      ).join("\n");
      const initial = attachSession({
        conversation_id: "resumed-session",
        messages: [
          { role: "user", content: [{ type: "text", text: "resumed-q" }] },
          { role: "assistant", content: [{ type: "text", text: longBody }] },
        ],
        turnCount: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        jsonMode: false,
      });
      const bridge = createTuiBridge({
        dataDir: baseDir,
        deps: makeDeps([]),
        inflight: createInflightRegistry(),
      });
      const askBridge = createTuiAskUserBridge();
      const toolEventSink = createToolEventSink();
      const out: string[] = [];
      stdout.on("data", (chunk) => out.push(String(chunk)));
      const instance = render(
        <TuiApp
          bridge={bridge}
          askBridge={askBridge}
          toolEventSink={toolEventSink}
          initialSession={initial}
          cwd="/tmp/proj"
          dataDir={baseDir}
        />,
        {
          stdout,
          stdin,
          exitOnCtrlC: false,
          interactive: true,
          kittyKeyboard: { mode: "disabled" },
        }
      );
      instances.push(instance);
      const lastOutput = (): string => strip(out.join(""));
      await delay(400); // 等 mount + useInput effect

      // resume 内容渲染出来（messageCursor=28 > budget(24)：scroll=0 窗口
      // [4,28) 顶部裁掉 user 行；末段「A0 resume 内容第24行」作初次锚点）
      await waitFor(
        () => lastOutput().includes("A0 resume 内容第24行"),
        8000,
        "resumed-content"
      );
      // 初始 scrollRows=0：无「行历史」顶部指示
      const before = lastOutput();
      expect(before).not.toContain("行历史");

      // PgUp → scrollRows += 13，clamp 到 maxScroll=4 →「↑ 4 行历史」
      stdin.write("[5~"); // PgUp ANSI sequence
      await delay(300);
      await waitFor(
        () => lastOutput().slice(-1500).includes("4 行历史"),
        8000,
        "resume-pgup"
      );
      // 滚到顶 → 顶部 user 内容再次进入窗口
      expect(lastOutput().slice(-1500)).toContain("resumed-q");
    },
    LONG_TIMEOUT
  );
});
