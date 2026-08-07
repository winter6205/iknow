/**
 * tests/tui/copy-flow.test.tsx
 *
 * #237 /copy + Ctrl+Y 端到端：mount 一个 resume 会话（assistant 有内容），
 * type "/copy" + Enter → notice 出现 /copy 已复制（kind: "ok"）；外加
 * Ctrl+Y → 同样触发。Ctrl+Y 串 = "\x19"（EtX）。
 *
 * 路径：app.tsx handleSubmit switch case "copy" → copyLastAssistant
 *   → extractLastAssistantText + copyToClipboard → setNotice。
 * 我们不依赖本机剪贴板命令是否在 PATH（自动化测试环境常缺），允许
 * notice 文案是 "ok" / "fallback" 之一。
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
import { attachSession } from "../../src/tui/session-state.js";
import { makeDeps } from "../cli/_fixtures.js";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");
const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

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

const LONG_TIMEOUT = 30_000;

describe("TuiApp /copy + Ctrl+Y 流程", () => {
  let baseDir: string;
  let stdout: ReturnType<typeof fakeTtyStream>;
  let stdin: ReturnType<typeof fakeTtyStream>;
  const instances: Instance[] = [];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-copy-"));
    stdout = fakeTtyStream();
    stdin = fakeTtyStream();
  }, LONG_TIMEOUT);
  afterEach(async () => {
    for (const ins of instances) ins.unmount();
    instances.length = 0;
    await rm(baseDir, { recursive: true, force: true });
  }, LONG_TIMEOUT);

  function mountResumedApp(): ((text: string) => Promise<void>) & {
    readonly out: () => string;
  } {
    const initial = attachSession({
      conversation_id: "copy-target",
      messages: [
        { role: "user", content: [{ type: "text", text: "请讲个故事" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "SENTINEL_COPY_BODY_START" },
            { type: "text", text: "SENTINEL_COPY_BODY_END" },
          ],
        },
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
    const type = async (text: string): Promise<void> => {
      for (const ch of text) {
        stdin.write(ch);
        await delay(10);
      }
    };
    return Object.assign(type, { out: (): string => strip(out.join("")) });
  }

  it(
    "/copy 命令：mount resume 会话 → type /copy ⏎ → notice 出现 /copy 已复制",
    async () => {
      const type = mountResumedApp();
      await delay(400); // 等 mount + useInput effect
      // 锚点：assistant 文本可见（确认会话已显示）
      await waitFor(
        () => type.out().includes("请讲个故事"),
        8000,
        "resumed-session-visible"
      );
      // 输入 /copy + Enter
      await type("/copy\r");
      // 断言 copyLastAssistant 触发 notice（不依赖本机剪贴板命令是否在 PATH）：
      //   ok → "/copy 已复制 (...)"
      //   fallback → "/copy 剪贴板命令不可用，文本已写入 ..."
      //   error → "/copy 复制失败: ..."
      await waitFor(
        () => /\/copy (已复制|剪贴板命令不可用|复制失败)/.test(type.out()),
        8000,
        "copy-notice"
      );
    },
    LONG_TIMEOUT
  );

  it(
    "/copy 命令：空会话（draft，无 assistant）→ notice 提示无回复",
    async () => {
      // initialSession 缺省 → draft；messages 空。
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
      const type = async (text: string): Promise<void> => {
        for (const ch of text) {
          stdin.write(ch);
          await delay(10);
        }
      };
      const lastOutput = (): string => strip(out.join(""));
      await delay(400);
      await type("/copy\r");
      await waitFor(
        () => lastOutput().includes("还没有 assistant 回复"),
        8000,
        "empty-copy-notice"
      );
    },
    LONG_TIMEOUT
  );

  it(
    "Ctrl+Y 快捷键：mount resume 会话 → 写 \\x19 → 触发 copyLastAssistant",
    async () => {
      const type = mountResumedApp();
      await delay(400);
      await waitFor(
        () => type.out().includes("请讲个故事"),
        8000,
        "resumed-session-visible"
      );
      // Ctrl+Y = ASCII 0x19 (EtX)
      stdin.write("\x19");
      await waitFor(
        () => /\/copy (已复制|剪贴板命令不可用|复制失败)/.test(type.out()),
        8000,
        "ctrl-y-copy-notice"
      );
    },
    LONG_TIMEOUT
  );
});
