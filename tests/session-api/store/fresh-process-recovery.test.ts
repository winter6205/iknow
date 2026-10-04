/**
 * Fresh-process crash tests for the published-state criteria: SC1 (integrity
 * across the publication crash window), SC2 (accepted-input boundary), SC8
 * (compaction branch).
 *
 * Every test here runs the REAL host in a forked `node` process, kills that
 * process GROUP with a real `SIGKILL` at a NAMED crash point, and reopens the
 * same session in a SECOND real process. Nothing is reconstructed inside this
 * test process, and no assertion below trusts a value the harness returned:
 * the on-disk facts are read here, and the recovery verdict comes from the
 * second process reading that same disk.
 *
 * Names carry the criterion so the acceptance matrix stays greppable.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  parseSessionJsonl,
  resolvePublishedNativeState,
  type ParsedSessionLog,
  type SessionNativeStateRecord,
} from "../../../src/session-api/store/jsonl.ts";
import {
  nativeStateBlobsDir,
  parseNativeStateBody,
} from "../../../src/session-api/store/native-state-store.ts";
import type { NativeStateMessage } from "../../../src/shared/native-state-port.ts";
import {
  createCrashHost,
  disposeAllCrashHosts,
  realConversationDir,
  realLogBytes,
  realNativeBodies,
  realSessionFingerprint,
  runHostToCompletion,
  runHostToCrashPoint,
  runRoleInFreshProcess,
  type CrashHost,
} from "../crash/crash-harness.ts";
import { buildMutantTree } from "../crash/mutant-tree.ts";
import { injectReplayedRestoredToolCalls } from "../crash/replay-defect.ts";

/** Every child pays module load, and this file forks two per test. */
const CRASH_TEST_TIMEOUT = 180_000;

const userMsg = (text: string): NativeStateMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistantMsg = (text: string): NativeStateMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const texts = (
  messages: ReadonlyArray<NativeStateMessage> | null
): ReadonlyArray<string> =>
  (messages ?? []).map((m) =>
    m.content
      .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
      .join("")
  );

/** The tool-dispatch probe's own verdict, reported by whichever arm armed it.
 *  Declared here rather than imported: `crash-host-entry.ts` is a child-process
 *  ENTRY (it reads argv and runs on import), so a test may not import from it. */
interface ToolProbeResult {
  readonly armed: boolean;
  readonly controls: ReadonlyArray<string>;
  /** Hits on the live counter, snapshotted when the measurement window closed. */
  readonly hits: ReadonlyArray<string>;
  /** Every production tool name the probe is riding. */
  readonly wrapped: ReadonlyArray<string>;
  /** How many defs the REAL production toolset assembled in that process. */
  readonly productionCount: number;
  /** How many of them the probe wrapped. Must equal `productionCount`. */
  readonly wrappedCount: number;
  /** The host arm's own def floor, so this file asserts the SAME boundary the
   *  arm enforces instead of a second literal that can drift from it. */
  readonly minDefs: number;
}

interface ReopenResult {
  readonly status: { readonly status: string };
  readonly savedMessageCount: number | null;
  readonly restoredContext: ReadonlyArray<NativeStateMessage> | null;
  readonly messages: ReadonlyArray<NativeStateMessage>;
  readonly outcome: { readonly state: string } | null;
  readonly tripwire: {
    readonly armed: boolean;
    readonly controls: ReadonlyArray<string>;
    readonly hits: ReadonlyArray<string>;
  };
  /** Additive: the REAL production toolset assembled in the reopen process, every
   *  def wrapped before registration, behind the real registry and executor,
   *  armed BEFORE recovery ran and live across it. */
  readonly toolProbe: ToolProbeResult;
  /** Present only when the arm was told to replay the restored `tool_use`. */
  readonly replay?: ReplayLeg;
  /** Present only when the arm continued the host with a real turn after
   *  recovery — the window in which a replay regression would show up. */
  readonly continued?: ContinuedTurn;
  /** Per-dispatch records snapshotted when the RECOVERY window closed, before
   *  the continued turn ran. */
  readonly dispatchesAfterRecovery?: ReadonlyArray<ToolDispatch>;
}

/** One dispatch the probe actually saw, attributed to the call that caused it. */
interface ToolDispatch {
  readonly name: string;
  /** The Anthropic `tool_use_id` the executor passed to the handler, so a
   *  dispatch can be named rather than merely counted. */
  readonly toolUseId: string | undefined;
  readonly input: unknown;
}

/** What the host's own next turn did, on the host's own dispatch path. */
interface ContinuedTurn {
  /** The NEW `tool_use` the scripted response carried. */
  readonly newToolUseId: string;
  readonly newToolUseInput: { readonly path: string };
  readonly hitsDuringTurn: ReadonlyArray<string>;
  readonly dispatchesDuringTurn: ReadonlyArray<ToolDispatch>;
  /** How many messages the turn started from, and their text — so the test can
   *  confirm the restored context really was on the turn's history. */
  readonly priorMessageCount: number;
  readonly priorTexts: ReadonlyArray<string>;
}

/** The deliberate-replay control's own numbers, on the same live instrument. */
interface ReplayLeg {
  readonly restoredToolUse: {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  } | null;
  /** The counter as the NEGATIVE window closed: the SAME snapshot the child took
   *  and handed to the replay leg, so the two are one number, not two. */
  readonly hitsAfterRecovery: ReadonlyArray<string>;
  readonly dispatch: {
    readonly kind: string;
    readonly readBack: boolean;
  };
  /** The counter after the replay. MUST be non-zero. */
  readonly hitsAfterReplay: ReadonlyArray<string>;
  /** Inputs the real handlers were called with; the control's own dispatch is
   *  cleared out of this log, so what remains is the replay's alone. */
  readonly observedInputs: ReadonlyArray<unknown>;
}

/** What the tool Prove-It arm reports back from its real host process. */
interface ToolArmResult {
  readonly toolProbe: ToolProbeResult;
  /** The `tool_use.input` the scripted model response carried. */
  readonly providerToolUseInput: unknown;
  /** The `input` the real handler body was actually called with. */
  readonly handlerObservedInput: unknown;
  readonly sentinel: string;
}

/**
 * Every text the log's `tool_result` blocks carry. `tool_result.content` is
 * `unknown` by contract (tool payloads are not this layer's concern), so the
 * narrowing is the reader's job and happens here, on the real bytes.
 */
function toolResultTexts(log: ParsedSessionLog): ReadonlyArray<string> {
  const out: string[] = [];
  for (const event of log.events) {
    const message = event.message as NativeStateMessage | undefined;
    if (message === undefined) continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const content = block.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const text = (part as { type?: string; text?: string }).text;
        if ((part as { type?: string }).type === "text" && text !== undefined) {
          out.push(text);
        }
      }
    }
  }
  return out;
}

/** The real log, read from disk in THIS process. */
async function realLog(host: CrashHost): Promise<ParsedSessionLog> {
  return parseSessionJsonl(await realLogBytes(host));
}

const nativeStateRecords = (
  log: ParsedSessionLog
): ReadonlyArray<SessionNativeStateRecord> =>
  log.records.filter(
    (r): r is SessionNativeStateRecord => r.type === "native_state"
  );

/** Every immutable body the pool really holds, parsed from its real bytes. */
async function realSnapshots(
  host: CrashHost
): Promise<ReadonlyArray<{ readonly sha: string; readonly messages: number }>> {
  const dir = nativeStateBlobsDir(realConversationDir(host));
  return Promise.all(
    (await realNativeBodies(host)).map((sha) => {
      const snapshot = parseNativeStateBody(readFileSync(join(dir, sha)));
      return { sha, messages: snapshot.messages.length };
    })
  );
}

/**
 * The probe must be riding the WHOLE production toolset assembled in that
 * process, not a hand-picked def. A one-def probe is blind to every other tool
 * the host could dispatch, and a toolset that shrank to nothing would make the
 * reopen's zero pass for free — so the coverage is asserted, not assumed, against
 * the floor the HOST reports: one boundary, enforced there and checked here.
 */
function assertFullProductionSurface(probe: ToolProbeResult): void {
  assert.equal(
    probe.wrappedCount,
    probe.productionCount,
    `the probe wrapped ${probe.wrappedCount} of ${probe.productionCount} production defs`
  );
  assert.ok(
    probe.productionCount >= probe.minDefs,
    `the real production toolset has only ${probe.productionCount} defs, below the host's own floor of ${probe.minDefs}; a shrinking toolset must not make the zero vacuous`
  );
  assert.equal(
    new Set(probe.wrapped).size,
    probe.productionCount,
    "every production def is wrapped exactly once, under its own name"
  );
  assert.ok(
    probe.wrapped.includes("read_file"),
    "the control's real production tool is inside the probed surface"
  );
}

/** The `tool_use` block every real log below carries, by id. */
function loggedToolUseIds(log: ParsedSessionLog): ReadonlyArray<string> {
  return log.events
    .flatMap((e) => (e.message as NativeStateMessage).content)
    .filter((b) => b.type === "tool_use")
    .map((b) => b.id);
}

let host: CrashHost;

afterEach(async () => {
  // Kills any group still alive, waits for it, then removes the temp root.
  await disposeAllCrashHosts();
});

describe("SC1 — published-state integrity across the publication window (fresh process)", () => {
  it(
    "SC1: a host SIGKILLed between the immutable body write and the record append reopens on the PRIOR checkpoint, and the orphan body is neither selectable nor progress",
    async () => {
      host = await createCrashHost({
        prefix: "iknow-sc1-orphan-",
        conversationId: "sc1-orphan-body",
      });
      const receipt = await runHostToCrashPoint({
        host,
        crashPoint: "after_body_write_before_record_append",
        timeoutMs: CRASH_TEST_TIMEOUT,
        request: {
          role: "publish",
          crashPointHint: "after_body_write_before_record_append",
          plan: [
            { op: "create", cwd: host.workspaceRoot },
            { op: "appendEvents", messages: [userMsg("first")] },
            {
              op: "appendNativeState",
              anchorEventId: "e0",
              boundary: "input",
              messages: [userMsg("first")],
            },
          ],
          // The publication that dies in the window: the log is made
          // un-appendable, so the body write lands and the record is refused.
          faultedPublish: {
            anchorEventId: "e0",
            boundary: "input",
            messages: [userMsg("first"), assistantMsg("never published")],
          },
        },
      });
      assert.equal(receipt.signal, "SIGKILL", "the host died by a real signal");
      assert.equal(
        receipt.pgid,
        receipt.pid,
        "the kill reached the whole group"
      );
      assert.equal(
        receipt.detail.refusedKind,
        "write_failed",
        "the record append was the real, refused write"
      );

      // --- the real on-disk state, read here ---
      const bodies = await realSnapshots(host);
      assert.equal(bodies.length, 2, "both bodies are really on disk");
      const orphan = bodies.find((b) => b.messages === 2);
      const published = bodies.find((b) => b.messages === 1);
      assert.ok(orphan !== undefined && published !== undefined);
      const records = nativeStateRecords(await realLog(host));
      assert.equal(records.length, 1, "the orphan body has no record");
      assert.equal(records[0]?.bodySha, published.sha);
      assert.equal(
        records.some((r) => r.bodySha === orphan.sha),
        false,
        "no record selects the orphan body"
      );

      // --- the second real process ---
      const reopened = await runRoleInFreshProcess<ReopenResult>({
        host,
        request: { role: "reopen_chat" },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });
      assert.equal(reopened.status.status, "recovered");
      assert.equal(
        reopened.savedMessageCount,
        1,
        "the orphan body is not counted as saved progress"
      );
      assert.deepEqual(texts(reopened.restoredContext), ["first"]);
      assert.equal(
        reopened.restoredContext?.some(
          (m) => texts([m])[0] === "never published"
        ),
        false
      );
      assert.equal(
        reopened.outcome?.state,
        "unknown",
        "no turn ever completed"
      );
    },
    CRASH_TEST_TIMEOUT
  );

  it(
    "SC1: a torn trailing record append leaves the PRIOR checkpoint selected, and the fragment is not a record",
    async () => {
      host = await createCrashHost({
        prefix: "iknow-sc1-torn-",
        conversationId: "sc1-torn-tail",
      });
      const receipt = await runHostToCrashPoint({
        host,
        crashPoint: "torn_trailing_append",
        timeoutMs: CRASH_TEST_TIMEOUT,
        request: {
          role: "publish",
          crashPointHint: "torn_trailing_append",
          plan: [
            { op: "create", cwd: host.workspaceRoot },
            { op: "appendEvents", messages: [userMsg("kept")] },
            {
              op: "appendNativeState",
              anchorEventId: "e0",
              boundary: "input",
              messages: [userMsg("kept")],
            },
          ],
        },
      });
      assert.equal(receipt.signal, "SIGKILL");
      const detail = receipt.detail as {
        bytesOnDisk: number;
        recordBytes: number;
      };
      assert.ok(
        detail.bytesOnDisk > 0 && detail.bytesOnDisk < detail.recordBytes,
        "the record really is half-written"
      );

      // --- the real on-disk bytes, read here ---
      const raw = await realLogBytes(host);
      assert.equal(
        raw.endsWith("\n"),
        false,
        "the log ends mid-record, with no terminator"
      );
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const fragment = lines[lines.length - 1]!;
      assert.equal(
        (() => {
          try {
            JSON.parse(fragment);
            return "parsed";
          } catch {
            return "unparseable";
          }
        })(),
        "unparseable",
        "the trailing fragment is not a record"
      );
      assert.equal(
        lines.slice(0, -1).every((l) => {
          try {
            JSON.parse(l);
            return true;
          } catch {
            return false;
          }
        }),
        true,
        "every line before the fragment is a whole record"
      );
      // The reader drops the torn tail rather than treating it as a record.
      const log = parseSessionJsonl(raw);
      assert.equal(log.events.length, 1, "the one real event survives");
      assert.equal(
        nativeStateRecords(log).length,
        1,
        "the fragment is not a record"
      );
      assert.equal(log.head, "e0");

      // --- the second real process ---
      const reopened = await runRoleInFreshProcess<ReopenResult>({
        host,
        request: { role: "reopen_chat" },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });
      assert.equal(reopened.status.status, "recovered");
      assert.equal(reopened.savedMessageCount, 1);
      assert.deepEqual(texts(reopened.restoredContext), ["kept"]);
    },
    CRASH_TEST_TIMEOUT
  );
});

describe("SC2 — accepted-input boundary (fresh process)", () => {
  // The criterion's two halves are both MEASURED now, at the real recovery entry,
  // and this comment says exactly what each rests on.
  //
  //   Premise 1 (MEASURED, below): the reopen process issued zero outbound
  //   provider requests, on a `globalThis.fetch` tripwire whose own `data:` URL
  //   control fired or the test fails.
  //
  //   Premise 2 (MEASURED, in the SAME reopen process, not by reading code): the
  //   reopen process assembled the REAL production toolset — the very factory
  //   `buildHarnessEngine` calls — wrapped EVERY def it produced before
  //   registration, and kept that surface live across the recovery call. The
  //   probe's own control, run there before anything under test, fired on a real
  //   production tool with the handler's real bytes coming back, so the zero
  //   below is read on an instrument proven live in that same process, and over
  //   the WHOLE toolset rather than a hand-picked def.
  //
  //   What that zero does NOT show, stated plainly rather than implied: the probe
  //   observes dispatches made THROUGH it, and this test's child assembles it.
  //   `recoverChatSessionEntry` is handed no registry and no executor — its own
  //   doc says the shared host contract takes no engine deps — so the counter
  //   reads 0 for ANY implementation of recovery, and this is NOT a
  //   discriminating test of recovery's implementation. Nor is the probe the
  //   production dispatch stack (`createAciExecutor` over `createExecutor` over
  //   `withLazyLspWarmup`): a dispatch made on some other stack in that process
  //   would not be observed.
  //
  //   The bound that remains is STRUCTURAL, and is stated as such rather than
  //   dressed as a measurement: the loop derives each tool wave solely from the
  //   current turn's `projection.toolCalls` (`loop-engine.ts` `runToolPhase`),
  //   and that projection is what the adapter returned. A `tool_use` block can
  //   therefore enter the process only inside a provider response — so with zero
  //   provider responses there is nothing for a dispatch to be built from. The
  //   third test in this block is the control that turns the zero red: it
  //   dispatches a restored `tool_use` on purpose, through that same live
  //   surface, and the counter reads non-zero.
  it(
    "SC2: a host SIGKILLed during the first model request reopens the accepted input in a second process that issues no model request, dispatches no tool, and writes nothing",
    async () => {
      host = await createCrashHost({
        prefix: "iknow-sc2-",
        conversationId: "sc2-accepted-input",
      });
      const receipt = await runHostToCrashPoint({
        host,
        crashPoint: "first_model_dispatch",
        timeoutMs: CRASH_TEST_TIMEOUT,
        request: { role: "chat_turn", line: "remember this" },
      });
      assert.equal(receipt.signal, "SIGKILL");
      assert.equal(
        receipt.detail.conversationId,
        "sc2-accepted-input",
        "the crash point is the model's own first main-loop request"
      );

      // --- the real on-disk state, read here ---
      const log = await realLog(host);
      assert.deepEqual(
        log.events.map((e) => texts([e.message as NativeStateMessage])[0]),
        ["remember this"],
        "the accepted input is on disk before the kill"
      );
      const records = nativeStateRecords(log);
      assert.equal(records.length, 1, "exactly the input-boundary state");
      assert.equal(records[0]?.boundary, "input");
      assert.equal(records[0]?.anchorEventId, "e0");
      assert.equal(
        log.events.some((e) => e.message.role === "assistant"),
        false,
        "the killed host committed no assistant turn"
      );
      assert.equal(
        log.records.some((r) => r.type === "operation_fact"),
        false,
        "no tool ever ran: no tool fact was recorded"
      );

      // --- the second real process ---
      const beforeReopen = await realSessionFingerprint(host);
      const reopened = await runRoleInFreshProcess<ReopenResult>({
        host,
        request: {
          role: "reopen_chat",
          seedMessages: [userMsg("remember this")],
        },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });
      assert.equal(
        reopened.tripwire.armed,
        true,
        `the tripwire's own control must fire, else it observed nothing: ${reopened.tripwire.controls.join(", ")}`
      );
      assert.deepEqual(
        reopened.tripwire.hits,
        [],
        `reopen issued a provider request: ${reopened.tripwire.hits.join(", ")}`
      );
      // The tool probe must be ARMED in that same process before its zero is
      // worth reading, and it must be riding the WHOLE real production toolset
      // that process assembled: a probe that wrapped one def would report zero
      // for every other tool the host could have dispatched.
      assertFullProductionSurface(reopened.toolProbe);
      assert.equal(
        reopened.toolProbe.armed,
        true,
        `the tool probe's own control must fire, else its zero is unobserved: ${reopened.toolProbe.controls.join(", ")}`
      );
      assert.deepEqual(
        reopened.toolProbe.hits,
        [],
        `recovery dispatched a tool: ${reopened.toolProbe.hits.join(", ")}`
      );
      assert.equal(
        await realSessionFingerprint(host),
        beforeReopen,
        "the reopen read the session and wrote none of it"
      );
      assert.equal(reopened.status.status, "recovered");
      assert.deepEqual(
        texts(reopened.restoredContext),
        ["remember this"],
        "the accepted input is the restored context"
      );
      assert.equal(reopened.savedMessageCount, 1);
      assert.equal(reopened.outcome?.state, "unknown");
    },
    CRASH_TEST_TIMEOUT
  );

  // Premise 2's own arm. Without it the SC2 assertions above would rest on a
  // probe nobody has seen fire; a probe that cannot fire is worse than none,
  // because it converts "unobserved" into "observed as absent". This one also
  // shows the probe is not merely armed: the real LOOP, dispatching a real
  // `tool_use` from a real provider response, lands on the probed surface.
  it(
    "SC2 premise 2 (PROVE-IT): a real tool really dispatched from a real tool_use block, and the same full-surface probe reads NON-ZERO with the handler's real output",
    async () => {
      host = await createCrashHost({
        prefix: "iknow-sc2-tool-",
        conversationId: "sc2-tool-prove-it",
      });
      const armed = await runRoleInFreshProcess<ToolArmResult>({
        host,
        request: {
          role: "chat_turn",
          line: "read the probe file",
          toolUse: { id: "toolu-prove-it" },
        },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });
      assertFullProductionSurface(armed.toolProbe);
      assert.equal(
        armed.toolProbe.armed,
        true,
        `the probe must fire where a tool really runs: ${armed.toolProbe.controls.join(", ")}`
      );
      assert.ok(
        armed.toolProbe.hits.length > 0,
        "a real dispatch produced no probe hit — the instrument is dead"
      );
      assert.deepEqual(
        armed.toolProbe.hits,
        ["handler:read_file"],
        "the hit is the real read_file handler body, not a routed call"
      );
      // Provenance, compared rather than assumed: the handler ran on the exact
      // input the provider's tool_use block carried.
      assert.deepEqual(
        armed.handlerObservedInput,
        armed.providerToolUseInput,
        "the dispatched input is the provider's own tool_use.input"
      );

      // --- the real on-disk state: the handler's real file contents came back
      // through the real loop and were committed by the real persistence ---
      const log = await realLog(host);
      const results = toolResultTexts(log);
      assert.ok(
        results.some((t) => t.includes(armed.sentinel)),
        `the real tool's real output was not committed: ${JSON.stringify(results)}`
      );
      const toolUseIds = log.events
        .flatMap((e) => (e.message as NativeStateMessage).content)
        .filter((b) => b.type === "tool_result")
        .map((b) => (b.type === "tool_result" ? b.tool_use_id : ""));
      assert.ok(
        toolUseIds.includes("toolu-prove-it"),
        `the committed tool_result answers the provider's tool_use id: ${JSON.stringify(toolUseIds)}`
      );
    },
    CRASH_TEST_TIMEOUT
  );

  // The control that makes the reopen's zero a real measurement instead of a
  // quiet absence: a REAL `tool_use` is left in the persisted context, the
  // reopen really restores it, and then the arm dispatches it ON PURPOSE through
  // the same live probed production surface — the replay this criterion forbids.
  // The counter MUST read non-zero there, or the negative above proves nothing.
  it(
    "SC2 deliberate-replay control (PROVE-RED): recovery restores a real tool_use but dispatches nothing, and the same surface reads 0 for recovery and NON-ZERO when that restored tool_use is dispatched on purpose",
    async () => {
      host = await createCrashHost({
        prefix: "iknow-sc2-replay-",
        conversationId: "sc2-replay-control",
      });
      const receipt = await runHostToCrashPoint({
        host,
        crashPoint: "tool_use_committed_before_kill",
        timeoutMs: CRASH_TEST_TIMEOUT,
        request: {
          role: "chat_turn",
          line: "read the probe file",
          toolUse: { id: "toolu-replay", killAfterCommit: true },
        },
      });
      assert.equal(receipt.signal, "SIGKILL");

      // --- the first leg's real on-disk state: a real tool_use is in the log ---
      const log = await realLog(host);
      assert.ok(
        loggedToolUseIds(log).includes("toolu-replay"),
        `a real tool_use block was never persisted: ${JSON.stringify(loggedToolUseIds(log))}`
      );
      assert.ok(
        nativeStateRecords(log).some((r) => r.boundary === "tool_batch"),
        "the tool batch that carried it was checkpointed"
      );

      // --- the second real process: recovery, then the deliberate replay ---
      const reopened = await runRoleInFreshProcess<ReopenResult>({
        host,
        request: {
          role: "reopen_chat",
          replayRestoredToolUse: true,
        },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });
      assertFullProductionSurface(reopened.toolProbe);
      assert.equal(
        reopened.toolProbe.armed,
        true,
        `the probe's own control must fire, else both numbers are unobserved: ${reopened.toolProbe.controls.join(", ")}`
      );
      // The negative window, snapshotted before the replay dispatch.
      assert.deepEqual(
        reopened.toolProbe.hits,
        [],
        `recovery dispatched a tool even though it restored one: ${reopened.toolProbe.hits.join(", ")}`
      );
      const replay = reopened.replay;
      assert.ok(replay !== undefined, "the arm ran the deliberate replay");
      // The replay really did target a block recovery itself restored.
      assert.ok(
        replay.restoredToolUse !== null,
        "no tool_use block was restored, so the replay controlled nothing"
      );
      assert.equal(
        replay.restoredToolUse?.name,
        "read_file",
        "the restored tool_use is the real production tool the first leg dispatched"
      );
      // The crash point claims a SETTLED `tool_result` is on disk next to that
      // block, so read it: the committed result must carry the real bytes of the
      // file the restored `tool_use` named, read from disk HERE rather than
      // reported by the harness.
      const restoredPath = (replay.restoredToolUse?.input as { path?: string })
        ?.path;
      assert.equal(
        typeof restoredPath,
        "string",
        "the restored tool_use names the real file the first leg read"
      );
      const probeBytes = readFileSync(restoredPath as string, "utf8").trim();
      const committed = toolResultTexts(log);
      assert.ok(
        committed.some((t) => t.includes(probeBytes)),
        `the committed tool_result does not carry the file's real bytes: ${JSON.stringify(committed)}`
      );
      // The SAME snapshot the child took when the window closed and passed into
      // the replay leg: one source, so this re-reads the number asserted above
      // rather than taking a second one.
      assert.equal(replay.hitsAfterRecovery.length, 0);
      assert.ok(
        replay.hitsAfterReplay.length > 0,
        `the deliberate replay of a restored tool_use produced ZERO probe hits: ${JSON.stringify(replay.hitsAfterReplay)}`
      );
      assert.ok(
        replay.hitsAfterReplay.includes("handler:read_file"),
        `the replay hit is the real handler body: ${JSON.stringify(replay.hitsAfterReplay)}`
      );
      // ...and it was a REAL dispatch, not a routed call: the real handler's own
      // output came back.
      assert.equal(replay.dispatch.kind, "ok", JSON.stringify(replay.dispatch));
      assert.equal(
        replay.dispatch.readBack,
        true,
        "the replayed call ran the real handler body — its real file bytes came back"
      );
      // Provenance of the replay itself, compared rather than assumed: the
      // handler that fired was called with the RESTORED block's own input, and
      // with nothing else — the probe's own control input is cleared out of this
      // log before the window opens, so an extra entry here would be a second,
      // unaccounted dispatch.
      assert.deepEqual(
        replay.observedInputs,
        [replay.restoredToolUse?.input],
        "the replay ran the restored block's own input, once, and only that"
      );
      // Two numbers, two windows, one instrument: zero for recovery, non-zero
      // for the replay it declined to do.
      assert.equal(reopened.tripwire.armed, true);
      assert.deepEqual(
        reopened.tripwire.hits,
        [],
        `reopen issued a provider request: ${reopened.tripwire.hits.join(", ")}`
      );
    },
    CRASH_TEST_TIMEOUT
  );

  // The behavior under test, observed where it lives.
  //
  // The two arms above observe a counter. This one observes the HOST: after
  // recovery the same real process takes the operator's next line, and the real
  // loop decides — alone, from the restored context on its history — whether
  // any tool runs. The restored `tool_use` is a real, settled block that a
  // replaying host would find sitting right there on its history.
  //
  // The scripted response carries a NEW `tool_use`, a different id on a
  // different file, so the window is not vacuous: the turn really does dispatch,
  // through the real loop and the real handler, on the same instrument the
  // negative is read from. `noDispatchOf(…, "toolu-resumed")` is the assertion
  // the mutation control below has to turn red.
  it(
    "SC2 on the host's own dispatch path (PROVE-IT): a real host resumed from the checkpoint, continued a real turn from the restored context, dispatched the turn's own new tool_use and NOT the restored one",
    async () => {
      host = await createCrashHost({
        prefix: "iknow-sc2-hostpath-",
        conversationId: "sc2-host-path",
      });
      const receipt = await runHostToCrashPoint({
        host,
        crashPoint: "tool_use_committed_before_kill",
        timeoutMs: CRASH_TEST_TIMEOUT,
        request: {
          role: "chat_turn",
          line: "read the probe file",
          toolUse: { id: "toolu-resumed", killAfterCommit: true },
        },
      });
      assert.equal(receipt.signal, "SIGKILL");

      // The first leg really left a `tool_use` the reopen will restore.
      const log = await realLog(host);
      assert.ok(
        loggedToolUseIds(log).includes(RESTORED_CALL),
        `no tool_use block was left on disk to replay: ${JSON.stringify(loggedToolUseIds(log))}`
      );

      const reopened = await runRoleInFreshProcess<ReopenResult>({
        host,
        request: {
          role: "reopen_chat",
          continueTurn: { line: "and now read the other file", id: NEW_CALL },
        },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });
      assertFullProductionSurface(reopened.toolProbe);
      assert.equal(
        reopened.toolProbe.armed,
        true,
        `the probe's own control must fire, else this window proves nothing: ${reopened.toolProbe.controls.join(", ")}`
      );

      // --- window 1: recovery itself ---
      assert.deepEqual(
        reopened.toolProbe.hits,
        [],
        `recovery dispatched a tool: ${reopened.toolProbe.hits.join(", ")}`
      );
      assert.deepEqual(reopened.dispatchesAfterRecovery, []);

      // --- window 2: the host's own next turn, from the restored context ---
      const turn = reopened.continued;
      assert.ok(
        turn !== undefined,
        "the arm continued the host with a real turn"
      );
      assert.ok(
        turn.priorMessageCount > 0 && turn.priorTexts.some((t) => t.length > 0),
        `the turn did not start from the restored context: ${JSON.stringify(turn.priorTexts)}`
      );

      // The path is live: the turn's own tool_use really dispatched, on the
      // probed production surface, with its own wire id.
      const byId = dispatchesById(turn.dispatchesDuringTurn);
      assert.equal(
        byId.get(NEW_CALL)?.name,
        "read_file",
        `the turn's own tool_use never dispatched, so the window observed nothing: ${JSON.stringify(turn.dispatchesDuringTurn)}`
      );

      // The negative, in the form the mutation has to defeat: the restored call
      // is identified by the wire id the product would replay it under.
      noDispatchOf(turn.dispatchesDuringTurn, RESTORED_CALL);

      // Recovery still issued no provider request; the turn after it is served
      // by the scripted boundary, not the network.
      assert.equal(reopened.tripwire.armed, true);
      assert.deepEqual(
        reopened.tripwire.hits,
        [],
        `reopen issued a provider request: ${reopened.tripwire.hits.join(", ")}`
      );
    },
    CRASH_TEST_TIMEOUT
  );

  // The mutation the row was missing, and the reason the arm above is not
  // vacuous: introduce replay INTO THE PRODUCT, on the path the negative is
  // read from, and the same negative must fail.
  //
  // The defect is written to a COPY of the tree (mutant-tree.ts) and the crash
  // host is pointed at the copy's own entry, because the suite runs in parallel
  // forks against the real source: mutating the repository in place would leak a
  // defective build into unrelated files. The repository's `src/` is digested
  // before and after, so a write-through fails the test instead of surviving.
  it(
    "SC2 replay mutation (PROVE-RED): a build that re-dispatches the restored tool_use on the host's own path turns that same negative red",
    async () => {
      const repoRoot = join(import.meta.dirname, "..", "..", "..");
      // The mkdtemp root IS the copy root, so cleanup removes the whole thing and
      // no empty parent is left behind on any run.
      const mutant = buildMutantTree(
        repoRoot,
        await mkdtemp(join(tmpdir(), "iknow-sc2-mutant-")),
        injectReplayedRestoredToolCalls
      );
      try {
        host = await createCrashHost({
          prefix: "iknow-sc2-mutant-",
          conversationId: "sc2-mutant-replay",
          hostEntryPath: mutant.hostEntryPath,
        });
        const receipt = await runHostToCrashPoint({
          host,
          crashPoint: "tool_use_committed_before_kill",
          timeoutMs: CRASH_TEST_TIMEOUT,
          request: {
            role: "chat_turn",
            line: "read the probe file",
            toolUse: { id: RESTORED_CALL, killAfterCommit: true },
          },
        });
        assert.equal(receipt.signal, "SIGKILL");

        const reopened = await runRoleInFreshProcess<ReopenResult>({
          host,
          request: {
            role: "reopen_chat",
            continueTurn: { line: "and now read the other file", id: NEW_CALL },
          },
          timeoutMs: CRASH_TEST_TIMEOUT,
        });
        assertFullProductionSurface(reopened.toolProbe);
        const turn = reopened.continued;
        assert.ok(turn !== undefined, "the mutant host continued a real turn");

        // THE POINT, in the only form that counts: the ORIGINAL negative
        // assertion — the same helper, unchanged, the previous test calls on the
        // real build — is run here against a build that replays, and it must
        // FAIL. Nothing about the assertion is relaxed for the mutant; if the
        // negative were insensitive to a replay regression, this would not
        // throw, and the previous test's zero would be worthless.
        assert.throws(
          () => noDispatchOf(turn.dispatchesDuringTurn, RESTORED_CALL),
          (error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            assert.match(
              message,
              new RegExp(RESTORED_CALL),
              `the failure must name the restored call it caught: ${message}`
            );
            return true;
          },
          "the original negative assertion PASSED on a build that re-dispatches the restored tool_use, so it does not observe the behavior under test"
        );

        // And the violation is a real handler body that ran, not a routed call:
        // it dispatched the restored block's own input, and read the real file
        // that input names.
        const replayed = dispatchesById(turn.dispatchesDuringTurn).get(
          RESTORED_CALL
        );
        assert.equal(replayed?.name, "read_file");
        const restoredPath = (replayed?.input as { path?: string })?.path;
        assert.equal(
          typeof restoredPath,
          "string",
          "the replayed dispatch ran the restored block's own input"
        );
        assert.equal(
          readFileSync(restoredPath as string, "utf8").includes(PROBE_MARKER),
          true,
          "the replayed call really read the file the checkpoint's tool_use named"
        );
        // The turn's own new call still dispatched, so the mutant differs from
        // the real build ONLY by the replay — not by the turn having failed.
        assert.equal(
          dispatchesById(turn.dispatchesDuringTurn).get(NEW_CALL)?.name,
          "read_file",
          "the mutant turn still dispatched its own tool_use"
        );
      } finally {
        // The guard throws on a write-through, and the copy must be gone either
        // way — so cleanup is the inner `finally`, not a second statement in the
        // outer one that the throw would skip.
        try {
          mutant.assertRepoSourceUnchanged();
        } finally {
          mutant.cleanup();
        }
      }
    },
    CRASH_TEST_TIMEOUT * 2
  );
});

/** Wire id the first leg commits and the reopen restores. */
const RESTORED_CALL = "toolu-resumed";
/** Wire id the post-recovery turn's own response carries — a different call. */
const NEW_CALL = "toolu-after-recovery";
/** Bytes both probe files carry, so a real read is distinguishable. */
const PROBE_MARKER = "IKNOW-TOOL-PROBE-SENTINEL";

/** Index the dispatches the probe saw by the wire id of the call. */
function dispatchesById(
  dispatches: ReadonlyArray<ToolDispatch>
): Map<string, ToolDispatch> {
  const byId = new Map<string, ToolDispatch>();
  for (const d of dispatches) {
    if (d.toolUseId !== undefined) {
      byId.set(d.toolUseId, d);
    }
  }
  return byId;
}

/**
 * The negative the mutation control has to defeat, stated once so both arms
 * assert the SAME thing and cannot drift apart.
 */
function noDispatchOf(
  dispatches: ReadonlyArray<ToolDispatch>,
  toolUseId: string
): void {
  const found = dispatchesById(dispatches).get(toolUseId);
  assert.equal(
    found,
    undefined,
    `the host dispatched the restored tool_use ${toolUseId}: ${JSON.stringify(found)}`
  );
}

describe("SC8 — compaction branch (fresh process)", () => {
  it(
    "SC8: after a real compaction publish and a SIGKILL, a second process restores exactly the post-compaction snapshot, and the pre-compaction checkpoint stays selectable on its own branch",
    async () => {
      host = await createCrashHost({
        prefix: "iknow-sc8-",
        conversationId: "sc8-compaction",
      });
      // The pre-compaction history the run continues from, written by a real
      // host process before the crash pass. Long enough for the real gate to
      // take its windowed path rather than the full-summary fallback.
      const prior: ReadonlyArray<NativeStateMessage> = Array.from(
        { length: 10 },
        (_v, i) =>
          i % 2 === 0 ? userMsg(`old q${i}`) : assistantMsg(`old a${i}`)
      );
      await runHostToCompletion({
        host,
        timeoutMs: CRASH_TEST_TIMEOUT,
        request: {
          role: "publish",
          plan: [
            { op: "create", cwd: host.workspaceRoot },
            { op: "appendEvents", messages: [userMsg("old q0")] },
            {
              op: "appendNativeState",
              anchorEventId: "e0",
              boundary: "input",
              messages: [userMsg("old q0")],
            },
            // A later event moves the head off the pre-compaction anchor, so
            // that checkpoint now sits on its own branch.
            { op: "appendEvents", messages: [assistantMsg("old a1")] },
          ],
        },
      });
      const log = await realLog(host);
      assert.equal(log.head, "e1");
      const preCompaction = nativeStateRecords(log);
      assert.equal(preCompaction.length, 1);
      assert.equal(preCompaction[0]?.anchorEventId, "e0");

      // Same temp pool, same conversation: a real host run that compacts, then
      // dies at its first main-loop model request.
      const second = await runHostToCrashPoint({
        host,
        crashPoint: "first_model_dispatch",
        timeoutMs: CRASH_TEST_TIMEOUT,
        request: {
          role: "chat_turn",
          line: "new question",
          priorMessages: prior,
          compress: true,
        },
      });
      assert.equal(second.signal, "SIGKILL");

      // --- the real on-disk state, read here ---
      const afterKill = await realLog(host);
      const records = nativeStateRecords(afterKill);
      const compactionRecord = records.find((r) => r.boundary === "compaction");
      assert.ok(
        compactionRecord !== undefined,
        "the compaction really published a state"
      );
      const bodies = nativeStateBlobsDir(realConversationDir(host));
      const compactedSnapshot = parseNativeStateBody(
        readFileSync(join(bodies, compactionRecord.bodySha))
      );
      assert.ok(
        compactedSnapshot.messages.length < prior.length,
        "the compacted body really is shorter than the pre-compaction history"
      );
      // The selector, run on the real log: the current head picks the newest
      // on-chain state, the pre-compaction head picks the older branch.
      const onCurrentHead = resolvePublishedNativeState(afterKill);
      assert.equal(
        onCurrentHead.selected?.bodySha,
        records[records.length - 1]?.bodySha
      );
      const onPreCompactionBranch = resolvePublishedNativeState({
        ...afterKill,
        head: "e0",
      });
      assert.equal(
        onPreCompactionBranch.selected?.bodySha,
        preCompaction[0]?.bodySha,
        "the pre-compaction checkpoint is still selectable on its own branch"
      );

      // --- the second real process ---
      const reopened = await runRoleInFreshProcess<ReopenResult>({
        host,
        request: { role: "reopen_chat", seedMessages: prior },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });
      assert.equal(reopened.status.status, "recovered");
      const restored = reopened.restoredContext;
      assert.notEqual(restored, null);
      const selectedSha =
        resolvePublishedNativeState(afterKill).selected?.bodySha;
      const bodyMessages = parseNativeStateBody(
        readFileSync(join(bodies, selectedSha as string))
      ).messages;
      assert.deepEqual(
        JSON.parse(JSON.stringify(restored)),
        JSON.parse(JSON.stringify(bodyMessages)),
        "the restored context is the exact published post-compaction body"
      );
      assert.equal(
        texts(restored).includes("new question"),
        true,
        "the restored context is the run's own post-compaction context"
      );
    },
    CRASH_TEST_TIMEOUT
  );
});
