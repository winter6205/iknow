/** @jsxImportSource @opentui/react */
/**
 * tests/tui/composer-draft-restore.test.tsx
 *
 * A rejected submit hands the draft back (src/tui/app.tsx): the composer buffer
 * and the folded payload table are spent only once the turn is accepted, so
 * every failure before the accepted user message leaves the user's input — and
 * an unrecoverable clipboard image payload — where it was.
 *
 * A second submit while that turn is still in flight is not one of those
 * failures. It stays queued, the composer stays empty, and the bridge sees
 * only the running turn.
 *
 * Asserted at the two observable boundaries, never through internals: what
 * crosses `bridge.postMessage` and what the composer's live buffer holds. A
 * restored label is proven *live* (Ctrl+G unfolds it; re-submitting sends the
 * same ordered blocks), because text alone would also come back from a copy of
 * the string. A rejection that may already have committed must NOT come back —
 * that is the no-duplicate rule, asserted explicitly.
 *
 * The rejection classes are the hub's own: `ValidationError` is what every
 * pre-accept throw site uses; a provider failure arrives as an Error carrying
 * the HTTP status. The clipboard reader is stubbed at its prop seam, the same
 * precedent as tests/tui/composer-clipboard-image.test.tsx.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  TuiApp,
  createToolEventSink,
  type ClipboardImageReader,
} from "../../src/tui/app.js";
import {
  createInflightRegistry,
  type TuiBridge,
  type TuiPostResult,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { ValidationError } from "../../src/shared/errors.js";
import type {
  ClipboardImageResult,
  ReadClipboardImageOptions,
} from "../../src/tui/clipboard-image.js";
import { PASTE_IMAGE_PROBE_TIMEOUT_MS } from "../../src/tui/clipboard-image.js";
import type { UserContentBlock } from "../../src/session-api/contract.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import { createSkillCatalog } from "../../src/harness/skill/catalog.js";
import type { SkillCatalog } from "../../src/harness/skill/catalog.js";
import { composerText } from "./_fixtures.js";

const COLS = 80;
const ROWS = 30;
const CONVERSATION_ID = "conv-restore";

/** Synthetic PNG-shaped payload, base64 as the clipboard reader hands it back. */
const PNG_A = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 0x41),
]).toString("base64");

function imageBlock(data: string): UserContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

const OK_A: ClipboardImageResult = {
  kind: "ok",
  mediaType: "image/png",
  data: PNG_A,
};

/** One submit as it crossed the bridge boundary. */
interface SubmittedTurn {
  readonly text: string;
  readonly content: readonly UserContentBlock[] | undefined;
}

/** What the next `postMessage` call does: answer, reject (optionally late), or
 *  stay in flight so a later submit waits in the turn-gap queue. */
type PostOutcome =
  | { readonly kind: "reply" }
  | {
      readonly kind: "reject";
      readonly error: Error;
      readonly delayMs?: number;
    }
  | { readonly kind: "in-flight" };

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleFrame(setup: TestRendererSetup, ms = 120): Promise<void> {
  await sleep(ms);
  await setup.renderOnce();
  await setup.waitForVisualIdle();
}

async function until(
  cond: () => boolean,
  label: string,
  timeoutMs = 8000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error(`until timeout: ${label}`);
}

function sessionFile(id: string): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    conversation_id: id,
    title: "",
    cwd: "/tmp/proj",
    sanitized_at: now,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    checkpoints: [],
  };
}

function fakeBridge(
  submits: SubmittedTurn[],
  outcomes: PostOutcome[]
): TuiBridge {
  const reply: TuiPostResult = {
    conversationId: CONVERSATION_ID,
    finalText: "",
    stopReason: "completed",
    turnCount: 1,
    jsonMode: false,
    lastUsage: null,
  };
  const file = sessionFile(CONVERSATION_ID);
  return {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? CONVERSATION_ID,
    postMessage: async (opts) => {
      submits.push({ text: opts.text, content: opts.content });
      const outcome = outcomes[submits.length - 1] ?? { kind: "reply" };
      if (outcome.kind === "reject") {
        if (outcome.delayMs !== undefined) await sleep(outcome.delayMs);
        throw outcome.error;
      }
      // A turn that never answers: the next submit is queued, not sent.
      if (outcome.kind === "in-flight")
        return new Promise<TuiPostResult>(() => {});
      return reply;
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    openSession: async () => {
      throw new Error("unused: this test never opens a persisted session");
    },
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("unused");
    },
    rewindSession: async () => ({ file }),
    listRewindTargets: async () => [],
    inflight: createInflightRegistry(),
    contextWindow: 200_000,
    listLiveBackgroundTasks: () => [],
    listSubagents: () => [],
    abortSubagentTask: () => false,
    abortSessionForegroundWork: () => [],
    subscribeSubagentTerminal: () => () => undefined,
    wakeFromSubagent: async () => undefined,
  };
}

/** A provider failure at this seam: an Error carrying the HTTP status, which is
 *  what renders the "API error (400)" line. Never a ValidationError, so the
 *  accepted message may already be in history. */
function providerError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function validationRejection(): ValidationError {
  return new ValidationError("text too long for admission", { field: "text" });
}

/** The lane a status-less rejection ends in. Turn end owns this line, so the
 *  catch-side `turn 失败：<message>` is a transitional frame that the teardown
 *  replaces (tests/tui/error-stop-notice.test.tsx pins the same behavior): this
 *  is the durable text that proves the failure arm ran, and the `protocolError`
 *  suffix is what separates it from a status-carrying provider rejection. */
const TURN_FAILED = "turn 未成功结束（protocolError）";

interface DrivenApp {
  readonly setup: TestRendererSetup;
  readonly submits: SubmittedTurn[];
  readonly type: (text: string) => Promise<void>;
  readonly paste: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly pressCtrlG: () => Promise<void>;
  readonly text: () => string | null;
  readonly frame: () => string;
  /** Wait until the composer shows exactly `expected` (the restore landing). */
  readonly waitText: (expected: string) => Promise<void>;
  /** Wait until a rendered notice line carries `needle` (the failure arm that
   *  ran, asserted as the user sees it). */
  readonly waitFrame: (needle: string) => Promise<void>;
  readonly destroy: () => Promise<void>;
}

/** One on-disk skill the `/skill prompt` cases can resolve without a scan. */
function foldedSkillCatalog(): SkillCatalog {
  const skillDir = mkdtempSync(join(tmpdir(), "iknow-skill-fold-"));
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: zz-fold\ndescription: fold probe\n---\n\nDo the folded prompt.\n",
    "utf8"
  );
  return createSkillCatalog([
    {
      name: "zz-fold",
      description: "fold probe",
      dir: skillDir,
      disabled: false,
    },
  ]);
}

async function mountApp(
  outcomes: PostOutcome[],
  opts: {
    readonly reader?: ClipboardImageReader;
    readonly skillCatalog?: SkillCatalog;
  } = {}
): Promise<DrivenApp> {
  const submits: SubmittedTurn[] = [];
  // Default double, shaped by the two gestures the app distinguishes: the
  // Ctrl+V chord returns the image payload (what the restore case attaches),
  // while a paste-path probe — recognizable by the bounded timeoutMs the app
  // passes and only the app passes — answers "no bitmap". Pasted text is what
  // the paste-bearing cases restore and unfold, so a default that turned a
  // paste into `[image#1]` would silently change their subject.
  const reader: ClipboardImageReader =
    opts.reader ??
    ((options?: ReadClipboardImageOptions) =>
      options?.timeoutMs === PASTE_IMAGE_PROBE_TIMEOUT_MS
        ? Promise.resolve<ClipboardImageResult>({ kind: "empty" })
        : Promise.resolve<ClipboardImageResult>(OK_A));
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-restore-"));
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={fakeBridge(submits, outcomes)}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      clipboardImageReader={reader}
      {...(opts.skillCatalog !== undefined
        ? { skillCatalog: opts.skillCatalog }
        : {})}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    {
      width: COLS,
      height: ROWS,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      kittyKeyboard: true,
    }
  );
  setupRef = setup;
  await sleep(300);
  await setup.waitForVisualIdle();
  return {
    setup,
    submits,
    type: async (text) => {
      await setup.mockInput.typeText(text, 0);
      await settleFrame(setup);
    },
    paste: async (text) => {
      await setup.mockInput.pasteBracketedText(text);
      await settleFrame(setup);
    },
    pressEnter: async () => {
      setup.mockInput.pressEnter();
      await settleFrame(setup);
    },
    pressCtrlG: async () => {
      setup.mockInput.pressKey("g", { ctrl: true });
      await settleFrame(setup);
    },
    text: () => composerText(setup),
    frame: () => setup.captureCharFrame(),
    waitText: async (expected) => {
      await until(() => composerText(setup) === expected, `buffer=${expected}`);
    },
    waitFrame: async (needle) => {
      await until(() => setup.captureCharFrame().includes(needle), needle);
    },
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
  };
}

describe("a folded paste is an input display", () => {
  test("the transcript shows the payload while the composer kept the label until submit", async () => {
    // The fold is an input-box display. The message the turn echoes is the
    // text the model receives, rendered as a normal user bubble — a summary
    // label here is the paste the model cannot see.
    const app = await mountApp([{ kind: "in-flight" }]);
    try {
      await app.paste("alpha\nbeta\ngamma");
      await app.waitText("[paste#1 · 3 lines · 16 chars]");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "submit reached the bridge");
      expect(app.submits[0]?.text).toBe("alpha\nbeta\ngamma");
      await app.waitFrame("alpha");
      const frame = app.frame();
      expect(frame).toContain("beta");
      expect(frame).toContain("gamma");
      expect(frame).not.toContain("[paste#");
      expect(app.text()).toBe("");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("a /skill prompt restores the paste, keeps the image label, and sends the bytes", async () => {
    // `/skill` plus a prompt is a different submit from a plain message: the
    // envelope used to be built from the input label, so the bubble and the
    // model both received `[paste#N]`. The prompt is restored; an image stays
    // a label in that prompt and travels as a block the model can read.
    const app = await mountApp([{ kind: "in-flight" }], {
      skillCatalog: foldedSkillCatalog(),
    });
    try {
      await app.type("/zz-fold ");
      await app.paste("alpha\nbeta\ngamma");
      app.setup.mockInput.pressKey("v", { ctrl: true });
      await app.waitText("/zz-fold [paste#1 · 3 lines · 16 chars][image#1]");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "submit reached the bridge");
      const sent = app.submits[0];
      expect(sent?.text).toContain('[skill-load name="zz-fold"]');
      expect(sent?.text).toContain("alpha\nbeta\ngamma[image#1]");
      expect(sent?.text).not.toContain("[paste#");
      expect(sent?.content).toEqual([
        { type: "text", text: sent?.text },
        imageBlock(PNG_A),
      ]);
      await app.waitFrame("alpha");
      const frame = app.frame();
      expect(frame).toContain("beta");
      expect(frame).toContain("gamma");
      expect(frame).toContain("[image#1]");
      expect(frame).toContain("loading skill zz-fold");
      expect(frame).not.toContain("[paste#");
      expect(frame).not.toContain("Do the folded prompt");
      expect(app.text()).toBe("");
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

describe("a rejected submit gives the draft back", () => {
  test("text-only draft: the typed text is back in the composer", async () => {
    // The rejection is held back so both halves are observable: an immediate one
    // restores inside the same poll tick that first reports the submit, and the
    // spent-at-submit frame can never be read.
    const app = await mountApp([
      { kind: "reject", error: validationRejection(), delayMs: 400 },
    ]);
    try {
      await app.type("just text");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "submit reached the bridge");
      expect(app.text()).toBe("");
      await app.waitFrame(TURN_FAILED);
      await app.waitText("just text");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("folded paste: the restored label is live, so Ctrl+G unfolds it", async () => {
    const app = await mountApp([
      { kind: "reject", error: validationRejection() },
    ]);
    try {
      await app.type("lead ");
      await app.paste("one\ntwo");
      const folded = "lead [paste#1 · 2 lines · 7 chars]";
      await app.waitText(folded);
      await app.pressEnter();
      await until(() => app.submits.length === 1, "submit reached the bridge");
      expect(app.submits[0]?.text).toBe("lead one\ntwo");
      await app.waitFrame(TURN_FAILED);
      await app.waitText(folded);
      // The payload table holds it again: the label is a unit, not literal text.
      await app.pressCtrlG();
      await app.waitText("lead one\ntwo");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("clipboard image: the payload comes back and re-sends the same blocks", async () => {
    const app = await mountApp([
      { kind: "reject", error: validationRejection() },
      { kind: "reply" },
    ]);
    try {
      await app.type("look");
      app.setup.mockInput.pressKey("v", { ctrl: true });
      await app.waitText("look[image#1]");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "submit reached the bridge");
      expect(app.submits[0]?.content).toEqual([
        { type: "text", text: "look" },
        imageBlock(PNG_A),
      ]);
      await app.waitFrame(TURN_FAILED);
      await app.waitText("look[image#1]");
      // Base64 bytes the user cannot paste again: resubmitting must send them.
      await app.pressEnter();
      await until(
        () => app.submits.length === 2,
        "second submit reached bridge"
      );
      expect(app.submits[1]?.text).toBe("look");
      expect(app.submits[1]?.content).toEqual([
        { type: "text", text: "look" },
        imageBlock(PNG_A),
      ]);
      // Accepted: the composer is spent and nothing is waiting to come back.
      await settleFrame(app.setup);
      expect(app.text()).toBe("");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("busy guard: a submit during a running turn waits in the gap queue", async () => {
    const app = await mountApp([{ kind: "in-flight" }]);
    try {
      await app.type("first");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "first submit in flight");
      expect(app.text()).toBe("");
      await app.type("second");
      await app.pressEnter();
      await app.waitFrame("queued 1");
      expect(app.frame()).toContain("next: second");
      expect(app.frame()).toContain("↑ edit");
      expect(app.text()).toBe("");
      expect(app.submits.length).toBe(1);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("no duplicate: a provider rejection keeps the spent draft spent", async () => {
    const app = await mountApp([
      {
        kind: "reject",
        error: providerError(400, "invalid request body"),
      },
    ]);
    try {
      await app.type("hello");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "submit reached the bridge");
      // The notice proves the failure carried an HTTP status, i.e. it is not a
      // pre-acceptance validation error.
      await app.waitFrame("API error (400): invalid request body");
      await settleFrame(app.setup, 300);
      expect(app.text()).toBe("");
      expect(app.submits.length).toBe(1);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("newer typing wins: a rejection does not paste over what came after", async () => {
    const app = await mountApp([
      {
        kind: "reject",
        error: validationRejection(),
        delayMs: 800,
      },
    ]);
    try {
      await app.type("failed draft");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "submit reached the bridge");
      expect(app.text()).toBe("");
      // The user moved on while the turn was still running.
      await app.type("my new work");
      await app.waitFrame(TURN_FAILED);
      await settleFrame(app.setup, 300);
      expect(app.text()).toBe("my new work");
    } finally {
      await app.destroy();
    }
  }, 30_000);
});
