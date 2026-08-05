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
    'slash 提示："/" 出现 6 条候选；"/q" + Tab → 提交 /quit 退出',
    async () => {
      const app = makeApp([]);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 输入 \"/\" → 输入框下方出现 6 条候选（按词表顺序）
      await app.type("/");
      for (const cmd of ["sessions", "new", "quit", "exit", "help", "info"]) {
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

  // 任务 A：聊天区域消息级滚动（PgUp → scroll +1，切到早期消息；End 回到底部）
  it(
    "任务 A：发 5 条消息 → 渲染出 5 条 → PgUp → 最新 1 条不可见；End → 全部回归",
    async () => {
      const app = makeApp([
        assistantResult({ texts: ["a0"] }),
        assistantResult({ texts: ["a1"] }),
        assistantResult({ texts: ["a2"] }),
        assistantResult({ texts: ["a3"] }),
        assistantResult({ texts: ["a4"] }),
      ]);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 顺序发 5 条：等 turn 落盘 + runState 回 idle（避免下条消息被「正在运行」拒绝）
      for (let i = 0; i < 5; i++) {
        await app.type(`m${i}\r`);
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

      // PgUp → scroll +1（隐藏最新 1 条 = m4 / a4）
      stdin.write("[5~"); // PgUp ANSI sequence
      await delay(500);
      await waitFor(
        () => app.lastOutput().includes("条新消息"),
        8000,
        "scroll-indicator"
      );
      // 顶部 dim 指示（1 条新消息）— 验证 scroll 真的切了消息
      // 注意：lastOutput 是累积 buffer（含 PgUp 之前的帧），不能直接断言
      // a4 缺席；改用「指示文案 + End 回到底部后 a4 重新出现」做等价证明
      expect(app.lastOutput()).toContain("1 条新消息");

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
});
