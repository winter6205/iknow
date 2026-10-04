/** @jsxImportSource @opentui/react */
/**
 * tests/tui/session-recovery-open.test.tsx (bun:test)
 *
 * The in-app session-ENTRY surface: selecting a session in the picker runs
 * recovery and puts the status in the EXISTING sticky notice lane (no new UI
 * system), with the `RECOVERY_IN_PROGRESS_LABEL` transient visible while the
 * entry promise is in flight.
 *
 * Real store / real published body / real workspace file; the only test harness
 * is the OpenTUI renderer, and the model boundary is the stub deps object
 * (`makeDeps([])` throws on any model request).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.js";
import { captureCodeSnapshot } from "../../src/session-api/store/code-snapshot-store.js";
import {
  NATIVE_STATE_FORMAT_VERSION,
  resolveConversationDir,
  resolveProjectSessionDir,
  RECOVERY_IN_PROGRESS_LABEL,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/session-api/store/schema.js";
import type { NativeStateMessage } from "../../src/shared/native-state-port.js";
import { makeDeps } from "../cli/_fixtures.ts";

// Explicit return types (not `as const`): the transpiler drops the `text` key
// from a mixed literal of that shape, which the store then rejects.
const text = (t: string): { readonly type: "text"; readonly text: string } => ({
  type: "text",
  text: t,
});
const userMsg = (t: string): NativeStateMessage => ({
  role: "user",
  content: [text(t)],
});
const assistantMsg = (t: string): NativeStateMessage => ({
  role: "assistant",
  content: [text(t)],
});
const toolUseMsg = (id: string): NativeStateMessage => ({
  role: "assistant",
  content: [
    {
      type: "tool_use" as const,
      id,
      name: "write_file",
      input: { file_path: "a.ts" },
    },
  ],
});

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

const sampleFile = (id: string, taskRoot: string): SessionFileV1 =>
  ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: `session ${id}`,
    cwd: taskRoot,
    sanitized_at: new Date().toISOString(),
    messages: [userMsg("seeded-q"), assistantMsg("seeded-a")],
    jsonMode: false,
    turnCount: 1,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
    nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
  }) as SessionFileV1;

interface Fixture {
  readonly dataDir: string;
  readonly taskRoot: string;
  readonly bridge: TuiBridge;
  readonly cleanup: () => Promise<void>;
}

/** One listable session whose recovery classifies as `needs handling`: the
 *  abnormal exit of a write whose tool result was never recorded. */
async function seedNeedsHandling(id: string): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "iknow-tui-open-"));
  const taskRoot = await mkdtemp(join(tmpdir(), "iknow-tui-open-root-"));
  const projectDir = resolveProjectSessionDir(
    dataDir,
    deriveProjectIdentityRoot({ cwd: taskRoot })
  );
  const store = new SessionStore(dataDir, taskRoot);
  const sessionFolder = resolveConversationDir({
    projectDir,
    conversationId: id,
  });
  await store.save({ id, file: sampleFile(id, taskRoot) });
  await store.appendNativeState({
    id,
    anchorEventId: "e1",
    boundary: "input",
    snapshot: { boundary: "input", messages: [userMsg("seeded-q")] },
  });
  // A trailing assistant TEXT message keeps the session listable: the picker
  // filters on `lastAssistantText`, and a trailing tool_use reads as no text.
  await store.appendEvents({
    id,
    events: [toolUseMsg("t-write"), assistantMsg("seeded-a2")],
  });
  await store.appendFileIntent({
    id,
    toolUseId: "t-write",
    captured: true,
    targets: [
      {
        relPath: "a.ts",
        rootIdentity: deriveProjectIdentityRoot({ cwd: taskRoot }),
        absentBefore: false,
        preimageSha: await captureCodeSnapshot(sessionFolder, "OLD BYTES"),
        postimageSha: await captureCodeSnapshot(sessionFolder, "NEW BYTES"),
      },
    ],
  });
  await writeFile(join(taskRoot, "a.ts"), "NEW BYTES", "utf8");
  return {
    dataDir,
    taskRoot,
    bridge: createTuiBridge({
      dataDir,
      workspaceRoot: taskRoot,
      deps: makeDeps([]),
      inflight: createInflightRegistry(),
    }),
    cleanup: async () => {
      await rm(dataDir, { recursive: true, force: true });
      await rm(taskRoot, { recursive: true, force: true });
    },
  };
}

async function mountApp(bridge: TuiBridge, dataDir: string) {
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      cwd={dataDir}
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      onQuit={() => {
        if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      }}
    />,
    {
      width: 100,
      height: 40,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      kittyKeyboard: true,
    }
  );
  await new Promise((r) => setTimeout(r, 300));
  await setup.waitForVisualIdle();
  return setup;
}

const key = async (
  setup: TestRendererSetup,
  press: () => void
): Promise<void> => {
  press();
  await new Promise((r) => setTimeout(r, 100));
  await setup.renderOnce();
};

const typeSlashSessions = async (setup: TestRendererSetup): Promise<void> => {
  for (const ch of "/sessions") {
    setup.mockInput.pressKey(ch);
    await new Promise((r) => setTimeout(r, 30));
  }
  await key(setup, () => setup.mockInput.pressEnter());
};

/** `/sessions` → ↓ onto the seeded session → Enter (openSessionAt). The list
 *  renders titles, so the wait keys on the seeded title. */
const pickSeededSession = async (
  setup: TestRendererSetup,
  title: string
): Promise<void> => {
  await typeSlashSessions(setup);
  // The picker opens before its async list lands; ↓ pressed in that window is
  // clamped away, so let the list render before moving the row cursor.
  await new Promise((r) => setTimeout(r, 300));
  await untilFrame(setup, (f) => f.includes(title));
  await key(setup, () => setup.mockInput.pressArrow("down"));
  // Wait until the row marker visibly leaves the new-session row, so Enter
  // cannot land before ↓ has been applied.
  await untilFrame(setup, (f) => !f.includes("> + 新建会话"));
  await key(setup, () => setup.mockInput.pressEnter());
};

describe("in-app session open surfaces the recovery status", () => {
  test("the settled open names the affected file in the notice lane", async () => {
    const id = "tui-open-handling";
    const fx = await seedNeedsHandling(id);
    const setup = await mountApp(fx.bridge, fx.dataDir);
    try {
      await untilFrame(setup, (f) => f.includes("Version"));
      await pickSeededSession(setup, `session ${id}`);
      const frame = await untilFrame(setup, (f) =>
        f.includes("Recovery needs")
      );
      expect(frame).toContain("a.ts");
      expect(frame).toContain("tool_outcome_unknown");
      // Fail closed on the mutation side: the crash's bytes survive.
      expect(await readFile(join(fx.taskRoot, "a.ts"), "utf8")).toBe(
        "NEW BYTES"
      );
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      await fx.cleanup();
    }
  }, 60_000);

  test("the in-flight label is visible while the entry promise is pending", async () => {
    const id = "tui-open-inflight";
    const fx = await seedNeedsHandling(id);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realOpen = fx.bridge.openSession;
    const held: TuiBridge = {
      ...fx.bridge,
      openSession: async (cid) => {
        await gate;
        return realOpen(cid);
      },
    };
    const setup = await mountApp(held, fx.dataDir);
    try {
      await untilFrame(setup, (f) => f.includes("Version"));
      await pickSeededSession(setup, `session ${id}`);
      const frame = await untilFrame(setup, (f) =>
        f.includes(RECOVERY_IN_PROGRESS_LABEL)
      );
      expect(frame).toContain("recovery in progress");
    } finally {
      release?.();
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      await fx.cleanup();
    }
  }, 60_000);
});
