/**
 * #1221 REGRESSION ON THE REAL PRODUCT SURFACE: a completed readiness probe
 * leaves NO residue, so the first real stimulus persists as its OWN user event.
 *
 * This reuses the harness built for #1219's evidence layer
 * (`_real-tui-pty-harness.ts`) rather than duplicating it: the real
 * `bun <repo>/src/cli.ts tui` in a REAL pty, an isolated loopback stub model,
 * a fresh temp HOME / data-dir / workspace-root, credentials deleted from the
 * env and a generated literal test key. Only the model transport is stubbed;
 * the renderer, the key parser, the session hub and the real `SessionStore` on a
 * real filesystem are all the product.
 *
 * THE DEFECT THIS IS THE DIRECT REGRESSION FOR. The measured #1221 run persisted
 * `"e1219probe-<hex>e1219probe-<hex>EVID-AFTER-PROBE"` as ONE user event — one
 * un-cleared probe token per probe attempt, concatenated onto the first real
 * stimulus. Root cause: `waitForToken` demanded the token CONTIGUOUS, the real
 * composer repaints each paced chunk at the cursor so it never is, and the
 * resulting `!echoed` path SKIPPED the composer clear.
 *
 * WHAT IS ASSERTED, in order:
 *   1. the probe proves readiness on the real renderer (the repair works there,
 *      not just on the fixture child);
 *   2. it stayed non-submitting — structurally, from the raw write log;
 *   3. it added NO `type:"message"` record and stayed out of the measured
 *      stimulus sequence;
 *   4. THE REGRESSION: the first real stimulus after the probe is persisted as
 *      its own clean user event whose text is EXACTLY the stimulus, with no
 *      probe text concatenated onto it.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  disposeAllPtySessions,
  probeReadiness,
} from "../../../../scripts/eval/tui/pty.ts";
import type { ReadinessPolicy } from "../../../../scripts/eval/tui/protocol.ts";
import { isRealUserMessage } from "../../../../scripts/eval/tui/session-store-reader.ts";
import {
  classifyTokenPaint,
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

/** Boot cost + one probe + one model round. Explicit, because the vitest
 *  default is 30s and this is assembly/IO budget, not the contract. */
const CASE_TIMEOUT_MS = 120_000;

interface Booted {
  readonly run: RealTuiRun;
  readonly model: StubModel;
  readonly timeline: Timeline;
  readonly why: string;
}

const live: Booted[] = [];

async function boot(label: string): Promise<Booted> {
  const timeline = new Timeline();
  const model = await startLoopbackTuiModel(timeline);
  const run = await startRealTui({ label, timeline, model });
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

/** The real user messages the store holds, in file order. The guard is the
 *  PRODUCTION `isRealUserMessage`, so a host-injected record (the product's
 *  `<agent_status>` block) can never satisfy an acceptance claim. */
function realUserEvents(run: RealTuiRun): readonly SessionEventRecord[] {
  return run.observer
    .records()
    .filter(
      (r): r is SessionEventRecord =>
        r.type === "message" && isRealUserMessage(r)
    );
}

afterEach(async () => {
  for (const booted of live.splice(0)) {
    await booted.run.dispose().catch(() => undefined);
    await booted.model.close().catch(() => undefined);
  }
  await disposeAllRealTuiRuns().catch(() => undefined);
});

afterAll(async () => {
  await disposeAllRealTuiRuns();
});

describe("real product TUI: a completed readiness probe leaves no residue", () => {
  it(
    "persists the first stimulus after the probe as its OWN clean user event",
    async () => {
      const booted = await boot("probe-residue");
      expect(
        (await waitForComposerReady(booted.run, 60_000)).ready,
        `the real composer never painted${booted.why}`
      ).toBe(true);

      const policy: ReadinessPolicy = {
        tokenPrefix: "e1219probe",
        probeTimeoutMs: 20_000,
        echoTimeoutMs: 5_000,
        attempts: 3,
      };
      const writesBefore = booted.run.session.writes.length;
      const probeMark = booted.run.session.captureMark;
      const verdict = await probeReadiness(booted.run.session, policy);
      const probeStream = booted.run.session.since(probeMark);
      booted.timeline.add(
        "readiness",
        `probeReadiness on the real surface: ${JSON.stringify({ ...verdict, evidence: "" })}`
      );

      // 1. THE REPAIR, ON THE REAL RENDERER. The token is repainted chunk by
      //    chunk at the cursor, and the probe accepts that.
      expect(
        verdict.echoed,
        `the real composer must echo the token chunk by chunk; evidence: ${verdict.evidence}${booted.why}`
      ).toBe(true);
      expect(
        verdict.cleared,
        `the composer must be left empty by the probe; evidence: ${verdict.evidence}${booted.why}`
      ).toBe(true);
      expect(
        verdict.ready,
        `the probe must prove readiness on the real surface${booted.why}`
      ).toBe(true);

      // The premise is OBSERVED, not demanded. Whether the paced token happens
      // to land CONTIGUOUSLY is load-dependent: under a loaded machine the real
      // renderer sometimes emits a whole-line repaint after the last chunk, and
      // then a contiguous copy does exist. That weakens nothing — the claim
      // under test is that the probe neither DEPENDS on contiguity nor leaves
      // residue, and the residue assertion below is self-validating (a broken
      // probe reliably leaves one copy per attempt, which was reproduced). So
      // the contiguity measurement is recorded for the reader and only the
      // STABLE half is asserted: the chunk was painted by the app, which a bare
      // kernel echo cannot produce.
      const firstChunk = verdict.token.slice(0, 8);
      const classification = classifyTokenPaint(probeStream, firstChunk);
      booted.timeline.add(
        "readiness",
        `probe token: contiguousOccurrence=${probeStream.includes(verdict.token)} ` +
          `firstChunkPaint=${classification.verdict} context=${classification.context}`
      );
      expect(
        probeStream.includes(firstChunk),
        `the first probe chunk must be present in the real raw stream${booted.why}`
      ).toBe(true);
      expect(
        classification.verdict,
        `the probe chunk must be an app paint, not a bare kernel echo${booted.why}`
      ).toBe("rendered");

      // 2. NON-SUBMITTING, structurally: not one CR among the probe's writes.
      expect(
        verdict.enterWrites,
        `the probe must never submit${booted.why}`
      ).toBe(0);
      const probeWrites = booted.run.session.writes.slice(writesBefore);
      for (const w of probeWrites)
        expect(
          w.includes("\r") || w.includes("\n"),
          `probe write ${JSON.stringify(w)} carries a line break`
        ).toBe(false);

      // 3. The probe persisted nothing: it is a probe, not a stimulus.
      expect(
        realUserEvents(booted.run).length,
        `a readiness probe must add no type:"message" record${booted.why}`
      ).toBe(0);

      // 4. THE REGRESSION. The first real stimulus after the probe must land as
      //    its own clean user event. Before the repair the un-cleared probe
      //    token was concatenated onto it, one copy per attempt, inside ONE
      //    event.
      const stimulus = "EVID-AFTER-PROBE";
      await booted.run.typeStimulus(stimulus, { chunkBytes: 5, delayMs: 25 });
      await booted.run.pressEnter();
      expect(
        await waitUntil(
          () => realUserEvents(booted.run).length >= 1,
          40_000,
          "a user event after the probe",
          booted
        ),
        `the stimulus after the probe was not persisted${booted.why}`
      ).toBe(true);

      const events = realUserEvents(booted.run);
      expect(
        events,
        `the stimulus must be its own user event, not a merge with probe text${booted.why}`
      ).toHaveLength(1);
      const text = messageText(events[0]!);
      const copies = text.split(verdict.token).length - 1;
      booted.timeline.add(
        "readiness",
        `user event ${events[0]!.id}: probeTokenCopies=${copies} ` +
          `attempts=${verdict.attempts} text=${JSON.stringify(text)}`
      );
      expect(
        text,
        `the persisted text must be EXACTLY the stimulus; probe residue was ` +
          `concatenated onto it${booted.why}`
      ).toBe(stimulus);
      expect(
        copies,
        `no copy of the probe token may reach the store${booted.why}`
      ).toBe(0);
      expect(
        booted.run.observer
          .records()
          .some((r) => JSON.stringify(r).includes(verdict.token)),
        `the probe token reached the store at all${booted.why}`
      ).toBe(false);

      // And the round really ran, so "one clean message" is not a half-written
      // turn: the stub saw the stimulus and the store reached its idle boundary.
      await booted.model.waitForTurns(1, 40_000, "the model turn");
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
    },
    CASE_TIMEOUT_MS
  );
});

describe("real product TUI: probe teardown", () => {
  it(
    "reaps the child and the relay after a probe",
    async () => {
      const booted = await boot("probe-teardown");
      expect(
        (await waitForComposerReady(booted.run, 60_000)).ready,
        `the composer never painted${booted.why}`
      ).toBe(true);
      const verdict = await probeReadiness(booted.run.session, {
        tokenPrefix: "e1219probe",
        probeTimeoutMs: 20_000,
        echoTimeoutMs: 5_000,
        attempts: 2,
      });
      expect(verdict.ready, `the probe must prove readiness${booted.why}`).toBe(
        true
      );

      const pids = [...booted.run.pids];
      const root = booted.run.root;
      await booted.run.dispose();
      await booted.model.close();
      await disposeAllPtySessions().catch(() => undefined);

      expect(
        pids.length,
        `the run must own a child and a relay pid${booted.why}`
      ).toBe(2);
      expect(
        booted.run.session.relayLog(),
        `the relay must report the child's exit${booted.why}`
      ).toMatch(/EXIT \S+ \S+/);
      expect(
        booted.run.session.disposed,
        `the pty session must report itself disposed`
      ).toBe(true);
      expect(
        root.startsWith("/tmp/"),
        `the hermetic root must be a temp tree`
      ).toBe(true);
    },
    CASE_TIMEOUT_MS
  );
});
