/** @jsxImportSource @opentui/react */
/**
 * tests/tui/composer-clipboard-image.test.tsx
 *
 * The Ctrl+V clipboard-image chord and the lifecycle around it (src/tui/app.tsx):
 * one image read folded into the composer as `[image#N]`, its real payload
 * submitted as an ordered user content block, gesture order kept across rapid
 * presses, and a late result discarded once the draft it belongs to is gone.
 *
 * The reader is stubbed at its own seam — the `clipboardImageReader` prop, the
 * same props-bag precedent as the fake bridge in
 * tests/tui/subagent-kill-key.test.tsx — because the host interop it drives is
 * unreachable from a test process. The reader's internals (magic bytes, temp
 * file, size gate, timeout) belong to tests/tui/clipboard-image.test.ts; what is
 * pinned here is the app's use of its typed outcome: the label lands at the live
 * caret, every failure leaves buffer and draft byte-identical with a visible
 * reason and no text fallback, and a result that resolves after clear / deletion
 * / session switch never reaches the composer.
 *
 * Asserted on observable data: the textarea's live buffer, the blocks crossing
 * the bridge boundary, the rendered notice. Payloads are synthetic bytes.
 *
 * The gesture split recorded in plans/tui-composer.md Decisions §2 (as amended
 * by the paste probe) is pinned here too: a MULTILINE paste is never an image
 * copy, so it folds with zero reads and no probe at all. A single-line paste
 * inserts its text FIRST — synchronously, in the paste handler — and only then
 * queues a clipboard probe through the same queue as the chord, under
 * `PASTE_IMAGE_PROBE_TIMEOUT_MS`. The probe may therefore only ever REPLACE
 * text it put into the buffer itself, in place; every other outcome (no bitmap,
 * a refused bitmap, the user's own edit, an invalidated draft, Enter) leaves the
 * buffer exactly as the paste made it. Nothing is held, reordered, or swallowed
 * behind the round trip, and only the chord is allowed to speak.
 *
 * And a gesture the composer cannot keep spends nothing at all: `PromptInput`'s
 * two imperative writes drop their argument silently while it is disabled, so
 * paste, probe and chord first ask `isEditable()` and bail — otherwise the
 * discarded bytes would still have taken an `[image#N]` / `[paste#N]` number and
 * left that payload orphaned in the draft, which is what blocks a rejected draft
 * from ever being handed back (see `composer 挂载但不可写` below).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
import {
  PASTE_IMAGE_PROBE_TIMEOUT_MS,
  type ClipboardImageResult,
  type ReadClipboardImageOptions,
} from "../../src/tui/clipboard-image.js";
import type { UserContentBlock } from "../../src/session-api/contract.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import {
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import { composerText } from "./_fixtures.js";

const COLS = 80;
const ROWS = 30;

/** Synthetic PNG-shaped payload (signature + filler), base64 as the reader
 *  would hand it back. Filler differs per image so ordering is visible. */
function payload(filler: number): string {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16, filler),
  ]).toString("base64");
}
const PNG_A = payload(0x41);
const PNG_B = payload(0x42);

const OK_A: ClipboardImageResult = {
  kind: "ok",
  mediaType: "image/png",
  data: PNG_A,
};
const OK_B: ClipboardImageResult = {
  kind: "ok",
  mediaType: "image/png",
  data: PNG_B,
};

function imageBlock(data: string): UserContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data },
  };
}

/**
 * Reader double: records every read the app *starts* — with the options it was
 * started with, so the probe's bounded timeout is observable at the seam — in
 * start order, and resolves one only when the test says so. The growth of
 * `started` is the serialization evidence — two presses never open two
 * concurrent host reads — and `settle(i)` resolves a read that is already stale
 * on purpose, which is what the caller's own generation token (not the abort)
 * has to survive.
 *
 * The one read that is not held by default: a paste-path probe, identifiable by
 * the bounded `timeoutMs` only that path passes. An un-armed probe answers
 * `{kind:"empty"}` the moment it starts, so any single-line paste in this file
 * behaves exactly like a clipboard with no bitmap (the text was already in the
 * buffer, nothing is substituted, nothing is said) without every test having to
 * arm it. Chord reads (no `timeoutMs`) always wait for `settle()`, keeping every
 * Ctrl+V case under test control.
 *
 * Probe arms are a QUEUE, not one slot: the cases that hold two pastes at once
 * (two image copies in a row, a paste behind a chord) need both probes pending
 * before either is answered, because the second one does not even start until
 * the first has been answered.
 */
type ProbeMode =
  | { readonly kind: "answer"; readonly result: ClipboardImageResult }
  | { readonly kind: "hold" };

interface StartedRead {
  readonly signal: AbortSignal | undefined;
  /** Exactly what the app handed the seam: probe reads carry the bounded
   *  timeout, chord reads carry none. */
  readonly options: ReadClipboardImageOptions | undefined;
  readonly resolve: (result: ClipboardImageResult) => void;
  settled: boolean;
}
interface ReaderStub {
  readonly reader: ClipboardImageReader;
  readonly started: StartedRead[];
  /** Resolve the i-th started read. Throws when it never started or was
   *  already answered. */
  settle(index: number, result: ClipboardImageResult): void;
  /** True while the i-th started read has an answer the app has not been given
   *  yet — the evidence that an assertion below runs mid-flight. */
  isPending(index: number): boolean;
  /** The next paste probe answers `result` the moment it starts. */
  answerNextProbe(result: ClipboardImageResult): void;
  /** The next paste probe behaves like a chord read: recorded and pending
   *  until `settle()`. For in-flight / late-result cases. */
  holdNextProbe(): void;
}
function createReaderStub(): ReaderStub {
  const started: StartedRead[] = [];
  const probeArms: ProbeMode[] = [];
  const reader: ClipboardImageReader = (options?: ReadClipboardImageOptions) =>
    new Promise<ClipboardImageResult>((resolve) => {
      const read: StartedRead = {
        signal: options?.signal,
        options,
        resolve,
        settled: false,
      };
      started.push(read);
      const isProbe = options?.timeoutMs === PASTE_IMAGE_PROBE_TIMEOUT_MS;
      if (isProbe) {
        const mode = probeArms.shift() ?? null;
        if (mode === null || mode.kind === "answer") {
          read.settled = true;
          read.resolve(mode === null ? { kind: "empty" } : mode.result);
        }
      }
      // A chord read (no timeoutMs) — or a held probe — stays pending: only
      // settle() answers it.
    });
  return {
    reader,
    started,
    settle(index, result) {
      const read = started[index];
      if (read === undefined || read.settled) {
        throw new Error(
          `clipboard read #${index} has not started or was already answered`
        );
      }
      read.settled = true;
      read.resolve(result);
    },
    isPending(index) {
      const read = started[index];
      if (read === undefined) {
        throw new Error(`clipboard read #${index} has not started`);
      }
      return !read.settled;
    },
    answerNextProbe(result) {
      probeArms.push({ kind: "answer", result });
    },
    holdNextProbe() {
      probeArms.push({ kind: "hold" });
    },
  };
}

interface SubmittedTurn {
  readonly text: string;
  readonly content: readonly UserContentBlock[] | undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Converge on a stable frame: state has committed. A raw sleep alone
 *  intermittently reads a pre-commit frame (same device as the Ctrl+C test). */
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

/** `until` for a RENDERED witness: draws a frame per round instead of only
 *  reading the live render tree, so a condition about what is on screen (a
 *  modal's copy, a label the composer must NOT show) cannot pass on a stale
 *  frame or fail on an undrawn one. */
async function untilFrame(
  setup: TestRendererSetup,
  cond: (frame: string) => boolean,
  label: string,
  timeoutMs = 8000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(25);
    await setup.renderOnce();
    if (cond(setup.captureCharFrame())) return;
  }
  throw new Error(`untilFrame timeout: ${label}`);
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

/** The app→hub boundary is the only stubbed collaborator: `postMessage` records
 *  what the composer submitted, so the block shape is asserted as data. */
function fakeBridge(submits: SubmittedTurn[]): TuiBridge {
  const reply: TuiPostResult = {
    conversationId: "conv-clip",
    finalText: "",
    stopReason: "completed",
    turnCount: 1,
    jsonMode: false,
    lastUsage: null,
  };
  const file = sessionFile("conv-clip");
  return {
    hub: undefined as never,
    store: undefined as never,
    ensureSession: async (id) => id ?? "conv-clip",
    postMessage: async (opts) => {
      submits.push({ text: opts.text, content: opts.content });
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

interface DrivenApp {
  readonly setup: TestRendererSetup;
  readonly stub: ReaderStub;
  readonly submits: SubmittedTurn[];
  readonly type: (text: string) => Promise<void>;
  readonly pressEnter: () => Promise<void>;
  readonly text: () => string | null;
  readonly frame: () => string;
  readonly settle: () => Promise<void>;
  /** Press the chord and wait until the app really called the reader. */
  readonly startPendingRead: () => Promise<void>;
  /** Deliver a real bracketed paste. Returns once the bytes reached the app,
   *  which under the insert-first rule is also when the text is in the buffer. */
  readonly pasteText: (text: string) => Promise<void>;
  /** Paste a single line and wait until the probe it queues has really
   *  started. Fails fast when the paste never reached the seam. */
  readonly startPendingProbe: (text: string) => Promise<void>;
  /** Caret moves, so the substitution's caret rule is observable through
   *  where a later typed character lands. Moves are absolute (HOME, then a
   *  count of rights) rather than a count of lefts: a wrapped composer's caret
   *  crosses a visual row at a row boundary, which is textarea behavior this
   *  file does not want in its expectations. */
  readonly moveHome: () => Promise<void>;
  readonly moveRight: (times: number) => Promise<void>;
  readonly backspace: (times: number) => Promise<void>;
  /** Put the composer into the state the silent-drop review is about: MOUNTED
   *  (a live textarea, a real handle) but DISABLED, so `insertText` /
   *  `replaceBuffer` throw their write away without saying so.
   *
   *  Reached the way a user reaches it — a pending permission ask whose modal is
   *  active. `askModalActive` is a disjunct of the `disabled={...}` expression
   *  handed to PromptInput (src/tui/app.tsx) and nothing else, so the composer
   *  stays mounted; the modal block renders from that same boolean, which is why
   *  "允许执行 bash？" on screen is a witness for the state rather than an
   *  assumption about it.
   *
   *  The other disjuncts (a `/memory`-style picker, chrome focus, the graph
   *  view) are not reachable from this harness without a submit on the way in —
   *  and the submit clears the exact buffer these cases have to observe. */
  readonly openAskModal: () => Promise<void>;
  /** Settle that ask: the composer is editable again. */
  readonly closeAskModal: () => Promise<void>;
  readonly destroy: () => Promise<void>;
}

async function mountApp(
  opts: {
    readonly view?: "chat" | "list";
    readonly session?: TuiSessionState;
    /** Replace the double entirely (an outcome the cue-resolved stub cannot
     *  express, e.g. a rejection). Absent → the stub. */
    readonly reader?: ClipboardImageReader;
  } = {}
): Promise<DrivenApp> {
  const stub = createReaderStub();
  const submits: SubmittedTurn[] = [];
  const askBridge = createTuiAskUserBridge();
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-clip-"));
  let setupRef: TestRendererSetup | undefined;
  let openAskId: string | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={fakeBridge(submits)}
      askBridge={askBridge}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      clipboardImageReader={opts.reader ?? stub.reader}
      {...(opts.view ? { initialView: opts.view } : {})}
      {...(opts.session ? { initialSession: opts.session } : {})}
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
    stub,
    submits,
    type: async (text) => {
      await setup.mockInput.typeText(text, 0);
      await settleFrame(setup);
    },
    pressEnter: async () => {
      // Converge so assertions read the buffer the paste just wrote, then
      // the frame after Enter. Submit itself reads the live buffer, so the
      // wait is not what keeps the text from being dropped.
      await settleFrame(setup);
      setup.mockInput.pressEnter();
      await settleFrame(setup);
    },
    text: () => composerText(setup),
    frame: () => setup.captureCharFrame(),
    settle: () => settleFrame(setup),
    startPendingRead: async () => {
      const before = stub.started.length;
      setup.mockInput.pressKey("v", { ctrl: true });
      await until(
        () => stub.started.length > before,
        "Ctrl+V 未启动剪贴板读取"
      );
    },
    pasteText: async (text) => {
      await setup.mockInput.pasteBracketedText(text);
    },
    startPendingProbe: async (text) => {
      const before = stub.started.length;
      await setup.mockInput.pasteBracketedText(text);
      await until(
        () => stub.started.length > before,
        "单行粘贴未启动剪贴板探测"
      );
    },
    moveHome: async () => {
      setup.mockInput.pressKey("HOME");
      await settleFrame(setup);
    },
    moveRight: async (times) => {
      for (let i = 0; i < times; i += 1) setup.mockInput.pressArrow("right");
      await settleFrame(setup);
    },
    backspace: async (times) => {
      for (let i = 0; i < times; i += 1) setup.mockInput.pressBackspace();
      await settleFrame(setup);
    },
    openAskModal: async () => {
      // Never awaited: an ask resolves through the modal or through
      // closeAskModal below, and awaiting here would dead-wait before keys land
      // (same discipline as tests/tui/ask-modal.test.tsx's askAndWaitModal).
      void askBridge.ask({
        tool: "bash",
        input: { command: "ls" },
        summaryHint: "ls",
        toolUseId: "toolu_clipboard_test",
      });
      const id = askBridge.pending()?.id;
      if (id === undefined)
        throw new Error("ask 未进入 pending（modal 不会挂载）");
      openAskId = id;
      // Converge on the witness, do not assume the state: the modal block and
      // PromptInput's `disabled` read the same `askModalActive` boolean, so this
      // frame proves the composer is disabled right now.
      await untilFrame(
        setup,
        (frame) => frame.includes("允许执行 bash？"),
        "ask modal 未接管输入（composer 未进入 disabled）"
      );
    },
    closeAskModal: async () => {
      const id = openAskId;
      if (id === undefined) throw new Error("没有打开的 ask modal 可关闭");
      openAskId = undefined;
      askBridge.resolveAsk(id, false);
      await untilFrame(
        setup,
        (frame) => !frame.includes("允许执行 bash？"),
        "ask modal 未收起（composer 未回到 editable）"
      );
    },
    destroy: async () => {
      // A modal left open would outlive the renderer; settle it so the pending
      // ask's fail-closed timer is the only thing still armed (and it is unref'd).
      if (openAskId !== undefined) askBridge.resolveAsk(openAskId, false);
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
  };
}

describe("Ctrl+V 折叠一张剪贴板图片", () => {
  test("ok: 标签落在解析时的活光标处，缓冲区其余文本原样", async () => {
    const app = await mountApp();
    try {
      await app.type("look");
      await app.startPendingRead();
      // The read is started under the caller's abort signal, never unowned.
      expect(app.stub.started[0]?.signal).toBeInstanceOf(AbortSignal);
      // Typing while the read is in flight: the label must follow the caret as
      // it is on arrival, not as it was when the chord was pressed.
      await app.type("at");
      expect(app.text()).toBe("lookat");
      app.stub.settle(0, OK_A);
      await until(() => app.text() === "lookat[image#1]", "标签未落进缓冲区");
      // No stray "v" from the chord, and no clipboard bytes as text.
      expect(app.frame()).not.toContain("剪贴板");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("submit: 标签背后的真实 payload 作为 image block 送出", async () => {
    const app = await mountApp();
    try {
      await app.type("look");
      await app.startPendingRead();
      app.stub.settle(0, OK_A);
      await until(() => app.text() === "look[image#1]", "标签未落进缓冲区");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      const submitted = app.submits[0];
      if (submitted === undefined) throw new Error("no submit recorded");
      expect(submitted.text).toBe("look");
      expect(submitted.content).toEqual([
        { type: "text", text: "look" },
        imageBlock(PNG_A),
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("image-only submit: 没有文本也送出图片块", async () => {
    const app = await mountApp();
    try {
      await app.startPendingRead();
      app.stub.settle(0, OK_A);
      await until(() => app.text() === "[image#1]", "标签未落进缓冲区");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.text).toBe("");
      expect(app.submits[0]?.content).toEqual([imageBlock(PNG_A)]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  const failures: ReadonlyArray<{
    readonly name: string;
    readonly result: ClipboardImageResult;
    readonly notice: string;
  }> = [
    { name: "empty", result: { kind: "empty" }, notice: "剪贴板里没有图片" },
    {
      name: "unsupported",
      result: { kind: "unsupported" },
      notice: "格式不支持",
    },
    {
      name: "too-large",
      result: { kind: "too-large", bytes: 2_097_152 },
      notice: "2097152 字节",
    },
    {
      name: "error",
      result: { kind: "error", message: "powershell.exe 不可用" },
      notice: "剪贴板读取失败：powershell.exe 不可用",
    },
  ];

  for (const failure of failures) {
    test(`failure ${failure.name}: 草稿原样不动，只给可见理由，绝不落文本`, async () => {
      const app = await mountApp();
      try {
        await app.type("keep");
        await app.startPendingRead();
        app.stub.settle(0, failure.result);
        await app.settle();
        // Buffer byte-identical: no label, no payload text, no chord residue.
        expect(app.text()).toBe("keep");
        expect(app.frame()).toContain(failure.notice);
        // Nothing was attached behind the scenes either: the submit stays a
        // plain text turn (`content` absent = the hub's single-text-block path).
        await app.pressEnter();
        await until(() => app.submits.length === 1, "提交未抵达 bridge");
        expect(app.submits[0]?.content).toBeUndefined();
      } finally {
        await app.destroy();
      }
    }, 30_000);
  }

  test("exception: reader 违背不 reject 的契约 → 有理由、草稿不动、队列还活着", async () => {
    // The real reader never rejects, so this is the one outcome the cue-resolved
    // double cannot express. It matters because the presses are serialized: a
    // rejection left unhandled would strand every later Ctrl+V on a dead chain.
    let calls = 0;
    const app = await mountApp({
      reader: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("host bridge died"))
          : Promise.resolve(OK_A);
      },
    });
    try {
      await app.type("keep");
      app.setup.mockInput.pressKey("v", { ctrl: true });
      await until(() => calls === 1, "Ctrl+V 未启动剪贴板读取");
      await app.settle();
      expect(app.text()).toBe("keep");
      expect(app.frame()).toContain("剪贴板读取失败");
      // Queue alive: the next press reads again and lands its label normally.
      app.setup.mockInput.pressKey("v", { ctrl: true });
      await until(() => calls === 2, "被 reject 打断后队列未恢复");
      await until(
        () => app.text() === "keep[image#1]",
        "恢复后的读取未落进缓冲区"
      );
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

describe("单行粘贴：文本先进缓冲区，探测命中才原位换成标签", () => {
  test("不等待：探测仍在途时，粘贴文本已经在缓冲区里了", async () => {
    // The anti-delay guarantee, and the reason the probe no longer holds the
    // text: a round trip to the host must never be what puts what the user
    // pasted on screen. Nothing has been answered here, and the buffer is
    // already the paste.
    const app = await mountApp();
    try {
      app.stub.holdNextProbe();
      await app.startPendingProbe("https://example.com/screenshot.png");
      expect(app.stub.isPending(0)).toBe(true);
      expect(app.text()).toBe("https://example.com/screenshot.png");
      // No placeholder is invented ahead of the answer: the buffer is the
      // paste's own text, not a preview of what the probe may turn it into.
      expect(app.text()).not.toContain("[image#");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("ok：无人改动 → 粘贴文本被就地换成 [image#1]，flavor 消失、无 notice", async () => {
    const app = await mountApp();
    try {
      app.stub.answerNextProbe(OK_A);
      await app.pasteText("https://example.com/screenshot.png");
      await until(
        () => app.text() === "[image#1]",
        "粘贴探测的图标签未落进缓冲区"
      );
      // The image copy's byproduct flavor is gone: the buffer is the label,
      // nothing else.
      expect(app.text()).not.toContain("example.com");
      expect(app.frame()).not.toContain("剪贴板");
      // The label is a real draft unit, not text shaped like one: submitting
      // spends the payload the probe found.
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.text).toBe("");
      expect(app.submits[0]?.content).toEqual([imageBlock(PNG_A)]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("ok：粘贴后继续键入 → 键入存活，标签停在原粘贴位置", async () => {
    const app = await mountApp();
    try {
      await app.type("before");
      app.stub.holdNextProbe();
      await app.startPendingProbe("flavor");
      await app.type("after");
      // Buffer truth while the read is in flight: the paste and the typing are
      // both there, in the order the user made them.
      expect(app.stub.isPending(0)).toBe(true);
      expect(app.text()).toBe("beforeflavorafter");
      app.stub.settle(0, OK_A);
      await until(
        () => app.text() === "before[image#1]after",
        "标签未停在粘贴的原位置"
      );
      expect(app.frame()).not.toContain("flavor");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("ok：用户改写了粘贴文本 → 一处都不动，编号与 payload 都没被花费", async () => {
    const app = await mountApp();
    try {
      await app.type("keep");
      app.stub.holdNextProbe();
      await app.startPendingProbe("flavor");
      await app.backspace(3);
      expect(app.text()).toBe("keepfla");
      app.stub.settle(0, OK_A);
      await app.settle();
      // The span no longer matches and the buffer does not end with it, so the
      // answer is: leave what the user wrote alone. No label anywhere.
      expect(app.text()).toBe("keepfla");
      expect(app.frame()).not.toContain("[image#");
      expect(app.frame()).not.toContain("剪贴板");
      // Nothing was spent to deliver the discarded answer: the next image is
      // still #1, and its payload is the only one the submit carries.
      await app.startPendingRead();
      app.stub.settle(1, OK_A);
      await until(
        () => app.text() === "keepfla[image#1]",
        "被丢弃的探测占用了标签编号"
      );
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.text).toBe("keepfla");
      expect(app.submits[0]?.content).toEqual([
        { type: "text", text: "keepfla" },
        imageBlock(PNG_A),
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("ok：粘贴文本既不在原段也不在缓冲区末尾（用户前后都加了字）→ 一字不改，编号与 payload 都没被花费", async () => {
    // The conservative arm, in the shape the truncating edit above does not
    // reach: the paste's bytes are STILL in the buffer, just neither at the span
    // the insert made (words went in front of it and shifted it off that offset)
    // nor at the end (words went behind it). The locator is positional on
    // purpose — it never searches for the string — because a global match would
    // overwrite what the user surrounded that text with, and an edit is never
    // worth overwriting to deliver an attachment.
    const app = await mountApp();
    try {
      app.stub.holdNextProbe();
      await app.startPendingProbe("flavor");
      // Converge first: the paste's own report commits on a later task, and a
      // caret move that lands before that commit is undone by it.
      await app.settle();
      await app.moveHome();
      await app.type("see ");
      await app.moveHome();
      await app.moveRight(10);
      await app.type(" now");
      expect(app.stub.isPending(0)).toBe(true);
      expect(app.text()).toBe("see flavor now");
      app.stub.settle(0, OK_A);
      await app.settle();
      expect(app.text()).toBe("see flavor now");
      expect(app.frame()).not.toContain("[image#");
      expect(app.frame()).not.toContain("剪贴板");
      // Nothing was spent to deliver the discarded answer: the next image is
      // still #1, and its payload is the only one the submit carries.
      await app.startPendingRead();
      app.stub.settle(1, OK_A);
      await until(
        () => app.text() === "see flavor now[image#1]",
        "被丢弃的探测占用了标签编号"
      );
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.text).toBe("see flavor now");
      expect(app.submits[0]?.content).toEqual([
        { type: "text", text: "see flavor now" },
        imageBlock(PNG_A),
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  // The caret rule of the in-place substitution, observed the only way this
  // harness can observe a caret: where a character typed afterwards lands.
  // `flavor` (0..6) is the pasted span and `tail` is typed during the read, so
  // the caret's three positions relative to the span — before it, inside it,
  // after it — give three different answers.
  //
  // The moves are absolute, not a left-press count: a wrapped composer moves a
  // visual caret up a row at a row boundary (and back down at the start of a
  // longer second row), which is a textarea behavior this file has no interest
  // in pinning. HOME plus the exact number of rights onto each position is the
  // same caret reached without crossing a row edge.
  const caretCases: ReadonlyArray<{
    readonly name: string;
    readonly moveAfterHome: number;
    readonly expected: string;
  }> = [
    {
      name: "光标在粘贴段之前",
      moveAfterHome: 0,
      expected: "X[image#1]tail",
    },
    {
      name: "光标在粘贴段之内",
      moveAfterHome: 2,
      expected: "[image#1]Xtail",
    },
    {
      name: "光标在粘贴段之后（标签末尾）",
      moveAfterHome: 10,
      expected: "[image#1]tailX",
    },
  ];
  for (const caretCase of caretCases) {
    test(`ok：${caretCase.name} → 替换后光标按规则移动`, async () => {
      const app = await mountApp();
      try {
        app.stub.holdNextProbe();
        await app.startPendingProbe("flavor");
        await app.type("tail");
        expect(app.text()).toBe("flavortail");
        await app.moveHome();
        await app.moveRight(caretCase.moveAfterHome);
        app.stub.settle(0, OK_A);
        await until(
          () => app.text() === "[image#1]tail",
          "标签未就地替换粘贴段"
        );
        await app.type("X");
        expect(app.text()).toBe(caretCase.expected);
      } finally {
        await app.destroy();
      }
    }, 30_000);
  }

  test("ok：连续两次单行粘贴都命中位图 → [image#1][image#2]，无 flavor 残留", async () => {
    // Both probes are held, so the second paste lands while the first is still
    // in flight: the first substitution shifts the second paste's span off the
    // offset it recorded, which is exactly what the end-of-buffer fallback is
    // for. Press order still decides numbering and block order.
    const app = await mountApp();
    try {
      app.stub.holdNextProbe();
      app.stub.holdNextProbe();
      await app.startPendingProbe("flavor-a");
      await app.pasteText("flavor-b");
      expect(app.text()).toBe("flavor-aflavor-b");
      // Serialized: the second gesture queues, it never opens a second read.
      expect(app.stub.started.length).toBe(1);
      app.stub.settle(0, OK_A);
      await until(() => app.stub.started.length === 2, "第二个粘贴探测未启动");
      expect(app.text()).toBe("[image#1]flavor-b");
      app.stub.settle(1, OK_B);
      await until(
        () => app.text() === "[image#1][image#2]",
        "第二次粘贴的标签未落在第一段之后"
      );
      expect(app.text()).not.toContain("flavor");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.content).toEqual([
        imageBlock(PNG_A),
        imageBlock(PNG_B),
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("ok（已知代价，按观察钉住）：删掉粘贴文本后手打同样的字节、落在缓冲区末尾 → 手打的那段也被换成 [image#1]", async () => {
    // Pinned as OBSERVED, not as intended, so a provenance-tracking fix shows up
    // here as a failure rather than as a silent edit. The end-of-buffer arm is
    // there for the queue case above: an earlier substitution shifts a later
    // paste off the offset it recorded. Its cost is that the locator matches
    // CONTENT, not provenance — so when the bytes the paste inserted are taken
    // back out and the very same bytes are typed by hand, still at the end of
    // the buffer, that arm fires and spends the user's own typing. Refusing
    // instead would drop an image the user really did copy, so the cost is
    // accepted; what it must never be is undocumented.
    const app = await mountApp();
    const flavor = "shot.png";
    try {
      app.stub.holdNextProbe();
      await app.startPendingProbe(flavor);
      expect(app.text()).toBe(flavor);
      // Converge before touching the buffer: the paste's own report commits on a
      // later task, and a deletion that lands before that commit is overwritten
      // by it (the interleave the paste handler documents).
      await app.settle();
      // The paste goes back out, byte for byte.
      await app.backspace(flavor.length);
      expect(app.text()).toBe("");
      // The same bytes come back in by hand, now at [4, 12): what the insert
      // recorded was the span [0, 8), so only the end-of-buffer arm can match.
      await app.type(`see ${flavor}`);
      expect(app.text()).toBe(`see ${flavor}`);
      expect(app.stub.isPending(0)).toBe(true);
      app.stub.settle(0, OK_A);
      await until(
        () => app.text() === "see [image#1]",
        "手打的相同字节被缓冲区末尾支路换成标签"
      );
      expect(app.text()).not.toContain(flavor);
      // The cost is symmetric: the words the user typed are gone AND the payload
      // is spent behind that label, so the turn carries an attachment for text
      // that was never a paste.
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.text).toBe("see ");
      expect(app.submits[0]?.content).toEqual([
        { type: "text", text: "see " },
        imageBlock(PNG_A),
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("探测有界：粘贴的读取带 PASTE_IMAGE_PROBE_TIMEOUT_MS，Ctrl+V 的读取不覆盖超时", async () => {
    const app = await mountApp();
    try {
      app.stub.holdNextProbe();
      await app.startPendingProbe("one line");
      // The text is already on screen while the bounded read is open.
      expect(app.text()).toBe("one line");
      // The probe goes through the seam with exactly { signal, timeoutMs }:
      // the bounded paste budget, observable at the boundary.
      expect(app.stub.started[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(app.stub.started[0]?.options?.timeoutMs).toBe(
        PASTE_IMAGE_PROBE_TIMEOUT_MS
      );
      app.stub.settle(0, { kind: "empty" });
      await app.settle();
      expect(app.text()).toBe("one line");
      // The chord keeps its own budget: same seam, no timeout override.
      await app.startPendingRead();
      expect(app.stub.started[1]?.options?.timeoutMs).toBeUndefined();
      app.stub.settle(1, OK_A);
      await until(
        () => app.text() === "one line[image#1]",
        "Ctrl+V 标签未落进缓冲区"
      );
    } finally {
      await app.destroy();
    }
  }, 30_000);

  // Anything but a real bitmap leaves the paste exactly as the terminal put it
  // there. Silence is the point: an ordinary text copy is the common answer,
  // and a probe that finds nothing is not a failure the user caused.
  const pasteFallbacks: ReadonlyArray<{
    readonly name: string;
    readonly result: ClipboardImageResult;
  }> = [
    { name: "empty", result: { kind: "empty" } },
    { name: "unsupported", result: { kind: "unsupported" } },
    { name: "error", result: { kind: "error", message: "interop 桥接失败" } },
    { name: "cancelled", result: { kind: "cancelled" } },
  ];
  for (const fallback of pasteFallbacks) {
    test(`${fallback.name}: 无可用位图 → 文本原地不动、一字不差、无 notice`, async () => {
      const app = await mountApp();
      try {
        app.stub.holdNextProbe();
        await app.startPendingProbe("复制的纯文本");
        expect(app.text()).toBe("复制的纯文本");
        app.stub.settle(0, fallback.result);
        await app.settle();
        // Same bytes as the paste left them: no label, no re-add, no reorder.
        expect(app.text()).toBe("复制的纯文本");
        expect(app.frame()).not.toContain("[image#");
        expect(app.frame()).not.toContain("剪贴板");
      } finally {
        await app.destroy();
      }
    }, 30_000);
  }

  test("too-large: 超限图片副本 → 粘贴文本仍留在原处，并给出与 Ctrl+V 同款的超限 notice", async () => {
    const app = await mountApp();
    try {
      app.stub.holdNextProbe();
      await app.startPendingProbe("IMG_0001.PNG");
      expect(app.text()).toBe("IMG_0001.PNG");
      app.stub.settle(0, { kind: "too-large", bytes: 2_097_152 });
      await app.settle();
      // The one non-ok answer worth reporting: a bitmap really is there, so the
      // refusal is shown the way the chord shows it — and the text the paste
      // already inserted stays exactly where it was.
      expect(app.text()).toBe("IMG_0001.PNG");
      // The same line clipboardImageFailureLines produces for the chord.
      expect(app.frame()).toContain("2097152 字节");
      expect(app.frame()).toContain("超过大小上限");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("reader 在粘贴路径上 reject：文本早已在缓冲区、无 notice，后续手势照常（队列未搁浅）", async () => {
    // Breaking the never-rejects contract on the paste path must strand
    // nothing: the queue serializes gestures, so an unhandled rejection would
    // dead-chain every later paste AND Ctrl+V behind it.
    let calls = 0;
    const app = await mountApp({
      reader: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("reader died mid-paste"))
          : Promise.resolve(OK_A);
      },
    });
    try {
      await app.pasteText("keep me");
      // The custom reader replaces the double, so the seam is counted by calls.
      expect(app.text()).toBe("keep me");
      await until(() => calls === 1, "粘贴探测未抵达 seam");
      await app.settle();
      expect(app.text()).toBe("keep me");
      expect(app.frame()).not.toContain("剪贴板");
      // Queue alive: the next gesture reaches the seam and lands normally.
      app.setup.mockInput.pressKey("v", { ctrl: true });
      await until(
        () => calls === 2,
        "reject 打断后队列未恢复（第二次读取未启动）"
      );
      await until(
        () => app.text() === "keep me[image#1]",
        "恢复后的读取未落进缓冲区"
      );
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("回归：粘贴后立刻回车提交（探测在途）→ 提交的文本就是粘贴内容，不丢输入", async () => {
    // What the "insert first" redesign is for. A held-over probe used to keep
    // the pasted text off the buffer until the host answered, so Enter pressed
    // during that window submitted an empty draft and dropped the paste on the
    // floor. The submit must carry what the user pasted, and the late answer
    // must then be discarded instead of labelling a composer that moved on.
    const app = await mountApp();
    try {
      app.stub.holdNextProbe();
      await app.startPendingProbe("https://example.com/screenshot.png");
      expect(app.text()).toBe("https://example.com/screenshot.png");
      // Still open when Enter is pressed: the read has no answer yet, so the
      // draft Enter takes is the paste itself.
      expect(app.stub.isPending(0)).toBe(true);
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.text).toBe("https://example.com/screenshot.png");
      // No attachment was invented for the turn: the probe had not answered.
      expect(app.submits[0]?.content).toBeUndefined();
      // Resolved after the draft was spent: nothing lands, in this composer or
      // the next one.
      app.stub.settle(0, OK_A);
      await app.settle();
      expect(app.text()).toBe("");
      expect(app.frame()).not.toContain("[image#1]");
      await app.type("next");
      await app.pressEnter();
      await until(() => app.submits.length === 2, "第二次提交未抵达 bridge");
      expect(app.submits[1]?.content).toBeUndefined();
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

describe("a multiline paste never probes the clipboard", () => {
  // What the split now guarantees (plans/tui-composer.md Decisions §2, as
  // amended by the paste probe): a multiline paste is never an image copy —
  // no bitmap carries a multi-line text flavor — so it folds synchronously and
  // the reader must sit silent through that whole path. That the fold is not
  // delayed is the same property the single-line path wins by inserting first:
  // no gesture the user can see waits on the host. Single-line pastes DO probe
  // (covered above); this case pins that the fold path never does, and that the
  // chord stays independent: its one press, its one read.
  test("multiline text folds to its summary with zero clipboard reads; Ctrl+V then reads once", async () => {
    const app = await mountApp();
    try {
      await app.setup.mockInput.pasteBracketedText("alpha\nbeta\ngamma");
      // No settle needed: the fold is a synchronous insert in the handler.
      expect(app.text()).toBe("[paste#1 · 3 lines · 16 chars]");
      // This is the assertion with teeth: wiring the text path to the
      // clipboard — even for a sniff — makes it non-zero.
      expect(app.stub.started.length).toBe(0);
      // The chord is the only gesture that reads, and it reads exactly once.
      await app.startPendingRead();
      expect(app.stub.started.length).toBe(1);
      app.stub.settle(0, OK_A);
      await until(
        () => app.text() === "[paste#1 · 3 lines · 16 chars][image#1]",
        "the image label did not join the folded paste"
      );
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("CR-only multiline paste (Windows Terminal) folds, expands to LF, and does not probe", async () => {
    // Clipboard CRLF is delivered as CR inside the bracketed paste. The fold
    // gate used to require LF, so this paste took the single-line path: the
    // raw text stayed in the buffer and a clipboard probe started.
    const app = await mountApp();
    try {
      await app.setup.mockInput.pasteBracketedText("alpha\rbeta\rgamma");
      expect(app.text()).toBe("[paste#1 · 3 lines · 16 chars]");
      expect(app.stub.started.length).toBe(0);

      app.setup.mockInput.pressKey("g", { ctrl: true });
      await until(
        () => app.text() === "alpha\nbeta\ngamma",
        "Ctrl+G did not expand the CR paste into LF lines"
      );

      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.text).toBe("alpha\nbeta\ngamma");
      expect(app.submits[0]?.content).toBeUndefined();
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("空粘贴：不写缓冲区，也不启动探测", async () => {
    const app = await mountApp();
    try {
      await app.type("kept");
      await app.setup.mockInput.pasteBracketedText("");
      await app.settle();
      expect(app.text()).toBe("kept");
      expect(app.stub.started.length).toBe(0);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("没有挂载 composer（list 视图）：粘贴既不插入也不启动探测", async () => {
    // The paste path is gated on the composer it would write into: there is no
    // buffer to substitute into and no draft to attach to, so the gesture makes
    // no host call at all rather than probing for a lost answer.
    const app = await mountApp({ view: "list" });
    try {
      expect(app.text()).toBeNull();
      await app.setup.mockInput.pasteBracketedText("https://example.com/a.png");
      await app.settle();
      expect(app.stub.started.length).toBe(0);
      expect(app.frame()).not.toContain("剪贴板");
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

describe("composer 挂载但不可写：手势不能花掉任何东西", () => {
  // The sibling of "没有挂载 composer（list 视图）" above, for the OTHER half of
  // why the imperative writes are gated: `insertText` / `replaceBuffer` are not
  // only absent-handed in the list view — they also throw their write away,
  // silently, on a composer that is mounted and DISABLED (ask modal, a picker,
  // chrome focus elsewhere, graph view: the disjuncts of PromptInput's
  // `disabled` in src/tui/app.tsx). Every gesture here therefore pays a host
  // round trip and/or spends a draft label number for bytes the buffer can never
  // name. An orphan payload is not cosmetic: `takeSubmission` walks only labels
  // present in the buffer, so it is never submitted, while
  // `heldPayloadCount() > 0` makes `restoreClaimedSubmission` refuse to hand a
  // rejected draft back at all.
  //
  // Asserted as the consequence the user can see, not as the gate: zero reads at
  // the seam, an untouched buffer, and — the number that carries the whole claim
  // — the next gesture the composer CAN keep still holds label #1.
  //
  // What this harness cannot express: which of the `disabled` disjuncts is the
  // cause. It drives the permission-ask modal only, because that is the disjunct
  // it can enter AND leave on demand without a submit clearing the buffer under
  // observation; a picker, chrome focus on the subagent ring, and the graph view
  // would need a slash submit or a `subagentCount` / graph snapshot this fixture
  // never injects. All of them reach the identical `editable() === false`, so one
  // of them pins the gate; the transitions in the two race cases are the real
  // thing being tested, not a stub that answers `isEditable()` on cue.
  test("禁用态的单行粘贴：零次剪贴板读取、缓冲区原样，下一次图片手势仍是 [image#1]", async () => {
    const app = await mountApp();
    try {
      await app.openAskModal();
      // The distinction this case exists for: a live textarea (an empty buffer,
      // not `null` as in the list view) and therefore a real handle whose write
      // would be dropped rather than missing.
      expect(app.text()).toBe("");
      await app.pasteText("https://example.com/screenshot.png");
      await app.settle();
      expect(app.text()).toBe("");
      // The assertion with teeth: a paste that cannot land does not ask the host
      // what the clipboard holds. Without the gate this is one round trip.
      expect(app.stub.started.length).toBe(0);
      expect(app.frame()).not.toContain("剪贴板");
      expect(app.frame()).not.toContain("[image#");
      // And the discarded gesture left no claim on the draft's numbering: the
      // first image the composer actually keeps is #1, the number an orphan
      // would have taken for a payload nothing can display.
      await app.closeAskModal();
      await app.startPendingRead();
      expect(app.stub.started.length).toBe(1);
      app.stub.settle(0, OK_A);
      await until(
        () => app.text() === "[image#1]",
        "禁用态被丢弃的粘贴占用了标签编号"
      );
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("禁用态的多行粘贴：不折叠、不占 [paste#N] 编号、不持有 payload", async () => {
    const app = await mountApp();
    try {
      await app.openAskModal();
      await app.pasteText("alpha\nbeta\ngamma");
      await app.settle();
      // Nothing reached the buffer, and the fold's summary label is nowhere on
      // screen either.
      expect(app.text()).toBe("");
      expect(app.frame()).not.toContain("[paste#");
      expect(app.stub.started.length).toBe(0);
      // The bite: the fold is computed as the ARGUMENT of the dropped write, so
      // an ungated handler spends `[paste#1]` and holds a 16-char payload for a
      // buffer that never received it. The next real fold is therefore numbered
      // #1, and what it submits carries exactly its own payload — an orphan held
      // behind it is both visible in this number and invisible to `takeSubmission`.
      await app.closeAskModal();
      await app.pasteText("one\ntwo");
      await until(
        () => app.text() === "[paste#1 · 2 lines · 7 chars]",
        "禁用态被丢弃的折叠占用了 paste 编号"
      );
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.text).toBe("one\ntwo");
      expect(app.submits[0]?.content).toBeUndefined();
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("竞态：探测在途时 composer 被禁用 → 迟到的答案不替换、不占编号，粘贴文本原样站着", async () => {
    // The race the paste-time gate alone cannot cover: the composer IS editable
    // when the paste lands, and becomes disabled while that probe's host read is
    // in flight. An ungated `receivePastedImageProbe` would match the paste's
    // bytes (they are still the whole buffer), call `addImage` — spending #1 and
    // holding a payload — and then have `replaceBuffer` drop the label. The
    // buffer would look untouched while the draft quietly kept an orphan.
    const app = await mountApp();
    try {
      app.stub.holdNextProbe();
      await app.startPendingProbe("flavor");
      expect(app.text()).toBe("flavor");
      expect(app.stub.isPending(0)).toBe(true);
      await app.openAskModal();
      // The read is still open across the transition — this is mid-flight, not
      // a gesture that arrived already disabled.
      expect(app.stub.isPending(0)).toBe(true);
      app.stub.settle(0, OK_A);
      await app.settle();
      // The paste stands exactly where the terminal put it, unlabelled, and the
      // discarded answer says nothing.
      expect(app.text()).toBe("flavor");
      expect(app.frame()).not.toContain("[image#");
      expect(app.frame()).not.toContain("剪贴板");
      // The observable that proves nothing was spent: back in an editable
      // composer, the next image is #1 and its payload is the only one attached.
      await app.closeAskModal();
      await app.startPendingRead();
      // Read #0 was the discarded probe: the chord is the SECOND read on this
      // seam, so an ungated handler would have answered it as `[image#2]`.
      expect(app.stub.started.length).toBe(2);
      app.stub.settle(1, OK_B);
      await until(
        () => (app.text() ?? "").includes("[image#1]"),
        "禁用期间丢弃的在途探测占用了标签编号"
      );
      expect(app.text()).not.toContain("[image#2]");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      // Exactly one payload crosses the boundary — the one the buffer names.
      // (Asserted as the image set, not the block order: where the chord's label
      // lands is the live caret's business, and this case is about numbering.)
      const blocks = app.submits[0]?.content ?? [];
      expect(blocks).toContainEqual(imageBlock(PNG_B));
      expect(blocks.filter((block) => block.type === "image")).toHaveLength(1);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("竞态：Ctrl+V 在途时 composer 被禁用 → 迟到的答案不折叠、不占编号", async () => {
    // The chord's own half of the same race, and the only case that reaches the
    // third gate: `receiveClipboardImage` writes its label unconditionally into
    // whatever the handle reports, so a result arriving after the composer went
    // disabled would `addImage` — spending #1 and holding a payload — and then
    // have `replaceBuffer` drop the label. Unlike the paste arms, this gesture
    // owns no buffer span to lose: the orphan is the whole cost, which is exactly
    // why the observable is the number the next real image gets.
    const app = await mountApp();
    try {
      await app.startPendingRead();
      expect(app.stub.isPending(0)).toBe(true);
      await app.openAskModal();
      expect(app.stub.isPending(0)).toBe(true);
      app.stub.settle(0, OK_A);
      await app.settle();
      expect(app.text()).toBe("");
      expect(app.frame()).not.toContain("[image#");
      expect(app.frame()).not.toContain("剪贴板");
      await app.closeAskModal();
      await app.startPendingRead();
      expect(app.stub.started.length).toBe(2);
      app.stub.settle(1, OK_B);
      await until(
        () => (app.text() ?? "").includes("[image#1]"),
        "禁用期间丢弃的 chord 结果占用了标签编号"
      );
      expect(app.text()).not.toContain("[image#2]");
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

describe("手势顺序与草稿生命周期", () => {
  test("两次连按 Ctrl+V：读取串行，编号与提交顺序跟着按键顺序", async () => {
    const app = await mountApp();
    try {
      await app.startPendingRead();
      // Rapid second press, before the first read has any answer.
      app.setup.mockInput.pressKey("v", { ctrl: true });
      await app.settle();
      expect(app.stub.started.length).toBe(1);
      app.stub.settle(0, OK_A);
      await until(() => app.text() === "[image#1]", "第一张图未落进缓冲区");
      // The queued press starts only now, so it can never be numbered first.
      await until(() => app.stub.started.length === 2, "第二次读取未启动");
      app.stub.settle(1, OK_B);
      await until(
        () => app.text() === "[image#1][image#2]",
        "第二张图未落进缓冲区"
      );
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.content).toEqual([
        imageBlock(PNG_A),
        imageBlock(PNG_B),
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("order: 先粘贴（图片副本）再 Ctrl+V → 串行、编号与提交顺序跟着按键顺序", async () => {
    const app = await mountApp();
    try {
      app.stub.holdNextProbe();
      await app.startPendingProbe("flavor-a");
      expect(app.text()).toBe("flavor-a");
      // Chord pressed while the probe read is in flight — it must line up
      // behind it, never open a second concurrent host read.
      app.setup.mockInput.pressKey("v", { ctrl: true });
      await app.settle();
      expect(app.stub.started.length).toBe(1);
      app.stub.settle(0, OK_A);
      await until(() => app.text() === "[image#1]", "粘贴图片标签未落进缓冲区");
      await until(
        () => app.stub.started.length === 2,
        "排队中的 Ctrl+V 未启动"
      );
      app.stub.settle(1, OK_B);
      await until(
        () => app.text() === "[image#1][image#2]",
        "chord 图片标签未落进缓冲区"
      );
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.content).toEqual([
        imageBlock(PNG_A),
        imageBlock(PNG_B),
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("order: 先 Ctrl+V（答完）再粘贴（图片副本）→ 串行、编号与提交顺序跟着按键顺序", async () => {
    // The gesture pair the user actually makes at a readable pace: the chord is
    // answered before the paste starts, so the paste's text lands after the
    // label and its probe substitutes at the offset it recorded. Both labels
    // keep press order in the buffer and in the submitted blocks.
    const app = await mountApp();
    try {
      await app.startPendingRead();
      app.stub.settle(0, OK_A);
      await until(() => app.text() === "[image#1]", "chord 标签未落进缓冲区");
      app.stub.holdNextProbe();
      await app.pasteText("flavor-b");
      await until(() => app.stub.started.length === 2, "粘贴探测未启动");
      expect(app.text()).toBe("[image#1]flavor-b");
      app.stub.settle(1, OK_B);
      await until(
        () => app.text() === "[image#1][image#2]",
        "粘贴标签未落进缓冲区"
      );
      expect(app.text()).not.toContain("flavor-b");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.content).toEqual([
        imageBlock(PNG_A),
        imageBlock(PNG_B),
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("order（已知倒置）: 先 Ctrl+V 再粘贴（探测重叠）→ 编号仍按按键顺序，缓冲区位置与提交块序相反", async () => {
    // Pinned as OBSERVED, not as intended, so a fix shows up here as a failure
    // rather than as a silent edit. Why it inverts: the chord writes its label
    // at the caret as it is on arrival, and by then the synchronous paste has
    // already pushed that caret past its own text; the probe then substitutes
    // in place at the offset the paste recorded, i.e. *before* the chord's
    // label. Numbering still follows press order (#1 is the chord that was
    // pressed first) and every payload stays behind its own label — but the
    // buffer reads `[image#2][image#1]`, and submission takes payloads in
    // buffer order, so the model receives them reversed. The non-overlapping
    // direction above keeps both properties.
    const app = await mountApp();
    try {
      await app.startPendingRead();
      expect(app.stub.isPending(0)).toBe(true);
      app.stub.holdNextProbe();
      await app.pasteText("flavor-b");
      // The paste is on screen before anything has been answered, and its probe
      // has not even started: the chord owns the queue.
      expect(app.text()).toBe("flavor-b");
      expect(app.stub.started.length).toBe(1);
      app.stub.settle(0, OK_A);
      await until(
        () => app.stub.started.length === 2,
        "排队中的粘贴探测未启动"
      );
      // The chord landed after the pasted text, at the live caret.
      expect(app.text()).toBe("flavor-b[image#1]");
      app.stub.settle(1, OK_B);
      await until(
        () => app.text() === "[image#2][image#1]",
        "粘贴标签未在原位替换"
      );
      expect(app.text()).not.toContain("flavor-b");
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.text).toBe("");
      expect(app.submits[0]?.content).toEqual([
        imageBlock(PNG_B),
        imageBlock(PNG_A),
      ]);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("discard: 读取在途时提交清空草稿 → 迟到的结果不落进缓冲区", async () => {
    const app = await mountApp();
    try {
      await app.type("hi");
      await app.startPendingRead();
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.text()).toBe("");
      // Resolved, not cancelled: the abort cannot reach a read that already has
      // its bytes, so only the caller's generation token can discard it.
      app.stub.settle(0, OK_A);
      await app.settle();
      expect(app.text()).toBe("");
      await app.type("next");
      await app.pressEnter();
      await until(() => app.submits.length === 2, "第二次提交未抵达 bridge");
      expect(app.submits[1]?.content).toBeUndefined();
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("discard: 读取在途时 Ctrl+C 清空草稿 → 迟到的结果不落进缓冲区", async () => {
    const app = await mountApp();
    try {
      await app.type("hi");
      await app.startPendingRead();
      app.setup.mockInput.pressKey("c", { ctrl: true });
      await until(() => app.text() === "", "Ctrl+C 未清空草稿");
      // Invalidation reaches the host read too, not just the result: a wedged
      // interop process is abandoned rather than kept running for nothing.
      expect(app.stub.started[0]?.signal?.aborted).toBe(true);
      app.stub.settle(0, OK_A);
      await app.settle();
      expect(app.text()).toBe("");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("discard: 删除 [image#1] 单元后，迟到的第二张图不落进缓冲区", async () => {
    const app = await mountApp();
    try {
      await app.startPendingRead();
      app.stub.settle(0, OK_A);
      await until(() => app.text() === "[image#1]", "第一张图未落进缓冲区");
      await app.startPendingRead();
      app.setup.mockInput.pressBackspace();
      await until(() => app.text() === "", "标签未作为一个单元删除");
      app.stub.settle(1, OK_B);
      await app.settle();
      expect(app.text()).toBe("");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("discard: 排队中的第二次按键在失效后不再启动读取", async () => {
    const app = await mountApp();
    try {
      await app.type("hi");
      await app.startPendingRead();
      // Queued behind the first read — it has not touched the reader yet.
      app.setup.mockInput.pressKey("v", { ctrl: true });
      await app.settle();
      expect(app.stub.started.length).toBe(1);
      app.setup.mockInput.pressKey("c", { ctrl: true });
      await until(() => app.text() === "", "Ctrl+C 未清空草稿");
      app.stub.settle(0, OK_A);
      await app.settle();
      // Neither press landed a label, and the queued one never started a host
      // read at all: an invalidation stops the queue, not just the open read.
      expect(app.stub.started.length).toBe(1);
      expect(app.text()).toBe("");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("discard: 会话切换后，迟到的结果不落进新会话的 composer", async () => {
    // The list view's first row (Enter ≡ /new) is the only session switch that
    // does not submit on the way, so the discard below has one possible cause.
    const app = await mountApp({
      view: "list",
      session: { ...createDraftSession(), conversationId: "conv-seeded" },
    });
    try {
      await app.startPendingRead();
      app.setup.mockInput.pressEnter();
      await settleFrame(app.setup);
      // The composer is mounted again and empty: without the switch
      // invalidating the read, this is exactly where the label would land.
      expect(app.text()).toBe("");
      app.stub.settle(0, OK_A);
      await settleFrame(app.setup);
      expect(app.text()).toBe("");
      expect(app.frame()).not.toContain("[image#1]");
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

describe("粘贴探测的迟到结果被丢弃", () => {
  // The probe shares the chord's invalidation, but what a discard means is
  // narrower than it was: the paste's text is already the user's buffer, so a
  // discarded answer drops only the substitution. Nothing late is inserted and
  // nothing already there is taken away.
  //
  // Session switch is the one invalidation not covered on this path, and it
  // cannot be: the composer only mounts in the chat view (a paste with no
  // composer neither inserts nor queues a probe — pinned above), and every route
  // out of the chat view to another session goes through submit, which already
  // discards the draft on its own. The switch itself is pinned on the chord path
  // ("会话切换后，迟到的结果不落进新会话的 composer").
  test("discard: 探测在途时 Ctrl+C 清空草稿 → 迟到的答案不再替换任何东西", async () => {
    const app = await mountApp();
    try {
      app.stub.holdNextProbe();
      await app.startPendingProbe("later text");
      expect(app.text()).toBe("later text");
      app.setup.mockInput.pressKey("c", { ctrl: true });
      await until(() => app.text() === "", "Ctrl+C 未清空草稿");
      // Invalidation reaches the in-flight probe read, not just its answer.
      expect(app.stub.started[0]?.signal?.aborted).toBe(true);
      app.stub.settle(0, OK_A);
      await app.settle();
      // The clear was the user's own hand: the discarded answer neither puts
      // the text back nor labels the empty composer.
      expect(app.text()).toBe("");
      expect(app.frame()).not.toContain("[image#1]");
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("discard: 删除 [image#1] 单元后，迟到的粘贴探测结果不落进缓冲区", async () => {
    const app = await mountApp();
    try {
      app.stub.answerNextProbe(OK_A);
      await app.pasteText("flavor one");
      await until(() => app.text() === "[image#1]", "第一张图未落进缓冲区");
      app.stub.holdNextProbe();
      await app.startPendingProbe("flavor two");
      // The caret sits after the second paste; step onto the label's right edge
      // and one backspace takes the whole unit — and with it the draft the
      // pending probe was queued for.
      await app.moveHome();
      await app.moveRight(1);
      await app.backspace(1);
      await until(() => app.text() === "flavor two", "标签未作为一个单元删除");
      app.stub.settle(1, OK_B);
      await app.settle();
      // The label is gone and its late sibling never arrives, but the text the
      // second paste carried is the user's now: it stays, unlabelled.
      expect(app.text()).toBe("flavor two");
      expect(app.frame()).not.toContain("[image#2]");
      // No phantom attachment behind the surviving text.
      await app.pressEnter();
      await until(() => app.submits.length === 1, "提交未抵达 bridge");
      expect(app.submits[0]?.text).toBe("flavor two");
      expect(app.submits[0]?.content).toBeUndefined();
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("discard: 排队中的粘贴探测在失效后根本不启动读取", async () => {
    // The paste-path mirror of "排队中的第二次按键在失效后不再启动读取": the
    // probe queued behind a chord read is stopped at the queue, not just at the
    // answer, so an invalidated draft never pays for a host round trip.
    const app = await mountApp();
    try {
      await app.startPendingRead();
      app.stub.holdNextProbe();
      await app.pasteText("queued flavor");
      await app.settle();
      expect(app.text()).toBe("queued flavor");
      // Queued behind the chord read — it has not touched the reader yet.
      expect(app.stub.started.length).toBe(1);
      app.setup.mockInput.pressKey("c", { ctrl: true });
      await until(() => app.text() === "", "Ctrl+C 未清空草稿");
      app.stub.settle(0, OK_A);
      await app.settle();
      expect(app.stub.started.length).toBe(1);
      expect(app.text()).toBe("");
    } finally {
      await app.destroy();
    }
  }, 30_000);
});

describe("Ctrl+V 按下时 composer 已经禁用：花一次读取，不花标签", () => {
  // The half of the gate the race case in `composer 挂载但不可写` cannot reach:
  // there the chord is pressed while the composer is EDITABLE and the modal only
  // arrives mid-flight, so `receiveClipboardImage` is met by a composer that went
  // disabled. Here the composer is already disabled BEFORE the press, which is the
  // combination the caveat in plans/tui-composer.md and CHANGELOG.md describes and
  // which nothing pinned until now.
  //
  // The asymmetry is deliberate, so it is asserted as the cost it really is and
  // not as the zero the paste arms promise. The chord has no entry `isEditable()`
  // gate because its result is the only thing that could ever tell the user
  // anything about the clipboard — a bitmap sitting under a screenshot shortcut is
  // exactly the case with no paste to carry a text flavor — and gating the press
  // would change pre-existing Ctrl+V behaviour beyond this issue. So one host read
  // IS started. What the delivery gate owes instead is that the accepted bytes
  // never become a draft write.
  //
  // Same observable as every other case in this file, because it is the only one
  // that proves the whole claim: an ungated handler would call `addImage` —
  // spending #1 and holding a payload `takeSubmission` can never find in a buffer
  // that never named it — then have `insertText` drop the label. The buffer would
  // look untouched while the draft kept an orphan that both renumbers the next
  // image to #2 and makes `restoreClaimedSubmission` refuse a rejected draft.
  test("已禁用时按下 Ctrl+V：一次读取、零次落笔、不报剪贴板，modal 收起后下一张图仍是 [image#1]", async () => {
    const app = await mountApp();
    try {
      await app.openAskModal();
      // Mounted and empty, not absent: a live textarea whose imperative write
      // would be dropped rather than missing, which is what makes the delivery
      // gate the only thing standing between these bytes and an orphan.
      expect(app.text()).toBe("");
      // The documented cost, paid: the press reaches the seam even though nothing
      // can be written. `startPendingRead` is the harness's own press-and-wait, so
      // this line also proves the chord is not swallowed by the modal.
      await app.startPendingRead();
      expect(app.stub.started.length).toBe(1);
      expect(app.stub.isPending(0)).toBe(true);
      // Answer with a bitmap the composer would have taken: the refusal is the
      // gate, not the host having nothing to give.
      app.stub.settle(0, OK_A);
      await app.settle();
      expect(app.text()).toBe("");
      expect(app.frame()).not.toContain("[image#");
      expect(app.frame()).not.toContain("剪贴板");
      // The refund. Back in an editable composer the next image still gets #1 —
      // read #0 is the discarded press, so this is the SECOND read on the seam and
      // an ungated handler would have answered it as `[image#2]`.
      await app.closeAskModal();
      await app.startPendingRead();
      expect(app.stub.started.length).toBe(2);
      app.stub.settle(1, OK_B);
      await until(
        () => (app.text() ?? "").includes("[image#1]"),
        "禁用态按下的 Ctrl+V 占用了标签编号"
      );
      expect(app.text()).not.toContain("[image#2]");
    } finally {
      await app.destroy();
    }
  }, 30_000);
});
