/**
 * SC24 — normal-permission host acceptance over a real PTY
 * (spec `session-checkpoint-architecture.md` SC24).
 *
 * The criterion asks for one continuous experiment, and this file is that
 * experiment rather than a set of approximations:
 *
 *   1. a PERSISTENT native session host runs on a real pty, under its NORMAL
 *      permission fence — no `--yolo`, no `--auto-mode`, no `--eval-state`, no
 *      permission env override (asserted, not assumed);
 *   2. a user input is accepted, and the engine publishes the accepted-input
 *      boundary to real storage;
 *   3. the host makes a REAL file write, which the fence gates: the write only
 *      happens because the test answered the host's own `[ask] … [y/N]:`
 *      prompt the way a human would;
 *   4. the host is killed by SIGKILL to its pty process group at a NAMED
 *      boundary — holding the settled tool result, blocked inside its next
 *      model dispatch, with no cleanup handler and no graceful path;
 *   5. the SAME session is reopened twice: in a second real process (the
 *      existing fresh-process crash harness) and on a second real pty host;
 *   6. the recovery status is observed, the accepted input and the file
 *      progress are verified present, and no model or tool replay happens.
 *
 * No real model key is involved or required. The host reaches a real Anthropic
 * Messages endpoint served by a loopback HTTP server in this process, so the
 * host's own transport, request bodies and dispatch boundaries are all real;
 * only the model's answer is scripted. `real-llm/` remains the only place a
 * real provider call counts, and nothing here claims otherwise.
 *
 * Isolation, per `.claude/rules/test.md`: the session pool, the workspace and
 * the `$HOME` whose settings route the provider are three temp directories under
 * one root, created by the existing crash harness. This file never reads or
 * writes the repository's `data/`, and never reads a real `~/.iknow` or any
 * credential — the provider key is a literal placeholder this test owns.
 *
 * Step 2 carries a publication claim, and a claim is only evidence if it can
 * fail. The third test is the control for it: the same flow driven on the
 * `--resume` posture, where the product is structurally unable to publish
 * (ADR-0136 — `newFormat` is `resumeId === undefined`, so the resumed posture
 * installs no persistence sink at all). It runs on one session, one log and one
 * predicate, holding everything but the posture constant, and it asserts the
 * publication does NOT arrive. Without it, "the input boundary was published"
 * is a claim about what the reader reports rather than about what the host did.
 */
import { afterAll, afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  createCrashHost,
  disposeAllCrashHosts,
  type CrashHost,
  realConversationDir,
  realLogBytes,
  realLogPath,
  realNativeBodies,
  realSessionFingerprint,
  runRoleInFreshProcess,
} from "./crash/crash-harness.ts";
import {
  assertNormalFence,
  createPtyChatHost,
  disposeAllPtyHosts,
  isProcessAlive,
  startLoopbackProvider,
  waitForOnDisk,
  writeHermeticHome,
  type LoopbackProvider,
  type PtyChatHost,
} from "./crash/pty-harness.ts";
import { parseSessionJsonl } from "../../src/session-api/store/jsonl.ts";
import { canRunBwrapFence } from "../_helpers/bwrap-capability.ts";

/** A real host pays ~1s of module loading before it prints anything, and the
 *  reopen is a second boot, so these are IO budgets, not contract timeouts. */
const HOST_READY_MS = 120_000;
const TURN_MS = 120_000;
const FENCE_MS = 120_000;
const BOUNDARY_MS = 120_000;
const FRESH_PROCESS_MS = 120_000;
/** Wall clock for the whole criterion, asserted per test below. */
const SCENARIO_TIMEOUT_MS = 480_000;

const API_KEY_ENV = "IKNOW_PTY_ACCEPTANCE_KEY";
/** A literal placeholder, never a real credential. */
const API_KEY = "pty-acceptance-placeholder";

/** The first turn exists to give the session a committed head and a settled
 *  turn before the write turn, so the write turn is the one the crash boundary
 *  interrupts. The greeting's own input boundary DOES publish: the accepted-input
 *  seam appends the message before the engine dispatches, so the publication
 *  always has an anchor on a new-format host (measured, not assumed). */
const GREETING = "say hello first";
const WRITE_INSTRUCTION = "write the acceptance output file";
const WRITE_CONTENT = "written under the normal permission fence\n";
/** The tool the harness's real host exposes for creating a file; the fence
 *  prompt, the model request and the restored context must all name it. */
const WRITE_TOOL_NAME = "write_file";
/** The control's second accepted input. Distinct from GREETING and from the
 *  write instruction on purpose: the control needs a turn that publishes and
 *  settles WITHOUT reaching a tool, so it needs no fence answer and the
 *  provider stays on its text branch. */
const PUBLISHING_TURN = "restate the acceptance rule";
/** Distinct again, so the resumed host's dispatch is provably its own turn and
 *  not a repeat of the one before it. */
const RESUMED_TURN = "name the turn before this one";

/** The recovery view a fresh process reports, as the crash harness prints it. */
interface ReopenReport {
  readonly status: { readonly status: string };
  readonly savedMessageCount: number;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly content: ReadonlyArray<{
      readonly type: string;
      readonly text?: string;
    }>;
  }>;
  readonly operations: ReadonlyArray<{ readonly status?: string }>;
  readonly tripwire: {
    readonly armed: boolean;
    readonly hits: ReadonlyArray<string>;
  };
}

/** Every session log the killed host really wrote, read from the pool. */
async function realSessionLogs(sessionPoolDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (path.endsWith(".jsonl")) out.push(path);
    }
  };
  await walk(sessionPoolDir);
  return out.sort();
}

/**
 * Every runtime-state boundary the real log carries, in storage vocabulary.
 *
 * Extracted because the control below must defend THIS assertion: a control
 * that re-implemented the filter would be asserting a copy of it, and a copy
 * can agree with a broken original for reasons that have nothing to do with
 * publication.
 */
function inputBoundaries(logText: string): ReadonlyArray<string | undefined> {
  return parseSessionJsonl(logText)
    .records.filter((r) => r.type === "native_state")
    .map((r) => (r as { boundary?: string }).boundary);
}

/** How many `input` boundaries that list holds. The main experiment asserts
 *  `includes("input")`; a count lets the control compare before/after on ONE
 *  log instead of racing a record an earlier turn already published. */
function inputBoundaryCount(logText: string): number {
  return inputBoundaries(logText).filter((b) => b === "input").length;
}

/** Start one fenced pty host. Asserting the fence here means no leg of either
 *  experiment can acquire a bypass by editing its own argument list. */
async function startFencedLeg(opts: {
  readonly host: CrashHost;
  readonly home: string;
  readonly label: string;
  readonly extraArgs: ReadonlyArray<string>;
}): Promise<PtyChatHost> {
  assertNormalFence(opts.extraArgs);
  return createPtyChatHost({
    label: opts.label,
    cwd: opts.host.workspaceRoot,
    dataDir: opts.host.sessionPoolDir,
    home: opts.home,
    apiKeyEnv: API_KEY_ENV,
    apiKey: API_KEY,
    extraArgs: opts.extraArgs,
  });
}

/**
 * Wait for a pattern in output produced AFTER `from`.
 *
 * The harness's own `waitFor` matches the whole rolling screen, so a SECOND
 * turn on one host would be declared settled by the first turn's already-printed
 * text. Slicing at the mark taken before the send is what makes the second
 * turn's settle a real observation.
 */
async function waitForFreshOutput(opts: {
  readonly host: PtyChatHost;
  readonly from: number;
  readonly pattern: RegExp;
  readonly ms: number;
  readonly what: string;
}): Promise<void> {
  const deadline = Date.now() + opts.ms;
  while (Date.now() < deadline) {
    if (opts.pattern.test(opts.host.output().slice(opts.from))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `${opts.host.label}: timed out after ${opts.ms}ms waiting for ${opts.what}\n` +
      `--- pty output ---\n${opts.host.output()}`
  );
}

/**
 * Type one line into a real host's readline and prove the turn really ran: a
 * model dispatch carrying that exact accepted text, then a settled turn.
 *
 * The dispatch half is what makes the control non-degenerate. A `--resume` host
 * that published nothing would look identical to one that never reached the
 * model, and the difference between "the posture withholds the publication" and
 * "nothing happened" is decided here, out of process.
 */
async function runAcceptedTurn(opts: {
  readonly host: PtyChatHost;
  readonly provider: LoopbackProvider;
  readonly text: string;
  readonly ms: number;
}): Promise<void> {
  const arrivedBefore = opts.provider.requests.length;
  const printedBefore = opts.host.output().length;
  opts.host.send(`${opts.text}\n`);
  await opts.provider.waitForRequests(
    arrivedBefore + 1,
    opts.ms,
    `the model dispatch carrying "${opts.text}"`
  );
  assert.ok(
    opts.provider.requests
      .slice(arrivedBefore)
      .some((r) => r.flat.includes(opts.text)),
    `the host must dispatch the accepted input "${opts.text}" to the model`
  );
  await waitForFreshOutput({
    host: opts.host,
    from: printedBefore,
    pattern: /stop=completed/,
    ms: opts.ms,
    what: `the turn "${opts.text}" to settle`,
  });
}

describe("SC24 — normal-permission host acceptance over a real pty", () => {
  afterEach(async () => {
    // Every host disposes itself from its own `finally`; this is the backstop
    // that makes a failed assertion unable to leak a process.
    await disposeAllPtyHosts();
    await disposeAllCrashHosts();
  });
  afterAll(async () => {
    await disposeAllPtyHosts();
    await disposeAllCrashHosts();
  });

  // SC24 needs a real fence: the host must admit the write because the test
  // answered its `[ask]` prompt, which only happens when the fence really
  // isolates rather than refusing outright. On a runner that cannot unshare a
  // namespace the host dies at `runInSandbox: bwrap is required` and the case
  // times out waiting for the REPL prompt — a 120s stall, not a clean skip.
  //
  // The other two cases deliberately expect the fence to DENY the write, so
  // they pass on exactly the hosts where this one cannot run: absent bwrap the
  // fence refuses early and the assertion holds. They are deliberately left
  // ungated — registering this whole file to silence SC24 would throw away two
  // cases that are green in CI today.
  it.skipIf(!canRunBwrapFence())(
    "accepts input, writes a file under the fence, dies abnormally, and reopens with no replay",
    async () => {
      const host = await createCrashHost({
        prefix: "iknow-pty-acceptance-",
        conversationId: randomUUID(),
      });
      const home = join(host.root, "home");
      await mkdir(join(home, ".iknow"), { recursive: true });
      const writePath = join(host.workspaceRoot, "acceptance-output.txt");
      const provider = await startLoopbackProvider({
        writeInstruction: WRITE_INSTRUCTION,
        writePath,
        writeContent: WRITE_CONTENT,
      });
      await writeHermeticHome({
        home,
        providerOrigin: provider.origin,
        apiKeyEnv: API_KEY_ENV,
      });

      // Every leg asserts the fence on the args it actually passes, so a future
      // edit that reaches for a bypass fails here rather than producing
      // evidence that would have to be thrown away.
      const startLeg = async (
        label: string,
        extraArgs: ReadonlyArray<string>
      ): Promise<Awaited<ReturnType<typeof createPtyChatHost>>> => {
        assertNormalFence(extraArgs);
        return createPtyChatHost({
          label,
          cwd: host.workspaceRoot,
          dataDir: host.sessionPoolDir,
          home,
          apiKeyEnv: API_KEY_ENV,
          apiKey: API_KEY,
          extraArgs,
        });
      };

      // -- leg 1: the persistent host on a real pty --------------------------
      const leg1 = await startLeg("leg1", []);
      const leg1ChildPid = leg1.childPid;
      try {
        await leg1.waitFor(
          /iknow> /,
          HOST_READY_MS,
          "the persistent host REPL prompt"
        );

        leg1.send(`${GREETING}\n`);
        await leg1.waitFor(
          /stop=completed/,
          TURN_MS,
          "the greeting turn to settle"
        );

        // The accepted input must reach the model boundary — that is the proof it
        // was accepted, not merely echoed.
        await provider.waitForRequests(1, TURN_MS, "the first model dispatch");
        assert.ok(
          provider.requests.some((r) => r.flat.includes(GREETING)),
          "the host must dispatch the accepted user input to the model"
        );

        leg1.send(`${WRITE_INSTRUCTION}\n`);
        // The prompt must name the real file-write tool: an approval for some
        // other question would not be what gated this write.
        await leg1.waitFor(
          /\[ask\] write_file\? \[y\/N\]:/,
          FENCE_MS,
          "the normal permission fence to ask about the write"
        );
        leg1.send("y\n");

        // The NAMED crash boundary: the settled tool result is in the host's
        // context and it is asking the model again. The provider leaves that
        // request unanswered, so the host is blocked inside its model call.
        const boundary = await provider.waitForPostToolDispatch(
          BOUNDARY_MS,
          "the post-write model dispatch"
        );
        assert.ok(
          boundary.hasToolResult,
          "the crash boundary must be reached with the tool result already settled"
        );

        // File progress: a real write, in a temp dir, with the real bytes.
        await waitForOnDisk(
          () => existsSync(writePath),
          FENCE_MS,
          "the fenced file write to land on disk"
        );
        assert.equal(await readFile(writePath, "utf8"), WRITE_CONTENT);
      } finally {
        await leg1.killGroup();
      }
      assert.ok(
        !isProcessAlive(leg1ChildPid),
        "the SIGKILLed pty host must not survive its own crash"
      );

      // -- what the killed host left on disk ---------------------------------
      const logs = await realSessionLogs(host.sessionPoolDir);
      assert.equal(
        logs.length,
        1,
        `expected exactly one session log, got ${logs.join(", ")}`
      );
      const logPath = logs[0] as string;
      const logText = await readFile(logPath, "utf8");
      const parsed = parseSessionJsonl(logText);

      // The harness's own reader must agree with where the real host wrote, or
      // every later read through it would be reading a fiction.
      const conversationId = parsed.header.conversation_id;
      assert.match(
        conversationId,
        /^[0-9a-f-]{36}$/,
        "the killed host must own a real conversation id"
      );
      const asDiscovered: CrashHost = { ...host, conversationId };
      assert.equal(
        realLogPath(asDiscovered),
        logPath,
        "the crash harness's log reader must resolve the killed host's real log"
      );
      assert.equal(realConversationDir(asDiscovered), join(logPath, ".."));

      const records = parsed.records;
      const boundaries = inputBoundaries(logText);
      assert.ok(
        boundaries.includes("input"),
        `the accepted-input publication must reach storage on a real host, saw ${JSON.stringify(boundaries)}`
      );
      assert.ok(
        (await realNativeBodies(asDiscovered)).length > 0,
        "a published native state must leave an immutable content-addressed body"
      );
      assert.ok(
        records.some((r) => r.type === "operation_fact"),
        "the file write must leave a durable operation fact"
      );
      assert.ok(
        logText.includes(WRITE_INSTRUCTION),
        "the accepted write instruction must be in the session log"
      );
      assert.ok(
        logText.includes(WRITE_TOOL_NAME) && logText.includes("tool_result"),
        "the tool request and its settled result must both be durable"
      );
      // The crash boundary itself, read off the log: the greeting turn settled,
      // the write turn did not. A host that had exited gracefully would have
      // written a second turn outcome here.
      assert.equal(
        records.filter((r) => r.type === "outcome").length,
        1,
        "only the settled greeting turn may have an outcome; the killed turn must not"
      );

      // -- reopen 1: a second REAL process (the existing crash harness) -------
      const reopen = await runRoleInFreshProcess<ReopenReport>({
        host: asDiscovered,
        request: { role: "reopen_chat" },
        timeoutMs: FRESH_PROCESS_MS,
      });
      assert.equal(
        reopen.status.status,
        "recovered",
        "a fresh process reopening a crashed new-format session must classify as recovered"
      );
      assert.ok(
        reopen.savedMessageCount > 0,
        "the reopen must restore saved context"
      );
      const restored = JSON.stringify(reopen.messages);
      assert.ok(
        restored.includes(WRITE_INSTRUCTION),
        "the reopened session must carry the accepted input forward"
      );
      assert.ok(
        restored.includes(`"name":"${WRITE_TOOL_NAME}"`),
        "the reopened session must carry the file write's request forward"
      );
      assert.ok(
        restored.includes("tool_result") &&
          restored.includes("wrote") &&
          restored.includes(`${WRITE_CONTENT.length} bytes`),
        "the reopened session must carry the file write's settled result forward"
      );
      assert.equal(
        reopen.tripwire.armed,
        true,
        "the reopen tripwire must be armed"
      );
      assert.deepEqual(
        reopen.tripwire.hits,
        [],
        "a fresh-process reopen must make no outbound provider request"
      );

      // -- reopen 2: a second REAL pty host on the SAME session --------------
      const beforeReopen = {
        requests: provider.requests.length,
        log: await realLogBytes(asDiscovered),
        fingerprint: await realSessionFingerprint(asDiscovered),
        file: await stat(writePath),
      };
      const leg2 = await startLeg("leg2", ["--resume", conversationId]);
      try {
        const statusLine = await leg2.waitFor(
          /\[recovery\][^\n]*/,
          HOST_READY_MS,
          "the reopened host to report its recovery status"
        );
        assert.match(
          statusLine.match(/\[recovery\][^\n]*/)?.[0] ?? "",
          /^\[recovery\] recovered/,

          `the reopened host must report a real recovery status, saw: ${leg2.output()}`
        );
        // The open path is complete once the host is back at its prompt, so this
        // is the point at which "nothing was replayed" is decidable: a replay
        // would have to be dispatched during the open, strictly before this.
        await leg2.waitFor(
          /iknow> /,
          HOST_READY_MS,
          "the reopened host REPL prompt"
        );
        const duringReopen = provider.requests.slice(beforeReopen.requests);
        // "No automatic replay" stated as the observable it is: nothing the
        // crashed turn settled — its accepted input, its tool_use, its
        // tool_result — may appear in any request the reopen makes. A boot-time
        // call whose whole context is one literal line is not settled work and
        // is not excluded here; the claim is scoped to replay, and the
        // zero-tool_use count below closes the tool half.
        const replayed = duringReopen.filter(
          (r) =>
            r.hasToolResult ||
            r.hasToolUse ||
            r.flat.includes(WRITE_INSTRUCTION) ||
            r.flat.includes(WRITE_TOOL_NAME)
        );
        assert.deepEqual(
          replayed.map((r) => r.n),
          [],
          `the reopen replayed settled work to the model: ${JSON.stringify(replayed.map((r) => r.blocks))}`
        );
        assert.deepEqual(
          duringReopen.filter((r) =>
            r.blocks.some((b) => b.startsWith("tool_use"))
          ),
          [],
          "the reopen must dispatch no tool"
        );
        assert.ok(
          (await realLogPath(asDiscovered)) === logPath,
          "the reopened host must reopen the same session log"
        );
      } finally {
        await leg2.killGroup();
      }

      // -- no replay, no duplicate record, no repeated file mutation ---------
      assert.equal(
        await realLogBytes(asDiscovered),
        beforeReopen.log,
        "reopening must not append a duplicate record to the session log"
      );
      assert.equal(
        await realSessionFingerprint(asDiscovered),
        beforeReopen.fingerprint,
        "reopening must not mutate any byte under the session folder"
      );
      const afterFile = await stat(writePath);
      assert.equal(await readFile(writePath, "utf8"), WRITE_CONTENT);
      assert.equal(
        afterFile.mtimeMs,
        beforeReopen.file.mtimeMs,
        "recovery must not repeat the file mutation"
      );
    },
    SCENARIO_TIMEOUT_MS
  );

  it(
    "refuses the write when the fence is denied, proving the fence is the product's own",
    async () => {
      const host = await createCrashHost({
        prefix: "iknow-pty-fence-",
        conversationId: randomUUID(),
      });
      const home = join(host.root, "home");
      await mkdir(join(home, ".iknow"), { recursive: true });
      const writePath = join(host.workspaceRoot, "denied-output.txt");
      const provider = await startLoopbackProvider({
        writeInstruction: WRITE_INSTRUCTION,
        writePath,
        writeContent: WRITE_CONTENT,
      });
      await writeHermeticHome({
        home,
        providerOrigin: provider.origin,
        apiKeyEnv: API_KEY_ENV,
      });

      const leg = await createPtyChatHost({
        label: "deny",
        cwd: host.workspaceRoot,
        dataDir: host.sessionPoolDir,
        home,
        apiKeyEnv: API_KEY_ENV,
        apiKey: API_KEY,
      });
      try {
        await leg.waitFor(/iknow> /, HOST_READY_MS, "the host REPL prompt");
        leg.send(`${GREETING}\n`);
        await leg.waitFor(
          /stop=completed/,
          TURN_MS,
          "the greeting turn to settle"
        );
        leg.send(`${WRITE_INSTRUCTION}\n`);
        // The prompt's existence is the fence: under a retired fence
        // (--yolo / full_auto) no question is ever asked and the write lands
        // unattended. Its absence would make the whole criterion worthless.
        await leg.waitFor(
          /\[ask\] write_file\? \[y\/N\]:/,
          FENCE_MS,
          "the permission fence to ask"
        );
        leg.send("n\n");
        // The host now holds a denial result and re-asks; that re-ask is the same
        // named boundary, and it is where this host is stopped.
        await provider.waitForPostToolDispatch(
          BOUNDARY_MS,
          "the post-denial model dispatch"
        );
        assert.equal(
          existsSync(writePath),
          false,
          "a denied write must not reach the filesystem"
        );
      } finally {
        await leg.killGroup();
        await leg.dispose();
      }
    },
    SCENARIO_TIMEOUT_MS
  );

  it(
    "proves the input-boundary publication can fail: the --resume posture never publishes it",
    async () => {
      const host = await createCrashHost({
        prefix: "iknow-pty-publication-",
        conversationId: randomUUID(),
      });
      const home = join(host.root, "home");
      await mkdir(join(home, ".iknow"), { recursive: true });
      const provider = await startLoopbackProvider({
        writeInstruction: WRITE_INSTRUCTION,
        // Never reached: no turn here carries the write instruction, so the
        // provider stays on its text branch and the control needs no fence.
        writePath: join(host.workspaceRoot, "control-unused.txt"),
        writeContent: WRITE_CONTENT,
      });
      await writeHermeticHome({
        home,
        providerOrigin: provider.origin,
        apiKeyEnv: API_KEY_ENV,
      });

      let logPath: string | undefined;
      let conversationId: string | undefined;
      let publishedBytes = "";
      let publishedInputCount = 0;

      // -- phase 1 + 2: one NEW-format host, two accepted turns --------------
      const creator = await startFencedLeg({
        host,
        home,
        label: "control-create",
        extraArgs: [],
      });
      try {
        await creator.waitFor(
          /iknow> /,
          HOST_READY_MS,
          "the creating host REPL prompt"
        );
        await runAcceptedTurn({
          host: creator,
          provider,
          text: GREETING,
          ms: TURN_MS,
        });

        const logs = await realSessionLogs(host.sessionPoolDir);
        assert.equal(
          logs.length,
          1,
          `expected exactly one session log, got ${logs.join(", ")}`
        );
        logPath = logs[0] as string;
        const asCreated: CrashHost = {
          ...host,
          conversationId: parseSessionJsonl(await readFile(logPath, "utf8"))
            .header.conversation_id,
        };
        conversationId = asCreated.conversationId;
        assert.equal(
          realLogPath(asCreated),
          logPath,
          "the crash harness's log reader must resolve the creating host's real log"
        );

        // Already 1, and this is the control's lower clamp. The first accepted
        // input's own publication lands on the head its own transcript commit
        // created: `commitAcceptedInput` appends the message BEFORE `runHarness`
        // dispatches, so `readHeadOrSkip` always has an anchor here. A reader
        // that reported success unconditionally would still satisfy the main
        // test; pinning this at exactly 1 is what makes the count a function of
        // the turns a host really ran rather than a constant.
        assert.equal(
          inputBoundaryCount(await readFile(logPath, "utf8")),
          1,
          `the first accepted input must publish exactly one input boundary, saw ${JSON.stringify(inputBoundaries(await readFile(logPath, "utf8")))}`
        );

        // Second turn, same host, same session, same log. The count must move,
        // so the predicate above is discriminating rather than fixed.
        await runAcceptedTurn({
          host: creator,
          provider,
          text: PUBLISHING_TURN,
          ms: TURN_MS,
        });
        publishedBytes = await readFile(logPath, "utf8");
        publishedInputCount = inputBoundaryCount(publishedBytes);
        assert.equal(
          publishedInputCount,
          2,
          `a NEW-format host must publish one input boundary per accepted turn, saw ${JSON.stringify(inputBoundaries(publishedBytes))}`
        );
      } finally {
        await creator.killGroup();
      }
      // Type guard for the resume leg below: the identity is only read after
      // this passes.
      assert.ok(
        logPath !== undefined && conversationId !== undefined,
        "the creating host must own a real session log before the resume leg"
      );

      // -- phase 3: the SAME flow on the `--resume` posture ------------------
      const asResumed: CrashHost = { ...host, conversationId };
      const resumed = await startFencedLeg({
        host,
        home,
        label: "control-resume",
        extraArgs: ["--resume", conversationId],
      });
      try {
        const statusLine = await resumed.waitFor(
          /\[recovery\][^\n]*/,
          HOST_READY_MS,
          "the resumed host to report its recovery status"
        );
        // The same real crash-recovery open the main experiment's leg2 makes, so
        // the posture is held constant and the publication is the only variable
        // the control varies.
        assert.match(
          statusLine.match(/\[recovery\][^\n]*/)?.[0] ?? "",
          /^\[recovery\] recovered/,
          `the resumed host must report a real recovery status, saw: ${resumed.output()}`
        );
        await resumed.waitFor(
          /iknow> /,
          HOST_READY_MS,
          "the resumed host REPL prompt"
        );
        assert.equal(
          realLogPath(asResumed),
          logPath,
          "the resumed host must reopen the same session log"
        );

        // The head this turn would publish off is the SAME head phase 2 already
        // published off, so a headless skip is not what withholds the record
        // here. The posture is the only variable that changed.
        await runAcceptedTurn({
          host: resumed,
          provider,
          text: RESUMED_TURN,
          ms: TURN_MS,
        });

        // THE CONTROL — the main experiment's own assertion, on this log, after
        // a turn this host really accepted, really dispatched and really
        // settled. It is the one assertion in this file that is expected NOT to
        // hold, and it is the only thing standing between the main test's
        // publication claim and a reader that reports success unconditionally.
        const resumedBytes = await readFile(logPath, "utf8");
        assert.equal(
          inputBoundaryCount(resumedBytes),
          publishedInputCount,
          `the --resume posture must not publish an input boundary, saw ${JSON.stringify(inputBoundaries(resumedBytes))}`
        );
        // Non-degeneracy, in the log rather than in the harness's own beliefs:
        // the resumed turn appended to the SAME log and its accepted input is
        // durable, so the withheld publication is the posture's, not an idle
        // host's.
        assert.ok(
          resumedBytes.length > publishedBytes.length,
          "the resumed turn must have appended to the same session log"
        );
        assert.ok(
          resumedBytes.includes(RESUMED_TURN),
          "the resumed turn's accepted input must be durable in the transcript"
        );
      } finally {
        await resumed.killGroup();
        await resumed.dispose();
      }
    },
    SCENARIO_TIMEOUT_MS
  );
});
