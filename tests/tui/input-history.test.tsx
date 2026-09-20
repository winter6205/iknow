/** @jsxImportSource @opentui/react */
/**
 * tests/tui/input-history.test.tsx
 *
 * Regression tests for TUI input-history ↑/↓ navigation.
 *
 * Coverage:
 *  1) empty history: ↑/↓ no-op (no crash, no swallowed input);
 *  2) ↑ recall / ↓ past-the-newest restores the live draft (draft round-trip);
 *  3) while hint candidates are visible, ↑/↓ drive the hint cursor (hint wins);
 *  4) consecutive-duplicate dedup (submitting the same text twice enters history once).
 *  5) session-resume seeding: after initialSession restore / /sessions
 *     openSessionAt switch, ↑ works immediately (transcript projection
 *     seedInputHistory), and history is per-session isolated (A's submits
 *     never leak into B's ↑ history);
 *  6) Tab completion wiring: hint cursor on a non-first candidate + Tab →
 *     completes with the selected item (app.tsx onTabComplete cursor>0
 *     branch — the old length===1 && cursor===0 condition was unreachable
 *     dead code); regression guards for /q unique match and /e LCP
 *     no-progress no-op;
 *  7) submit-append regression guard (appendInputHistory behavior unchanged after wiring).
 *
 * Assembly: mountAppAsync + stub deps (same pattern as app.test.tsx).
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
import {
  resolveConversationDir,
  resolveProjectSessionDir,
} from "../../src/session-api/store/session-store.js";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.js";
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
    /** Session resume (equivalent to `iknow tui <id>`): attach at mount, no fresh draft. */
    readonly initialSession?: TuiSessionState;
    /** Reuse an external dataDir (the openSessionAt case seeds session files on disk first). */
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
      // Shift+Enter must carry the shift modifier (kitty protocol encodes [13;2u).
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

/** Occurrences of a substring in the frame (separates transcript copies from the input-box copy, as in keyboard.test.tsx). */
function countOccurrences(frame: string, needle: string): number {
  let count = 0;
  let idx = frame.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = frame.indexOf(needle, idx + 1);
  }
  return count;
}

/** Minimal valid SessionFileV1 (a user/assistant pair forms a turn; same required-field set as sampleFile in
 *  rewind.test.tsx), reused for initialSession attach / on-disk seeding. */
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

    // Type two lines (Shift+Enter as separator).
    await app.typeText("第一行");
    app.setup.mockInput.pressEnter({ shift: true });
    await new Promise((r) => setTimeout(r, 100));
    await app.setup.renderOnce();
    await app.typeText("第二行");
    await app.pressEnter();

    // Turn persisted: title contains the newline.
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "multi-turn");
    const list = await app.bridge.listSessions();
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe("第一行\n第二行");

    // After submit the input box is cleared: the `输入消息` ("type a message")
    // placeholder reappears (before submit the box holds real text; note the
    // message stream renders the full user text too, so "first line gone" is
    // not a usable signal).
    await untilFrame(app.setup, (f) => f.includes("输入消息"), 8000, "cleared");

    // History recall: ↑ → placeholder disappears (full multi-line text restored).
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

    // No history: ↑ and ↓ are both no-ops → input box still shows the placeholder
    await app.pressArrow("up");
    await app.pressArrow("down");

    // Later input is not swallowed: a full turn submits normally
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

    // 1) seed one history entry
    await app.typeText("hist-a");
    await app.pressEnter();
    await until(() => app.bridge.inflight.ids().size === 0, 8000, "seed-turn");

    // 2) type a partial draft (never submitted)
    await app.typeText("wip-draft");
    await new Promise((r) => setTimeout(r, 100));

    // 3) ↑ → recalls "hist-a"
    await app.pressArrow("up");
    await untilFrame(app.setup, (f) => f.includes("hist-a"), 8000, "up-recall");

    // 4) ↓ → past the newest entry, back to the draft: "wip-draft" restored
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
    // After attach the transcript already holds all user messages.
    await untilFrame(app.setup, (f) => f.includes("第二条"));

    // ↑ → input box restores "第二条" (the most recent): placeholder gone, plus
    // one extra copy beyond the transcript copy.
    // Before the fix (no seeding): ↑ was a no-op, placeholder always present → untilFrame times out.
    await app.pressArrow("up");
    const frame = await untilFrame(
      app.setup,
      (f) => !f.includes("输入消息"),
      8000
    );
    expect(countOccurrences(frame, "第二条")).toBeGreaterThanOrEqual(2);

    // ↑ again → "第一条" (seeding is in turn order, so navigation is complete).
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
    // Seed only B on disk (A is an in-memory attach, never persisted) → B is
    // the list's sole entry, index always 1.
    // The bridge derives its root via `deriveProjectIdentityRoot({cwd: dataDir})`,
    // so the seed must live under the same projectDir in the `<convId>/` folder.
    const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-histswitch-"));
    const fileB = sessionFileWithUserMessages(["msg-b1", "msg-b2"], {
      id: "conv-hist-b",
    });
    const projectDir = resolveProjectSessionDir(
      dataDir,
      deriveProjectIdentityRoot({ cwd: dataDir })
    );
    const dir = resolveConversationDir({
      projectDir,
      conversationId: fileB.conversation_id,
    });
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

    // /sessions → list (first row `+ 新建会话` "new session", next row B).
    await app.typeText("/sessions");
    await app.pressEnter();
    await untilFrame(
      app.setup,
      (f) => f.includes("新建会话") && f.includes("msg-b1")
    );

    // ↓ selects B (wait until the ">" row marker visibly lands on B's title
    // before pressing Enter, to avoid the race where Enter arrives before ↓
    // renders and onOpen(0) wrongly opens a new session)
    // → Enter → openSessionAt(1): loadSessionFile + attach + seeding.
    await app.pressArrow("down");
    await untilFrame(app.setup, (f) => f.includes("> msg-b1"));
    await app.pressEnter();
    await untilFrame(app.setup, (f) => f.includes("msg-b2"));

    // ↑ → recalls B's latest entry "msg-b2" (one transcript copy + one input-box copy).
    // Before the fix: switching sessions did not seed → ↑ no-op (placeholder stays) → untilFrame timeout.
    // Isolation assert: A's input (msg-a*) must not appear in the frame
    // (a shared global history would recall A instead).
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
    // Empty prefix → full vocabulary hint (order: sessions, new, quit, …).
    await untilFrame(
      app.setup,
      (f) => f.includes("/sessions") && f.includes("/quit")
    );

    // ↓ moves the hint cursor → index 1 (new); Tab completes the input to "/new ".
    // After completion "/new " is exact + remainder (space) → hint fully hidden
    // (its disambiguation job is done), so only the input-box copy of /new remains.
    await app.pressArrow("down");
    await app.pressTab();
    const frame = await untilFrame(
      app.setup,
      (f) => f.includes("/new") && !f.includes("/quit"),
      8000
    );
    // Input box is non-empty (placeholder gone) and the hint is hidden → exactly 1 /new in the frame.
    expect(frame).not.toContain("输入消息");
    expect(countOccurrences(frame, "/new")).toBe(1);

    await app.destroy();
  }, 30_000);

  test("/q + Tab → /quit （唯一匹配补全回归护栏）", async () => {
    const app = await mountAppAsync([assistantResult({ texts: ["r"] })]);
    await untilFrame(app.setup, (f) => f.includes("Version"));

    await app.typeText("/q");
    // Sole candidate quit: hint shows one /quit (input box still /q).
    await untilFrame(app.setup, (f) => countOccurrences(f, "/quit") === 1);

    await app.pressTab();
    // Completes "/quit ": exact + trailing space = committed remainder →
    // hint fully hidden, only the input-box copy of /quit remains.
    await untilFrame(
      app.setup,
      (f) => f.includes("/quit ") && countOccurrences(f, "/quit") === 1,
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
    // no-op: input box still "/e" (no completion text inserted), hint still shows both candidates.
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
