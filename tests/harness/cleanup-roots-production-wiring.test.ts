/**
 * ADR-0132 / ADR-0133 — the cleanup root context must reach permission
 * admission THROUGH PRODUCTION ASSEMBLY.
 *
 * `cleanup-exceptions.test.ts` drives `createPermissionPolicy` directly and
 * `bash-cleanup-roots.test.ts` drives the Bash handler directly. Both prove the
 * classifier and the handler work, and neither can see the seam that matters
 * most: whether a host that ASSEMBLES the policy ever supplies the roots at
 * all. A `hostRoots` field no production entry passes is an exception that is
 * correct in tests and dead in the product.
 *
 * So every case here goes through the real entry — `buildHarnessEngine` for
 * the main session, `createWorkerDeps` for the worker identity — and asserts
 * on the OBSERVED outcome of one real `bash` call: the executor's result and,
 * for admitted commands, whether the file is actually gone. The command is
 * executed, not merely classified, because "the wall stopped answering" and
 * "the command ran" are different claims and only the second one is the
 * repair.
 *
 * The roots each entry must contribute, and why they differ:
 *   - main session: the live `taskRoot` cell plus the session scratch derived
 *     from `(projectDir, conversationId)`.
 *   - worker: the worker's OWN pad, nested under `subagents/<taskId>/`. ADR-0092
 *     gives each identity its own session tmp, so a worker that adopted the
 *     parent's scratch would be able to delete the parent's files.
 *   - default `createAciExecutor` with no policy: byte-identical to today —
 *     no session context means no cleanup scope, so no exception.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import { buildHarnessEngine } from "../../src/harness/build-engine.js";
import { createAciExecutor } from "../../src/harness/aci/aci-executor.js";
import { createExecutor } from "../../src/harness/tools/executor.js";
import { createDefaultAciRegistry } from "../../src/harness/aci/tools/registry.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/modes.js";
import { createWorkerDeps } from "../../src/harness/subagent/worker.js";
import { classifyBoundedCleanupException } from "../../src/harness/permission/hard-walls.js";
import { snapshotBashCleanupRoots } from "../../src/harness/sandbox/fence-tmp.js";
import { createSkillCatalog } from "../../src/harness/skill/catalog.js";
import { createStubModel } from "../../src/harness/stubs/stub-model.js";
import { createNoopTraceService } from "../../src/harness/trace/noop.js";
import type { IknowEnv } from "../../src/config/env.js";
import type { BuiltEngine } from "../../src/harness/build-engine.js";

/**
 * Deterministic env, same shape as the other build-engine wiring tests: a
 * `makeEnv` variant here would let a missing `apiKey` masquerade as a wiring
 * failure.
 */
const ENV = {
  llm: {
    baseUrl: "http://127.0.0.1:9999",
    model: "test-model",
    fallback: [],
    apiKey: "sk-wiring-probe",
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
} as unknown as IknowEnv;

/** Worker assembly takes a different env slice (no mcp / no llm.stream shape). */
const WORKER_ENV = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: { type: "disabled" },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200_000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
} as unknown as IknowEnv;

/* ------------------------------------------------------------------ */
/* filesystem fixture                                                  */
/* ------------------------------------------------------------------ */

const root = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-wiring-")));

/** The main session's live `taskRoot` (a real task worktree shape). */
const taskRoot = join(root, "repo");
/**
 * The session folder the main identity's scratch hangs under. `build-engine`
 * derives the scratch as `<projectDir>/<sanitize(conversationId)>/fence-tmp`,
 * the same `resolveSessionFenceTmp` formula the Bash handler uses — so the
 * fixture uses that exact shape, and the wiring is asserted against it.
 */
const projectDir = join(root, "pool");
const mainConversationId = "11111111-2222-3333-4444-555555555555";
const mainScratch = join(projectDir, mainConversationId, "fence-tmp");
/** A DIFFERENT identity's scratch, same project pool. */
const otherConversationId = "99999999-8888-7777-6666-555555555555";
const otherScratch = join(projectDir, otherConversationId, "fence-tmp");
/** The worker identity's own pad, nested under `subagents/<taskId>/`. */
const workerTaskId = "task-abc";
const subagentsDir = join(projectDir, mainConversationId, "subagents");
const workerScratch = join(subagentsDir, workerTaskId, "fence-tmp");
/** Lives outside every root, reachable only through the `escape` symlink. */
const outside = join(root, "outside");

function plant(dir: string, files: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const name of files) writeFileSync(join(dir, name), "x");
}

plant(taskRoot, ["tmp_pycheck.cjs", "user-note.md", ".env"]);
mkdirSync(join(taskRoot, "sub"), { recursive: true });
writeFileSync(join(taskRoot, "sub", "nested.cjs"), "x");
plant(mainScratch, ["a.cjs"]);
plant(otherScratch, ["c.cjs"]);
plant(workerScratch, ["w.cjs"]);
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "x");
// A symlink INSIDE taskRoot whose real location is outside every root.
symlinkSync(outside, join(taskRoot, "escape"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Recreate a fixture file a prior case consumed, so cases stay independent. */
function restore(path: string, body = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

/* ------------------------------------------------------------------ */
/* main-session engine                                                 */
/* ------------------------------------------------------------------ */

const built: BuiltEngine[] = [];

async function buildMainSession(
  mode: "default" | "full_auto"
): Promise<BuiltEngine> {
  const engine = await buildHarnessEngine({
    env: ENV,
    askUser: createNoAskUser(),
    surface: "chat",
    cwd: taskRoot,
    sandboxRoot: taskRoot,
    userHome: join(root, "home"),
    todoDir: projectDir,
    projectDir,
    permissionMode: createPermissionModeContext(mode),
    // What every production host already knows: the id of the session this
    // engine is currently running. A live reader because the engine outlives
    // any single session on the serve path.
    sessionConversationId: () => mainConversationId,
  });
  built.push(engine);
  return engine;
}

type BashResult = {
  readonly kind: string;
  readonly message?: string;
  readonly payload?: ReadonlyArray<{ readonly text?: string }>;
};

async function runBash(
  engine: BuiltEngine,
  command: string,
  conversationId?: string
): Promise<BashResult> {
  const [result] = await engine.deps.executor.executeAll(
    [{ id: "call-1", name: "bash", input: { command } }],
    undefined,
    undefined,
    conversationId
  );
  return result as BashResult;
}

/** Whether the call was refused by a hard wall rather than by the ask gate. */
function deniedByHardWall(result: BashResult): boolean {
  return result.message?.includes("[hard_wall]") === true;
}

describe("ADR-0133 — workspace cleanup reaches ordinary permissions via buildHarnessEngine", () => {
  it("full_auto admits and EXECUTES `rm -f tmp_pycheck.cjs` in the live taskRoot", async () => {
    const target = join(taskRoot, "tmp_pycheck.cjs");
    restore(target);
    const engine = await buildMainSession("full_auto");

    const result = await runBash(engine, "rm -f tmp_pycheck.cjs");

    assert.equal(
      deniedByHardWall(result),
      false,
      `full_auto must not hit a hard wall: ${result.message ?? result.kind}`
    );
    assert.equal(result.kind, "ok", `expected execution, got ${result.message ?? ""}`);
    // The strongest form of "admitted": the file is really gone.
    assert.equal(
      existsSync(target),
      false,
      "an admitted workspace cleanup must actually delete the file"
    );
  });

  it("full_auto admits an absolute taskRoot spelling and a user-created file", async () => {
    for (const [target, command] of [
      [join(taskRoot, "user-note.md"), "rm -f user-note.md"],
      [join(taskRoot, "sub", "nested.cjs"), `rm -f ${join(taskRoot, "sub", "nested.cjs")}`],
    ] as const) {
      restore(target, target.endsWith("user-note.md") ? "user authored" : "x");
      const engine = await buildMainSession("full_auto");
      const result = await runBash(engine, command);
      assert.equal(
        deniedByHardWall(result),
        false,
        `${command}: must not hit a hard wall (${result.message ?? ""})`
      );
      assert.equal(result.kind, "ok", `${command}: ${result.message ?? ""}`);
      assert.equal(existsSync(target), false, `${command}: file must be gone`);
    }
  });

  it("default ASKS rather than admitting or denying at the wall", async () => {
    const target = join(taskRoot, "tmp_pycheck.cjs");
    restore(target);
    // An ask inlet that DECLINES, so the observed outcome distinguishes "the
    // wall no longer answers" from "the mode arm admitted it". With
    // `createNoAskUser` the two are indistinguishable at the result envelope.
    const engine = await buildHarnessEngine({
      env: ENV,
      askUser: async () => false,
      surface: "chat",
      cwd: taskRoot,
      sandboxRoot: taskRoot,
      userHome: join(root, "home"),
      todoDir: projectDir,
      projectDir,
      permissionMode: createPermissionModeContext("default"),
    });
    built.push(engine);

    const result = await runBash(engine, "rm -f tmp_pycheck.cjs");

    assert.equal(
      deniedByHardWall(result),
      false,
      `default mode must not be a hard-wall deny: ${result.message ?? ""}`
    );
    assert.equal(
      result.message,
      "[user_denied] user declined tool call: bash",
      "a declined ordinary ask is the observable signature of `default` asking"
    );
    assert.equal(
      existsSync(target),
      true,
      "a declined ask must leave the file in place"
    );
  });
});

describe("ADR-0132 — the main session's own scratch, via buildHarnessEngine", () => {
  it("full_auto admits and executes `rm -f $TMPDIR/a.cjs` in this identity's scratch", async () => {
    const target = join(mainScratch, "a.cjs");
    restore(target);
    const engine = await buildMainSession("full_auto");

    // The conversationId argument is the one the loop passes per turn
    // (LoopEngineDeps.conversationId → executeAll's 4th argument).
    const result = await runBash(engine, "rm -f $TMPDIR/a.cjs", mainConversationId);

    assert.equal(
      deniedByHardWall(result),
      false,
      `own scratch must not hit a hard wall: ${result.message ?? ""}`
    );
    assert.equal(result.kind, "ok", `${result.message ?? ""}`);
    assert.equal(existsSync(target), false, "the scratch file must actually be gone");
  });

  it("another identity's scratch gets NO exception through the same assembly", async () => {
    const target = join(otherScratch, "c.cjs");
    restore(target);
    const engine = await buildMainSession("full_auto");

    const result = await runBash(
      engine,
      `rm -f ${otherScratch}/c.cjs`,
      mainConversationId
    );

    assert.equal(
      deniedByHardWall(result),
      true,
      "another identity's scratch must keep its hard-wall deny"
    );
    assert.equal(
      existsSync(target),
      true,
      "the foreign scratch file must survive"
    );
  });
});

/* ------------------------------------------------------------------ */
/* worker identity                                                     */
/* ------------------------------------------------------------------ */

/**
 * The worker is assembled with `tmpDir` already resolved to its own pad —
 * `resolveWorkerFenceTmp` reads `opts.tmpDir` first and the registry threads
 * that value to the bash factory. The worker's policy must be built from the
 * SAME pad, or the two gates would disagree (ADR-0132's core requirement).
 */
/**
 * Assembled with the EXACT payload `SubAgentManager.workerLedgerFields`
 * produces — `{taskId, traceFilePath, transcriptPath}` and **no explicit
 * `tmpDir`**. That omission is deliberate: the manager never sends a pad, so
 * the worker's own scratch has to be derived by the same
 * `resolveWorkerFenceTmp` fallback the Bash factory already used, and a test
 * that passed `tmpDir` would pin the seam open and prove nothing about
 * production. (`transcriptPath` is omitted because this file makes no claim
 * about the transcript surface.)
 */
async function buildWorker(): Promise<Awaited<ReturnType<typeof createWorkerDeps>>> {
  return createWorkerDeps({
    env: WORKER_ENV,
    sandboxRoot: taskRoot,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    trace: createNoopTraceService(),
    taskId: workerTaskId,
    traceFilePath: join(subagentsDir, workerTaskId, `agent-${workerTaskId}.jsonl`),
  });
}

describe("ADR-0132 — the worker identity uses ITS OWN scratch, not the parent's", () => {
  it("a worker admits cleanup in its own pad", async () => {
    const target = join(workerScratch, "w.cjs");
    restore(target);
    const deps = await buildWorker();
    const [result] = await deps.executor.executeAll([
      { id: "w-1", name: "bash", input: { command: "rm -f $TMPDIR/w.cjs" } },
    ]);
    const observed = result as BashResult;

    assert.equal(
      deniedByHardWall(observed),
      false,
      `the worker's own scratch must not hit a hard wall: ${observed.message ?? ""}`
    );
    assert.equal(existsSync(target), false, "the worker's scratch file must be gone");
  });

  it("a worker also gets ordinary workspace cleanup in its own taskRoot", async () => {
    // The worker's taskRoot arm comes from the same `sandboxRoot` its fence
    // runs in, so ADR-0133's ordinary-cleanup route is live for the subagent
    // face of the session too — not only for the main chain.
    const target = join(taskRoot, "tmp_pycheck.cjs");
    restore(target);
    const deps = await buildWorker();
    const [result] = await deps.executor.executeAll([
      { id: "w-3", name: "bash", input: { command: "rm -f tmp_pycheck.cjs" } },
    ]);
    const observed = result as BashResult;

    assert.equal(
      deniedByHardWall(observed),
      false,
      `a worker's own workspace cleanup must not hit a hard wall: ${observed.message ?? ""}`
    );
    assert.equal(existsSync(target), false, "the file must be gone");
  });

  it("the worker is refused inside the PARENT session's scratch", async () => {    const target = join(mainScratch, "a.cjs");
    restore(target);
    const deps = await buildWorker();
    const [result] = await deps.executor.executeAll([
      {
        id: "w-2",
        name: "bash",
        input: { command: `rm -f ${mainScratch}/a.cjs` },
      },
    ]);
    const observed = result as BashResult;

    assert.equal(
      deniedByHardWall(observed),
      true,
      "a worker must inherit nothing from the parent session's scratch"
    );
    assert.equal(
      existsSync(target),
      true,
      "the parent's scratch file must survive a worker's rm"
    );
  });
});

/* ------------------------------------------------------------------ */
/* the unwired default                                                 */
/* ------------------------------------------------------------------ */

describe("no session context means no cleanup scope (byte-identical to today)", () => {
  it("createAciExecutor with no policy keeps denying an ordinary workspace rm", async () => {
    const target = join(taskRoot, "tmp_pycheck.cjs");
    restore(target);
    const registry = createDefaultAciRegistry({
      env: ENV,
      sandboxRoot: taskRoot,
    });
    // No `policy` → the default `createPermissionPolicy()` construction runs,
    // which is the exact path a bare-ACI caller gets.
    const executor = createAciExecutor({
      inner: createExecutor(registry.inner),
      registry: registry.inner,
      askUser: createNoAskUser(),
    });
    const [result] = await executor.executeAll([
      { id: "bare-1", name: "bash", input: { command: "rm -f tmp_pycheck.cjs" } },
    ]);
    const observed = result as BashResult;

    assert.equal(
      deniedByHardWall(observed),
      true,
      "with no host root context the destructive-rm verdict must be today's"
    );
    assert.equal(existsSync(target), true, "the file must survive");
  });
});

/* ------------------------------------------------------------------ */
/* the snapshot's own fail-toward-deny contract                        */
/* ------------------------------------------------------------------ */

describe("an unresolvable root is ABSENT, never an empty path", () => {
  it("a scratch path that cannot resolve grants no scratch exception at all", () => {
    // Regression: the snapshot used to answer `""` for an unresolvable path.
    // The classifier reads a defined root as a real path and resolves
    // `$TMPDIR` operands against it, so `rm -f $TMPDIR/etc/hostname` was
    // reported as `identity-scratch` with root `""` — a real hard-wall
    // finding removed by a root that names nothing. Latent while only the
    // Bash handler consumed the snapshot (it never reached admission);
    // reachable the moment a production entry passes these roots to policy.
    const snapshot = snapshotBashCleanupRoots({
      tmpDir: join(root, "no-such-dir", "deeper"),
      waveRoot: taskRoot,
    });
    assert.equal(
      snapshot.scratchRoot,
      undefined,
      "an unresolvable scratch path must be absent, not empty"
    );
    for (const command of [
      "rm -f $TMPDIR/etc/hostname",
      "rm -f $TMPDIR/root/.ssh/id_rsa",
    ]) {
      assert.equal(
        classifyBoundedCleanupException(command, snapshot),
        null,
        `${command}: an absent scratch root must grant no exception`
      );
    }
  });

  it("a taskRoot that cannot resolve still leaves the scratch arm intact", () => {
    const snapshot = snapshotBashCleanupRoots({
      tmpDir: mainScratch,
      waveRoot: join(root, "no-such-task-root"),
    });
    assert.equal(snapshot.taskRoot, undefined);
    assert.equal(
      classifyBoundedCleanupException("rm -f tmp_pycheck.cjs", snapshot),
      null,
      "a relative operand needs the taskRoot base; without it there is no exception"
    );
  });
});

/* ------------------------------------------------------------------ */
/* nothing was widened                                                 */
/* ------------------------------------------------------------------ */

/**
 * The negatives that matter most are the ones the wiring could plausibly have
 * broken: an over-broad `taskRoot`, a wrong scratch, or a containment check
 * that stopped resolving. Each case must still be denied by a hard wall
 * through the SAME production assembly that now admits the positives.
 */
describe("the wiring widened nothing — every negative still denies", () => {
  const denied: ReadonlyArray<readonly [string, string]> = [
    ["recursive in taskRoot", "rm -rf tmp_pycheck.cjs"],
    ["the taskRoot itself", `rm -f ${taskRoot}`],
    ["a directory target", "rm -f sub"],
    ["outside the root entirely", `rm -f ${outside}/secret.txt`],
    ["escaping through `..`", "rm -f ../outside/secret.txt"],
    ["escaping through a symlinked ancestor", "rm -f escape/secret.txt"],
    ["a glob", "rm -f *.cjs"],
    ["an unresolved variable", "rm -f $NAME.cjs"],
    ["a protected target in the workspace", "rm -f .env"],
    ["recursive in scratch", "rm -rf $TMPDIR/a.cjs"],
    ["the scratch root itself", "rm -f $TMPDIR"],
  ];

  for (const [why, command] of denied) {
    it(`still denies: ${why}`, async () => {
      const engine = await buildMainSession("full_auto");
      const result = await runBash(engine, command, mainConversationId);
      assert.equal(
        deniedByHardWall(result),
        true,
        `${command} must keep a hard-wall deny, got: ${result.kind} ${
          result.message ?? ""
        }`
      );
    });
  }
});
