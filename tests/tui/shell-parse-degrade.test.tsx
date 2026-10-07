/** @jsxImportSource @opentui/react */
/**
 * tests/tui/shell-parse-degrade.test.tsx
 *
 * The on-screen half of ADR-0124 §6's only degrade path (「降级不许静默」):
 * while `parseFoundationState()` reports UNAVAILABLE, the input-box area of
 * `TuiApp` carries exactly one red row with the pinned copy
 * `shell 解析器不可用，已降级到旧扫描：判定仍生效（详见日志）`,
 * and while it reports UNINITIALIZED or READY it carries nothing of it.
 *
 * Two routes drive the getter here, and the difference matters:
 *  - the stubbed route (`mock.module` on the state getter) is the only way to
 *    show READY and UNAVAILABLE in one process, because a load that never
 *    succeeded is terminal and a load that succeeded can never degrade again;
 *  - the real route (an injected loader that throws, plus one call through the
 *    seam) is what proves the arm follows the actual state machine rather than
 *    a test double.
 * `bun test` runs every file in this directory in ONE process against ONE module
 * registry (measured: a file that reaches READY leaves a later file reading
 * READY), so the last case hands the remaining files back an undegraded getter
 * — otherwise this file's red row would be painted onto every later frame
 * assertion in tests/tui/.
 */
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { CapturedFrame } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import * as shellParse from "../../src/harness/permission/shell-parse.js";
import type { ParseFoundationState } from "../../src/harness/permission/shell-parse.js";

const SHELL_PARSE_MODULE = "../../src/harness/permission/shell-parse.js";
const DEGRADE_COPY =
  "shell 解析器不可用，已降级到旧扫描：判定仍生效（详见日志）";
const DEGRADE_MARKER = "解析器不可用";
const PLACEHOLDER_MARKER = "输入消息";
const MODE_MARKER = "mode:";
const BANNER_MARKER = "Version";

/** Frame wait: rendering settles asynchronously; poll renderOnce. */
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

function fakeBridge(): TuiBridge {
  const inflight = createInflightRegistry();
  const file: SessionFileV1 = {
    schemaVersion: 3,
    conversation_id: "conv-degrade-notice",
    title: "",
    cwd: "/tmp/proj",
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
  };
  return {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-degrade-notice",
    postMessage: async () => {
      throw new Error("postMessage unused in degrade-notice tests");
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    compactSession: async () => ({
      compacted: false,
      // stub never compacts: the no-compaction arm of CompactReason.
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("continueSession unused in degrade-notice tests");
    },
    rewindSession: async (_id, _head) => ({ file }),
    listRewindTargets: async () => [],
    inflight,
    contextWindow: 200_000,
    listSubagents: () => [],
    abortSessionForegroundWork: () => [],
    abortSubagentTask: () => false,
    openSession: async () => {
      throw new Error("unused: no session is opened here");
    },
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async () => undefined,
  };
}

interface MountedApp {
  readonly setup: TestRendererSetup;
  readonly frame: () => Promise<string>;
  readonly spans: () => Promise<CapturedFrame>;
  readonly destroy: () => Promise<void>;
}

async function mountApp(): Promise<MountedApp> {
  const setup = await testRender(
    <TuiApp
      bridge={fakeBridge()}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={mkdtempSync(join(tmpdir(), "iknow-tui-degrade-"))}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      onQuit={() => {
        if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      }}
    />,
    { width: 80, height: 30, exitOnCtrlC: false, consoleMode: "disabled" }
  );
  await new Promise((r) => setTimeout(r, 400));
  await setup.waitForVisualIdle();
  await untilFrame(setup, (f) => f.includes(BANNER_MARKER));
  return {
    setup,
    frame: async () => {
      await setup.renderOnce();
      return setup.captureCharFrame();
    },
    spans: async () => {
      await setup.renderOnce();
      return setup.captureSpans();
    },
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
  };
}

/**
 * Drives the getter the arm reads, leaving every other export of the module in
 * place. Needed for the states the real terminal machine cannot show twice in
 * one process (READY and UNAVAILABLE exclude each other).
 */
function stubFoundationState(state: ParseFoundationState): void {
  mock.module(SHELL_PARSE_MODULE, () => ({
    ...shellParse,
    parseFoundationState: () => state,
  }));
}

/** Hands the module namespace back to the real implementation. */
function realModuleSurface(): void {
  mock.module(SHELL_PARSE_MODULE, () => ({ ...shellParse }));
}

function rowIndexes(frame: string, needle: string): number[] {
  return frame
    .split("\n")
    .map((row, index) => (row.includes(needle) ? index : -1))
    .filter((index) => index >= 0);
}

/** The notice must be added, never to the detriment of the chrome around it. */
function assertSurroundingChromeIntact(frame: string): void {
  expect(frame).toContain(BANNER_MARKER);
  expect(frame).toContain(MODE_MARKER);
  expect(frame).toContain(PLACEHOLDER_MARKER);
}

/** One row carries the copy, and nothing else on screen repeats its wording. */
function assertExactlyOneDegradeRow(frame: string): void {
  expect(rowIndexes(frame, DEGRADE_COPY)).toHaveLength(1);
  expect(rowIndexes(frame, DEGRADE_MARKER)).toHaveLength(1);
  assertSurroundingChromeIntact(frame);
}

/** captureSpans reports channel values normalized to 0-1. */
function redDominant(color: { r: number; g: number; b: number }): boolean {
  return color.r > 0.5 && color.r - color.g > 0.2 && color.r - color.b > 0.2;
}

function redWidthShare(spans: CapturedFrame, rowIndex: number): number {
  const painted = (spans.lines[rowIndex]?.spans ?? []).filter(
    (span) => span.text.trim().length > 0
  );
  if (painted.length === 0) return 0;
  const totalWidth = painted.reduce((sum, span) => sum + span.width, 0);
  const redWidth = painted
    .filter((span) => redDominant(span.fg))
    .reduce((sum, span) => sum + span.width, 0);
  return totalWidth === 0 ? 0 : redWidth / totalWidth;
}

describe("TUI degrade notice", () => {
  test("renders nothing of the notice before the foundation has degraded", async () => {
    const state = shellParse.parseFoundationState();
    expect(state).not.toBe("UNAVAILABLE");
    expect(state).toBe("UNINITIALIZED");

    const app = await mountApp();
    const frame = await app.frame();

    expect(frame).not.toContain(DEGRADE_COPY);
    expect(frame).not.toContain(DEGRADE_MARKER);
    assertSurroundingChromeIntact(frame);
    await app.destroy();
  });

  test("renders nothing of the notice while the parser answers from the foundation", async () => {
    stubFoundationState("READY");
    try {
      expect(shellParse.parseFoundationState()).toBe("READY");
      const app = await mountApp();
      const frame = await app.frame();

      expect(frame).not.toContain(DEGRADE_COPY);
      expect(frame).not.toContain(DEGRADE_MARKER);
      assertSurroundingChromeIntact(frame);
      await app.destroy();
    } finally {
      realModuleSurface();
    }
  });

  test("renders the pinned copy as one red row in the input-box area while the getter reports UNAVAILABLE", async () => {
    stubFoundationState("UNAVAILABLE");
    let app: MountedApp | undefined;
    try {
      expect(shellParse.parseFoundationState()).toBe("UNAVAILABLE");
      app = await mountApp();
      const frame = await untilFrame(app.setup, (f) =>
        f.includes(DEGRADE_COPY)
      );

      assertExactlyOneDegradeRow(frame);
      const noticeRow = rowIndexes(frame, DEGRADE_COPY)[0];
      const modeRow = rowIndexes(frame, MODE_MARKER)[0];
      const placeholderRow = rowIndexes(frame, PLACEHOLDER_MARKER)[0];
      // The row belongs to the input box, not to the transcript: below the
      // status row and within the prompt's own rows, above or below the box.
      expect(noticeRow).toBeGreaterThan(modeRow);
      expect(Math.abs(noticeRow - placeholderRow)).toBeLessThanOrEqual(3);

      const spans = await app.spans();
      expect(redWidthShare(spans, noticeRow)).toBeGreaterThanOrEqual(0.6);
    } finally {
      await app?.destroy();
      realModuleSurface();
    }
  }, 30_000);

  test("follows the real state machine: a load that never succeeds degrades the getter and the row appears with no stub in place", async () => {
    realModuleSurface();
    const seam = (shellParse as unknown as Readonly<Record<string, unknown>>)
      .scanWithLegacyDegrade as
      | ((
          command: string,
          legacyScan: (command: string) => null
        ) => { readonly kind: string })
      | undefined;
    if (typeof seam !== "function") {
      throw new Error(
        "shell-parse.ts exports no scanWithLegacyDegrade to drive the transition"
      );
    }

    shellParse.setBindingLoaderForTest(() => {
      throw new Error("no prebuild for this host");
    });
    let app: MountedApp | undefined;
    try {
      const outcome = seam("echo degrade-tui-probe", () => null);

      expect(outcome.kind).toBe("legacy-clean");
      expect(shellParse.parseFoundationState()).toBe("UNAVAILABLE");

      app = await mountApp();
      const frame = await untilFrame(app.setup, (f) =>
        f.includes(DEGRADE_COPY)
      );
      assertExactlyOneDegradeRow(frame);
    } finally {
      await app?.destroy();
      shellParse.setBindingLoaderForTest(null);
    }
  }, 30_000);

  test("hands the rest of the run an undegraded getter, so no later file paints the notice", async () => {
    // The transition above is process-terminal (`UNAVAILABLE 为进程内终态、
    // 不重试`) and bun shares one module registry across files, so the only way
    // to leave the remaining tests/tui files untouched is to hand them back a
    // getter reporting the state this run never entered.
    stubFoundationState("UNINITIALIZED");

    const app = await mountApp();
    const frame = await app.frame();

    expect(frame).not.toContain(DEGRADE_MARKER);
    assertSurroundingChromeIntact(frame);
    await app.destroy();
  });
});
