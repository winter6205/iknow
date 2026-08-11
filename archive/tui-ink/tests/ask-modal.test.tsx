/**
 * tests/tui/ask-modal.test.tsx
 *
 * #279 项3：权限 ask 走 modal 槽（y/a/n = once/always/reject）的 TuiApp
 * 端到端回归（ink render + 假 TTY stdin/stdout 驱动，与 app.test.tsx 同基建）：
 *  - modal 渲染（pending ask 出现时）+ y/n 直选 resolve；
 *  - a「总是允许」→ resolve true + sessionGrants 登记 session 层 allow 规则，
 *    且该规则在 checkPermission 层真正放行（policy 级断言）；
 *  - ↑↓ + Enter 导航确认；
 *  - Esc 收起 → 退回输入框 y/n 兼容路径（向后兼容语义）；
 *  - 窄终端 modal 活跃时整帧不超终端行数（行账 modalRows 入账守卫）。
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
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import {
  createPermissionPolicy,
  checkPermission,
} from "../../src/harness/permission/policy.js";
import type { AciToolDef } from "../../src/harness/aci/types.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { makeDeps } from "../cli/_fixtures.js";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  cond: () => boolean,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`waitFor timeout: ${label}`);
    await delay(40);
  }
}

function fakeTty(rows = 30, cols = 100) {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
    setRawMode: (v: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  s.setRawMode = (): void => {};
  s.ref = (): void => {};
  s.unref = (): void => {};
  return s;
}

const bashTool: AciToolDef = Object.freeze({
  name: "bash",
  description: "test bash",
  inputSchema: { type: "object", additionalProperties: false },
  handler: async () => "ok",
  aci: Object.freeze({
    category: "execute" as const,
    isConcurrencySafe: false,
    interruptBehavior: "cancel" as const,
    timeoutTier: "default" as const,
  }),
});

describe("TuiApp 权限 ask modal（#279 项3）", () => {
  const LONG_TIMEOUT = 30_000;
  let baseDir: string;
  const instances: Instance[] = [];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "iknow-tui-ask-modal-"));
  }, LONG_TIMEOUT);
  afterEach(async () => {
    for (const instance of instances) instance.unmount();
    instances.length = 0;
    await rm(baseDir, { recursive: true, force: true });
  }, LONG_TIMEOUT);

  function mount(opts?: {
    readonly rows?: number;
    readonly cols?: number;
    readonly sessionGrants?: ReturnType<typeof createSessionGrants>;
  }) {
    const stdout = fakeTty(opts?.rows ?? 30, opts?.cols ?? 100);
    const stdin = fakeTty(opts?.rows ?? 30, opts?.cols ?? 100);
    const out: string[] = [];
    stdout.on("data", (c) => out.push(String(c)));
    const askBridge = createTuiAskUserBridge();
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    });
    const instance = render(
      <TuiApp
        bridge={bridge}
        askBridge={askBridge}
        toolEventSink={createToolEventSink()}
        cwd="/tmp/proj"
        dataDir={baseDir}
        permissionMode={createPermissionModeContext("default")}
        {...(opts?.sessionGrants ? { sessionGrants: opts.sessionGrants } : {})}
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
    return {
      stdin,
      askBridge,
      lastOutput: (): string => strip(out.join("")),
      since: (): (() => string) => {
        const anchor = out.join("").length;
        return () => strip(out.join("").slice(anchor));
      },
      lastFrame: (): string => {
        for (let i = out.length - 1; i >= 0; i--) {
          const visible = strip(out[i] ?? "");
          if (visible.length > 0) return visible;
        }
        return "";
      },
      type: async (text: string): Promise<void> => {
        for (const ch of text) {
          stdin.write(ch);
          await delay(10);
        }
      },
      ready: async (): Promise<void> => {
        await delay(400);
      },
    };
  }

  const askCtx = {
    tool: "bash",
    input: { command: "ls" },
    summaryHint: "ls",
  };

  it(
    "pending ask → modal 渲染；y 直选 → ask 放行，modal 消失",
    async () => {
      const app = mount();
      await app.ready();
      const promise = app.askBridge.ask(askCtx);
      await waitFor(
        () => app.lastOutput().includes("允许执行 bash？"),
        8000,
        "modal-rendered"
      );
      expect(app.lastOutput()).toContain("本次允许");
      expect(app.lastOutput()).toContain("总是允许（本会话）");
      expect(app.lastOutput()).toContain("拒绝");

      await app.type("y");
      await expect(promise).resolves.toBe(true);
      const after = app.since();
      await waitFor(
        () => !after().includes("允许执行 bash？"),
        8000,
        "modal-gone"
      );
    },
    LONG_TIMEOUT
  );

  it(
    "n 直选 → ask 拒绝",
    async () => {
      const app = mount();
      await app.ready();
      const promise = app.askBridge.ask(askCtx);
      await waitFor(
        () => app.lastOutput().includes("允许执行 bash？"),
        8000,
        "modal-rendered"
      );
      await app.type("n");
      await expect(promise).resolves.toBe(false);
    },
    LONG_TIMEOUT
  );

  it(
    "a 直选 → 放行 + sessionGrants 登记「总是允许」（policy 层真放行）",
    async () => {
      const sessionGrants = createSessionGrants();
      const app = mount({ sessionGrants });
      await app.ready();
      const promise = app.askBridge.ask(askCtx);
      await waitFor(
        () => app.lastOutput().includes("允许执行 bash？"),
        8000,
        "modal-rendered"
      );
      await app.type("a");
      await expect(promise).resolves.toBe(true);
      // 授权登记：session 层 allow 规则（同 id 去重）。
      const rules = sessionGrants.list();
      expect(rules.length).toBe(1);
      expect(rules[0]!.decision).toBe("allow");
      expect(rules[0]!.match({ tool: "bash", input: {} })).toBe(true);
      expect(rules[0]!.match({ tool: "write_file", input: {} })).toBe(false);
      // policy 级：同 grants 实例接入 checkPermission → execute 类工具
      // 原本 default=ask，登记后直接 allow（后续调用不再弹 modal）。
      const policy = createPermissionPolicy({ session: sessionGrants });
      const outcome = checkPermission({
        def: bashTool,
        input: { command: "ls" },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
        mode: policy.mode,
      });
      expect(outcome.decision).toBe("allow");
      // notice 提示「总是允许」。
      await waitFor(
        () => app.lastOutput().includes("本会话总是允许"),
        8000,
        "always-notice"
      );
    },
    LONG_TIMEOUT
  );

  it(
    "↑↓ + Enter 导航：↓↓ + Enter → 选中「拒绝」",
    async () => {
      const app = mount();
      await app.ready();
      const promise = app.askBridge.ask(askCtx);
      await waitFor(
        () => app.lastOutput().includes("允许执行 bash？"),
        8000,
        "modal-rendered"
      );
      app.stdin.write("\u001b[B"); // ↓
      await delay(80);
      app.stdin.write("\u001b[B"); // ↓
      await delay(150);
      app.stdin.write("\r");
      await expect(promise).resolves.toBe(false);
    },
    LONG_TIMEOUT
  );

  it(
    "Esc 收起 → 退回输入框 y/n 兼容路径（typed y + Enter 放行）",
    async () => {
      const app = mount();
      await app.ready();
      const promise = app.askBridge.ask(askCtx);
      await waitFor(
        () => app.lastOutput().includes("允许执行 bash？"),
        8000,
        "modal-rendered"
      );
      await app.type("\u001b"); // Esc
      const after = app.since();
      await waitFor(
        () => after().includes("输入 y/a/n"),
        8000,
        "dismissed-ask-line"
      );
      // modal 已收起（新帧不再出现 modal 盒子标题的粗框样式文本：三选项行消失）
      expect(after()).not.toContain("总是允许（本会话）");
      // 兼容路径：输入框 typed y + Enter。
      await app.type("y\r");
      await expect(promise).resolves.toBe(true);
    },
    LONG_TIMEOUT
  );

  it(
    "窄终端（44 列）modal 活跃：整帧行数 ≤ 终端行数（行账不溢出）",
    async () => {
      const app = mount({ rows: 24, cols: 44 });
      await app.ready();
      void app.askBridge.ask({
        ...askCtx,
        summaryHint: "写入 src/some/long/path/file.ts（覆盖既有内容）",
      });
      await waitFor(
        () => app.lastOutput().includes("允许执行 bash？"),
        8000,
        "modal-rendered-narrow"
      );
      await delay(300); // 等行账稳定帧
      const frame = app.lastFrame().replace(/\n+$/, "");
      const frameRows = frame.split("\n").length;
      expect(
        frameRows,
        `窄终端帧高 ${frameRows} ≤ 24（modal 行数已入 chromeReserveRows）`
      ).toBeLessThanOrEqual(24);
      // modal 内容完整可见（折行不截断选项）。
      expect(app.lastFrame()).toContain("拒绝");
    },
    LONG_TIMEOUT
  );
});
