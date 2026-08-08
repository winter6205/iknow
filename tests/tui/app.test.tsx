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
import { VERSION } from "../../src/tui/version.js";
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
  /** 锚定当前 raw buffer 位置，返回取「此锚点之后写出的帧」的函数。 */
  readonly since: () => () => string;
  /** 最近一次 ink 写入的帧（最后一个 chunk，stripped）。用于断言
   *  settled idle 帧内容，避免 `out.join("")` 累积的中间帧（running spinner
   *  等瞬态文本）误导 `not.toContain` 类断言。ink 单次 render 通常落在
   *  同一个 write 里，但若最后帧跨 chunk 写入，则取最后两个 chunk 拼接
   *  兜底（实测确认一次 render 一 chunk，但跨 chunk 拼接安全无害）。 */
  readonly lastFrame: () => string;
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
      // raw 字节锚点 + 随后按帧切片 + strip。用 raw 长度作为索引比用 stripped
      // 长度更稳定（stripped 索引会因 ANSI 序列在帧间被截断而错位）。
      since: (): (() => string) => {
        const anchor = out.join("").length;
        return () => strip(out.join("").slice(anchor));
      },
      lastFrame: (): string =>
        // 最近一次 ink 写入的「可视」chunk — 回退规则:从后往前找第一个
        // strip(去 ANSI)后非空的 chunk。**不**按原始字节长度判断:ink
        // 常发纯 ANSI 控制序列(cursor / clear-line)作为末片,raw 长度
        // > 0 但 strip 后为空,被误当作「最后帧」,idle 断言因此读到
        // 空串。strip 后非空才是真正的可视内容帧。
        strip(
          (() => {
            for (let i = out.length - 1; i >= 0; i--) {
              const raw = out[i] ?? "";
              const visible = strip(raw);
              if (visible.length > 0) return raw;
            }
            return "";
          })()
        ),
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

      // sticky 头 + 单行 logo 常驻：发消息后 banner 自动收成单行 `◆ iknow`。
      // 空会话完整眼 → 发消息后单行（2026-08-07 真实 pty 复现定稿：完整眼
      // 永久常驻把消息区压扁；单行保留 logo 字符、腾出消息区）。
      await waitFor(
        () => app.lastOutput().includes("◆ iknow"),
        8000,
        "banner-persistent-compact"
      );

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
    "未知命令 → 提示行；/info → 元信息（draft 未建档、无 usage → tokens: —）",
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
      // T4: draft 无 usage → /info tokens 兜底 `tokens: —`
      expect(app.lastOutput()).toContain("tokens: —");
    },
    LONG_TIMEOUT
  );

  // T4: ContextBar 挂载 + 一轮含 usage 的 turn → 状态栏收敛 + /info token 明细。
  it(
    "T4: 聊天视图挂 ContextBar（`│ ctx`）+ 一轮 usage → /info 显示 token 明细",
    async () => {
      const app = makeApp([
        assistantResult({
          texts: ["答复"],
          usage: {
            inputTokens: 1200,
            outputTokens: 40,
            cacheReadInputTokens: null,
            cacheCreationInputTokens: null,
          },
        }),
      ]);
      await app.ready();
      // ContextBar 首轮前（null usage）：始终显示 0% 框（`│ ctx ░░… 0% ok`）
      await waitFor(
        () => app.lastOutput().includes("│ ctx"),
        8000,
        "contextbar-null"
      );
      expect(app.lastOutput()).toContain("0% ok");

      // 提交消息 → turn 完成。`ctx ░` 与 null 状态（空带）撞字（test
      // 设计缺陷：null 时也是 `ctx ░░░…`），改用 assistant 答复文本作为
      // turn-完成 + ContextBar 真值落定的真值信号——答复文本出现 ⟹ turn
      // 已落盘 + lastUsage 已抄入 + ContextBar 渲染了 1% 真值。
      await app.type("你好\r");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "usage-turn-done"
      );
      // 等 assistant 答复渲染（turn 落盘 + ContextBar 真值带刷新）
      await waitFor(
        () => app.lastOutput().includes("答复"),
        8000,
        "answer-rendered-after-usage"
      );
      // 等 ContextBar 刷新出已用值：1200/200000 = 1% → `1% ok` + `1.2k/200.0k`
      //（`ctx ░` 空带在 null 状态也出现，不能当真值信号）。
      await waitFor(
        () => app.lastOutput().includes("1% ok"),
        8000,
        "contextbar-real-band"
      );
      expect(app.lastOutput()).toContain("1.2k/200.0k");

      // /info → token 明细行（tokens in/out + cache read + window）
      await app.type("/info\r");
      await waitFor(
        () => app.lastOutput().includes("tokens in/out: 1200/40"),
        8000,
        "info-tokens-in-out"
      );
      expect(app.lastOutput()).toContain("cache read: null");
      expect(app.lastOutput()).toContain("window: 200000");
    },
    LONG_TIMEOUT
  );

  // 用户 2026-08-07 设计反馈：底部 StatusBar 整条移除（空闲/版本号/运行态
  // 全部不需要——版本号 banner 已有，前台运行态 ContextBar 脉动承担，
  // 「后台运行中」bg 标记保留为独立条件行，无 bg 会话时不显示）。
  it(
    "StatusBar 移除 — 底部无空闲/版本号/运行态；sessionCount/uuid/新会话摘要本就不出现",
    async () => {
      const app = makeApp([assistantResult({ texts: ["hi"] })]);
      await app.ready();
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");
      // 注意：`lastOutput()` 是 out.join("") 累积帧，turn 运行中 spinner 的
      // 「运行中…」会永久残留，`not.toContain("运行中")` 必然误报。本测试的
      // 本意是「settled idle 帧底部无运行态指示」——断言 lastFrame()（最近
      // 一次 ink render 帧），不含 running 瞬态。
      await app.type("hi\r");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "first-turn-done"
      );
      // 等 assistant 答复渲染（idle 帧已落地：turnFinished + 消息渲染完成）
      await waitFor(() => app.lastOutput().includes("hi"), 8000, "answer-in");
      // 锚定 settled idle 帧。原 `waitFor(lastFrame().includes("hi"))`
      // 在 running 帧（含键入 "hi"）即过 → 之后断言误捕「运行中…」瞬态。
      // 改用:最近一次非空 ink 写入必须同时含 ctx 带且不含运行态指示,
      // 此条件只在真正的 idle 帧上成立。Condition 取全部底部 not.toContain
      // + 含 ctx,实现 idle 帧的多重指纹。
      await waitFor(
        () => {
          const frame = app.lastFrame();
          if (!frame.includes("ctx ")) return false;
          if (frame.includes("运行中")) return false;
          if (frame.includes("空闲")) return false;
          if (frame.includes(`v${VERSION}`)) return false;
          if (frame.includes("后台运行中")) return false;
          if (/会话\s+\d+/.test(frame)) return false;
          if (frame.includes("新会话")) return false;
          return true;
        },
        8000,
        "idle-frame-settled"
      );
      const out = app.lastFrame();
      // 移除：空闲 / 运行中 / 后台等运行态（不在底部显示）
      expect(out).not.toContain("空闲");
      expect(out).not.toContain(`v${VERSION}`);
      expect(out).not.toMatch(/会话\s+\d+/);
      expect(out).not.toContain("新会话");
      expect(out).not.toContain("后台运行中");
      // ContextBar 始终显示（首轮已完成 → 1%）
      expect(out).toContain("ctx ");
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

  // 任务 A：聊天区域行级滚动（PgUp → scrollRows += viewportRows/2，窗口上移
  // 使底部内容被裁；End → 回到底部）。新语义无「↑ N 行历史」指示，验证窗口
  // 滑动行为：PgUp 后最新消息被裁、End 后回归。
  it(
    "任务 A：发 5 条消息 → 渲染出 5 条 → PgUp → 最新消息被裁；End → 全部回归",
    async () => {
      // 用长文本（每条 6 行）确保 totalRows > viewportRows（≈26），PgUp 后
      // maxScroll > 0 才能让窗口真正上移。短消息填不满 viewport 会被 clamp 到 0。
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
      // 滚动前（scroll=0，auto-follow 底）：最新消息 m4 / a4 可见
      expect(app.lastOutput()).toContain("m4");
      expect(app.lastOutput()).toContain("a4");

      // PgUp → scrollRows += viewportRows/2（行级滚动，按 viewport 半页跳）。
      // 窗口上移 → 底部最新消息 a4 被裁出窗口。
      // 关键：PgUp 后必须稳定（等 800ms 让 ink 把所有 re-render 帧写完），
      // 然后 anchor since()，再 End。否则中间帧可能误导 waitFor（瞬态帧
      // 偶然不含 a4 让 clip 检查假阳性通过，但 End 时 anchor 已过完所有帧）。
      const pgupFrames = app.since();
      stdin.write("[5~"); // PgUp ANSI sequence
      await waitFor(
        () => !pgupFrames().includes("a4"),
        8000,
        "a4-clipped-after-pgup"
      );
      await delay(800); // 等 PgUp 后所有 re-render 帧稳定写入
      // 再次确认 clip（滚动窗口稳定后无 a4）
      expect(pgupFrames()).not.toContain("a4");

      // End → scroll 重置为 0（auto-follow 底），a4 恢复。
      const endFrames = app.since();
      stdin.write("[F"); // End ANSI sequence
      await waitFor(
        () => endFrames().includes("a4"),
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
      // 方案 B 最终定稿：banner(15 完整眼) 与消息共享 row window。
      // A：user(2) + assistant(16+1=17) = 19 + banner 15 = 34 contentRows，
      // viewportRows=26 → maxScroll=8。B：user(2) + assistant(24+1=25) = 27 +
      // banner 15 = 42 contentRows → maxScroll=16。两会话在 PgUp 后窗口都
      // 能上移（最新消息被裁）。切回 A 时若 scroll 未重置会残留 B 的偏移，
      // A 的底部消息会被错误裁掉。
      const lines = (tag: string, n: number): string =>
        Array.from({ length: n }, (_, i) => `${tag} 行${i + 1}内容占位`).join(
          "\n"
        );
      const app = makeApp([
        // A：user(2) + assistant(17) + banner(15) = 34
        assistantResult({ texts: [lines("aA", 16)] }),
        // B（方案 B 最终定稿）：user(2) + assistant(25) + banner(15) = 42
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

      // B 上 PgUp → scrollRows > 0（scroll = step = floor(26/2) = 13），
      // 窗口上移 → 最新消息 aB 被裁出窗口。since() 用 raw 字节锚定 + strip。
      const pgupFramesB = app.since();
      stdin.write("[5~"); // PgUp
      await waitFor(
        () => !pgupFramesB().includes("aB"),
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
      // 锚定在 Enter 之前：B 的 chat frame（含 msg-B / aB 被裁）在进入 list
      // 视图前已写入，排除在窗口外。since() 锚定避免 stripped 索引错位。
      const openFrames = app.since();
      stdin.write("\r");
      // openSessionAt 必须重置 scroll → A 的 scroll=0 窗口贴 A 内容底显示
      // 末尾若干行（"aA 行16…"）。STICKY banner 后消息窗口预算 = viewport -
      // STICKY banner 已恢复方案 B：banner + 消息共 row window，viewport=27
      // 完整看见 A 内容（19 行）+ 末行 aA 行16 可见。
      // openSessionAt 必须重置 scroll → A 的 scroll=0 窗口 [8,34) 露出 aA 末尾
      // 行（"aA 行16…"）。若残留 B 的 scroll=13，窗口 [0,21) 只露 aA 前 4 行，
      // 末尾行会被裁掉 → 断言 aA 末行可见即证明 scroll 已重置。
      await waitFor(
        () => {
          const after = openFrames();
          return after.includes("aA 行16内容占位") && after.includes("msg-A");
        },
        8000,
        "A-active-and-scroll-reset"
      );
    },
    LONG_TIMEOUT
  );

  // 滚轮支持回归：app 挂载 useEffect 启用 DECSET 1000/1006 SGR 滚轮报告（让
  // 滚轮驱动 chatScroll，与 PgUp/PgDn 同条滚动状态）。在 render 前就挂 raw
  // 监听，断言 stdout 出现 DECSET 启用序列（mount 阶段一次，不是每次 re-render）。
  it(
    "滚轮捕获：mount 写一次 DECSET 1000/1006 启用序列（不重复）",
    async () => {
      const bridge = createTuiBridge({
        dataDir: baseDir,
        deps: makeDeps([assistantResult({ texts: ["mouse-on"] })]),
        inflight: createInflightRegistry(),
      });
      const askBridge = createTuiAskUserBridge();
      const toolEventSink = createToolEventSink();
      const rawWrites: string[] = [];
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
      await delay(400); // 等 mount + useEffect
      await waitFor(
        () => strip(rawWrites.join("")).includes("iknow"),
        8000,
        "startup"
      );
      // 触发一次提交（验证 useEffect 不因 re-render 再写 DECSET）
      for (const ch of "hi\r") {
        stdin.write(ch);
        await delay(10);
      }
      await waitFor(() => bridge.inflight.ids().size === 0, 8000, "turn-done");
      await delay(300);
      const joined = rawWrites.join("");
      // mount 写一次 1000h/1006h/1002h（drag mode #238）；不应被 effect
      // 多次触发。
      const enableCount = (joined.match(/\x1b\[\?1000h/g) ?? []).length;
      expect(enableCount, "mount 写一次 1000h").toBe(1);
      const dragEnable = (joined.match(/\x1b\[\?1002h/g) ?? []).length;
      expect(dragEnable, "mount 写一次 1002h（drag 模式）").toBe(1);
      // unmount 会再写 DECRST（effect cleanup 写 1000l/1006l/1002l）—— 但
      // listener 仍挂着，理应看到。instances.push 已经挂了 afterEach，
      // instance 此时仍在这里，手动 unmount 即可。
      instance.unmount();
      await delay(150);
      stdout.removeListener("data", rawListener);
      const joinedFull = rawWrites.join("");
      const disableCount = (joinedFull.match(/\x1b\[\?1006l/g) ?? []).length;
      expect(disableCount, "unmount 写一次 1006l").toBeGreaterThanOrEqual(1);
      // #238 quit 路径 / leak guard：drag mode 1002l 也必须出现（不依赖
      // effect cleanup；quit() 防御性同步写全序列）。
      const dragDisable = (joinedFull.match(/\x1b\[\?1002l/g) ?? []).length;
      expect(
        dragDisable,
        "unmount 写一次 1002l（drag mode 关闭）"
      ).toBeGreaterThanOrEqual(1);
    },
    LONG_TIMEOUT
  );

  // 任务 B 已移到独立文件 tests/tui/slash-hint-new-session.test.tsx（hint
  // Enter → onSelectHint race 在本文件全量 suite CPU 竞争下偶发 flake）。

  // #189 Spec Low：`initialSession`（`iknow tui <id>` resume）恢复路径未测。
  // 挂载即生成既有会话内容，行级滚动应从 scrollRows=0（auto-follow 底）
  // 起步：初始末段可见；PgUp 后窗口上移，末段被裁；End → 末段恢复。
  it(
    "Spec Low：initialSession resume 从 scrollRows=0 起步；PgUp → 末段被裁；End → 恢复",
    async () => {
      const { attachSession } = await import("../../src/tui/session-state.js");
      // 方案 B 最终定稿：banner + user(2) + assistant(25) ≈ 42；viewportRows≈26；
      // maxScroll ≈ 16。PgUp step = 13。
      // 使用末段 sentinel「A0 resume 内容第24行」— 只在 assistant 内容里出现，
      // 状态栏会话摘要不冲突（摘要 = user 文本「resumed-q」）。
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

      // scrollRows=0（auto-follow 底）：末段可见作初次锚点
      await waitFor(
        () => lastOutput().includes("A0 resume 内容第24行"),
        8000,
        "resumed-bottom-visible"
      );

      // PgUp → scrollRows += 13，窗口上移 → 末段被裁出可视窗。raw 字节锚定 + strip。
      // 必须等 PgUp 后 ink re-render 稳定（800ms）再 anchor End，否则中间帧会
      // 让 End anchor 错过 a4 恢复帧。
      const pgupA = out.join("").length;
      stdin.write("[5~"); // PgUp ANSI sequence
      await waitFor(
        () =>
          !strip(out.join("").slice(pgupA)).includes("A0 resume 内容第24行"),
        8000,
        "resume-pgup-clips-tail"
      );
      await delay(800); // 等 PgUp re-render 稳定
      expect(strip(out.join("").slice(pgupA))).not.toContain(
        "A0 resume 内容第24行"
      );

      // End → scrollRows=0（auto-follow 底）：末段恢复
      const endA = out.join("").length;
      stdin.write("[F"); // End ANSI sequence
      await waitFor(
        () => strip(out.join("").slice(endA)).includes("A0 resume 内容第24行"),
        8000,
        "resume-end-restores-tail"
      );
    },
    LONG_TIMEOUT
  );

  // 滚轮驱动 chatScroll（朴素滚动）：SGR 上滚 → 窗口上移（末段被裁）；
  // SGR 下滚 → 窗口回滚（末段恢复）。与 PgUp/PgDn 同一条滚动状态。
  it(
    "滚轮：SGR 上滚 → 末段被裁；SGR 下滚 → 末段恢复（同 chatScroll）",
    async () => {
      const { attachSession } = await import("../../src/tui/session-state.js");
      const longBody = Array.from(
        { length: 24 },
        (_, i) => `WHEEL 内容第${i + 1}行`
      ).join("\n");
      const initial = attachSession({
        conversation_id: "wheel-session",
        messages: [
          { role: "user", content: [{ type: "text", text: "wheel-q" }] },
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
      await delay(400); // 等 mount + useInput + mouse listener effect

      await waitFor(
        () => lastOutput().includes("WHEEL 内容第24行"),
        8000,
        "wheel-bottom-visible"
      );

      // 滚轮上滚 ×1 → clamp 到顶（用户 2026-08-08：滚轮第3次才有反应 →
      // 改为 wheel-up/wheel-down 即 clamp 到顶/底，单格即决断），末段被裁。
      const wheelUpA = out.join("").length;
      stdin.write("\x1b[<64;10;5M");
      await delay(150);
      await waitFor(
        () => !strip(out.join("").slice(wheelUpA)).includes("WHEEL 内容第24行"),
        8000,
        "wheel-up-clips-tail"
      );

      // 滚轮下滚 ×1 → clamp 回底（auto-follow），末段恢复。
      const wheelDownA = out.join("").length;
      stdin.write("\x1b[<65;10;5M");
      await delay(150);
      await waitFor(
        () =>
          strip(out.join("").slice(wheelDownA)).includes("WHEEL 内容第24行"),
        8000,
        "wheel-down-restores-tail"
      );
    },
    LONG_TIMEOUT
  );
});
