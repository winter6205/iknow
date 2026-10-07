/**
 * What the finalization RECORD says about how the agent stopped.
 *
 * Why this file exists: `docker.ts` learned to parse the agent's own output and to report a
 * TYPED observation (`AgentDispatchObservation`) that distinguishes "the agent published a stop
 * reason" from "we could not read what it published". But `runStages` persisted only the two
 * flattened strings, `dispatch.model` and `dispatch.stopReason`. On the durable row that loses
 * the distinction the parser exists to make: `unreadable-agent-output` lands as a bare string,
 * indistinguishable from an ordinary producer value unless an auditor opens the retained
 * transcript, and the usage state is not on the row at all.
 *
 * So this file drives the REAL chain — `beginAttempt` → `runAttempt` over the real
 * `createDockerRunner` behind a recording `ExecFn` — and asserts the parsed facts survive onto
 * the record itself. No docker is involved: every command goes through the injected `exec`.
 *
 * The two stop-reason shapes are covered as separate worlds, because the whole point is that
 * they must be tellable apart from the ROW ALONE.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import {
  beginAttempt,
  readAttemptRecords,
  runAttempt,
  type FinalRecord,
} from "../../../../scripts/eval/terminal-bench-2.1/attempt.ts";
import {
  createDockerRunner,
  type ExecFn,
} from "../../../../scripts/eval/terminal-bench-2.1/docker.ts";
import { sha256File } from "../../../../scripts/eval/terminal-bench-2.1/runner.ts";
import type { RunIdentity } from "../../../../scripts/eval/terminal-bench-2.1/identities.ts";
import { cleanupTempRoots, tempRoot } from "./fixtures.ts";

afterAll(cleanupTempRoots);

const TASK = "db-wal-recovery";
const SLOT_KEY = `${TASK}:arm40:40`;

/** A real content digest: 64 lowercase hex characters, which is what a registry emits. */
const REAL_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;

/**
 * The credentials the copied user-layer settings file carries.
 *
 * `readModelRoute` reads only `llm.model` out of this file and returns a `detail` that names the
 * FILE. These two literals are the tripwires: if either ever reaches a record, a log or an error
 * message, the assertions below fail with the leaked value in the message.
 */
const API_KEY = "sk-live-TESTONLY-do-not-log-0123456789";
const SETTINGS_BODY = JSON.stringify({
  llm: { model: "deepseek/deepseek-chat", apiKey: API_KEY },
});

/** The success envelope `formatRunJson` publishes: a real stop reason and a real spend. */
const SUCCESS_ENVELOPE = JSON.stringify({
  finalText: "recovered the WAL",
  stopReason: "stop",
  turnCount: 3,
  lastUsage: {
    inputTokens: 120,
    outputTokens: 34,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 7,
  },
});

/** The grader output shape a real task emits: a result line, and no `reward=` on stdout. */
const GRADER_STDOUT =
  "grader_exit=0\n=============== 7 passed, 1 skipped in 12.41s ===============\n";

/**
 * Transcript text that is NOT a producer document — the eval-state notice on stderr, and a
 * stack-trace-looking line. `readProducerDocument` must skip it and find no envelope at all.
 */
const UNPARSEABLE_TRANSCRIPT = [
  "node /opt/iknow/dist/cli.js ask: started",
  "eval-state: workspace=/app",
  'Error: something the agent printed that is not JSON {"stopReason": broken',
  "",
].join("\n");

interface RunWorld {
  readonly runRoot: string;
  readonly ledgerPath: string;
  readonly taskDir: string;
  readonly bundlePath: string;
  readonly nodeArchivePath: string;
  readonly settingsPath: string;
  readonly identity: RunIdentity;
}

/**
 * A dataset, an identity whose pinned shas are the REAL files on disk, and a settings file that
 * carries BOTH the model route and an API key — so `verifyInstrument` passes exactly as it does
 * on a real run, and the secret is genuinely present on the path `readModelRoute` reads.
 */
function worldFor(basename: string): RunWorld {
  const root = tempRoot(basename);
  const runRoot = join(root, "run");
  const taskDir = join(root, "dataset", "tasks", TASK);
  mkdirSync(join(taskDir, "tests"), { recursive: true });
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(
    join(taskDir, "instruction.md"),
    "Recover the corrupted SQLite WAL.\n"
  );
  writeFileSync(join(taskDir, "tests", "test.sh"), "pytest -q\n");
  const bundlePath = join(root, "iknow-bundle.tgz");
  const nodeArchivePath = join(root, "node.tar.gz");
  const settingsPath = join(root, "settings.json");
  writeFileSync(bundlePath, "bundle bytes");
  writeFileSync(nodeArchivePath, "node dist bytes");
  writeFileSync(settingsPath, SETTINGS_BODY);
  const identity: RunIdentity = {
    runId: "run-1220",
    task: TASK,
    image: "alexgshaw/db-wal-recovery:20251031",
    imageDigest: REAL_IMAGE_DIGEST,
    datasetCommit: "7131e4375048a0e408a8fb404b5f499d726b695b",
    bundleSha256: sha256File(bundlePath),
    nodeArchiveSha256: sha256File(nodeArchivePath),
    runnerVersion: "tb2.1-attempt/1",
    outputLayout: "trace/ logs/ process/ meta/",
  };
  return {
    runRoot,
    ledgerPath: join(runRoot, "ledger.jsonl"),
    taskDir,
    bundlePath,
    nodeArchivePath,
    settingsPath,
    identity,
  };
}

/** A recording `ExecFn` that answers each phase by the marker its real script carries. */
function recordingExec(dispatchStderr: string): ExecFn {
  const table: ReadonlyArray<[string, string]> = [
    // The provisioning probe's own markers: a booted agent and a writable /logs.
    ["logs-mount-writable", "logs-mount-writable\nv20.11.0\niknow-native-ok\n"],
    ["grader_exit=", GRADER_STDOUT],
    ["cli.js ask", ""],
  ];
  return async (_file, args) => {
    const script = args.find((arg) => arg.includes(";")) ?? "";
    const hit = table.find(([needle]) => script.includes(needle));
    // The agent's own envelope goes to stderr, which is where `ask oneshot` really writes it.
    return {
      stdout: hit?.[1] ?? "",
      stderr: hit?.[0] === "cli.js ask" ? dispatchStderr : "",
      code: 0,
    };
  };
}

/** Provision, dispatch and grade one real attempt, and read back what the record retained. */
async function runRealAttempt(
  world: RunWorld,
  dispatchStderr: string
): Promise<FinalRecord> {
  const runner = createDockerRunner(recordingExec(dispatchStderr), 1_000);
  const handle = beginAttempt({
    runRoot: world.runRoot,
    slotsDir: join(world.runRoot, "slots"),
    slotKey: SLOT_KEY,
    task: TASK,
    arm: "arm40",
    maxTurns: 40,
    identity: world.identity,
    ledgerPath: world.ledgerPath,
    bundlePath: world.bundlePath,
    settingsPath: world.settingsPath,
    startedAtEpochMs: 1_750_000_000_000,
    pid: 4242,
  });
  // What the grader's bind mount leaves on the HOST when the attempt succeeds.
  mkdirSync(join(handle.dir, "logs/verifier"), { recursive: true });
  writeFileSync(join(handle.dir, "logs/verifier/reward.txt"), "1\n");

  await runAttempt(handle, world.ledgerPath, {
    runner,
    provisionSpec: {
      identity: world.identity,
      taskDir: world.taskDir,
      outDir: handle.dir,
      bundlePath: world.bundlePath,
      nodeArchivePath: world.nodeArchivePath,
      settingsPath: world.settingsPath,
    },
    maxTurns: 40,
    agentWallSec: 2_700,
    graderGraceSec: 600,
    declaredVerifierTimeoutSec: 300,
    readUsage: () => null,
  });

  const final = readAttemptRecords(handle.dir).find(
    (record): record is FinalRecord => record.recordType === "attempt-finalized"
  );
  assert.ok(
    final !== undefined,
    "the attempt must retain a finalization record"
  );
  return final;
}

describe("the finalization record carries the parsed dispatch observation", () => {
  it("records a real producer stop reason as a typed, readable fact", async () => {
    const world = worldFor("dispatch-readable");
    const final = await runRealAttempt(world, `${SUCCESS_ENVELOPE}\n`);

    assert.deepEqual(
      final.dispatchEvidence?.stopReason,
      { source: "success-envelope", value: "stop" },
      "the agent DID publish a stop reason, and the record must say so in a form an auditor " +
        "cannot confuse with an unreadable agent output; got: " +
        JSON.stringify(final.dispatchEvidence?.stopReason)
    );
  });

  it("records the usage state on the row, without opening process/ask.*", async () => {
    const world = worldFor("dispatch-usage");
    const final = await runRealAttempt(world, `${SUCCESS_ENVELOPE}\n`);

    assert.deepEqual(
      final.dispatchEvidence?.usage,
      {
        state: "reported",
        tokens: {
          inputTokens: 120,
          outputTokens: 34,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 7,
        },
      },
      "the usage the agent published must be readable from the record alone; got: " +
        JSON.stringify(final.dispatchEvidence?.usage)
    );
  });

  it("records an unreadable agent output as unreadable, not as an ordinary stop reason", async () => {
    const world = worldFor("dispatch-unreadable");
    const final = await runRealAttempt(world, UNPARSEABLE_TRANSCRIPT);

    assert.deepEqual(
      final.dispatchEvidence?.stopReason,
      { source: "unreadable", value: null },
      "no producer document could be read, and the row must say THAT rather than carrying a bare " +
        `string; the flattened reason for the same run was: ${JSON.stringify(final.reason)}`
    );
    assert.deepEqual(
      final.dispatchEvidence?.usage,
      { state: "absent", because: "no-envelope" },
      "an unreadable envelope means NOTHING is known about spend — never a zero"
    );
  });

  it("names the model route and the file it was read from", async () => {
    const world = worldFor("dispatch-model-route");
    const final = await runRealAttempt(world, `${SUCCESS_ENVELOPE}\n`);

    assert.deepEqual(
      final.dispatchEvidence?.model,
      { source: "settings", route: "deepseek/deepseek-chat" },
      "the only honest model source is the copied settings file, and the record must attribute " +
        "the route to it; got: " +
        JSON.stringify(final.dispatchEvidence?.model)
    );
  });
});

describe("the flattened columns keep their existing contract", () => {
  it("keeps model and reason exactly as the runner reported them", async () => {
    const world = worldFor("dispatch-flat-columns");
    const final = await runRealAttempt(world, `${SUCCESS_ENVELOPE}\n`);

    assert.equal(
      final.model,
      "deepseek/deepseek-chat",
      "existing consumers read this column; adding the parsed facts must not change it"
    );
    assert.equal(
      final.reason,
      "stop",
      "existing consumers read this column; adding the parsed facts must not change it"
    );
  });
});

describe("the record stays small and secret-free", () => {
  it("keeps the agent transcript OFF the record", async () => {
    const world = worldFor("dispatch-no-transcript");
    const final = await runRealAttempt(world, `${SUCCESS_ENVELOPE}\n`);
    const persisted = JSON.stringify(final);

    assert.equal(
      "agentOutput" in final,
      false,
      "a whole transcript is unbounded and belongs in the retained host artifacts, not on a " +
        "row that is appended once per attempt"
    );
    assert.equal(
      persisted.includes("recovered the WAL"),
      false,
      "the agent's finalText must not be copied into the record; the transcript's home is " +
        "process/ask.stdout"
    );
  });

  it("never writes the settings API key into the record", async () => {
    const world = worldFor("dispatch-no-secret");
    const final = await runRealAttempt(world, `${SUCCESS_ENVELOPE}\n`);
    const persisted = JSON.stringify(final);

    assert.equal(
      persisted.includes(API_KEY),
      false,
      `the settings file's API key reached the durable record: ${persisted}`
    );
  });
});
