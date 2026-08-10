/**
 * tests/tui/slash-hint-new-session.test.tsx
 *
 * 任务 B：slash 候选 ↑/↓ 选中 + Enter 触发 onSelectHint（不走 raw 文本解析）
 *
 * 关键点：cursor 默认 0 = sessions；如果 ↓ + Enter 触发的是 sessions
 * → 切到 list 视图；如果是 new → 切到新 draft。我们断言：↓ + Enter
 * 之后应用未退出、也未切到列表视图（list 视图特征 = "+ 新建会话"），
 * 而是新 draft 创建（inputValue 清空，可继续发消息）。
 *
 * 为什么独立文件：本用例依赖 hint Enter → onSelectHint 的异步 race（`↓`
 * 后 ink useInput 注册时序 + `delay(300)` 给 hint 触发让出窗口）。在
 * `app.test.tsx` 全量 suite CPU 竞争下偶发 flake（`new-reply` waitFor
 * timeout），与该文件其它用例不共享状态。独立文件 + 单独跑能稳定通过。
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
  readonly instance: Instance;
  readonly lastOutput: () => string;
  readonly type: (text: string) => Promise<void>;
}

describe('任务 B："/" 出现候选 → ↓ → Enter 触发 /new', () => {
  // eslint-disable-next-line no-magic-numbers
  const LONG_TIMEOUT = 30_000;
  let baseDir: string;
  let stdout: ReturnType<typeof fakeTtyStream>;
  let stdin: ReturnType<typeof fakeTtyStream>;
  let instance: Instance | undefined;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-task-b-"));
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
      instance,
      lastOutput: (): string => strip(out.join("")),
      type: async (text: string): Promise<void> => {
        for (const ch of text) {
          stdin.write(ch);
          await delay(10);
        }
      },
    };
  }

  it(
    '"/" 出现候选 → ↓ → Enter 触发 /new（不退出，验证选中索引非 0）',
    async () => {
      const app = mountApp(
        createTuiBridge({
          dataDir: baseDir,
          deps: makeDeps([assistantResult({ texts: ["new-draft-reply"] })]),
          inflight: createInflightRegistry(),
        })
      );
      await delay(400); // 等 ink useInput 注册
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
      stdin.write("\x1b[B");
      await delay(150);

      // 3) Enter → onSelectHint("new") 触发 → handleSubmit("/new") → newSession()
      stdin.write("\r");
      await delay(300);
      const after = app.lastOutput();
      expect(after).not.toContain("+ 新建会话");
      expect(after).toContain("输入消息");

      // 4) 后续发消息：落盘到新 session
      await app.type("new-draft-msg\r");
      await waitFor(
        () => app.bridge.inflight.ids().size === 0,
        8000,
        "new-turn-done"
      );
      // inflight 清空后 session 落盘仍有一个调度窗口：固定 sleep 在
      // CPU 争用下会过早断言导致偶发 flake，改用轮询等待落盘完成。
      await waitFor(
        async () => (await app.bridge.listSessions()).length === 1,
        8000,
        "session-persisted"
      );
      const list = await app.bridge.listSessions();
      expect(list).toHaveLength(1);
      expect(list[0]!.summary).toBe("new-draft-msg");
      // 5) assistant 答复渲染出来
      await waitFor(
        () => app.lastOutput().includes("new-draft-reply"),
        8000,
        "new-reply"
      );
    },
    LONG_TIMEOUT
  );
});
