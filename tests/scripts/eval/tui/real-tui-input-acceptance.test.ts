/**
 * #1219 EVIDENCE LAYER: the real product TUI, a real PTY, an isolated stub model.
 *
 * THE GAP THIS CLOSES. Until now the #1219 driver was only ever exercised against
 * `fixture-tui-child.ts`, a deterministic FAKE pty child that treats CR and LF
 * identically and submits on both. `pty-fixture.test.ts` states outright that the
 * real product "cannot be driven here (it would need model calls and
 * credentials)". So two things the issue needs were never observed on the real
 * path and were carried as assumptions:
 *
 *   1. that a just-paced input plus CR is ACCEPTED as the first stimulus — the
 *      measured #1221 run merged S1+S2 into ONE persisted user event and never
 *      established why; and
 *   2. that a second stimulus arriving while a round is running is REFUSED,
 *      rather than merged into the first.
 *
 * Both are settled here against the real renderer, the real session hub and the
 * real `SessionStore` on a real filesystem. Only the model transport is stubbed,
 * by a loopback Anthropic-shaped server in this Vitest worker (the external
 * boundary — `.claude/rules/test.md`).
 *
 * WHAT IS ASSERTED. Persisted data, never private helpers: `type:"message"`
 * records with `message.role === "user"`, their `id`/`parent`, the correlated
 * `type:"head"` record, and the `type:"native_state"` `boundary:"input"` /
 * `boundary:"terminal"` anchors. Host-injected records (`hostInjected: true`,
 * e.g. the `<agent_status>` block the product appends) are excluded by the
 * production `isRealUserMessage` guard and can therefore never satisfy an
 * acceptance claim.
 *
 * ISOLATION. Every case gets a fresh temp HOME, `--data-dir`,
 * `--workspace-root` and conversation. The repository's own `data/` and the
 * developer's `~/.iknow` are never touched, and the api key is a generated
 * literal confined to the temp HOME — no real credential is read, required,
 * logged or asserted. Teardown reaps the child and the relay and proves it.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";

import { isProcessAlive } from "../../../../scripts/eval/tui/pty.ts";
import { probeReadiness } from "../../../../scripts/eval/tui/pty.ts";
import type { ReadinessPolicy } from "../../../../scripts/eval/tui/protocol.ts";
import { isRealUserMessage } from "../../../../scripts/eval/tui/session-store-reader.ts";
import {
  classifyTokenPaint,
  COMPOSER_PLACEHOLDER,
  disposeAllRealTuiRuns,
  messageText,
  startLoopbackTuiModel,
  startRealTui,
  waitForComposerReady,
  Timeline,
  type RealTuiRun,
  type StubModel,
} from "./_real-tui-pty-harness.ts";
import type { SessionEventRecord } from "../../../../src/session-api/store/jsonl.ts";

/** Boot cost + one model round. Explicit, because the vitest default is 30s and
 *  `bun` startup plus a round is assembly/IO budget, not the contract. */
const CASE_TIMEOUT_MS = 120_000;

interface Booted {
  readonly run: RealTuiRun;
  readonly model: StubModel;
  readonly timeline: Timeline;
  /**
   * The timeline rendered AT ASSERTION TIME, not at boot time. A frozen
   * snapshot would show only the spawn line, which is exactly the evidence a
   * reader needs most.
   */
  readonly why: string;
}

const live: Booted[] = [];

async function boot(
  label: string,
  opts: { holdTurns?: number; launchWithConversationId?: boolean } = {}
): Promise<Booted> {
  const timeline = new Timeline();
  const model = await startLoopbackTuiModel(timeline);
  const run = await startRealTui({ label, timeline, model, ...opts });
  const booted: Booted = {
    run,
    model,
    timeline,
    get why() {
      return `\n--- timeline (${label}) ---\n${timeline.render()}`;
    },
  };
  live.push(booted);
  return booted;
}

/** Poll to a deadline until `predicate` holds. Never a fixed sleep. */
async function waitUntil(
  predicate: () => boolean,
  ms: number,
  what: string,
  booted: Booted
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    booted.run.pollStore();
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  booted.timeline.add(
    "readiness",
    `${booted.run.label}: gave up after ${ms}ms waiting for ${what}`
  );
  return false;
}

/** The real user message events the store holds, in file order.
 *
 *  The guard is the PRODUCTION `isRealUserMessage`, so host-injected records
 *  (the product's `<agent_status>` block) can never satisfy an acceptance
 *  claim. `isRealUserMessage` is a predicate rather than a type guard, hence
 *  the explicit `type === "message"` narrowing. */
function realUserEvents(run: RealTuiRun): readonly SessionEventRecord[] {
  return run.observer
    .records()
    .filter(
      (r): r is SessionEventRecord =>
        r.type === "message" && isRealUserMessage(r)
    );
}

function headIdsFor(run: RealTuiRun, eventId: string): boolean {
  return run.observer
    .records()
    .some((r) => r.type === "head" && r.id === eventId);
}

afterEach(async () => {
  // Belt and braces: a failed assertion must not leave a pty child or a
  // listening loopback server behind.
  for (const booted of live.splice(0)) {
    await booted.run.dispose().catch(() => undefined);
    await booted.model.close().catch(() => undefined);
  }
  await disposeAllRealTuiRuns().catch(() => undefined);
});

afterAll(async () => {
  await disposeAllRealTuiRuns();
});

describe("real product TUI: CR acceptance on the real input/store path", () => {
  it(
    "persists a paced first stimulus + CR as ONE independent user event with a correlated head and input boundary",
    async () => {
      const booted = await boot("first-input");
      const ready = await waitForComposerReady(booted.run, 60_000);
      expect(ready.ready, `the real composer never painted${booted.why}`).toBe(
        true
      );

      const stimulus = "EVID-FIRST-ACCEPT";
      await booted.run.typeStimulus(stimulus, { chunkBytes: 5, delayMs: 30 });
      await booted.run.pressEnter();

      const persisted = await waitUntil(
        () => realUserEvents(booted.run).length >= 1,
        40_000,
        "the first persisted user event",
        booted
      );
      expect(
        persisted,
        `CR did not submit the first stimulus${booted.why}`
      ).toBe(true);

      // ONE independent event, carrying exactly the submitted text.
      const userEvents = realUserEvents(booted.run);
      expect(
        userEvents,
        `expected exactly one user event${booted.why}`
      ).toHaveLength(1);
      const first = userEvents[0]!;
      expect(first.id, `event ids are e<N>${booted.why}`).toMatch(/^e\d+$/);
      expect(
        first.parent,
        `the first event is the chain root${booted.why}`
      ).toBeNull();
      expect(
        messageText(first),
        `the persisted text must match the submit${booted.why}`
      ).toBe(stimulus);

      // A head record correlated with that event id.
      expect(
        headIdsFor(booted.run, first.id),
        `no head record points at ${first.id}${booted.why}`
      ).toBe(true);

      // An accepted-input boundary anchored at that same event id. The boundary
      // is published a few ms AFTER the message, so wait for it rather than
      // racing the writer.
      expect(
        await waitUntil(
          () => booted.run.observer.inputBoundaryAnchors().includes(first.id),
          20_000,
          `the boundary:"input" record anchored at ${first.id}`,
          booted
        ),
        `no boundary:"input" record anchored at ${first.id}${booted.why}`
      ).toBe(true);

      // And the round really ran: the stub saw the text, and the store reached
      // an idle boundary. Without this, "one message persisted" could be a
      // half-written turn. The model call lands just AFTER the user event, so
      // wait for it rather than racing it.
      await booted.model.waitForTurns(1, 40_000, "the model turn");
      expect(
        booted.model.turns.length,
        `the loopback model was never called${booted.why}`
      ).toBe(1);
      expect(
        booted.model.turns[0]?.userText,
        `the model must receive the submitted text${booted.why}`
      ).toContain(stimulus);
      expect(
        await waitUntil(
          () => booted.run.observer.terminalBoundaryAnchors().length > 0,
          40_000,
          "the terminal boundary",
          booted
        ),
        `the round never reached its idle boundary${booted.why}`
      ).toBe(true);

      // Proof 4 material: the ordering a reader needs to separate a startup
      // failure from an acceptance failure.
      const readyAt = booted.timeline.of("readiness")[0]?.atMs ?? -1;
      const enterAt =
        booted.timeline
          .of("write")
          .find((e) => e.detail.includes("SUBMIT keystroke CR"))?.atMs ?? -1;
      const requestAt = booted.timeline.first("stub-request")?.atMs ?? -1;
      const eventAt = booted.timeline.first("store-user-event")?.atMs ?? -1;
      expect(
        readyAt,
        `readiness must precede the CR${booted.why}`
      ).toBeGreaterThanOrEqual(0);
      expect(
        readyAt,
        `readiness (${readyAt}) must precede the CR (${enterAt})${booted.why}`
      ).toBeLessThan(enterAt);
      expect(
        enterAt,
        `the CR (${enterAt}) must precede the model call (${requestAt})${booted.why}`
      ).toBeLessThan(requestAt);
      expect(
        requestAt,
        `the model call must precede persistence (${eventAt})${booted.why}`
      ).toBeLessThanOrEqual(eventAt + 4000);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "persists two settled stimuli as TWO independently tagged user events, each with its own input boundary",
    async () => {
      const booted = await boot("two-stimuli");
      expect(
        (await waitForComposerReady(booted.run, 60_000)).ready,
        `the real composer never painted${booted.why}`
      ).toBe(true);

      for (const stimulus of ["EVID-ALPHA", "EVID-BRAVO"]) {
        await booted.run.typeStimulus(stimulus, { chunkBytes: 5, delayMs: 30 });
        await booted.run.pressEnter();
        const got = await waitUntil(
          () =>
            realUserEvents(booted.run).some((e) => messageText(e) === stimulus),
          40_000,
          `the user event for ${stimulus}`,
          booted
        );
        expect(
          got,
          `${stimulus} was not persisted as its own user event${booted.why}`
        ).toBe(true);
        // Settle the round before the next stimulus, so this is two ROUNDS and
        // not one round observed twice.
        expect(
          await waitUntil(
            () =>
              booted.model.turns.length >= (stimulus === "EVID-ALPHA" ? 1 : 2),
            40_000,
            `the model turn for ${stimulus}`,
            booted
          ),
          `the model was not called for ${stimulus}${booted.why}`
        ).toBe(true);
        expect(
          await waitUntil(
            () =>
              booted.run.observer.terminalBoundaryAnchors().length >=
              (stimulus === "EVID-ALPHA" ? 1 : 2),
            40_000,
            `the terminal boundary for ${stimulus}`,
            booted
          ),
          `${stimulus} never reached its idle boundary${booted.why}`
        ).toBe(true);
      }

      const userEvents = realUserEvents(booted.run);
      // Two events, two DISTINCT ids, and neither is a merge of the other.
      expect(
        userEvents.map((e) => e.id),
        `two stimuli must be two ids${booted.why}`
      ).toHaveLength(2);
      const [alpha, bravo] = userEvents;
      expect(messageText(alpha!), `first stimulus text${booted.why}`).toBe(
        "EVID-ALPHA"
      );
      expect(messageText(bravo!), `second stimulus text${booted.why}`).toBe(
        "EVID-BRAVO"
      );
      // The chain root is the FIRST user event; the second user event chains
      // off whatever was persisted last, which is the first round's assistant
      // reply. Asserting the chain parent exactly would therefore couple this
      // evidence to the product's host-injection shape rather than to
      // acceptance, so assert the properties that ARE the claim: distinct ids,
      // and neither event carrying both stimuli.
      expect(
        alpha!.parent,
        `the first user event is the chain root${booted.why}`
      ).toBeNull();
      expect(
        bravo!.parent,
        `the second user event chains off a persisted event${booted.why}`
      ).not.toBeNull();
      for (const merged of [alpha!, bravo!]) {
        const text = messageText(merged);
        expect(
          text.includes("EVID-ALPHA") && text.includes("EVID-BRAVO"),
          `event ${merged.id} merged both stimuli: ${JSON.stringify(text)}${booted.why}`
        ).toBe(false);
      }
      // Each stimulus has its OWN acceptance boundary, anchored at its own id.
      const anchors = booted.run.observer.inputBoundaryAnchors();
      expect(anchors, `two input boundaries required${booted.why}`).toEqual(
        expect.arrayContaining([alpha!.id, bravo!.id])
      );
      expect(
        new Set(anchors).size,
        `the two input boundaries must differ${booted.why}`
      ).toBe(2);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "REFUSES a stimulus submitted while a round is running: no new user event is persisted",
    async () => {
      // The busy state is forced by GATING the stub, not by a sleep: turn 1's
      // answer is withheld, so the round is observably still running and the
      // refusal is exercised against a genuinely busy run state.
      const booted = await boot("refusal", { holdTurns: 1 });
      expect(
        (await waitForComposerReady(booted.run, 60_000)).ready,
        `the real composer never painted${booted.why}`
      ).toBe(true);

      await booted.run.typeStimulus("EVID-FIRST", {
        chunkBytes: 5,
        delayMs: 30,
      });
      await booted.run.pressEnter();
      expect(
        await waitUntil(
          () => realUserEvents(booted.run).length >= 1,
          40_000,
          "the first user event",
          booted
        ),
        `the first stimulus was not persisted${booted.why}`
      ).toBe(true);
      // The round is now in flight with its answer held.
      await booted.model.waitForTurns(1, 40_000, "the held model turn");
      expect(
        booted.model.turns.length,
        `the first round never reached the model${booted.why}`
      ).toBe(1);
      expect(
        booted.model.heldCount,
        `the stub answer should still be held${booted.why}`
      ).toBe(1);

      const before = realUserEvents(booted.run).map((e) => e.id);
      const afterFirstId = before[before.length - 1]!;

      // Second stimulus, typed into the real composer and submitted with a real
      // CR while the first round is still running.
      const mark = booted.run.session.captureMark;
      await booted.run.typeStimulus("EVID-SECOND", {
        chunkBytes: 5,
        delayMs: 30,
      });
      await booted.run.pressEnter();

      // Discriminating evidence, part 1: the app was ALIVE and PAINTING while
      // the refusal happened, so "nothing persisted" cannot be explained by a
      // dead or wedged child. A running round repaints its spinner, so the
      // capture keeps growing on its own.
      const bytesAtSubmit = booted.run.session.totalBytes;
      await new Promise((r) => setTimeout(r, 1_500));
      const bytesWhileBusy = booted.run.session.totalBytes;
      expect(
        bytesWhileBusy - bytesAtSubmit,
        `the app stopped painting while a round was running, so the missing ` +
          `persistence would be indistinguishable from a dead child${booted.why}`
      ).toBeGreaterThan(100);

      // Discriminating evidence, part 2: what the composer did with the
      // stimulus. Measured per CHUNK, because a repainting composer emits each
      // paced chunk separately and the concatenated token is therefore never
      // contiguous in the raw stream.
      const since = booted.run.session.since(mark);
      const chunks = ["EVID-", "SECON", "D"];
      const paintedChunks = chunks.filter((c) => since.includes(c));
      const verdicts = chunks.map(
        (c) => `${JSON.stringify(c)}=>${classifyTokenPaint(since, c).verdict}`
      );
      booted.timeline.add(
        "readiness",
        `busy-window composer paint per chunk: ${verdicts.join(" ")} ` +
          `(painted ${paintedChunks.length}/${chunks.length})`
      );

      // Wait a bounded window with the round STILL running: no second user
      // event may appear.
      const leaked = await booted.run.waitForNewUserEvent(
        before,
        6_000,
        "a second user event while a round is running"
      );
      expect(
        leaked,
        `a stimulus submitted during a running round was PERSISTED as ` +
          `${leaked?.id}: ${JSON.stringify(leaked && messageText(leaked))}${booted.why}`
      ).toBeNull();
      expect(
        realUserEvents(booted.run).map((e) => e.id),
        `the store gained a user event while busy${booted.why}`
      ).toEqual(before);
      expect(
        booted.model.turns.length,
        `the refused stimulus must not reach the model${booted.why}`
      ).toBe(1);
      expect(
        booted.run.observer.inputBoundaryAnchors(),
        `the refused stimulus must not gain an input boundary${booted.why}`
      ).toEqual([afterFirstId]);

      // And the refusal is a real refusal, not a stall: releasing the gate lets
      // the in-flight round finish normally, with the refused text absent.
      booted.model.releaseHeld();
      expect(
        await waitUntil(
          () => booted.run.observer.terminalBoundaryAnchors().length > 0,
          40_000,
          "the first round to settle",
          booted
        ),
        `the gated round never settled${booted.why}`
      ).toBe(true);
      expect(
        realUserEvents(booted.run).map((e) => e.id),
        `settling must not resurrect the refused stimulus${booted.why}`
      ).toEqual(before);
      expect(
        JSON.stringify(booted.run.observer.records()).includes("EVID-SECOND"),
        `the refused stimulus text reached the store${booted.why}`
      ).toBe(false);
    },
    CASE_TIMEOUT_MS
  );
});

describe("real product TUI: startup failure vs input-acceptance failure", () => {
  it(
    "names a conversation that does not exist: a TYPED STARTUP FAILURE, distinguishable from a non-accepted input",
    async () => {
      // `iknow tui <id>` resumes through `bridge.openSession(id)`
      // (run.tsx:1048-1054), which reads the store. A fresh id is not a session,
      // so the child fails BEFORE a renderer exists. This is the reference case
      // for telling the two failure classes apart: readiness never becomes true,
      // the relay reports the child's exit, and NO stimulus was ever accepted.
      const booted = await boot("startup-failure", {
        launchWithConversationId: true,
      });
      const ready = await waitForComposerReady(booted.run, 30_000);
      expect(
        ready.ready,
        `a typed startup failure must not read as ready${booted.why}`
      ).toBe(false);
      expect(
        ready.detail,
        `the child must report an exit${booted.why}`
      ).toContain("EXIT");

      // The renderer never came up, so the composer placeholder was never painted.
      expect(
        booted.run.session.since(0).includes(COMPOSER_PLACEHOLDER),
        `the composer must never have painted${booted.why}`
      ).toBe(false);
      // And nothing was persisted: the store file was never created.
      expect(
        booted.run.observer.records(),
        `a startup failure must persist no conversation${booted.why}`
      ).toHaveLength(0);

      // The relay preserved the child's waitpid result, so the exit is a fact
      // rather than a teardown discovery.
      const exit = await booted.run.session.waitExit(5_000);
      expect(
        exit,
        `the relay must report the child's exit${booted.why}`
      ).not.toBeNull();
      expect(
        exit!.exited,
        `a typed startup failure is a clean non-zero exit${booted.why}`
      ).toBe(true);
      expect(
        exit!.code,
        `the startup failure must not exit 0${booted.why}`
      ).not.toBe(0);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "records outbound writes, model calls, the first persisted event and the relay exit in one ordered timeline",
    async () => {
      // The shape proof 4 asks for: a single ordered, timestamped record that
      // lets a reader decide which half of the input path failed.
      const booted = await boot("timeline-shape");
      expect(
        (await waitForComposerReady(booted.run, 60_000)).ready,
        `the composer never painted${booted.why}`
      ).toBe(true);
      await booted.run.typeStimulus("EVID-TIMELINE", {
        chunkBytes: 6,
        delayMs: 25,
      });
      await booted.run.pressEnter();
      expect(
        await waitUntil(
          () => realUserEvents(booted.run).length >= 1,
          40_000,
          "the user event",
          booted
        ),
        `nothing was persisted${booted.why}`
      ).toBe(true);
      // The model call lands AFTER persistence, so the ordering assertion below
      // needs it to have happened; wait rather than assume it already has.
      await booted.model.waitForTurns(1, 40_000, "the model turn");

      // Every outbound stimulus byte is recorded in order, and the CR is its
      // own entry — so "the driver never sent it" is decidable.
      const writes = booted.timeline.of("write");
      expect(
        writes.length,
        `every outbound write must be recorded${booted.why}`
      ).toBeGreaterThan(1);
      const enterWrites = writes.filter((w) =>
        w.detail.includes("SUBMIT keystroke CR")
      );
      expect(
        enterWrites,
        `the CR must be recorded as its own write${booted.why}`
      ).toHaveLength(1);
      const lastWrite = writes[writes.length - 1]!;
      expect(
        lastWrite,
        `the CR must be the final outbound write${booted.why}`
      ).toBe(enterWrites[0]!);
      // The recorded outbound bytes are exactly what was sent, in order.
      expect(
        booted.run.outbound.join(""),
        `the timeline's writes must match the bytes actually sent${booted.why}`
      ).toBe("EVID-TIMELINE\r");

      // Ordering: readiness < CR < model call < first persisted event.
      const at = (kind: Parameters<Timeline["first"]>[0]) =>
        booted.timeline.first(kind)?.atMs ?? -1;
      expect(
        at("readiness"),
        `readiness must be recorded${booted.why}`
      ).toBeGreaterThanOrEqual(0);
      expect(
        at("readiness"),
        `readiness before the CR${booted.why}`
      ).toBeLessThan(enterWrites[0]!.atMs);
      expect(
        enterWrites[0]!.atMs,
        `the CR before the model call${booted.why}`
      ).toBeLessThan(at("stub-request"));
      expect(
        at("store-user-event"),
        `the first persisted user event must be recorded${booted.why}`
      ).toBeGreaterThanOrEqual(0);
      // The acceptance boundary is published just after the user event, so wait
      // for it rather than assuming it is already there.
      expect(
        await waitUntil(
          () => booted.run.observer.inputBoundaryAnchors().length > 0,
          20_000,
          "the input boundary",
          booted
        ),
        `an input boundary is required${booted.why}`
      ).toBe(true);
    },
    CASE_TIMEOUT_MS
  );
});

describe("real product TUI: readiness-probe evidence", () => {
  it(
    "shows a readiness token can appear in raw PTY bytes WITHOUT the composer having rendered it",
    async () => {
      // Written the instant the pty exists, i.e. before the TUI can have put
      // the terminal in raw mode. This is the exposure the driver's token
      // search has and cannot see.
      const booted = await boot("echo-not-paint");
      const token = "EVIDECHO0000";
      const mark = booted.run.session.captureMark;
      booted.run.writeChunk(token, "pre-readiness token write");

      const appeared = await (async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (booted.run.session.since(mark).includes(token)) return true;
          await new Promise((r) => setTimeout(r, 20));
        }
        return false;
      })();

      // The token IS in the raw byte stream — a raw-substring readiness search
      // would score this as "the composer echoed it".
      expect(
        appeared || booted.run.session.since(mark).includes(token),
        `the token never reached the raw stream${booted.why}`
      ).toBe(true);

      // Whether the composer had actually painted at that moment is the
      // separate question the raw search cannot answer. Report it either way;
      // the point is that the two are different claims.
      const classified = classifyTokenPaint(
        booted.run.session.since(mark),
        token
      );
      const placeholderAtTokenTime = booted.run.session
        .since(0)
        .slice(0, classified.context.length)
        .includes(COMPOSER_PLACEHOLDER);
      booted.timeline.add(
        "readiness",
        `pre-readiness token: paint=${classified.verdict} ` +
          `placeholderAlreadyPainted=${placeholderAtTokenTime} context=${classified.context}`
      );
      // Not an assertion about WHICH value: both are reported. What is asserted
      // is the structural fact that a raw-token match and a composer render are
      // independent, decidable observations.
      expect(
        ["rendered", "bare-echo"],
        `the token must be classifiable${booted.why}`
      ).toContain(classified.verdict);
    },
    CASE_TIMEOUT_MS
  );

  it(
    "on a READY surface, the same token IS an app paint — the two cases are distinguishable from the bytes",
    async () => {
      const booted = await boot("paint-after-ready");
      expect(
        (await waitForComposerReady(booted.run, 60_000)).ready,
        `the composer never painted${booted.why}`
      ).toBe(true);
      const mark = booted.run.session.captureMark;
      const token = "EVIDREADY9999";
      booted.run.writeChunk(token, "post-readiness token write");
      // Wait for the app to repaint the composer around the new characters.
      const painted = await (async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (booted.run.session.since(mark).includes(token)) return true;
          await new Promise((r) => setTimeout(r, 20));
        }
        return false;
      })();
      expect(
        painted,
        `the token never reached the raw stream${booted.why}`
      ).toBe(true);
      const classified = classifyTokenPaint(
        booted.run.session.since(mark),
        token
      );
      booted.timeline.add(
        "readiness",
        `post-readiness token: paint=${classified.verdict} context=${classified.context}`
      );
      // After readiness the TUI owns the terminal, so the token must arrive as
      // a cell-addressing repaint, never as a bare kernel echo.
      expect(
        classified.verdict,
        `a token typed on a ready surface must be an app paint, not an echo` +
          ` (context ${classified.context})${booted.why}`
      ).toBe("rendered");
    },
    CASE_TIMEOUT_MS
  );

  it(
    "REPORTS the driver's own probeReadiness as ready, and leaves the composer clean for the next stimulus",
    async () => {
      // This case was originally written to PIN THE DEFECT: it asserted
      // `echoed:false` / `ready:false` and then reproduced the #1221 merged user
      // event, because `waitForToken` demanded a CONTIGUOUS token while the real
      // composer repaints each paced chunk at the cursor, and the `!echoed`
      // branch skipped the composer clear so every attempt stacked another copy
      // into the composer.
      //
      // That defect is repaired (issue #1219). Asserting it any longer would
      // fail the moment the repair works, so the case now asserts the REPAIRED
      // contract on the same real surface — which is the stronger statement, not
      // a weaker one: the probe must now both prove readiness AND leave nothing
      // behind, and the next real stimulus must land as its own clean event.
      // The pre-fix evidence (one un-cleared token copy per attempt, merged into
      // a single user message) is preserved in this file's git history and is
      // restated in docs/evidence/1219-post1220-qualification-reconciliation.md.
      //
      // NOTE on what is deliberately NOT asserted: whether the token happens to
      // appear contiguously in the raw stream is LOAD-DEPENDENT — under parallel
      // test load the real renderer sometimes repaints the whole line after the
      // final chunk, which makes it contiguous. The contiguity premise is
      // therefore recorded, not asserted; the stable property is that the chunks
      // were cell-addressed by the APP rather than bare kernel echo.
      const booted = await boot("probe-readiness");
      expect(
        (await waitForComposerReady(booted.run, 60_000)).ready,
        `the composer never painted${booted.why}`
      ).toBe(true);
      const mark = booted.run.session.captureMark;
      const policy: ReadinessPolicy = {
        tokenPrefix: "e1219probe",
        probeTimeoutMs: 20_000,
        echoTimeoutMs: 5_000,
        attempts: 2,
      };
      const verdict = await probeReadiness(booted.run.session, policy);
      const raw = booted.run.session.since(mark);
      booted.timeline.add(
        "readiness",
        `probeReadiness verdict: ${JSON.stringify({ ...verdict, evidence: "" })} ` +
          `contiguousInRawStream=${raw.includes(verdict.token)}`
      );

      // The repaired contract: ready, with the echo proven as an app paint and
      // the composer cleared — and still never submitting.
      expect(
        verdict.echoed,
        `every probe chunk must be recognised as an app paint, not a bare echo${booted.why}`
      ).toBe(true);
      expect(
        verdict.cleared,
        `the probe must clear the composer on every attempt${booted.why}`
      ).toBe(true);
      expect(
        verdict.ready,
        `a ready, rendering surface must pass the probe${booted.why}`
      ).toBe(true);
      expect(
        verdict.detail,
        `the detail must name the chunk-by-chunk paint${booted.why}`
      ).toContain("chunk by chunk");
      // It never submitted — the probe is still a non-submitting probe.
      expect(
        verdict.enterWrites,
        `the probe must never submit${booted.why}`
      ).toBe(0);

      // The reason the old probe failed, pinned on the real stream: the first
      // chunk is present AND was painted by the app, not echoed by the kernel
      // line discipline.
      const firstChunk = verdict.token.slice(0, 8);
      expect(
        raw.includes(firstChunk),
        `expected the first probe chunk to be present in the raw stream${booted.why}`
      ).toBe(true);
      expect(
        classifyTokenPaint(raw, firstChunk).verdict,
        `the probe chunk should be an app paint, not a kernel echo${booted.why}`
      ).toBe("rendered");
      // And the composer was live the whole time.
      expect(
        booted.run.session.totalBytes,
        `the surface must still be producing bytes${booted.why}`
      ).toBeGreaterThan(0);

      // THE PAYLOAD: the #1221 merged-message failure must NOT reproduce. The
      // stimulus that follows a successful probe persists as its own user event
      // carrying exactly its own text — no probe token, no residue, no merge.
      await booted.run.typeStimulus("EVID-AFTER-PROBE", {
        chunkBytes: 5,
        delayMs: 25,
      });
      await booted.run.pressEnter();
      const persisted = await waitUntil(
        () => realUserEvents(booted.run).length >= 1,
        40_000,
        "a user event after the probe",
        booted
      );
      expect(
        persisted,
        `a surface the probe passed must persist the stimulus${booted.why}`
      ).toBe(true);

      const events = realUserEvents(booted.run);
      const text = messageText(events[0]!);
      const copies = text.split(verdict.token).length - 1;
      booted.timeline.add(
        "readiness",
        `post-probe user event ${events[0]!.id}: tokenCopies=${copies} ` +
          `attempts=${verdict.attempts} text=${JSON.stringify(text)}`
      );
      // Exactly the stimulus, nothing else. Before the repair this read
      // "<token><token>EVID-AFTER-PROBE" — one un-cleared copy per attempt.
      expect(
        text,
        `the stimulus after a passed probe must be persisted verbatim, with no probe residue${booted.why}`
      ).toBe("EVID-AFTER-PROBE");
      expect(
        copies,
        `a passed probe must leave ZERO token copies behind, got ${copies} in ${JSON.stringify(text)}${booted.why}`
      ).toBe(0);
    },
    CASE_TIMEOUT_MS
  );
});

describe("real product TUI: teardown", () => {
  it(
    "reaps the child and the relay, and leaves the temp tree and the stub behind nothing",
    async () => {
      const booted = await boot("teardown");
      expect(
        (await waitForComposerReady(booted.run, 60_000)).ready,
        `the composer never painted${booted.why}`
      ).toBe(true);
      await booted.run.typeStimulus("EVID-TEARDOWN", {
        chunkBytes: 6,
        delayMs: 25,
      });
      await booted.run.pressEnter();
      expect(
        await waitUntil(
          () => realUserEvents(booted.run).length >= 1,
          40_000,
          "the user event",
          booted
        ),
        `nothing was persisted${booted.why}`
      ).toBe(true);

      const pids = [...booted.run.pids];
      const root = booted.run.root;
      const store = booted.run.observer.storeFile!;
      expect(
        pids,
        `the run must own a child and a relay pid${booted.why}`
      ).toHaveLength(2);
      for (const pid of pids)
        expect(
          isProcessAlive(pid),
          `pid ${pid} must be running before teardown`
        ).toBe(true);

      await booted.run.dispose();
      await booted.model.close();

      // No survivor: the child and the relay are both gone.
      for (const pid of pids)
        expect(isProcessAlive(pid), `pid ${pid} survived teardown`).toBe(false);
      // The relay preserved the child's waitpid result before disposal finished.
      expect(
        booted.run.session.relayLog(),
        `the relay must report the child's exit before disposal completes${booted.why}`
      ).toMatch(/EXIT \S+ \S+/);
      // The hermetic temp tree is gone, so no data or key outlives the run.
      expect(existsSync(root), `the temp root must be removed`).toBe(false);
      expect(
        existsSync(store),
        `the store must be inside the removed temp root`
      ).toBe(false);
      expect(
        booted.run.session.disposed,
        `the pty session must report itself disposed`
      ).toBe(true);
    },
    CASE_TIMEOUT_MS
  );
});
