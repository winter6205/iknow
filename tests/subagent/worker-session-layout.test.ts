/**
 * Worker fence /tmp padding and main-session isolation; new layout
 * `subagents/<taskId>/` (record + pad), plus: a new spawn's stderr sits in the
 * same dir as record and pad, while the legacy `stderr/<taskId>.log` is never
 * migrated and stays readable.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import { createBashTool } from "../../src/harness/aci/tools/bash.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { MAIN_SESSION_FENCE_TMP_DIR_NAME } from "../../src/shared/session-tree-names.ts";
import {
  listSubagentRecordPaths,
  resolveExistingSubagentRecordPath,
  SubagentRecordListError,
  workerFenceTmpPath,
  workerRecordPath,
  workerStderrPath,
} from "../../src/harness/sandbox/fence-tmp.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import type { IknowEnv } from "../../src/config/env.ts";

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly pid: number;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

function makeFakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    pid: 1000,
  }) as unknown as FakeChild;
}

function emitOk(child: FakeChild, body: string): void {
  const env: SubAgentEnvelope = {
    status: "ok",
    summary: body,
    result: body,
  };
  child.stdout.write(`${JSON.stringify(env)}\n`);
  child.emit("exit", 0, null);
}

function flushTwoTicks(): Promise<void> {
  return new Promise((r) => setImmediate(r)).then(
    () => new Promise((r) => setImmediate(r))
  );
}

const scratchPaths: string[] = [];

function makeScratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

interface BashEnvelope {
  readonly output: string;
}

function parseBash(envelope: unknown): {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  return JSON.parse((envelope as BashEnvelope).output) as {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  };
}

const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: "off",
    thinkingEffort: "",
    maxTurns: undefined,
    timeoutMs: 300_000,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false },
  mcp: { connectTimeoutMs: 60_000 },
  subagent: { taskTimeoutMs: undefined, maxConcurrentWorkers: 15 },
  workspaceRoot: undefined,
  productRoot: undefined,
};

let tempRoot: string;
let subagentsDir: string;

beforeEach(() => {
  tempRoot = makeScratch("iknow-t3-layout-");
  subagentsDir = join(tempRoot, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
});

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function makeManager(): {
  readonly manager: ReturnType<typeof createSubAgentManager>;
  readonly spawned: FakeChild[];
} {
  const spawned: FakeChild[] = [];
  const manager = createSubAgentManager({
    spawn: () => {
      const c = makeFakeChild();
      spawned.push(c);
      return c as unknown as ChildProcess;
    },
    sandboxRoot: tempRoot,
    subagentsDir,
  });
  return { manager, spawned };
}

describe("T3 worker session layout (SC7)", () => {
  it("new spawn creates subagents/<taskId>/ with record and fence-tmp pad", async () => {
    const { manager, spawned } = makeManager();
    const { taskId } = manager.spawn({ task: "layout" });
    emitOk(spawned[0]!, "ok");
    await flushTwoTicks();
    await manager.shutdown();

    const taskDir = join(subagentsDir, taskId);
    assert.equal(existsSync(taskDir), true, `expected ${taskDir}`);
    assert.equal(
      existsSync(workerRecordPath(subagentsDir, taskId)),
      true,
      "record file lives inside the taskId directory"
    );
    assert.equal(
      existsSync(join(subagentsDir, `agent-${taskId}.jsonl`)),
      false,
      "new workers must not write the legacy flat jsonl"
    );
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    assert.equal(existsSync(pad), true, `expected pad ${pad}`);
    assert.equal(
      pad,
      join(taskDir, MAIN_SESSION_FENCE_TMP_DIR_NAME),
      "pad is fence-tmp under the taskId directory"
    );
  });
});

describe("T7 worker stderr in taskId dir (SC7)", () => {
  it("new crash stderr lives beside record and pad, not session-level stderr/", async () => {
    const { manager, spawned } = makeManager();
    const { taskId } = manager.spawn({ task: "crash" });
    spawned[0]!.stderr.write("nested-stderr\n");
    spawned[0]!.stderr.end();
    spawned[0]!.emit("exit", 2, null);
    await flushTwoTicks();
    await manager.shutdown();

    const nested = workerStderrPath(subagentsDir, taskId);
    assert.equal(existsSync(nested), true, `expected ${nested}`);
    assert.match(readFileSync(nested, "utf8"), /nested-stderr/);
    assert.equal(
      nested,
      join(subagentsDir, taskId, "stderr.log"),
      "stderr is a file inside subagents/<taskId>/"
    );
    assert.equal(
      existsSync(join(subagentsDir, "stderr", `${taskId}.log`)),
      false,
      "new spawn must not write the legacy session-level stderr log"
    );

    const records = readFileSync(workerRecordPath(subagentsDir, taskId), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const stop = records.find(
      (record) => record.record_type === "subagent_stop"
    );
    assert.equal(stop?.stderr_path, nested);
  });

  it("does not migrate or overwrite a leftover subagents/stderr/<taskId>.log", async () => {
    const leftoverId = "leftover-old-stderr";
    const leftoverPath = join(subagentsDir, "stderr", `${leftoverId}.log`);
    mkdirSync(dirname(leftoverPath), { recursive: true });
    writeFileSync(leftoverPath, "pre-t7 leftover\n", "utf8");

    const { manager, spawned } = makeManager();
    const { taskId } = manager.spawn({ task: "crash" });
    spawned[0]!.stderr.write("new-worker-stderr\n");
    spawned[0]!.stderr.end();
    spawned[0]!.emit("exit", 2, null);
    await flushTwoTicks();
    await manager.shutdown();

    assert.equal(existsSync(leftoverPath), true, "legacy log must remain");
    assert.equal(readFileSync(leftoverPath, "utf8"), "pre-t7 leftover\n");
    assert.equal(
      existsSync(workerStderrPath(subagentsDir, leftoverId)),
      false,
      "must not copy leftover stderr into a new task dir"
    );
    assert.match(
      readFileSync(workerStderrPath(subagentsDir, taskId), "utf8"),
      /new-worker-stderr/
    );
  });
});

describe("worker session tmp isolation (SC3, ADR-0092)", () => {
  it.skipIf(!hasBwrap())(
    "worker bash $TMPDIR writes land in this worker's pad, not the parent pad",
    async () => {
      const { manager, spawned } = makeManager();
      const { taskId } = manager.spawn({ task: "iso" });
      emitOk(spawned[0]!, "ok");
      await flushTwoTicks();

      const parentPad = join(tempRoot, MAIN_SESSION_FENCE_TMP_DIR_NAME);
      mkdirSync(parentPad, { recursive: true });
      const workerPad = workerFenceTmpPath(subagentsDir, taskId);
      const taskRoot = makeScratch("t3-task-root-");

      const workerBash = createBashTool(taskRoot, {
        tmpDir: workerPad,
      });
      const write = parseBash(
        await workerBash.handler({ command: 'printf worker-z >"$TMPDIR/z"' })
      );
      assert.equal(write.code, 0, write.stderr);
      assert.equal(readFileSync(join(workerPad, "z"), "utf8"), "worker-z");
      assert.equal(existsSync(join(parentPad, "z")), false);

      // The parent pad is a distinct host dir; the parent cannot observe the
      // worker's $TMPDIR write via its own $TMPDIR.
      const parentBash = createBashTool(taskRoot, {
        tmpDir: parentPad,
      });
      const read = parseBash(
        await parentBash.handler({ command: 'cat "$TMPDIR/z"' })
      );
      assert.notEqual(read.code, 0, "parent must not see the worker pad file");
      assert.notEqual(read.stdout, "worker-z");

      await manager.shutdown();
    }
  );

  it.skipIf(!hasBwrap())(
    "createWorkerDeps with nested traceFilePath makes $TMPDIR that task pad",
    async () => {
      const taskId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const recordPath = workerRecordPath(subagentsDir, taskId);
      mkdirSync(dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, "", "utf8");
      const workerPad = workerFenceTmpPath(subagentsDir, taskId);
      mkdirSync(workerPad, { recursive: true });
      const parentPad = join(tempRoot, MAIN_SESSION_FENCE_TMP_DIR_NAME);
      mkdirSync(parentPad, { recursive: true });
      const taskRoot = makeScratch("t3-worker-root-");
      const home = makeScratch("t3-worker-home-");

      const deps = await createWorkerDeps({
        env: TEST_ENV,
        sandboxRoot: taskRoot,
        cwd: taskRoot,
        userHome: home,
        model: createStubModel({ responses: [] }),
        skillCatalog: createSkillCatalog([]),
        system: async () => undefined,
        traceFilePath: recordPath,
        taskId,
      });
      const bash = deps.registry.get("bash");
      assert.ok(bash, "worker registry must expose bash");
      const tmpdirOut = parseBash(
        await bash.handler({ command: 'printf %s "$TMPDIR"' })
      );
      assert.equal(tmpdirOut.code, 0, tmpdirOut.stderr);
      assert.equal(tmpdirOut.stdout, workerPad);
      const write = parseBash(
        await bash.handler({ command: 'printf from-worker >"$TMPDIR/z"' })
      );
      assert.equal(write.code, 0, write.stderr);
      assert.equal(readFileSync(join(workerPad, "z"), "utf8"), "from-worker");
      assert.equal(existsSync(join(parentPad, "z")), false);
    }
  );
});

describe("T3 legacy flat agent-*.jsonl (SC8)", () => {
  it("list and resolve still find a pre-seeded flat agent-*.jsonl", () => {
    const legacyId = "legacy-flat-id";
    const flat = join(subagentsDir, `agent-${legacyId}.jsonl`);
    writeFileSync(flat, '{"record_type":"subagent_spawn"}\n', "utf8");

    assert.equal(
      resolveExistingSubagentRecordPath(subagentsDir, legacyId),
      flat
    );
    const listed = listSubagentRecordPaths(subagentsDir);
    assert.ok(
      listed.includes(flat),
      `expected flat record in list, got ${listed.join(",")}`
    );
  });

  it("list finds both a new nested record and a leftover flat record", async () => {
    const legacyId = "old-flat";
    const flat = join(subagentsDir, `agent-${legacyId}.jsonl`);
    writeFileSync(flat, '{"record_type":"subagent_spawn"}\n', "utf8");

    const { manager, spawned } = makeManager();
    const { taskId } = manager.spawn({ task: "new" });
    emitOk(spawned[0]!, "ok");
    await flushTwoTicks();
    await manager.shutdown();

    const nested = workerRecordPath(subagentsDir, taskId);
    const listed = listSubagentRecordPaths(subagentsDir);
    assert.ok(listed.includes(flat), "legacy flat still listed");
    assert.ok(listed.includes(nested), "new nested record listed");
    assert.equal(
      readdirSync(subagentsDir).includes(`agent-${taskId}.jsonl`),
      false
    );
  });

  it("listSubagentRecordPaths returns [] when the directory is missing (ENOENT)", () => {
    const missing = join(subagentsDir, "no-such-subagents");
    assert.deepEqual(listSubagentRecordPaths(missing), []);
  });

  it("listSubagentRecordPaths throws typed error when readdir fails for a non-directory", () => {
    const asFile = join(subagentsDir, "not-a-dir");
    writeFileSync(asFile, "x");
    assert.throws(
      () => listSubagentRecordPaths(asFile),
      (error: unknown) =>
        error instanceof SubagentRecordListError && error.code === "ENOTDIR"
    );
  });

  it("queryBuffer still answers a spawned task after the layout change", async () => {
    const { manager, spawned } = makeManager();
    const { taskId } = manager.spawn({ task: "query" });
    emitOk(spawned[0]!, "query-body");
    await flushTwoTicks();
    const result = manager.queryBuffer(taskId);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.result, "query-body");
    }
    await manager.shutdown();
  });
});
