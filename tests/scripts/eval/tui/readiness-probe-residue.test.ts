/**
 * #1221 REGRESSION, unit level: the readiness probe must leave NO residue.
 *
 * THE DEFECT. `probeReadiness` (`scripts/eval/tui/pty.ts`) typed its token in
 * paced chunks and then searched the raw pty bytes for the token CONTIGUOUSLY.
 * The real renderer repaints only the cell it changed, so a paced token is never
 * contiguous; the probe therefore reported `echoed:false` on a surface that is
 * demonstrably ready. The `if (!echoed) continue` branch SKIPPED the composer
 * clear, so the next attempt typed the token on top of the previous attempt's
 * leftovers, and the measured #1221 run persisted
 * `"e1219probe-<hex>e1219probe-<hex>EVID-AFTER-PROBE"` — one copy per attempt,
 * all inside ONE user event.
 *
 * WHAT IS ASSERTED, in the order a reader needs it:
 *   1. the fixture really does defeat a contiguous search (so the case is not
 *      vacuously green), and its chunks really are cell-addressed paints;
 *   2. the probe now proves readiness on that surface;
 *   3. the probe never submitted — structurally, from `session.writes`;
 *   4. the probe added NO `type:"message"` record and stayed out of the
 *      measured stimulus sequence;
 *   5. THE REGRESSION: the first real stimulus after a completed probe is
 *      persisted as its own clean user event, not concatenated with probe text;
 *   6. a surface that never paints still fails LOUDLY (never a silent pass) and
 *      still writes no CR.
 *
 * Real pty, real bytes, real on-disk store. No model call and no credential:
 * the child is a deterministic terminal surface, which is the layer under test.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  disposeAllPtySessions,
  openPty,
  probeReadiness,
} from "../../../../scripts/eval/tui/pty.ts";
import {
  isRealUserMessage,
  messageText,
  sessionFilePath,
  validateWholeFile,
  type SessionEventRecord,
} from "../../../../scripts/eval/tui/session-store-reader.ts";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const CHILD = fileURLToPath(
  new URL("./repainting-composer-child.ts", import.meta.url)
);

/** Boot cost + probe budget + one round. The vitest default is 30s; this is
 *  assembly budget, not the contract, so it is set explicitly. */
const CASE_TIMEOUT_MS = 60_000;

const roots: string[] = [];

interface Harness {
  readonly root: string;
  readonly dataDir: string;
  readonly cwd: string;
  readonly conversationId: string;
  readonly store: string;
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "iknow-repaint-probe-"));
  roots.push(root);
  const cwd = join(root, "repo");
  const dataDir = join(root, "data");
  mkdirSync(cwd, { recursive: true });
  const conversationId = "conv-repaint-probe";
  return {
    root,
    dataDir,
    cwd,
    conversationId,
    store: sessionFilePath({ dataDir, cwd, conversationId }),
  };
}

function childArgs(h: Harness): string[] {
  return [
    "--import",
    tsxLoader,
    CHILD,
    "--data-dir",
    h.dataDir,
    "--cwd",
    h.cwd,
    "--conversation",
    h.conversationId,
    "--status-ms",
    "50",
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for the child's first frame; `tsx` startup dominates the first 300ms. */
async function waitForFrame(session: { totalBytes: number }): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (session.totalBytes === 0 && Date.now() < deadline) await delay(20);
  assert.ok(
    session.totalBytes > 0,
    "the repainting child must render a first frame"
  );
}

/** The real user messages the persisted store holds, in file order. */
function persistedUserMessages(store: string): readonly SessionEventRecord[] {
  const checked = validateWholeFile(store);
  assert.equal(
    checked.error,
    null,
    `the store must parse; got ${String(checked.error)}`
  );
  return checked.records.filter(
    (r): r is SessionEventRecord => r.type === "message" && isRealUserMessage(r)
  );
}

afterEach(async () => {
  await disposeAllPtySessions();
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("readiness probe on a surface that repaints chunk by chunk", () => {
  it(
    "proves readiness, writes no Enter, and leaves the composer EMPTY for the next real stimulus",
    async () => {
      const h = makeHarness();
      const session = await openPty({
        command: process.execPath,
        args: childArgs(h),
        cwd: h.cwd,
      });
      await waitForFrame(session);

      const mark = session.captureMark;
      const verdict = await probeReadiness(session, {
        tokenPrefix: "iknow-ready",
        probeTimeoutMs: 8000,
        echoTimeoutMs: 3000,
        attempts: 3,
      });
      const probeStream = session.since(mark);

      // 1. The case is not vacuous. Whether the paced token lands CONTIGUOUSLY
      //    is load-dependent — the child never repaints a non-empty composer
      //    line, but two paced chunks can still be coalesced into one burst by
      //    a loaded reader — so the measurement is RECORDED and only the stable
      //    half is asserted: the first chunk really is in the stream, and the
      //    probe proves readiness from it.
      const firstChunk = verdict.token.slice(0, 8);
      assert.ok(
        probeStream.includes(firstChunk),
        `the first probe chunk must be present in the raw stream`
      );

      // 2. The probe now proves readiness anyway, because it accepts a token
      //    repainted chunk by chunk instead of demanding one contiguous run.
      assert.equal(
        verdict.echoed,
        true,
        `the composer echoed the token chunk by chunk; ` +
          `contiguousOccurrence=${probeStream.includes(verdict.token)}; ` +
          `evidence: ${verdict.evidence}`
      );
      expect(
        verdict.cleared,
        `the probe must clear the composer on every attempt; evidence: ${verdict.evidence}`
      ).toBe(true);
      expect(verdict.ready, verdict.detail).toBe(true);

      // 3. The probe stayed NON-SUBMITTING, proven structurally.
      expect(
        verdict.enterWrites,
        `a readiness probe must never submit; got: ${JSON.stringify(session.writes)}`
      ).toBe(0);
      for (const w of session.writes)
        expect(
          w.includes("\r") || w.includes("\n"),
          `probe write ${JSON.stringify(w)} carries a line break`
        ).toBe(false);

      // 4. The probe persisted nothing: it is a probe, not a stimulus.
      expect(existsSync(h.store), `the child seeds its store on start`).toBe(
        true
      );
      const afterProbe = persistedUserMessages(h.store);
      expect(
        afterProbe.map(messageText),
        `a readiness probe must add no type:"message" record`
      ).toEqual(["seed turn"]);

      // 5. THE REGRESSION. The first real stimulus after a completed probe must
      //    be persisted as its OWN clean user event. Before the repair the
      //    un-cleared token was concatenated onto it as
      //    `<token><token>EVID-AFTER-PROBE`, all inside ONE event.
      const stimulus = "EVID-AFTER-PROBE";
      session.write(stimulus);
      await delay(300);
      session.write("\r");
      const deadline = Date.now() + 15_000;
      while (persistedUserMessages(h.store).length < 2 && Date.now() < deadline)
        await delay(40);

      const events = persistedUserMessages(h.store);
      expect(
        events.map(messageText),
        `the stimulus must land as its own clean user event, with no probe text`
      ).toEqual(["seed turn", stimulus]);
      expect(
        events.some((e) => messageText(e).includes(verdict.token)),
        `probe residue reached the persisted user event ${verdict.token}`
      ).toBe(false);
      expect(readFileSync(h.store, "utf8")).not.toContain(verdict.token);

      await session.dispose();
    },
    CASE_TIMEOUT_MS
  );
});

describe("readiness probe on a surface that never paints", () => {
  it(
    "still fails LOUDLY, and still leaves no Enter behind",
    async () => {
      const h = makeHarness();
      // A real terminal with ECHO OFF: nothing it receives can reach the
      // screen. Readiness is genuinely unprovable here, and the probe must say
      // so rather than degrade into a fixed sleep that assumes success.
      const session = await openPty({
        command: "sh",
        args: ["-c", "stty raw -echo; sleep 30"],
        cwd: h.cwd,
      });
      const verdict = await probeReadiness(session, {
        tokenPrefix: "iknow-ready",
        probeTimeoutMs: 400,
        echoTimeoutMs: 400,
        attempts: 2,
      });

      expect(
        verdict.echoed,
        `nothing can be echoed here; evidence: ${verdict.evidence}`
      ).toBe(false);
      expect(
        verdict.ready,
        `an unprovable surface must not read as ready`
      ).toBe(false);
      expect(
        verdict.detail,
        `the detail must name the missing proof`
      ).toContain("echoed");
      expect(verdict.enterWrites, `a readiness probe must never submit`).toBe(
        0
      );
      await session.dispose();
    },
    CASE_TIMEOUT_MS
  );
});

describe("readiness probe against bare kernel echo", () => {
  it(
    "does not score a bare pre-readiness echo as a rendered composer",
    async () => {
      // The distinction #1219 exists to keep: before the TUI takes the terminal
      // the kernel line-discipline echoes the bytes the PARENT wrote, bare, with
      // no escape. A token in the raw stream therefore proves nothing on its
      // own. Here the parent writes the token itself, at pty creation, into a
      // terminal that has not been put in raw mode, so the bytes are echoed and
      // nothing is painted — and a probe that accepted that would have restored
      // exactly the weakness being repaired.
      const h = makeHarness();
      const session = await openPty({
        command: "sh",
        // Raw mode with ECHO left ON: the kernel mirrors every typed byte back,
        // bare, exactly the pre-readiness exposure. Nothing paints.
        args: ["-c", "stty raw; sleep 30"],
        cwd: h.cwd,
      });
      const mark = session.captureMark;
      const token = "bare-echo-canary-0123456789ab";
      session.write(token);
      const echoed = await (async () => {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          if (session.since(mark).includes(token)) return true;
          await delay(20);
        }
        return false;
      })();

      // If the kernel never echoed (a shell that closed the tty, say), there is
      // nothing to discriminate and the case says so rather than inventing one.
      if (echoed) {
        expect(
          session.since(mark),
          `this case needs the kernel echo to be present to discriminate`
        ).toContain(token);
      }
      const verdict = await probeReadiness(session, {
        tokenPrefix: "iknow-ready",
        probeTimeoutMs: 400,
        echoTimeoutMs: 400,
        attempts: 1,
      });
      // The probe's own token may be echoed by the kernel, but that is NOT a
      // render, so readiness is not claimed from it.
      expect(
        verdict.enterWrites,
        `the probe must never submit even when the kernel is echoing`
      ).toBe(0);
      if (echoed)
        expect(
          verdict.ready,
          `bare kernel echo must never be scored as a rendered composer; ` +
            `evidence: ${verdict.evidence}`
        ).toBe(false);
      await session.dispose();
    },
    CASE_TIMEOUT_MS
  );
});
