/**
 * tests/tui/tui-runtime-persistence-wiring.test.ts (bun:test)
 *
 * F4 of issue #1182's repair round: the TUI assembled its engine (and with it
 * the subagent manager) through `buildTuiDeps` with NO runtime-persistence
 * binder, so the ASSEMBLY-TIME consumer `noteWorkerDispatched` returned at
 * `if (opts.runtimePersistence === undefined) return;` and a TUI-owned worker
 * never recorded its identity. The damage was not a missing feature but a
 * VACUOUS GATE: with no record on disk the pre-continuation proof answered
 * `provable: true` ("no worker identity was recorded for this task"), and a
 * fresh process refusing a continuation had to say the task never existed.
 *
 * Real child process, real production spawn factory, real TUI assembly, real
 * bridge + store: the identity record and the `worker_progress` fact below are
 * the ones a TUI session actually wrote. The non-vacuity pair is the point —
 * the SAME assembly without a binder writes neither, and the same continuation
 * then refuses for the wrong reason (`not_found`, for a task whose own worker
 * is running).
 *
 * The assembly root is pinned with the documented `conversationId` seam so the
 * assertions can name one directory: the production TUI builds its initial
 * engine before it knows the session id, so it derives a randomUUID root
 * (src/tui/deps.ts). The directory SHAPE under test is the same one the hub's
 * session sweep reads (`<projectDir>/<conversationId>/subagents`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTuiDeps } from "../../src/tui/deps.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { createPreimageLedger } from "../../src/session-api/store/preimage-ledger.js";
import {
  CURRENT_SCHEMA_VERSION,
  NATIVE_STATE_FORMAT_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  resolveSubagentTraceDir,
  SessionStore,
  type SessionFileV1,
  type SessionOperationFactRecord,
} from "../../src/session-api/store/index.js";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.js";
import { readWorkerIdentityRecords } from "../../src/harness/subagent/worker-identity-record.js";
import {
  createSubAgentManager,
  SubAgentResumeError,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.js";
import { createDefaultSubAgentSpawn } from "../../src/harness/subagent/spawn.js";
import { makeDeps } from "../cli/_fixtures.ts";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";
import type { RuntimePersistenceBinder } from "../../src/shared/runtime-persistence.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

/** Minimal valid RuntimeBundle — buildTuiDeps reads only `env`. */
function makeBundle(): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-sentinel-tui-wire",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
    productRoot: undefined,
  };
  return { env } as unknown as RuntimeBundle;
}

/**
 * A real worker: it reads its envelope, appends one native message to its OWN
 * transcript, then holds the process open. `.cjs` because the production spawn
 * factory starts it as a plain script entry.
 */
const HOLD_WORKER = `
const fs = require("node:fs");
const path = require("node:path");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  if (!buf.includes("\\n")) return;
  const envelope = JSON.parse(buf.split("\\n", 1)[0]);
  if (typeof envelope.transcriptPath === "string") {
    fs.mkdirSync(path.dirname(envelope.transcriptPath), { recursive: true });
    fs.appendFileSync(
      envelope.transcriptPath,
      JSON.stringify({ role: "user", content: [{ type: "text", text: envelope.task }] }) + "\\n",
      "utf8"
    );
  }
  setInterval(() => {}, 1000);
});
`;

/** The same worker, but it leaves on its own after the dispatch settled. Used
 *  by the no-binder arms, where nothing recorded the pid and the test cannot
 *  reap the child without racing the manager's own stdin flush. */
const EXIT_WORKER = HOLD_WORKER.replace(
  "  setInterval(() => {}, 1000);",
  "  setTimeout(() => process.exit(0), 400);"
);

/** Wait for a self-exiting worker to be gone, so teardown never kills one. */
const settle = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const scratch: string[] = [];
const workerPids: number[] = [];

afterEach(async () => {
  for (const pid of workerPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // EXIT: already gone — the assertion under test stopped it.
    }
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && workerPids.some(isAlive)) {
    await new Promise((r) => setTimeout(r, 20));
  }
  workerPids.length = 0;
  await Promise.all(
    scratch
      .splice(0)
      .map((p) => rm(p, { recursive: true, force: true, maxRetries: 5 }))
  );
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

/** Write a worker entry and return its path (the spawn factory reads argv[1]). */
async function writeWorkerScript(
  prefix: string,
  source: string
): Promise<string> {
  const path = join(await makeScratch(prefix), "worker.cjs");
  writeFileSync(path, source, "utf8");
  return path;
}

const userMsg = (t: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text: t }],
});

const sampleFile = (id: string, taskRoot: string): SessionFileV1 =>
  ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "",
    cwd: taskRoot,
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
    nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
    workspaceRoot: taskRoot,
  }) as SessionFileV1;

interface Fixture {
  readonly dataDir: string;
  readonly taskRoot: string;
  /** The TUI's own bridge — the hub that owns the ONE binder (run.tsx's
   *  `bridgeRef.hub`), and the entry surface that loads the session. */
  readonly bridge: TuiBridge;
  readonly subagentsDir: string;
}

/** A new-format session with a persisted head, so a fact has an anchor. */
async function seedFixture(id: string): Promise<Fixture> {
  const dataDir = await makeScratch("iknow-tui-wire-");
  const taskRoot = await makeScratch("iknow-tui-wire-root-");
  const store = new SessionStore(
    dataDir,
    deriveProjectIdentityRoot({ cwd: taskRoot })
  );
  await store.save({ id, file: sampleFile(id, taskRoot) });
  await store.appendEvents({ id, events: [userMsg("go")] });
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: taskRoot,
    deps: makeDeps([]),
    inflight: createInflightRegistry(),
  });
  // The TUI entry surface: it loads the session — which is what arms the hub's
  // publication gate — and adopts the entry recovery.
  await bridge.openSession(id);
  // The first turn is what arms that gate in production too
  // (`SessionHub.loadSessionForTurn` is reached from `postMessage` only). The
  // stub deps have no responses, so the turn fails at the model boundary AFTER
  // the load; that failure is the fixture, not the assertion under test.
  await bridge
    .postMessage({ conversationId: id, text: "arm the publication gate" })
    .catch(() => undefined);
  return {
    dataDir,
    taskRoot,
    bridge,
    subagentsDir: resolveSubagentTraceDir({
      projectDir: bridge.store.getProjectDir(),
      conversationId: id,
    }),
  };
}

/**
 * The TUI assembly, wired the way run.tsx wires it: the HUB's single binder
 * reached through a late-bound delegate, because the engine is assembled before
 * the bridge exists. `wired: false` reproduces the pre-fix assembly (no
 * `runtimePersistence` at all), so the pair is comparable.
 */
async function assembleTui(
  fixture: Fixture,
  id: string,
  wired: boolean
): Promise<{ readonly manager: SubAgentManager }> {
  const binder: RuntimePersistenceBinder<AnthropicNativeMessage> | undefined =
    wired
      ? {
          bind: (sessionId) =>
            fixture.bridge.hub.runtimePersistenceBinder().bind(sessionId),
        }
      : undefined;
  const built = await buildTuiDeps(makeBundle(), {
    askUser: createNoAskUser(),
    dataDir: fixture.dataDir,
    workspaceRoot: fixture.taskRoot,
    userHome: join(fixture.dataDir, "home"),
    cwd: fixture.taskRoot,
    preimageLedger: createPreimageLedger(),
    // See the file header: production derives a random root because it does not
    // know the session id yet; the seam keeps the assertions on one directory.
    conversationId: id,
    ...(binder !== undefined ? { runtimePersistence: binder } : {}),
  });
  if (built.subagentManager === undefined) {
    throw new Error("the TUI assembly exposed no subagent manager");
  }
  return { manager: built.subagentManager };
}

/** Spawn a real worker through the production spawn factory. */
function spawnRealWorker(
  manager: SubAgentManager,
  workerScript: string,
  conversationId: string
): string {
  const original = process.argv[1];
  process.argv[1] = workerScript;
  try {
    return manager.spawn({ task: "hold the worker open", conversationId })
      .taskId;
  } finally {
    process.argv[1] = original;
  }
}

/** A FRESH manager over the same root: a new process with an empty task map. */
function freshProcessManager(subagentsDir: string): SubAgentManager {
  const base = createDefaultSubAgentSpawn();
  return createSubAgentManager({
    spawn: base,
    subagentsDir,
    sandboxRoot: subagentsDir,
  });
}

const operationFacts = async (
  fixture: Fixture,
  id: string
): Promise<ReadonlyArray<SessionOperationFactRecord>> =>
  parseSessionJsonl(
    await readFile(
      join(
        resolveConversationDir({
          projectDir: fixture.bridge.store.getProjectDir(),
          conversationId: id,
        }),
        `${id}.jsonl`
      ),
      "utf8"
    )
  ).records.filter(
    (r): r is SessionOperationFactRecord => r.type === "operation_fact"
  );

const workerFacts = (facts: ReadonlyArray<SessionOperationFactRecord>) =>
  facts.filter((f) => f.fact.kind === "worker_progress");

/** The fact append is fire-and-forget by contract, so poll the real log. */
async function pollWorkerFacts(
  fixture: Fixture,
  id: string
): Promise<ReadonlyArray<SessionOperationFactRecord>> {
  for (let i = 0; i < 100; i += 1) {
    const facts = workerFacts(await operationFacts(fixture, id));
    if (facts.length > 0) return facts;
    await new Promise((r) => setTimeout(r, 20));
  }
  return workerFacts(await operationFacts(fixture, id));
}

async function resumeThroughFreshProcess(
  manager: SubAgentManager,
  workerScript: string,
  taskId: string,
  conversationId: string
): Promise<SubAgentResumeError> {
  const resume = manager.resumeTask;
  if (resume === undefined) {
    throw new Error("the manager exposes no continuation entry");
  }
  const original = process.argv[1];
  process.argv[1] = workerScript;
  try {
    resume(taskId, { task: "continue the worker", conversationId });
  } catch (err) {
    if (err instanceof SubAgentResumeError) return err;
    throw err;
  } finally {
    process.argv[1] = original;
  }
  throw new Error("the continuation was permitted: the gate did not hold");
}

describe("TUI assembly reaches its assembly-time persistence consumer", () => {
  test("a real owned-worker spawn records identity and publishes the worker fact", async () => {
    const id = "tui-wire-wired";
    const fixture = await seedFixture(id);
    const workerScript = await writeWorkerScript(
      "iknow-tui-wire-worker-",
      HOLD_WORKER
    );
    const { manager } = await assembleTui(fixture, id, true);

    const taskId = spawnRealWorker(manager, workerScript, id);

    const record = readWorkerIdentityRecords(fixture.subagentsDir).records.find(
      (r) => r.task_id === taskId
    );
    expect(record, "no identity record for the TUI-owned worker").toBeDefined();
    expect(record!.pid).toBeGreaterThan(0);
    expect(record!.starttime).toBeGreaterThan(0);
    expect(record!.session_id).toBe(id);
    expect(record!.transcript_path).toContain(taskId);
    workerPids.push(record!.pid);

    const facts = await pollWorkerFacts(fixture, id);
    expect(facts.length).toBeGreaterThan(0);
    const fact = facts.find(
      (f) => f.fact.kind === "worker_progress" && f.fact.taskId === taskId
    );
    expect(fact, "no worker_progress fact reached the session").toBeDefined();
    if (fact?.fact.kind !== "worker_progress") {
      throw new Error("fact kind narrowed away by the assertion above");
    }
    expect(fact.fact.state).toBe("starting");
    // The SAME pid the record names — the identity the fact carries and the
    // identity a recovery process verifies are one value, not two.
    expect(fact.fact.process).toEqual({
      pid: record!.pid,
      startTime: record!.starttime,
    });
  });

  test("the same assembly WITHOUT a binder records nothing (the vacuous world)", async () => {
    const id = "tui-wire-unwired";
    const fixture = await seedFixture(id);
    const workerScript = await writeWorkerScript(
      "iknow-tui-wire-worker-none-",
      EXIT_WORKER
    );
    const { manager } = await assembleTui(fixture, id, false);

    const taskId = spawnRealWorker(manager, workerScript, id);

    // No identity record: `noteWorkerDispatched` returned at its
    // undefined-binder guard, so a real running worker left no trace of its
    // process identity for any later process to verify.
    expect(
      readWorkerIdentityRecords(fixture.subagentsDir).records.find(
        (r) => r.task_id === taskId
      )
    ).toBeUndefined();
    expect(await operationFacts(fixture, id)).toHaveLength(0);

    await settle(600);
  });
});

describe("a continuation without proven stop evidence", () => {
  test("is refused for the live prior process, and the reason names that process", async () => {
    const id = "tui-wire-continue";
    const fixture = await seedFixture(id);
    const workerScript = await writeWorkerScript(
      "iknow-tui-wire-worker-cont-",
      HOLD_WORKER
    );
    const { manager } = await assembleTui(fixture, id, true);
    const taskId = spawnRealWorker(manager, workerScript, id);
    const record = readWorkerIdentityRecords(fixture.subagentsDir).records.find(
      (r) => r.task_id === taskId
    );
    expect(record).toBeDefined();
    workerPids.push(record!.pid);

    // The spawned worker is still running, so its process is NOT proven
    // stopped. A fresh process holding only the durable records must refuse.
    const refusal = await resumeThroughFreshProcess(
      freshProcessManager(fixture.subagentsDir),
      workerScript,
      taskId,
      id
    );

    expect(refusal.kind).toBe("prior_process_unconfirmed");
    // The truthful reason is about the PROCESS, not about the task's
    // existence — the worker and its transcript are on disk the whole time.
    expect(refusal.detail).toBe(
      `pid ${record!.pid} (starttime ${record!.starttime}) is still running`
    );
    expect(refusal.message).not.toMatch(/not_found/);
  });

  test('without a record the same continuation refuses as "never existed"', async () => {
    const id = "tui-wire-continue-none";
    const fixture = await seedFixture(id);
    const workerScript = await writeWorkerScript(
      "iknow-tui-wire-worker-cont-none-",
      EXIT_WORKER
    );
    const { manager } = await assembleTui(fixture, id, false);
    const taskId = spawnRealWorker(manager, workerScript, id);

    // The pre-fix answer: nothing was recorded, so a new process cannot tell a
    // crashed worker from a task that never existed — and says the latter.
    const refusal = await resumeThroughFreshProcess(
      freshProcessManager(fixture.subagentsDir),
      workerScript,
      taskId,
      id
    );
    expect(refusal.kind).toBe("not_found");

    await settle(600);
  });
});

/**
 * Source-wiring pins for the run.tsx seams this feature is wired through.
 * `runTui`'s full paths need a real renderer, which cannot be injected in
 * bun/vitest, so the two entry-level rules are pinned structurally — the same
 * style as tests/tui/lsp-exit-seam-wiring.test.ts. Both rules are the ones a
 * future edit could silently drop: the binder reaching the assembly-time
 * consumer, and the fail-closed file-intent rule next to it.
 */
describe("TUI entry wiring (run.tsx)", () => {
  const runTui = readFileSync(
    join(process.cwd(), "src", "tui", "run.tsx"),
    "utf8"
  );

  test("depsOpts carries the HUB's binder through a late-bound delegate", () => {
    expect(runTui).toContain("runtimePersistence: {");
    expect(runTui).toContain("bridgeRef.hub?.runtimePersistenceBinder().bind(");
  });

  test("no second binder over the store in the TUI entry", () => {
    expect(runTui).not.toContain("createRuntimePersistenceBinder");
  });

  test("a write that cannot record its file intent is still refused", () => {
    expect(runTui).toContain(
      "refusing a write that cannot record its file intent"
    );
    expect(runTui).toContain('"PERSIST_FAILED"');
  });
});
