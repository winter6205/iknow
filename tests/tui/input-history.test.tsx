/** @jsxImportSource @opentui/react */
/**
 * tests/tui/input-history.test.tsx
 *
 * #343 T6-C：#279 项5 — TUI 输入历史 ↑/↓ 导航回归测试（自 archive
 * tui-ink/tests/input-history.test.tsx 迁移）。
 *
 * 覆盖：
 *  1) 空历史 ↑/↓ no-op（不崩、不吞后续输入）；
 *  2) ↑ 召回 / ↓ 越界回现场（草稿 round-trip）；
 *  3) hint 候选可见时 ↑/↓ 走 hint cursor（hint 优先）；
 *  4) 连续重复去重（连提两条相同只入一条历史）。
 *  5) 会话恢复种子（fix/tui-input-issues）：initialSession 恢复 / /sessions
 *     openSessionAt 切换后 ↑ 立即可用（transcript 投影 seedInputHistory），
 *     且 per-session 隔离（A 会话提交不泄漏进 B 的 ↑ 历史）；
 *  6) Tab 补全接线：hint 游标选中非首候选 + Tab → 按选中项补全
 *     （app.tsx onTabComplete cursor>0 分支，原 length===1 && cursor===0
 *     恒不可达死代码）；/q 唯一匹配、/e LCP 无进展 no-op 回归护栏；
 *  7) 提交追加回归护栏（appendInputHistory 接线后行为不变）。
 *
 * 装配：mountAppAsync + stub deps（同 app.test.tsx 模式）。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import {
  attachSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import { resolveProjectSessionDir } from "../../src/session-api/store/session-store.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

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
  readonly pressArrow: (dir: "up" | "down") => Promise<void>;
  readonly pressBackspace: () => Promise<void>;
  readonly pressTab: () => Promise<void>;
}

async function mountAppAsync(
  responses: Parameters<typeof makeDeps>[0],
  opts: {
    /** 会话恢复（`iknow tui <id>` 等价）：mount 即 attach，不走新建 draft。 */
    readonly initialSession?: TuiSessionState;
    /** 复用外部 dataDir（openSessionAt 用例需先在盘上播种会话文件）。 */
    readonly dataDir?: string;
  } = {}
): Promise<DrivenApp> {
  const dataDir =
    opts.dataDir ?? mkdtempSync(join(tmpdir(), "iknow-tui-history-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
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
      initialSession={opts.initialSession}
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
  await new Promise((r) => setTimeout(r, 300));
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
    typeText: async (text: string) => {
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressArrow: async (dir) => {
      setup.mockInput.pressArrow(dir);
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
    pressBackspace: async () => {
      setup.mockInput.pressBackspace();
      await new Promise((r) => setTimeout(r, 50));
      await setup.renderOnce();
    },
    pressTab: async () => {
      setup.mockInput.pressTab();
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();
    },
  };
}

/** 帧内子串出现次数（区分消息流转录份与输入框渲染份，同 keyboard.test.tsx）。 */
function countOccurrences(frame: string, needle: string): number {
  let count = 0;
  let idx = frame.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = frame.indexOf(needle, idx + 1);
  }
  return count;
}

/** 最小合法 SessionFileV1（user/assistant 对构成 turn；同 rewind.test.tsx
 *  sampleFile 的必填字段集），供 initialSession attach / 盘上播种复用。 */
function sessionFileWithUserMessages(
  texts: ReadonlyArray<string>,
  overrides?: { readonly id?: string; readonly updatedAt?: string }
): SessionFileV1 {
  const messages: AnthropicNativeMessage[] = [];
  for (const t of texts) {
    messages.push({ role: "user", content: [{ type: "text", text: t }] });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "答" }],
    });
  }
  return {
    schemaVersion: 3,
    conversation_id: overrides?.id ?? "conv-hist-seed",
    messages,
    jsonMode: false,
    turnCount: texts.length,
    updatedAt: overrides?.updatedAt ?? "2026-08-11T00:00:00.000Z",
    title: texts[0] ?? "",
    cwd: "",
    sanitized_at: "2026-08-11T00:00:00.000Z",
    checkpoints: [],
  };
}

describe("T8 多行输入：提交后清空 + 历史召回保留多行", () => {
  test("Shift+Enter 换行 → Enter 提交 → 输入框清空 + 历史召回多行文本", async () => {
    const app = await mountAppAsync([
      assistantResult({ texts: ["multi-reply"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 输入两行（Shift+Enter 分隔）。
    await app.typeText("第一行");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.typeText("第二行");
    await app.pressEnter();

    // turn 落盘：title 含换行。
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "multi-turn");
    const list = await app.bridge.listSessions();
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe("第一行\n第二行");

    // 提交后输入框已清空：占位「输入消息」重新可见（提交前输入框是实际文本；
    // 注意消息流里会渲染用户消息全文，故不能用「第一行消失」作信号）。
    await untilFrame(app.setup, (f) => f.includes("输入消息"), 8000, "cleared");

    // 历史召回：↑ → 输入框占位消失（内容恢复完整多行文本）。
    await app.pressArrow("up");
    await untilFrame(
      app.setup,
      (f) => !f.includes("输入消息"),
      8000,
      "recall-multi"
    );

    await app.destroy();
  }, 30_000);
});

describe("#279 项5：TUI 输入历史 ↑/↓ 导航", () => {
  test("空历史 ↑/↓ no-op：不崩、不吞后续输入", async () => {
    const app = await mountAppAsync([
      assistantResult({ texts: ["fresh-reply"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 无历史：↑ ↓ 均 no-op → 输入框仍是占位符
    await app.pressArrow("up");
    await app.pressArrow("down");

    // 后续输入不被吞：正常提交一轮
    await app.typeText("after-noop");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "noop-turn");
    const list = await app.bridge.listSessions();
    expect(list).toBeDefined();
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe("after-noop");
    await app.destroy();
  }, 30_000);

  test("草稿 round-trip：↑ 不覆盖在写内容、↓ 越过最新条恢复草稿", async () => {
    const app = await mountAppAsync([
      assistantResult({ texts: ["draft-reply"] }),
    ]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    // 1) 种一条历史
    await app.typeText("hist-a");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "seed-turn");

    // 2) 输入半截草稿（不提交）
    await app.typeText("wip-draft");
    await new Promise((r) => setTimeout(r, 100));

    // 3) ↑ → 召回 "hist-a"
    await app.pressArrow("up");
    await untilFrame(app.setup, (f) => f.includes("hist-a"), 8000, "up-recall");

    // 4) ↓ → 越过最新条回输入现场：恢复草稿 "wip-draft"
    await app.pressArrow("down");
    await untilFrame(
      app.setup,
      (f) => f.includes("wip-draft"),
      8000,
      "down-restore-draft"
    );

    await app.destroy();
  }, 30_000);
});

describe("会话恢复种子：per-session 输入历史（initialSession / openSessionAt）", () => {
  test("resume：initialSession 恢复后 ↑ 直接召回最近一条 user 输入（修复前历史恒空）", async () => {
    const file = sessionFileWithUserMessages(["第一条", "第二条"]);
    const app = await mountAppAsync([assistantResult({ texts: ["r"] })], {
      initialSession: attachSession(file),
    });
    await untilFrame(app.setup, (f) => f.includes("Version"));
    // attach 后转录即含全部 user 消息。
    await untilFrame(app.setup, (f) => f.includes("第二条"));

    // ↑ → 输入框恢复「第二条」（最近一条）：占位消失 + 转录份之外多一份。
    // 修复前（无种子）：↑ no-op，占位恒在 → untilFrame 超时。
    await app.pressArrow("up");
    const frame = await untilFrame(
      app.setup,
      (f) => !f.includes("输入消息"),
      8000
    );
    expect(countOccurrences(frame, "第二条")).toBeGreaterThanOrEqual(2);

    // 再 ↑ → 「第一条」（种子按 turn 顺序可完整导航）。
    await app.pressArrow("up");
    const frame2 = await untilFrame(
      app.setup,
      (f) => countOccurrences(f, "第一条") >= 2,
      8000
    );
    expect(countOccurrences(frame2, "第一条")).toBeGreaterThanOrEqual(2);

    await app.destroy();
  }, 30_000);

  test("openSessionAt：/sessions 切到 B 后 ↑ 召回 B 的种子，A 的输入不泄漏", async () => {
    // 盘上只播种 B（A 仅内存 attach，不落盘）→ 列表唯一条目 = B，index 恒 1。
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-histswitch-"));
    const fileB = sessionFileWithUserMessages(["msg-b1", "msg-b2"], {
      id: "conv-hist-b",
    });
    const dir = resolveProjectSessionDir(dataDir, process.cwd());
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${fileB.conversation_id}.json`),
      JSON.stringify(fileB, null, 2),
      "utf8"
    );
    const fileA = sessionFileWithUserMessages(["msg-a1", "msg-a2"], {
      id: "conv-hist-a",
    });
    const app = await mountAppAsync([assistantResult({ texts: ["r"] })], {
      initialSession: attachSession(fileA),
      dataDir,
    });
    await untilFrame(app.setup, (f) => f.includes("msg-a2"));

    // /sessions → 列表（首行「+ 新建会话」，下一行 B）。
    await app.typeText("/sessions");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("新建会话") && f.includes("msg-b1")
    );

    // ↓ 选中 B（选中行 marker ">" 落到 B 的 title 上，状态可见后再按
    // Enter，避免「Enter 先于 ↓ 的渲染提交 → onOpen(0) 误开新会话」竞态）
    // → Enter → openSessionAt(1)：loadSessionFile + attach + 种子。
    await app.pressArrow("down");
    await untilFrame(app.setup, (f) => f.includes("> msg-b1"));
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("msg-b2"));

    // ↑ → 召回 B 最近一条「msg-b2」（转录 1 份 + 输入框 1 份）。
    // 修复前：切会话不种子 → ↑ no-op（占位恒在）→ untilFrame 超时。
    // 隔离断言：A 的输入（msg-a*）不得出现在帧内（若全局历史串户则会召回 A）。
    await app.pressArrow("up");
    const frame = await untilFrame(
      app.setup,
      (f) => !f.includes("输入消息"),
      8000
    );
    expect(countOccurrences(frame, "msg-b2")).toBeGreaterThanOrEqual(2);
    expect(frame).not.toContain("msg-a");

    await app.destroy();
  }, 30_000);
});

describe("Tab 补全接线：hint 选中项 + 三态 slashComplete（app.tsx onTabComplete）", () => {
  test("/ + ↓ + Tab → 按选中候选（index 1 = new）补全 /new（修复前死代码 no-op）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["r"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/");
    // 空前缀 → 全词表 hint（词表序 sessions, new, quit, …）。
    await untilFrame(
      app.setup,
      (f) => f.includes("/sessions") && f.includes("/quit")
    );

    // ↓ hint 游标 → index 1（new）；Tab → 补全选中项 "/new "，hint 收缩唯一。
    // 修复前（cursor>0 恒不可达）：slashComplete("/") → LCP 无进展 → null
    // → no-op，全词表 hint 不消失（帧内 /quit 恒在）→ untilFrame 超时。
    await app.pressArrow("down");
    await app.pressTab();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("/new") && !f.includes("/quit"),
      8000
    );
    // 输入框非空（占位消失），输入框 + hint 两份 /new。
    expect(frame).not.toContain("输入消息");
    expect(countOccurrences(frame, "/new")).toBeGreaterThanOrEqual(2);

    await app.destroy();
  }, 30_000);

  test("/q + Tab → /quit （唯一匹配补全回归护栏）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["r"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/q");
    // 唯一候选 quit：hint 1 份 /quit（输入框还是 /q）。
    await untilFrame(app.setup, (f) => countOccurrences(f, "/quit") === 1);

    await app.pressTab();
    // 补全 "/quit "：输入框多 1 份 → 共 2 份。
    await untilFrame(
      app.setup,
      (f) => countOccurrences(f, "/quit") === 2,
      8000
    );
    await app.destroy();
  }, 30_000);

  test("/e + Tab → no-op（effort/exit LCP 无进展；输入框与 hint 均不变）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["r"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/e");
    await untilFrame(
      app.setup,
      (f) =>
        f.includes("/effort") &&
        f.includes("/exit") &&
        countOccurrences(f, "/effort") === 1 &&
        countOccurrences(f, "/exit") === 1
    );

    await app.pressTab();
    const frame = app.setup.captureCharFrame();
    // no-op：输入框仍 "/e"（无补全串进输入框），hint 仍双候选。
    expect(countOccurrences(frame, "/effort")).toBe(1);
    expect(countOccurrences(frame, "/exit")).toBe(1);
    expect(frame).not.toContain("输入消息");

    await app.destroy();
  }, 30_000);
});

describe("提交追加回归护栏（appendInputHistory 接线后行为不变）", () => {
  test("hello 提交后 ↑ 召回 hello（转录份 + 输入框份）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["r"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("hello");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "hello-turn");
    await untilFrame(app.setup, (f) => f.includes("输入消息"), 8000);

    await app.pressArrow("up");
    const frame = await untilFrame(
      app.setup,
      (f) => !f.includes("输入消息"),
      8000
    );
    expect(countOccurrences(frame, "hello")).toBeGreaterThanOrEqual(2);

    await app.destroy();
  }, 30_000);
});
