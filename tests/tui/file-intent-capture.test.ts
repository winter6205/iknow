/**
 * tests/tui/file-intent-capture.test.ts (bun:test)
 *
 * The TUI write path records a DURABLE per-file intent (ADR-0136 §3, SC9):
 * `buildTuiPreimageCapture` hands the capture the `intentRecorder` it needs, so
 * a TUI write leaves the same evidence the Hub write path leaves. Before this
 * wiring the TUI produced blobs + ledger entries and no durable intent, so
 * recovery had nothing to read on the TUI path.
 *
 * Real temp dirs, real production SessionStore, real filesystem, real TUI
 * assembly: the write tool is taken out of the ASSEMBLED registry, not
 * hand-wired, so every write below really goes through the TUI's capture. The
 * store is read back through a NEWLY CONSTRUCTED instance — a crash loses
 * in-memory state, which is what "durable" has to survive. Nothing about the
 * store or the filesystem is mocked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTuiDeps } from "../../src/tui/deps.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { createPreimageLedger } from "../../src/session-api/store/preimage-ledger.js";
import { createNativeStatePort } from "../../src/session-api/store/native-state-port-host.js";
import { NativeStatePortError } from "../../src/shared/native-state-port.js";
import { writeWorkerIdentityRecord } from "../../src/harness/subagent/worker-identity-record.js";
import {
  createRuntimePersistenceBinder,
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  SessionStore,
  type SessionFileV1,
  type SessionOperationFactRecord,
} from "../../src/session-api/store/index.js";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.js";
import type { RuntimeBundle } from "../../src/cli/runtime.js";
import type { IknowEnv } from "../../src/config/env.js";

/** Minimal valid RuntimeBundle — buildTuiDeps reads only `env` (same fixture
 *  shape as deps-tools.test.ts). */
function makeBundle(): RuntimeBundle {
  const env: IknowEnv = {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-test-sentinel-tui",
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

let dataDir: string;
let taskRoot: string;
let store: SessionStore;

const sampleFile = (id: string): SessionFileV1 => ({
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
});

const userMsg = (t: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text: t }],
});

/** A session with a real persisted head, so an intent has a branch anchor. */
async function seedChain(id: string): Promise<string> {
  await store.save({ id, file: sampleFile(id) });
  await store.appendEvents({ id, events: [userMsg("go")] });
  const log = parseSessionJsonl(
    await readFile(
      join(
        resolveConversationDir({
          projectDir: store.getProjectDir(),
          conversationId: id,
        }),
        `${id}.jsonl`
      ),
      "utf8"
    )
  );
  if (log.head === null) throw new Error("fixture must have a persisted head");
  return log.head;
}

/** Reopen from scratch: a NEW store instance over the same directory. */
const reopenedStore = (): SessionStore =>
  new SessionStore(dataDir, deriveProjectIdentityRoot({ cwd: taskRoot }));

const durableIntents = async (id: string) =>
  (await reopenedStore().loadPublishedNativeState({ id })).fileIntents;

/** Operation-fact records, read from the log on disk. */
const operationFacts = async (
  id: string
): Promise<ReadonlyArray<SessionOperationFactRecord>> =>
  parseSessionJsonl(
    await readFile(
      join(
        resolveConversationDir({
          projectDir: store.getProjectDir(),
          conversationId: id,
        }),
        `${id}.jsonl`
      ),
      "utf8"
    )
  ).records.filter(
    (r): r is SessionOperationFactRecord => r.type === "operation_fact"
  );

/** The manager's fact append is fire-and-forget, so poll the real log. */
async function pollFacts(
  id: string,
  attempts = 50
): Promise<ReadonlyArray<SessionOperationFactRecord>> {
  for (let i = 0; i < attempts; i += 1) {
    const facts = await operationFacts(id);
    if (facts.length > 0) return facts;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return operationFacts(id);
}

/** The TUI's own assembly, built as the TUI entry builds it. `writeFile` is
 *  the tool the ASSEMBLED registry holds, so the call runs the TUI's capture. */
async function assembleTui(withRecorder: boolean) {
  const deps = await buildTuiDeps(makeBundle(), {
    askUser: createNoAskUser(),
    dataDir,
    workspaceRoot: taskRoot,
    userHome: join(dataDir, "home"),
    cwd: taskRoot,
    preimageLedger: createPreimageLedger(),
    ...(withRecorder
      ? { fileIntentRecorder: createNativeStatePort({ store }) }
      : {}),
  });
  const write = deps.registry.get("write_file");
  const read = deps.registry.get("read_file");
  if (write === undefined || read === undefined) {
    throw new Error("TUI assembly registered no write_file / read_file");
  }
  return {
    // Same registry instance → the read registers the last-read the write gate
    // checks, exactly as it does in a live TUI turn.
    readFile: (
      path: string,
      call: { conversationId: string; toolUseId: string }
    ) => read.handler({ path }, call),
    writeFile: (
      path: string,
      content: string,
      call: { conversationId: string; toolUseId: string }
    ) => write.handler({ path, content }, call),
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "iknow-tui-intent-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-tui-intent-root-"));
  store = new SessionStore(
    dataDir,
    deriveProjectIdentityRoot({ cwd: taskRoot })
  );
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

describe("TUI write records a durable per-file intent", () => {
  test("a real write through the TUI capture is readable from a FRESH store", async () => {
    const id = "tui-intent-1";
    const head = await seedChain(id);
    await writeFile(join(taskRoot, "a.ts"), "old\n", "utf8");
    const tui = await assembleTui(true);

    // read-then-write: the overwrite gate (ADR-0084) is part of the real write
    // path, so satisfy it through the same assembled registry.
    await tui.readFile("a.ts", { conversationId: id, toolUseId: "tu-read" });

    await tui.writeFile("a.ts", "new\n", {
      conversationId: id,
      toolUseId: "tu-1",
    });
    expect(await readFile(join(taskRoot, "a.ts"), "utf8")).toBe("new\n");

    const intents = await durableIntents(id);
    expect(intents.length).toBe(1);
    const rec = intents[0]!.record;
    expect(rec.toolUseId).toBe("tu-1");
    expect(rec.captured).toBe(true);
    expect(rec.anchorEventId).toBe(head);
    expect(rec.targets.length).toBe(1);
    expect(rec.targets[0]!.relPath).toBe("a.ts");
    expect(rec.targets[0]!.rootIdentity).toBe(taskRoot);
    expect(rec.targets[0]!.absentBefore).toBe(false);
    // The preimage/postimage blobs are recorded as content addresses, so
    // recovery can read both bodies from the fresh store.
    expect(rec.targets[0]!.preimageSha).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.targets[0]!.postimageSha).toMatch(/^[0-9a-f]{64}$/);
  });

  test("one record per target — two targets under one tool_use_id do not collapse", async () => {
    const id = "tui-intent-2";
    await seedChain(id);
    const tui = await assembleTui(true);

    // Exactly the multi-file tool shape: the port runs once per target under
    // ONE tool_use_id, so a last-write-wins key would drop a target.
    for (const path of ["a.ts", "b.ts"]) {
      await tui.writeFile(path, `${path} body\n`, {
        conversationId: id,
        toolUseId: "tu-multi",
      });
    }

    const intents = await durableIntents(id);
    expect(intents.length).toBe(2);
    expect(intents.map((i) => i.record.toolUseId)).toEqual([
      "tu-multi",
      "tu-multi",
    ]);
    expect(intents.map((i) => i.record.targets[0]!.relPath)).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  test("no recorder supplied → the TUI assembly is unchanged (blobs only)", async () => {
    const id = "tui-intent-none";
    await seedChain(id);
    const tui = await assembleTui(false);
    await tui.writeFile("a.ts", "new\n", {
      conversationId: id,
      toolUseId: "tu-none",
    });
    // The write still happened …
    expect(await readFile(join(taskRoot, "a.ts"), "utf8")).toBe("new\n");
    // … and absent recorder is the pre-existing behavior, asserted so the
    // wiring cannot be mistaken for a behavior change on the no-recorder path.
    expect(await durableIntents(id)).toHaveLength(0);
  });

  test("a recorder that cannot record refuses the write (fail-closed)", async () => {
    const id = "tui-intent-refused";
    await seedChain(id);
    await writeFile(join(taskRoot, "guarded.ts"), "old\n", "utf8");
    // The exact refusal the TUI entry installs when its store is not ready: a
    // write that cannot record its file intent must not proceed.
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      dataDir,
      workspaceRoot: taskRoot,
      userHome: join(dataDir, "home"),
      cwd: taskRoot,
      preimageLedger: createPreimageLedger(),
      fileIntentRecorder: {
        recordFileIntent: () =>
          Promise.reject(
            new NativeStatePortError(
              "PERSIST_FAILED",
              "TUI store is not ready: refusing a write that cannot record its file intent"
            )
          ),
      },
    });
    const write = deps.registry.get("write_file");
    const read = deps.registry.get("read_file");
    if (write === undefined || read === undefined) {
      throw new Error("TUI assembly registered no write_file / read_file");
    }
    // The overwrite gate is part of the real write path, so satisfy it first:
    // the refusal under test must be the intent recorder's, not the gate's.
    await read.handler(
      { path: "guarded.ts" },
      { conversationId: id, toolUseId: "tu-read-refused" }
    );

    // Fail-closed means the write never reaches the filesystem at all: the
    // capture raises before the mutation, and the executor is what turns that
    // into a tool error for the model.
    let refusal: unknown;
    try {
      await write.handler(
        { path: "guarded.ts", content: "new\n" },
        { conversationId: id, toolUseId: "tu-refused" }
      );
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(NativeStatePortError);
    expect((refusal as NativeStatePortError).code).toBe("PERSIST_FAILED");
    // the refused write left the file alone
    expect(await readFile(join(taskRoot, "guarded.ts"), "utf8")).toBe("old\n");
    expect(await durableIntents(id)).toHaveLength(0);
  });
});

describe("TUI engine reaches the host runtime-persistence binder", () => {
  test("a real engine consumer publishes its fact to the session store", async () => {
    const id = "tui-binder-1";
    const head = await seedChain(id);
    // The binder the bridge owns, over the same store the intents go through.
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      dataDir,
      workspaceRoot: taskRoot,
      userHome: join(dataDir, "home"),
      cwd: taskRoot,
      preimageLedger: createPreimageLedger(),
      runtimePersistence: createRuntimePersistenceBinder({
        store,
        serialize: (_id, work) => work(),
        shouldPublish: () => true,
      }),
    });
    const manager = deps.subagentManager;
    if (manager?.stopOwnedWorkers === undefined) {
      throw new Error("the TUI assembly exposed no worker sweep");
    }
    const subagentsDir = join(dataDir, "subagents");
    // A pid that has already exited: the sweep's own probe confirms the stop
    // and publishes the verdict, so this exercises the real consumer path.
    const gone = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" });
    if (gone.pid === undefined) throw new Error("no pid to record");
    writeWorkerIdentityRecord(subagentsDir, {
      task_id: "task-binder-1",
      ownership: "foreground",
      worker_state: "running",
      pid: gone.pid,
      starttime: 1,
      transcript_path: join(subagentsDir, "task-binder-1.jsonl"),
      session_id: id,
    });

    await manager.stopOwnedWorkers({ subagentsDir, sessionId: id });

    // The append is fire-and-forget by contract, so poll for the record rather
    // than racing one tick.
    const facts = await pollFacts(id);
    expect(facts.length).toBe(1);
    const fact = facts[0]!.fact;
    expect(fact.kind).toBe("worker_progress");
    // RuntimeOperationFact is a 3-arm union; taskId/state live on the worker
    // arm, so read them through the kind check asserted above.
    if (fact.kind !== "worker_progress") {
      throw new Error(`expected a worker_progress fact, got ${fact.kind}`);
    }
    expect(fact.taskId).toBe("task-binder-1");
    expect(fact.state).toBe("stopped");
    expect(facts[0]!.anchorEventId).toBe(head);
  });

  test("no binder supplied → the sweep reports the stop and publishes nothing", async () => {
    const id = "tui-binder-none";
    await seedChain(id);
    const deps = await buildTuiDeps(makeBundle(), {
      askUser: createNoAskUser(),
      dataDir,
      workspaceRoot: taskRoot,
      userHome: join(dataDir, "home"),
      cwd: taskRoot,
      preimageLedger: createPreimageLedger(),
    });
    const manager = deps.subagentManager;
    if (manager?.stopOwnedWorkers === undefined) {
      throw new Error("the TUI assembly exposed no worker sweep");
    }
    const subagentsDir = join(dataDir, "subagents-none");
    const gone = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" });
    if (gone.pid === undefined) throw new Error("no pid to record");
    writeWorkerIdentityRecord(subagentsDir, {
      task_id: "task-binder-none",
      ownership: "foreground",
      worker_state: "running",
      pid: gone.pid,
      starttime: 1,
      transcript_path: join(subagentsDir, "task-binder-none.jsonl"),
      session_id: id,
    });

    const result = await manager.stopOwnedWorkers({
      subagentsDir,
      sessionId: id,
    });

    expect(result.workers.map((w) => w.taskId)).toEqual(["task-binder-none"]);
    expect(result.workers[0]!.state).toBe("confirmed_stopped");
    // Byte-identical to the no-binder assembly: absence is asserted, not assumed.
    expect(await operationFacts(id)).toHaveLength(0);
  });
});
