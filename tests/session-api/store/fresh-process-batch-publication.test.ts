/**
 * SC5 — full batch checkpoint, across a REAL crash before that publication.
 *
 * The window under test is the one no in-process test can reach: a batch has
 * settled its first calls, one call is still in flight, and the host dies
 * before the `tool_batch_settled` publication. What must hold afterwards is
 * that the fresh process rebuilds from the base checkpoint plus the durable
 * per-result facts, says the unaccounted call is unaccounted, and retries
 * nothing.
 *
 * Everything here is a real process against a real temp pool:
 *   - `createCrashHost` / `runHostToCompletion` / `runRoleInFreshProcess` /
 *     `realLogBytes` / `realSessionFingerprint` come from the shared crash
 *     harness, so the seeding pass and the reopen are the harness's own.
 *   - The CRASHING arm is forked by this file rather than by the harness. Its
 *     crash point is a tool batch that has not settled, which no crash point in
 *     `CRASH_POINTS` walks toward, and naming a new one would mean editing a
 *     shared harness another agent depends on. The child is written into this
 *     host's own temp root and runs the production CLI chat host
 *     (`createChatSessionPersistence` + `processChatLine`), the production
 *     `SessionStore`, the production executor and the production recovery entry.
 *     The kill is the harness's own: `SIGKILL` to the whole process group.
 *
 * Nothing below trusts a value a child computed and returned: the on-disk facts
 * are read here with a fresh parse, and the recovery verdicts come from second
 * processes reading that same disk.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";

import {
  parseSessionJsonl,
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
  realLogPath,
  realSessionFingerprint,
  runHostToCompletion,
  runRoleInFreshProcess,
  type CrashHost,
} from "../crash/crash-harness.ts";
import { canRunBwrapFence } from "../../_helpers/bwrap-capability.ts";

/** Every child pays module load and this file forks several per test. */
const CRASH_TEST_TIMEOUT = 180_000;
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

const LINE = "run the mixed batch";

const userMsg = (text: string): NativeStateMessage => ({
  role: "user",
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

interface ReopenResult {
  readonly status: { readonly status: string };
  readonly savedMessageCount: number | null;
  readonly restoredContext: ReadonlyArray<NativeStateMessage> | null;
  readonly outcome: { readonly state: string } | null;
  readonly tripwire: {
    readonly armed: boolean;
    readonly controls: ReadonlyArray<string>;
    readonly hits: ReadonlyArray<string>;
  };
}

interface ReopenFact {
  readonly status: { readonly status: string };
  readonly restoredContext: ReadonlyArray<NativeStateMessage> | null;
  readonly operationFacts: {
    readonly toolResults?: ReadonlyArray<{
      readonly toolUseId: string;
      readonly batchPosition: number;
      readonly batchSize: number;
    }>;
  } | null;
}

async function realLog(host: CrashHost): Promise<ParsedSessionLog> {
  return parseSessionJsonl(await realLogBytes(host));
}

const nativeStateRecords = (
  log: ParsedSessionLog
): ReadonlyArray<SessionNativeStateRecord> =>
  log.records.filter(
    (r): r is SessionNativeStateRecord => r.type === "native_state"
  );

/** The tool_result facts a real log holds, with the record's own anchor. */
interface ToolFactView {
  readonly toolUseId: string;
  readonly batchPosition: number;
  readonly batchSize: number;
  readonly baseBodySha: string | null;
}

function toolFacts(log: ParsedSessionLog): ReadonlyArray<ToolFactView> {
  return log.records.flatMap((r) =>
    r.type === "operation_fact" && r.fact.kind === "tool_result"
      ? [
          {
            toolUseId: r.fact.toolUseId,
            batchPosition: r.fact.batchPosition,
            batchSize: r.fact.batchSize,
            baseBodySha: r.baseBodySha,
          },
        ]
      : []
  );
}

/** `is_error` per tool_result block in the committed transcript, in file order. */
function erroredResultIds(log: ParsedSessionLog): ReadonlyArray<string> {
  return log.events.flatMap((e) =>
    e.message.content.flatMap((block) =>
      block.type === "tool_result" && block.is_error === true
        ? [block.tool_use_id]
        : []
    )
  );
}

// -- the crashing / reopening arm --------------------------------------------

/**
 * The arm's source. Plain ESM with absolute module URLs, written into the
 * host's own temp root: `crash` runs a real chat turn and holds open once two
 * of its three calls have settled, `reopen` runs the production recovery entry
 * and prints what IT folded.
 */
function armSource(host: CrashHost): string {
  const src = (rel: string): string =>
    pathToFileURL(join(repoRoot(), rel)).href;
  return `
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createChatSessionPersistence,
  processChatLine,
  recoverChatSessionEntry,
} from ${JSON.stringify(src("src/cli/chat-session.ts"))};
import { SessionStore } from ${JSON.stringify(
    src("src/session-api/store/session-store.ts")
  )};
import { parseSessionJsonl } from ${JSON.stringify(
    src("src/session-api/store/jsonl.ts")
  )};
import { createExecutor } from ${JSON.stringify(
    src("src/harness/tools/executor.ts")
  )};
import { createRegistry } from ${JSON.stringify(
    src("src/harness/tools/registry.ts")
  )};
import { assistantResult, makeCtx, makeDeps } from ${JSON.stringify(
    src("tests/cli/_fixtures.ts")
  )};

const pool = ${JSON.stringify(host.sessionPoolDir)};
const workspace = ${JSON.stringify(host.workspaceRoot)};
const conversationId = ${JSON.stringify(host.conversationId)};
const liveRootIdentity = ${JSON.stringify(host.liveRootIdentity)};
const crashPointPath = ${JSON.stringify(host.crashPointPath)};
const logPath = ${JSON.stringify(realLogPath(host))};
const line = ${JSON.stringify(LINE)};

const store = new SessionStore(pool, workspace);
const projectDir = store.getProjectDir();

/** One tool def; all three are concurrency-safe so the batch is a single wave
 *  of three calls, which is what makes batchSize a whole-batch claim. */
function tool(name, handler) {
  return {
    name,
    description: name,
    inputSchema: { type: "object", additionalProperties: false },
    handler,
    aci: {
      category: "read-only",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "fast",
    },
  };
}

const responses = [
  assistantResult({
    texts: [],
    toolCalls: [
      { id: "a", name: "settle_ok", input: {} },
      { id: "b", name: "settle_error", input: {} },
      { id: "c", name: "hold_forever", input: {} },
    ],
  }),
  assistantResult({ texts: ["done"], toolCalls: [] }),
];

/** The real host turn, wired the way the CLI chat host wires it. \`inFlight\`
 *  decides whether the third call of the batch ever settles. */
async function runTurn(inFlight) {
  const registry = createRegistry([
    tool("settle_ok", async () => "ok-result"),
    tool("settle_error", async () => {
      throw new Error("this call refused");
    }),
    tool(
      "hold_forever",
      inFlight ? () => new Promise(() => {}) : async () => "late-result"
    ),
  ]);
  const base = makeDeps(responses);
  let priors = [];
  const persistence = createChatSessionPersistence({
    store,
    conversationId,
    newFormat: true,
    jsonMode: false,
    getPriors: () => priors,
    workspaceRoot: projectDir,
    deps: base,
  });
  const ctx = makeCtx({
    responses,
    checkpointStore: store,
    workspaceRoot: projectDir,
    stateOverrides: { conversationId },
  });
  priors = ctx.state.messages;
  const deps = {
    ...base,
    registry,
    executor: createExecutor(registry),
    toolTimeoutMs: 3_600_000,
    commitMessages: persistence.commit,
    ...(persistence.runtimePersistence !== undefined
      ? { runtimePersistence: persistence.runtimePersistence }
      : {}),
  };
  return await processChatLine({
    line,
    ctx: {
      ...ctx,
      deps,
      newFormatSession: true,
      commitAcceptedInput: persistence.commitAcceptedInput,
    },
  });
}

async function crashArm() {
  // The turn never returns: the third call of the batch never settles, so the
  // full-batch publication is never reached. The host only announces itself
  // once the first two results are durable on disk.
  void runTurn(true).catch(() => {});

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let settled = 0;
    try {
      const log = parseSessionJsonl(readFileSync(logPath, "utf8"));
      settled = log.records.filter((r) => r.type === "operation_fact").length;
    } catch {
      settled = 0;
    }
    if (settled >= 2) {
      writeFileSync(
        crashPointPath,
        JSON.stringify({
          point: "tool_batch_before_publication",
          detail: { conversationId, settledFacts: settled, batchSize: 3 },
        })
      );
      // A live, blocked process: SIGKILL must land on something running.
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    await sleep(20);
  }
  throw new Error("two of the three calls never settled");
}

/** The positive control for the crash arm: the same host, the same batch, the
 *  third call settling too — so the turn reaches the publication itself. */
async function settleArm() {
  await runTurn(false);
  process.stdout.write(
    "IKNOW-CRASH-RESULT " + JSON.stringify({ turnEnded: true }) + "\\n"
  );
}

async function reopenArm() {
  const { recovery } = await recoverChatSessionEntry({
    store,
    conversationId,
    taskRoot: workspace,
    liveRootIdentity,
    seedMessages: [{ role: "user", content: [{ type: "text", text: line }] }],
  });
  process.stdout.write(
    "IKNOW-CRASH-RESULT " +
      JSON.stringify({
        status: recovery.status,
        restoredContext: recovery.restoredContext,
        operationFacts: recovery.operationFacts ?? null,
      }) +
      "\\n"
  );
}

if (process.argv[2] === "reopen") await reopenArm();
else if (process.argv[2] === "settle") await settleArm();
else await crashArm();
`;
}

function repoRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

interface Forked {
  readonly pid: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
}

let forked: Forked | null = null;

/** Fork a real `node` process on its own process group, exactly as the shared
 *  harness does for its own arms. */
async function forkArm(
  host: CrashHost,
  mode: "crash" | "reopen" | "settle"
): Promise<Forked> {
  const entry = join(host.workspaceRoot, "batch-arm.mts");
  await writeFile(entry, armSource(host), "utf8");
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", tsxLoader, entry, mode],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("error", (spawnErr) => {
      err += `\nspawn error: ${String(spawnErr)}`;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const handle: Forked = {
    pid: child.pid ?? -1,
    stdout: () => out,
    stderr: () => err,
    exited,
  };
  forked = handle;
  return handle;
}

/** Wait for the arm's own announcement file, racing its exit. */
async function waitForAnnouncement(
  host: CrashHost,
  child: Forked,
  timeoutMs = CRASH_TEST_TIMEOUT
): Promise<Readonly<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  let gone = false;
  void child.exited.then(() => {
    gone = true;
  });
  while (Date.now() < deadline) {
    if (existsSync(host.crashPointPath)) {
      const announced = JSON.parse(
        await readFile(host.crashPointPath, "utf8")
      ) as { point?: string; detail?: Record<string, unknown> };
      assert.equal(
        announced.point,
        "tool_batch_before_publication",
        "the host announced a different crash point than this window"
      );
      return announced.detail ?? {};
    }
    if (gone) {
      const exit = await child.exited;
      throw new Error(
        `the host died before reaching the crash point ` +
          `(status=${String(exit.code)}, signal=${String(exit.signal)})\n` +
          `stderr:\n${child.stderr()}`
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `the host never reached the crash point\nstderr:\n${child.stderr()}`
  );
}

let host: CrashHost;

afterEach(async () => {
  // The harness reaps its own groups; this file reaps the one it forked.
  if (forked !== null) {
    try {
      process.kill(-forked.pid, "SIGKILL");
    } catch {
      // Already dead: the test killed it itself.
    }
    await forked.exited;
    forked = null;
  }
  await disposeAllCrashHosts();
});

describe("SC5 — full batch checkpoint, crashed before publication (fresh process)", () => {
  // Only THIS case needs the sandbox, so only this case is gated. The
  // difference is which harness entry it reaches: the `reopen_chat` role runs
  // the production tool probe, and that probe builds the real production
  // surface — armProductionToolProbe → buildProbedProductionSurface →
  // createDefaultAciRegistry → createBashTool → requireBwrap
  // (tests/session-api/crash/crash-host-entry.ts:616, :1138). None of those
  // call shapes appears in this file, so the static guard cannot see the
  // dependency; it arrives through a child process. The control below is
  // deliberately left ungated: it drives only the `publish` role and this
  // file's own forked arm, neither of which builds a production tool surface,
  // and it passes on a bwrap-less runner (measured). Gating the whole file
  // would have thrown that case away.
  it.skipIf(!canRunBwrapFence())(
    "SC5: with one call still in flight and one error result settled, a SIGKILL before the batch publication leaves no batch checkpoint; a fresh process recovers the base checkpoint plus the two durable facts, reports the third call unaccounted, and retries nothing",
    async () => {
      host = await createCrashHost({
        prefix: "iknow-sc5-batch-",
        conversationId: "sc5-batch-publication",
      });
      // A real host process writes the session the crash will land on.
      await runHostToCompletion({
        host,
        request: {
          role: "publish",
          plan: [{ op: "create", cwd: host.workspaceRoot }],
        },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });

      // --- the crashing real process ---
      const child = await forkArm(host, "crash");
      const detail = await waitForAnnouncement(host, child);
      assert.equal(detail.conversationId, "sc5-batch-publication");
      assert.equal(
        detail.settledFacts,
        2,
        "two of the three calls settled before the kill"
      );
      assert.equal(detail.batchSize, 3);

      // The real kill: negative pid = the whole process group, no handler.
      process.kill(-child.pid, "SIGKILL");
      const exit = await child.exited;
      forked = null;
      assert.equal(
        exit.signal,
        "SIGKILL",
        `the host must die by SIGKILL, got status=${String(exit.code)} ` +
          `signal=${String(exit.signal)}\nstderr:\n${child.stderr()}`
      );

      // --- the real on-disk state, read in THIS process ---
      const log = await realLog(host);
      const states = nativeStateRecords(log);
      assert.deepEqual(
        states.map((r) => r.boundary),
        ["input"],
        "only the base checkpoint is published: no full batch state"
      );
      assert.deepEqual(
        texts(
          log.events[0]?.message !== undefined ? [log.events[0].message] : []
        ),
        [LINE],
        "the base checkpoint was taken from the accepted input"
      );
      assert.deepEqual(
        log.events.flatMap((e) =>
          e.message.content.flatMap((b) =>
            b.type === "tool_use" ? [b.id] : []
          )
        ),
        ["a", "b", "c"],
        "the batch really had three calls, the third of which never returned"
      );

      const facts = toolFacts(log);
      assert.deepEqual(
        facts.map((f) => f.toolUseId).sort(),
        ["a", "b"],
        "the settled calls are durable; the in-flight one is not"
      );
      assert.deepEqual(
        [...facts]
          .sort((x, y) => x.batchPosition - y.batchPosition)
          .map((f) => [f.batchPosition, f.batchSize]),
        [
          [0, 3],
          [1, 3],
        ],
        "each fact places its call in the three-call batch"
      );
      // Anchored to the base checkpoint that is actually selected, which is
      // what lets the reopen fold them into that state.
      assert.deepEqual(
        facts.map((f) => f.baseBodySha),
        [states[0]?.bodySha, states[0]?.bodySha]
      );
      assert.deepEqual(
        erroredResultIds(log),
        ["b"],
        "the error result is persisted as an error, not dropped"
      );

      // --- the second real process: what recovery folded from that disk ---
      const factReopen = await runReopenInSecondProcess(host);
      assert.equal(factReopen.status.status, "recovered");
      assert.deepEqual(
        texts(factReopen.restoredContext),
        [LINE],
        "the restored context is the base checkpoint, not a batch state"
      );
      assert.deepEqual(
        (factReopen.operationFacts?.toolResults ?? []).map((t) => [
          t.toolUseId,
          t.batchPosition,
          t.batchSize,
        ]),
        [
          ["a", 0, 3],
          ["b", 1, 3],
        ],
        "the reopen folded both durable facts, the error one included"
      );

      // --- the harness's own reopen, in another real process ---
      const beforeReopen = await realSessionFingerprint(host);
      const reopened = await runRoleInFreshProcess<ReopenResult>({
        host,
        request: { role: "reopen_chat", seedMessages: [userMsg(LINE)] },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });
      assert.equal(
        reopened.tripwire.armed,
        true,
        `the tripwire's own control must fire: ${reopened.tripwire.controls.join(", ")}`
      );
      assert.deepEqual(
        reopened.tripwire.hits,
        [],
        `reopen issued a provider request: ${reopened.tripwire.hits.join(", ")}`
      );
      assert.equal(
        await realSessionFingerprint(host),
        beforeReopen,
        "the reopen read the session and retried nothing into it"
      );
      assert.equal(reopened.status.status, "recovered");
      assert.equal(reopened.savedMessageCount, 1);
      assert.deepEqual(texts(reopened.restoredContext), [LINE]);
      assert.equal(
        reopened.outcome?.state,
        "unknown",
        "a turn with an in-flight call and no outcome record is unknown, not completed"
      );
    },
    CRASH_TEST_TIMEOUT
  );

  it(
    "SC5 control: the same host and the same mixed batch DO publish the full state once the third call settles, carrying every result into the saved context",
    async () => {
      host = await createCrashHost({
        prefix: "iknow-sc5-control-",
        conversationId: "sc5-batch-settled",
      });
      await runHostToCompletion({
        host,
        request: {
          role: "publish",
          plan: [{ op: "create", cwd: host.workspaceRoot }],
        },
        timeoutMs: CRASH_TEST_TIMEOUT,
      });

      const child = await forkArm(host, "settle");
      const exit = await child.exited;
      assert.equal(
        exit.code,
        0,
        `the settling turn must finish, got status=${String(exit.code)} ` +
          `signal=${String(exit.signal)}\nstderr:\n${child.stderr()}`
      );

      // Without this arm, "no batch checkpoint" in the crash test above could be
      // an unwired publication path rather than the in-flight call. Here the
      // same host, same binder, same batch reaches the publication.
      const log = await realLog(host);
      const states = nativeStateRecords(log);
      assert.deepEqual(
        states.map((r) => r.boundary),
        ["input", "tool_batch", "terminal"],
        "a fully settled batch publishes the tool_batch boundary"
      );

      const dir = nativeStateBlobsDir(realConversationDir(host));
      const batchBody = parseNativeStateBody(
        await readFile(join(dir, states[1]!.bodySha))
      );
      const merged = batchBody.messages.at(-1);
      assert.equal(merged?.role, "user");
      assert.deepEqual(
        (merged?.content ?? []).map((b) =>
          b.type === "tool_result" ? [b.tool_use_id, b.is_error === true] : []
        ),
        [
          ["a", false],
          ["b", true],
          ["c", false],
        ],
        "every returned call, the error result included, is inside the saved context"
      );
    },
    CRASH_TEST_TIMEOUT
  );
});

/** A second real process, running the production recovery entry, reporting what
 *  IT read — not a value this test computed from the same records. */
async function runReopenInSecondProcess(host: CrashHost): Promise<ReopenFact> {
  const child = await forkArm(host, "reopen");
  const exit = await child.exited;
  assert.equal(
    exit.code,
    0,
    `the reopen process must succeed, got status=${String(exit.code)} ` +
      `signal=${String(exit.signal)}\nstderr:\n${child.stderr()}`
  );
  const line = child
    .stdout()
    .split("\n")
    .find((l) => l.startsWith("IKNOW-CRASH-RESULT "));
  assert.ok(line !== undefined, `no result line:\n${child.stdout()}`);
  return JSON.parse(line.slice("IKNOW-CRASH-RESULT ".length)) as ReopenFact;
}
