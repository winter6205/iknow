/** @jsxImportSource @opentui/react */
/**
 * tests/tui/rewind-confirm-flow.test.tsx — app wiring for the three-action
 * confirm (specs/code-restore.md, SC "Picker confirm content lists the three
 * actions; the execute action carries the boolean the hub receives").
 *
 * Layering: tests/tui/rewind.test.ts owns the reducer's pure key→action
 * decisions and the bridge's flag forwarding; this file pins the chain
 * keystroke → confirm-row state → `bridge.rewindSession(id, head, restoreCode)`,
 * i.e. that ↑/↓ really moves the action row, that the executed row's boolean is
 * what the hub receives, that the restore report reaches the operator, and how a
 * typed hub failure renders. The fake bridge only replaces outlets with a call log
 * (same shape as tests/tui/esc-session-foreground.test.tsx); workspace bytes are
 * pinned by tests/session-api/store/code-preimage.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import type { TuiBridge } from "../../src/tui/hub-bridge.js";
import { createInflightRegistry } from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { createDraftSession } from "../../src/tui/session-state.js";
import type { RewindCodeRestoreResult } from "../../src/session-api/contract.js";
import type { LedgerRewindTarget } from "../../src/session-api/store/index.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";

const COLS = 90;
const ROWS = 34;
const CONVERSATION_ID = "conv-3action";

function anchor(head: string | null, text: string): LedgerRewindTarget {
  return {
    head,
    userMessageText: text,
    fullText: text,
    anchoredAt: "2026-09-17T00:00:00.000Z",
    // The anchor refill is the picker's other outlet; off here keeps the notice
    // the only thing a key press can change.
    fillInput: false,
    anchorTurnIndex: head === null ? 0 : 1,
  };
}

function makeFile(dataDir: string): SessionFileV1 {
  return {
    id: CONVERSATION_ID,
    workspaceRoot: dataDir,
    messages: [],
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    turnCount: 0,
    jsonMode: false,
    lastUsage: null,
  };
}

interface Rig {
  readonly setup: TestRendererSetup;
  /** What the hub would receive, in call order. */
  readonly rewindCalls: Array<{
    readonly head: string | null;
    readonly restoreCode: boolean;
  }>;
  readonly typeText: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressArrow: (dir: "up" | "down") => Promise<void>;
  readonly pressEscape: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

async function settle(setup: TestRendererSetup): Promise<void> {
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
}

async function untilFrame(
  setup: TestRendererSetup,
  pred: (frame: string) => boolean,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 50));
    await setup.renderOnce();
    if (pred(setup.captureCharFrame())) return;
  }
  throw new Error(`untilFrame timeout: ${label}\n${setup.captureCharFrame()}`);
}

/** `report` = the hub's answer to a restore-code rewind, injected so the notice
 *  text can be pinned without a real workspace. `rejection` = what the hub throws
 *  instead of answering, for the failure-render path. */
async function mountApp(
  report?: RewindCodeRestoreResult,
  rejection?: unknown
): Promise<Rig> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-rewind-3action-"));
  const file = makeFile(dataDir);
  const rewindCalls: Rig["rewindCalls"] = [];
  const bridge: TuiBridge = {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? CONVERSATION_ID,
    postMessage: async () => {
      throw new Error("unused: no turn is started here");
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("unused");
    },
    rewindSession: async (_id, head, restoreCode) => {
      rewindCalls.push({ head, restoreCode });
      if (rejection !== undefined) throw rejection;
      return report === undefined ? { file } : { file, codeRestore: report };
    },
    listRewindTargets: async () => [anchor("e1", "q2"), anchor(null, "q1")],
    inflight: createInflightRegistry(),
    contextWindow: 200_000,
    listSubagents: () => [],
    abortSubagentTask: () => true,
    abortSessionForegroundWork: () => [],
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async () => undefined,
  };
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      initialSession={Object.freeze({
        ...createDraftSession(),
        conversationId: CONVERSATION_ID,
      })}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  setupRef = setup;
  await setup.waitForVisualIdle();

  return {
    setup,
    rewindCalls,
    typeText: async (text) => {
      for (const ch of text) {
        setup.mockInput.pressKey(ch);
        await settle(setup);
      }
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await settle(setup);
    },
    pressArrow: async (dir) => {
      setup.mockInput.pressArrow(dir);
      await settle(setup);
    },
    pressEscape: async () => {
      setup.mockInput.pressEscape();
      await settle(setup);
    },
    dispose: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
  };
}

async function openPicker(rig: Rig): Promise<void> {
  await rig.typeText("/rewind");
  await rig.pressEnter();
  await untilFrame(
    rig.setup,
    (f) => f.includes("回退到更早的回合"),
    "锚点列表"
  );
}

async function enterConfirm(rig: Rig): Promise<void> {
  await rig.pressEnter();
  await untilFrame(rig.setup, (f) => f.includes("确认回退？"), "确认态");
}

describe("回退确认三动作（app 层按键 → bridge 调用）", () => {
  test("确认态屏上列出三个动作", async () => {
    const rig = await mountApp();
    try {
      await openPicker(rig);
      await enterConfirm(rig);
      const frame = rig.setup.captureCharFrame();
      expect(frame).toContain("回退对话并恢复代码");
      expect(frame).toContain("仅回退对话");
      expect(frame).toContain("取消");
      expect(rig.rewindCalls).toEqual([]);
    } finally {
      await rig.dispose();
    }
  }, 30_000);

  test("↑/↓ 移动动作行：第二行 Enter → hub 收到 restoreCode=false", async () => {
    const rig = await mountApp();
    try {
      await openPicker(rig);
      await enterConfirm(rig);
      await rig.pressArrow("down");
      await rig.pressEnter();
      await untilFrame(
        rig.setup,
        () => rig.rewindCalls.length === 1,
        "rewindSession 未被调用"
      );
      expect(rig.rewindCalls).toEqual([{ head: "e1", restoreCode: false }]);
      // A transcript-only rewind gets no report, so the notice stays the plain one.
      const frame = rig.setup.captureCharFrame();
      expect(frame).toContain("已回退到");
      expect(frame).not.toContain("代码恢复");
    } finally {
      await rig.dispose();
    }
  }, 30_000);

  test("首行 Enter → restoreCode=true，hub 报告写进 notice", async () => {
    const rig = await mountApp({
      restored: ["src/a.ts"],
      skipped: [{ relPath: "src/b.ts", reason: "drift" }],
    });
    try {
      await openPicker(rig);
      await enterConfirm(rig);
      await rig.pressEnter();
      await untilFrame(
        rig.setup,
        () => rig.rewindCalls.length === 1,
        "rewindSession 未被调用"
      );
      expect(rig.rewindCalls).toEqual([{ head: "e1", restoreCode: true }]);
      await untilFrame(
        rig.setup,
        (f) => f.includes("代码恢复") && f.includes("文件已被后续改动"),
        `恢复报告未上报：\n${rig.setup.captureCharFrame()}`
      );
    } finally {
      await rig.dispose();
    }
  }, 30_000);

  test("取消行 Enter 与确认态 Esc 都不回退，并关掉选择器", async () => {
    const rig = await mountApp();
    try {
      await openPicker(rig);
      await enterConfirm(rig);
      await rig.pressArrow("down");
      await rig.pressArrow("down");
      await rig.pressEnter();
      await untilFrame(
        rig.setup,
        (f) => !f.includes("确认回退？") && !f.includes("回退到更早的回合"),
        "取消后选择器仍开"
      );
      expect(rig.rewindCalls).toEqual([]);

      // Esc from the confirm step is the same action, not a hidden fourth one.
      await openPicker(rig);
      await enterConfirm(rig);
      await rig.pressEscape();
      await untilFrame(
        rig.setup,
        (f) => !f.includes("确认回退？") && !f.includes("回退到更早的回合"),
        "Esc 后选择器仍开"
      );
      expect(rig.rewindCalls).toEqual([]);
    } finally {
      await rig.dispose();
    }
  }, 30_000);

  test("typed hub failure renders kind + blob address, never [object Object]", async () => {
    // The preimage store throws a PLAIN typed object, so the generic
    // `err.message` path would print [object Object] and hide both the kind
    // and the content address the operator needs.
    const rig = await mountApp(undefined, {
      kind: "code_snapshot_missing",
      sha: "ab".repeat(32),
    });
    try {
      await openPicker(rig);
      await enterConfirm(rig);
      await rig.pressEnter();
      await untilFrame(
        rig.setup,
        (f) => f.includes("code_snapshot_missing"),
        `typed error 未按 kind 渲染：\n${rig.setup.captureCharFrame()}`
      );
      const frame = rig.setup.captureCharFrame();
      expect(frame).toContain("回退失败");
      expect(frame).toContain("会话存储错误 [code_snapshot_missing]");
      // The 90-col notice wraps, so the address is matched on its own run of
      // hex rather than as one continuous "blob <sha>" token.
      expect(frame).toContain("blob");
      expect(frame).toContain("abababababababab");
      expect(frame).not.toContain("[object Object]");
    } finally {
      await rig.dispose();
    }
  }, 30_000);
});
