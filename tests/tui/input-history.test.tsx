/**
 * tests/tui/input-history.test.tsx
 *
 * #279 项5：TUI 输入历史 ↑/↓ 导航回归。
 *
 * 覆盖：
 *  1) ↑ 从最新条向前召回、↓ 向后回到输入现场、召回后 Enter 再提交落盘；
 *  2) slash 候选可见时 ↑/↓ 仍走 hint cursor（hint 优先，不触发历史召回）；
 *  3) 空历史 ↑/↓ no-op（不崩、不吞后续输入）；
 *  4) review 修复回归：草稿保存/恢复 round-trip（↑ 不覆盖在写内容、↓ 越过
 *     最新条恢复草稿而非清空）；y/n 回复不进历史；连续重复去重。
 *
 * 独立文件原因同 slash-hint-new-session.test.tsx：依赖 ink useInput 注册
 * 时序 + 真实时钟 delay，避免在 app.test.tsx 全量 suite CPU 竞争下 flake。
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
import { createTuiAskUserBridge, type TuiAskUserBridge } from "../../src/tui/ask-user.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.js";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");

/** 取帧内输入框行（左框线 + ❯ 锚定）。聊天区用户消息也渲染成
 *  「❯ 文本」，整帧 includes 会被污染；断言输入值必须只看输入框行。 */
function inputLineOf(frame: string): string {
  return frame.split("\n").find((l) => l.includes("│ ❯ ")) ?? "";
}

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

/** 假 TTY 流：与 app.test.tsx 同一份定义（独立文件不复用 mountApp）。 */
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
  stream.setRawMode = (): void => {};
  stream.ref = (): void => {};
  stream.unref = (): void => {};
  return stream;
}

interface DrivenApp {
  readonly bridge: TuiBridge;
  readonly askBridge: TuiAskUserBridge;
  readonly instance: Instance;
  readonly lastOutput: () => string;
  readonly lastFrame: () => string;
  readonly type: (text: string) => Promise<void>;
}

describe("#279 项5：输入历史 ↑/↓ 导航", () => {
  // eslint-disable-next-line no-magic-numbers
  const LONG_TIMEOUT = 30_000;
  let baseDir: string;
  let stdout: ReturnType<typeof fakeTtyStream>;
  let stdin: ReturnType<typeof fakeTtyStream>;
  let instance: Instance | undefined;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-history-"));
    stdout = fakeTtyStream();
    stdin = fakeTtyStream();
  }, LONG_TIMEOUT);
  afterEach(async () => {
    instance?.unmount();
    instance = undefined;
    await rm(baseDir, { recursive: true, force: true });
  }, LONG_TIMEOUT);

  function mountApp(bridge: TuiBridge): DrivenApp {
    const askBridge = createTuiAskUserBridge();
    const toolEventSink = createToolEventSink();
    const out: string[] = [];
    stdout.on("data", (chunk) => out.push(String(chunk)));
    instance = render(
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
    return {
      bridge,
      askBridge,
      instance,
      lastOutput: (): string => strip(out.join("")),
      // 最近一次 ink 写入的可视帧（从后往前找 strip 后非空的 chunk；
      // 纯 ANSI 控制序列片跳过，同 app.test.tsx lastFrame 语义）。
      lastFrame: (): string =>
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
        for (const ch of text) {
          stdin.write(ch);
          await delay(10);
        }
      },
    };
  }

  it(
    "↑ 召回最新→更旧、↓ 向后回现场、召回再提交落盘",
    async () => {
      const app = mountApp(
        createTuiBridge({
          dataDir: baseDir,
          deps: makeDeps([
            assistantResult({ texts: ["reply-1"] }),
            assistantResult({ texts: ["reply-2"] }),
            assistantResult({ texts: ["reply-3"] }),
          ]),
          inflight: createInflightRegistry(),
        })
      );
      await delay(400); // 等 ink useInput 注册
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 1) 提交两条消息 → 历史 = ["first", "second"]
      await app.type("first\r");
      await waitFor(() => app.lastOutput().includes("reply-1"), 8000, "t1");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "t1-inflight"
      );
      await app.type("second\r");
      await waitFor(() => app.lastOutput().includes("reply-2"), 8000, "t2");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "t2-inflight"
      );

      // 2) ↑ → 召回最新条 "second"（inputLineOf 锚定输入框行，避开聊天区
      //    同名用户消息行）
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("second"),
        8000,
        "up-1"
      );

      // 3) 再 ↑ → 更旧的 "first"
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("first"),
        8000,
        "up-2"
      );

      // 4) ↓ → 回到 "second"
      stdin.write("\x1b[B");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("second"),
        8000,
        "down-1"
      );

      // 5) 再 ↓ → 越过最新条回到输入现场（占位符，值为空）
      stdin.write("\x1b[B");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("输入消息或 /help"),
        8000,
        "down-2-empty"
      );

      // 6) ↑ 召回 "second" 后 Enter → 再次提交（消费 reply-3）
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("second"),
        8000,
        "up-3"
      );
      stdin.write("\r");
      await waitFor(() => app.lastOutput().includes("reply-3"), 8000, "t3");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "t3-inflight"
      );

      // 7) 落盘验证：用户消息序列 = first / second / second（召回再提交）
      const list = await app.bridge.listSessions();
      expect(list).toHaveLength(1);
      const file = await app.bridge.loadSessionFile(list[0]!.conversation_id);
      const userTexts = file.messages
        .filter((m) => m.role === "user")
        .flatMap((m) =>
          m.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
        );
      expect(userTexts).toEqual(["first", "second", "second"]);
    },
    LONG_TIMEOUT
  );

  it(
    "hint 可见时 ↑/↓ 走候选 cursor（不触发历史召回）；hint 消失后恢复召回",
    async () => {
      const app = mountApp(
        createTuiBridge({
          dataDir: baseDir,
          deps: makeDeps([assistantResult({ texts: ["hint-reply"] })]),
          inflight: createInflightRegistry(),
        })
      );
      await delay(400);
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 1) 先提交一条 → 历史 = ["hello-hist"]
      await app.type("hello-hist\r");
      await waitFor(
        () => app.lastOutput().includes("hint-reply"),
        8000,
        "seed-turn"
      );
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "seed-inflight"
      );

      // 2) 输入 "/" → 候选出现
      await app.type("/");
      await waitFor(() => app.lastFrame().includes("/help"), 8000, "hints");

      // 3) ↑ 应只动 hint cursor：输入框仍为 "/"，不召回 "hello-hist"；
      //    候选列表仍可见（若误走历史召回，值变 "hello-hist" → hint 消失）
      stdin.write("\x1b[A");
      await delay(200);
      const lineAfterUp = inputLineOf(app.lastFrame());
      expect(lineAfterUp).toContain("❯ /");
      expect(lineAfterUp).not.toContain("hello-hist");
      expect(app.lastFrame()).toContain("/help"); // 候选仍可见

      // 4) Backspace 清掉 "/" → hint 消失；↑ 恢复历史召回
      stdin.write("\x7f");
      await delay(150);
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("hello-hist"),
        8000,
        "recall-after-hint"
      );
    },
    LONG_TIMEOUT
  );

  it(
    "空历史 ↑/↓ no-op：不崩、不吞后续输入",
    async () => {
      const app = mountApp(
        createTuiBridge({
          dataDir: baseDir,
          deps: makeDeps([assistantResult({ texts: ["fresh-reply"] })]),
          inflight: createInflightRegistry(),
        })
      );
      await delay(400);
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 无历史：↑ ↓ 均 no-op → 输入框仍是占位符
      stdin.write("\x1b[A");
      await delay(150);
      stdin.write("\x1b[B");
      await delay(150);
      expect(inputLineOf(app.lastFrame())).toContain("输入消息或 /help");

      // 后续输入不被吞：正常提交一轮
      await app.type("after-noop\r");
      await waitFor(
        () => app.lastOutput().includes("fresh-reply"),
        8000,
        "noop-turn"
      );
      const list = await app.bridge.listSessions();
      expect(list).toHaveLength(1);
      expect(list[0]!.summary).toBe("after-noop");
    },
    LONG_TIMEOUT
  );

  it(
    "草稿 round-trip：↑ 不覆盖在写内容、↓ 越过最新条恢复草稿",
    async () => {
      const app = mountApp(
        createTuiBridge({
          dataDir: baseDir,
          deps: makeDeps([assistantResult({ texts: ["draft-reply"] })]),
          inflight: createInflightRegistry(),
        })
      );
      await delay(400);
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 1) 种一条历史
      await app.type("hist-a\r");
      await waitFor(
        () => app.lastOutput().includes("draft-reply"),
        8000,
        "seed-turn"
      );
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "seed-inflight"
      );

      // 2) 输入半截草稿（不提交）
      await app.type("wip-draft");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("wip-draft"),
        8000,
        "draft-typed"
      );

      // 3) ↑ → 召回 "hist-a"（旧 bug：草稿被直接覆盖丢失）
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("hist-a"),
        8000,
        "up-recall"
      );

      // 4) ↓ → 越过最新条回输入现场：恢复草稿 "wip-draft"（旧 bug：清空）
      stdin.write("\x1b[B");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("wip-draft"),
        8000,
        "down-restore-draft"
      );

      // 5) 恢复后游标已归位：再 ↑ 仍从最新条起步、再 ↓ 草稿仍在
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("hist-a"),
        8000,
        "up-again"
      );
      stdin.write("\x1b[B");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("wip-draft"),
        8000,
        "down-restore-again"
      );
    },
    LONG_TIMEOUT
  );

  it(
    "y/n 回复不进历史：askPending 确认后 ↑ 仍召回真实消息",
    async () => {
      const app = mountApp(
        createTuiBridge({
          dataDir: baseDir,
          deps: makeDeps([assistantResult({ texts: ["ask-seed-reply"] })]),
          inflight: createInflightRegistry(),
        })
      );
      await delay(400);
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 1) 种一条真实消息 → 历史 = ["seed-msg"]
      await app.type("seed-msg\r");
      await waitFor(
        () => app.lastOutput().includes("ask-seed-reply"),
        8000,
        "seed-turn"
      );
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "seed-inflight"
      );

      // 2) 触发授权待决（组件树外状态；敲一键触发重渲染让根 tick 起轮询）
      const approved = app.askBridge.ask({
        tool: "shell",
        input: {},
        summaryHint: "rm -rf /tmp/x",
      });
      await app.type(" ");
      await waitFor(() => app.lastFrame().includes("[ask]"), 8000, "ask-line");

      // 3) 退格掉触发键空格，y 确认授权（不是对话消息，不得进历史）
      stdin.write("\x7f");
      await delay(100);
      await app.type("y\r");
      expect(await approved).toBe(true);
      await waitFor(
        () => app.askBridge.pending() === undefined,
        8000,
        "ask-resolved"
      );

      // 4) ↑ 召回的必须是 "seed-msg"——若 "y" 污染了历史，这里会召回 "y"
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("seed-msg"),
        8000,
        "recall-seed"
      );
    },
    LONG_TIMEOUT
  );

  it(
    "连续重复去重：连提两条相同只入一条历史（召回再提交也不重复）",
    async () => {
      const app = mountApp(
        createTuiBridge({
          dataDir: baseDir,
          deps: makeDeps([
            assistantResult({ texts: ["r-one"] }),
            assistantResult({ texts: ["r-dup-1"] }),
            assistantResult({ texts: ["r-dup-2"] }),
            assistantResult({ texts: ["r-dup-3"] }),
          ]),
          inflight: createInflightRegistry(),
        })
      );
      await delay(400);
      await waitFor(() => app.lastOutput().includes("iknow"), 8000, "startup");

      // 1) one / dup / dup 三轮（第二条 dup 为连续重复）
      await app.type("one\r");
      await waitFor(() => app.lastOutput().includes("r-one"), 8000, "t-one");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "t-one-inflight"
      );
      await app.type("dup\r");
      await waitFor(() => app.lastOutput().includes("r-dup-1"), 8000, "t-dup-1");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "t-dup-1-inflight"
      );
      await app.type("dup\r");
      await waitFor(() => app.lastOutput().includes("r-dup-2"), 8000, "t-dup-2");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "t-dup-2-inflight"
      );

      // 2) ↑ → "dup"、再 ↑ → "one"（未去重的话第二次 ↑ 仍会召回 "dup"）
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("dup"),
        8000,
        "up-dup"
      );
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("one"),
        8000,
        "up-one"
      );

      // 3) ↓ 回 "dup" 原样再提交（召回再提交路径）→ 仍只保留一条
      stdin.write("\x1b[B");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("dup"),
        8000,
        "down-dup"
      );
      stdin.write("\r");
      await waitFor(() => app.lastOutput().includes("r-dup-3"), 8000, "t-dup-3");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "t-dup-3-inflight"
      );

      // 4) 历史仍为 ["one","dup"]：↑ "dup"、再 ↑ "one"
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("dup"),
        8000,
        "up-dup-2"
      );
      stdin.write("\x1b[A");
      await waitFor(
        () => inputLineOf(app.lastFrame()).includes("one"),
        8000,
        "up-one-2"
      );
    },
    LONG_TIMEOUT
  );
});
