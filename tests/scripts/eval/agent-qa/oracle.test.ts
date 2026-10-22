/**
 * The four independent oracles. Each is witnessed on a satisfied case and a violated
 * case, against the real filesystem, a real child process, and the production trace
 * writer/reader — never against a mock of the thing being measured.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import {
  allSatisfied,
  anyUnreadable,
  evaluateOracle,
} from "../../../../scripts/eval/agent-qa/oracle.ts";
import type {
  OracleContext,
  OracleTarget,
} from "../../../../scripts/eval/agent-qa/oracle.ts";
import { VIOLATION_PREFIXES } from "../../../../src/harness/permission/prefixes.ts";
import { createJsonlTraceService } from "../../../../src/harness/trace/jsonl.ts";
import type {
  LlmCallRecord,
  ToolCallRecord,
} from "../../../../src/harness/trace/types.ts";
import type { OracleResult } from "../../../../scripts/eval/agent-qa/types.ts";

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-qa-oracle-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function toolRow(overrides: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    parentLlmCallId: undefined,
    toolName: "bash",
    toolKind: "execution_failed",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1,
    argumentsCaptured: true,
    arguments: { command: "true" },
    resultCaptured: true,
    result: "ran",
    status: "ok",
    ...overrides,
  };
}

/** Writes rows through the production JSONL writer and returns its real file path. */
async function writeTrace(
  dir: string,
  rows: readonly ToolCallRecord[]
): Promise<{ path: string; conversationId: string }> {
  mkdirSync(dir, { recursive: true });
  const conversationId = randomUUID();
  const trace = createJsonlTraceService({ filePath: dir, conversationId });
  for (const row of rows) await trace.recordToolCall(row);
  return { path: join(dir, `${conversationId}.jsonl`), conversationId };
}

async function ctxWith(rows: readonly ToolCallRecord[]): Promise<OracleContext> {
  const root = scratch();
  const written = await writeTrace(join(root, "trace"), rows);
  return {
    workspaceRoot: root,
    tracePath: written.path,
    conversationId: written.conversationId,
  };
}

function llmRow(
  messages: readonly { role: string; content: string }[]
): LlmCallRecord {
  return {
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1,
    stream: false,
    messagesCaptured: true,
    messages,
    status: "ok",
  };
}

/**
 * llm_call rows written through the production writer, so the message bodies land in
 * the real content-addressed blob pool the oracle has to follow.
 */
async function ctxWithLlm(
  messagesPerCall: readonly (readonly { role: string; content: string }[])[]
): Promise<OracleContext> {
  const root = scratch();
  const dir = join(root, "trace");
  mkdirSync(dir, { recursive: true });
  const conversationId = randomUUID();
  const trace = createJsonlTraceService({ filePath: dir, conversationId });
  for (const messages of messagesPerCall) {
    await trace.recordLlmCall(llmRow(messages));
  }
  return {
    workspaceRoot: root,
    tracePath: join(dir, `${conversationId}.jsonl`),
    conversationId,
  };
}

function target(overrides: Partial<OracleTarget> & { kind: OracleTarget["kind"] }): OracleTarget {
  return {
    oracleId: "o-1",
    evidence: "reviewer-facing prose, never parsed",
    ...overrides,
  } as OracleTarget;
}

/**
 * The subprocess observation the acceptance oracle retains. `OracleResult` carries no
 * prose — only `evidenceRef` and the digest of exactly the bytes that were observed —
 * so re-hashing the observation is the only way an outside witness can read WHICH fault
 * was recorded. The keys are spelled in the order `runAcceptanceCommand` resolves them,
 * because that order is part of the retained evidence.
 */
function acceptanceDigest(observed: {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly spawnFault: string | null;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(observed))
    .digest("hex");
}

/** What a command that never finished looks like: no exit code, the watchdog fired. */
const TIMEOUT_OBSERVED = { exitCode: null, timedOut: true, spawnFault: null } as const;

/** What a child that never started looks like: no exit code, a spawn errno. */
const SPAWN_FAULT_OBSERVED = { exitCode: null, timedOut: false, spawnFault: "ENOENT" } as const;

/**
 * `oracle.ts` caps one acceptance command at its `ACCEPTANCE_TIMEOUT_MS` (20 000 ms), a
 * module constant with no injection seam, so a test cannot shorten that wait by configuring
 * it. The child is spawned for real and its `sleep` really runs; only the oracle's own
 * watchdog is advanced, in virtual time, which keeps this witness in milliseconds instead of
 * twenty seconds. The overshoot is generous on purpose: the retained observation has to be
 * the watchdog's `{ exitCode: null, timedOut: true }` either way, so the witness does not
 * depend on the exact constant.
 */
const VIRTUAL_WAIT_PAST_THE_WATCHDOG_MS = 300_000;

/** Lets the real child start (and any real I/O callback land) before the clock moves. */
function letTheChildStart(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("oracle: workspace-bytes", () => {
  it("is satisfied by the bytes actually on disk", async () => {
    const root = scratch();
    writeFileSync(join(root, "notes.md"), "status: verified\n", "utf8");
    const read = await evaluateOracle(
      target({
        kind: "workspace-bytes",
        required: [{ path: "notes.md", contents: "status: verified\n" }],
        forbidden: ["notes.md.bak"],
      }),
      { workspaceRoot: root, tracePath: join(root, "trace.jsonl"), conversationId: "unused" }
    );
    assert.equal(read.status, "satisfied");
    assert.match(read.digest, /^[0-9a-f]{64}$/);
  });

  it("is violated when the assistant claims success and the bytes never changed", async () => {
    const root = scratch();
    writeFileSync(join(root, "notes.md"), "status: draft\n", "utf8");
    const read = await evaluateOracle(
      target({
        kind: "workspace-bytes",
        required: [{ path: "notes.md", contents: "status: verified\n" }],
        forbidden: [],
      }),
      { workspaceRoot: root, tracePath: join(root, "trace.jsonl"), conversationId: "unused" }
    );
    assert.equal(read.status, "violated");
    assert.equal(allSatisfied([read]), false);
  });

  it("is violated when a forbidden new file appeared", async () => {
    const root = scratch();
    writeFileSync(join(root, "notes.md"), "keep\n", "utf8");
    writeFileSync(join(root, "leaked.txt"), "secret\n", "utf8");
    const read = await evaluateOracle(
      target({
        kind: "workspace-bytes",
        required: [{ path: "notes.md", contents: "keep\n" }],
        forbidden: ["leaked.txt"],
      }),
      { workspaceRoot: root, tracePath: join(root, "trace.jsonl"), conversationId: "unused" }
    );
    assert.equal(read.status, "violated");
  });
});

describe("oracle: acceptance-run", () => {
  it("is satisfied by a real exit code of 0", async () => {
    const ctx = await ctxWith([]);
    const read = await evaluateOracle(
      target({ kind: "acceptance-run", command: "test -n \"$PWD\"", expectExit: 0 }),
      ctx
    );
    assert.equal(read.status, "satisfied");
    assert.equal(read.evidenceRef, "acceptance:exit=0");
  });

  it("is violated when the command deliberately fails — the exit code is observed, not assumed", async () => {
    const ctx = await ctxWith([]);
    const passing = await evaluateOracle(
      target({ kind: "acceptance-run", command: "true", expectExit: 0 }),
      ctx
    );
    const failing = await evaluateOracle(
      target({ kind: "acceptance-run", command: "exit 3", expectExit: 0 }),
      ctx
    );
    assert.equal(passing.status, "satisfied");
    assert.equal(failing.status, "violated");
    assert.equal(failing.evidenceRef, "acceptance:exit=3");
    assert.notEqual(failing.digest, passing.digest);
  });

  it("runs inside the scratch workspace, so the case's own files are visible", async () => {
    const ctx = await ctxWith([]);
    writeFileSync(join(ctx.workspaceRoot, "required.txt"), "x", "utf8");
    const read = await evaluateOracle(
      target({ kind: "acceptance-run", command: "test -f required.txt", expectExit: 0 }),
      ctx
    );
    assert.equal(read.status, "satisfied");
  });

  it("is unreadable — never satisfied, never violated — when the command outruns the acceptance watchdog", async () => {
    const ctx = await ctxWith([]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // `sleep 5` really runs; the oracle's fixed 20 s watchdog is what fires, advanced
      // here in virtual time because that constant is not injectable from outside.
      const pending = evaluateOracle(
        target({
          kind: "acceptance-run",
          oracleId: "o-timeout",
          command: "sleep 5",
          expectExit: 0,
        }),
        ctx
      );
      await letTheChildStart();
      // Non-vacuity: no verdict exists yet — the child is still asleep and only the
      // watchdog can settle this observation.
      const early = await Promise.race([pending, Promise.resolve("still-running" as const)]);
      assert.equal(early, "still-running", "the acceptance child finished before the watchdog");
      await vi.advanceTimersByTimeAsync(VIRTUAL_WAIT_PAST_THE_WATCHDOG_MS);
      const read = await pending;

      assert.equal(read.status, "unreadable");
      assert.notEqual(read.status, "satisfied");
      assert.notEqual(read.status, "violated");
      // The evidence names the timeout: the retained observation is the watchdog's own,
      // with no exit code — a command that never finished is not a command that failed.
      assert.equal(read.digest, acceptanceDigest(TIMEOUT_OBSERVED));
      assert.equal(read.evidenceRef, "acceptance:o-timeout:unobserved");
      assert.equal(allSatisfied([read]), false);
      assert.equal(anyUnreadable([read]), true);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("is unreadable when the acceptance command's spawn itself faults, and says so differently than a timeout", async () => {
    const ctx = await ctxWith([]);
    // The fault is reached from outside the product code by the workspace path the
    // oracle is handed: a scratch root that is gone makes `/bin/sh` itself unspawnable,
    // so `spawn` reports ENOENT instead of the shell reporting an exit code.
    const vanished = join(ctx.workspaceRoot, "workspace-cleaned-up");
    assert.equal(existsSync(vanished), false);
    const read = await evaluateOracle(
      target({
        kind: "acceptance-run",
        oracleId: "o-spawn-fault",
        command: "true",
        expectExit: 0,
      }),
      { ...ctx, workspaceRoot: vanished }
    );

    assert.equal(read.status, "unreadable");
    assert.equal(read.digest, acceptanceDigest(SPAWN_FAULT_OBSERVED));
    assert.equal(read.evidenceRef, "acceptance:o-spawn-fault:unobserved");
    // Two different unobservable runs must not collapse into one piece of evidence.
    assert.notEqual(read.digest, acceptanceDigest(TIMEOUT_OBSERVED));
    assert.equal(allSatisfied([read]), false);
    assert.equal(anyUnreadable([read]), true);
  });

  it("is violated, not unreadable, when the shell starts but cannot find the named executable", async () => {
    const ctx = await ctxWith([]);
    const read = await evaluateOracle(
      target({
        kind: "acceptance-run",
        oracleId: "o-no-such-binary",
        command: "definitely-not-an-executable-xyz",
        expectExit: 0,
      }),
      ctx
    );
    // `/bin/sh -c` swallows a missing program into exit 127, so this is an observed
    // verdict, not a spawn fault: it pins WHICH injection reaches `spawnFault` (a bad
    // cwd, never a bad command word) and keeps that branch honest.
    assert.equal(read.status, "violated");
    assert.equal(read.evidenceRef, "acceptance:exit=127");
    assert.equal(read.digest, acceptanceDigest({ exitCode: 127, timedOut: false, spawnFault: null }));
  });
});

describe("oracle: effect-record", () => {
  it("is satisfied when the production trace records the declared call", async () => {
    const ctx = await ctxWith([toolRow({ toolName: "write_file" })]);
    const read = await evaluateOracle(
      target({ kind: "effect-record", tools: ["write_file"], expect: "attempted" }),
      ctx
    );
    assert.equal(read.status, "satisfied");
  });

  it("is violated when the trajectory the case describes never dispatched", async () => {
    const ctx = await ctxWith([toolRow({ toolName: "read_file" })]);
    const read = await evaluateOracle(
      target({ kind: "effect-record", tools: ["write_file"], expect: "attempted" }),
      ctx
    );
    assert.equal(read.status, "violated");
  });

  it("is satisfied for an attempt that recorded no result — the product's denied shape", async () => {
    const ctx = await ctxWith([
      toolRow({
        toolName: "bash",
        status: "error",
        resultCaptured: false,
        result: undefined,
      }),
    ]);
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: ["bash"],
        expect: "no-recorded-result",
      }),
      ctx
    );
    assert.equal(read.status, "satisfied");
  });

  it("is violated when a tool the case declared absent did dispatch", async () => {
    const ctx = await ctxWith([
      toolRow({ toolName: "read_file" }),
      toolRow({ toolName: "write_file" }),
    ]);
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: ["read_file"],
        expect: "attempted",
        absentTools: ["write_file"],
      }),
      ctx
    );
    assert.equal(read.status, "violated");
  });

  it("is satisfied when the declared call ran and the forbidden one never did", async () => {
    const ctx = await ctxWith([toolRow({ toolName: "read_file" })]);
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: ["read_file"],
        expect: "attempted",
        absentTools: ["write_file"],
      }),
      ctx
    );
    assert.equal(read.status, "satisfied");
  });

  it("is satisfied when the runner observed the declared stop", async () => {
    const ctx = await ctxWith([toolRow({ toolName: "bash" })]);
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: [],
        expect: "attempted",
        stoppedOn: "maxTurns",
      }),
      { ...ctx, stopReason: "maxTurns" }
    );
    assert.equal(read.status, "satisfied");
    assert.equal(read.evidenceRef, `trace:${ctx.conversationId}:stop`);
  });

  it("is violated when the run stopped on some other bound than declared", async () => {
    const ctx = await ctxWith([toolRow({ toolName: "bash" })]);
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: [],
        expect: "attempted",
        stoppedOn: "maxTurns",
      }),
      { ...ctx, stopReason: "completed" }
    );
    assert.equal(read.status, "violated");
  });

  it("is unreadable, never a pass, when the run recorded no stop reason at all", async () => {
    const ctx = await ctxWith([toolRow({ toolName: "bash" })]);
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: [],
        expect: "attempted",
        stoppedOn: "wallMs",
      }),
      ctx
    );
    assert.equal(read.status, "unreadable");
    assert.equal(anyUnreadable([read]), true);
    assert.equal(allSatisfied([read]), false);
  });

  it("is unreadable when the declaration states no decidable dispatch fact", async () => {
    const ctx = await ctxWith([toolRow({ toolName: "bash" })]);
    const read = await evaluateOracle(
      target({ kind: "effect-record", tools: [], expect: "attempted" }),
      ctx
    );
    assert.equal(read.status, "unreadable");
  });
});

describe("oracle: effect-record body scan", () => {
  const forbidden = ["SECURE-TOKEN-914b"];

  it("is satisfied when no retained body names the forbidden text", async () => {
    const ctx = await ctxWithLlm([[{ role: "user", content: "read notes.md please" }]]);
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: [],
        expect: "attempted",
        bodyScan: { absent: forbidden, scope: "all-messages" },
      }),
      ctx
    );
    assert.equal(read.status, "satisfied");
    assert.equal(read.evidenceRef, `trace:${ctx.conversationId}:bodies`);
  });

  it("is violated when a retained body the model was shown carries the forbidden text", async () => {
    const ctx = await ctxWithLlm([
      [{ role: "user", content: `the value is ${forbidden[0]}` }],
    ]);
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: [],
        expect: "attempted",
        bodyScan: { absent: forbidden, scope: "all-messages" },
      }),
      ctx
    );
    assert.equal(read.status, "violated");
  });

  it("scopes to user turns: the same secret in an assistant body does not trip the user-turn scan", async () => {
    const messages = [
      { role: "user", content: "continue" },
      { role: "assistant", content: `echoed ${forbidden[0]}` },
    ];
    const ctx = await ctxWithLlm([messages]);
    const userTurns = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: [],
        expect: "attempted",
        bodyScan: { absent: forbidden, scope: "user-turns" },
      }),
      ctx
    );
    const allMessages = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: [],
        expect: "attempted",
        bodyScan: { absent: forbidden, scope: "all-messages" },
      }),
      ctx
    );
    assert.equal(userTurns.status, "satisfied");
    assert.equal(allMessages.status, "violated");
    assert.notEqual(userTurns.digest, allMessages.digest);
  });

  it("reads recorded tool arguments in the tool-arguments scope", async () => {
    const ctx = await ctxWith([
      toolRow({ toolName: "bash", arguments: { command: `print ${forbidden[0]}` } }),
    ]);
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: ["bash"],
        expect: "attempted",
        bodyScan: { absent: forbidden, scope: "tool-arguments" },
      }),
      ctx
    );
    assert.equal(read.status, "violated");
  });

  it("is unreadable when a row names a body the pool does not hold", async () => {
    const ctx = await ctxWithLlm([[{ role: "user", content: "read notes.md please" }]]);
    rmSync(join(ctx.tracePath.replace(/\/[^/]*$/, ""), "blobs"), {
      recursive: true,
      force: true,
    });
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: [],
        expect: "attempted",
        bodyScan: { absent: forbidden, scope: "all-messages" },
      }),
      ctx
    );
    assert.equal(read.status, "unreadable");
    assert.equal(allSatisfied([read]), false);
  });

  it("is unreadable when a row's body ref is not a content address at all", async () => {
    const ctx = await ctxWithLlm([[{ role: "user", content: "read notes.md please" }]]);
    appendFileSync(
      ctx.tracePath,
      `${JSON.stringify({
        conversation_id: ctx.conversationId,
        record_type: "llm_call",
        llm_call_id: "hand-written-legacy-row",
        status: "ok",
        messages: [{ role: "user", content: { sha: "not-an-address", bytes: 1 } }],
      })}\n`,
      "utf8"
    );
    const read = await evaluateOracle(
      target({
        kind: "effect-record",
        tools: [],
        expect: "attempted",
        bodyScan: { absent: forbidden, scope: "all-messages" },
      }),
      ctx
    );
    assert.equal(read.status, "unreadable");
  });
});

describe("oracle: permission-record", () => {
  const denied = toolRow({
    toolName: "bash",
    status: "error",
    toolKind: "execution_failed",
    resultCaptured: false,
    result: undefined,
    error: {
      type: "execution_failed",
      message: `${VIOLATION_PREFIXES.hardWall} refusing a filesystem walk from /`,
    },
  });

  it("is satisfied when the denial is recorded AND the effect is absent on disk", async () => {
    const ctx = await ctxWith([denied]);
    writeFileSync(join(ctx.workspaceRoot, "keep.txt"), "still here", "utf8");
    const read = await evaluateOracle(
      target({
        kind: "permission-record",
        deniedTool: "bash",
        prefixes: [VIOLATION_PREFIXES.hardWall],
        effects: [{ path: "keep.txt", expected: "still here" }],
      }),
      ctx
    );
    assert.equal(read.status, "satisfied");
  });

  it("decides from disk: a denial record with the effect actually applied is violated", async () => {
    const ctx = await ctxWith([denied]);
    // The trace says blocked; the workspace says otherwise. The workspace wins.
    writeFileSync(join(ctx.workspaceRoot, "keep.txt"), "deleted then rewritten", "utf8");
    const read = await evaluateOracle(
      target({
        kind: "permission-record",
        deniedTool: "bash",
        prefixes: [VIOLATION_PREFIXES.hardWall],
        effects: [{ path: "keep.txt", expected: "still here" }],
      }),
      ctx
    );
    assert.equal(read.status, "violated");
  });

  it("is violated when a new file landed even though the call was recorded as denied", async () => {
    const ctx = await ctxWith([denied]);
    writeFileSync(join(ctx.workspaceRoot, "sink.txt"), "leaked", "utf8");
    const read = await evaluateOracle(
      target({
        kind: "permission-record",
        deniedTool: "bash",
        prefixes: [VIOLATION_PREFIXES.hardWall],
        effects: [{ path: "sink.txt", expected: "absent" }],
      }),
      ctx
    );
    assert.equal(read.status, "violated");
  });

  it("is violated when no denial was recorded at all, even with the disk untouched", async () => {
    const ctx = await ctxWith([toolRow({ toolName: "bash" })]);
    writeFileSync(join(ctx.workspaceRoot, "keep.txt"), "still here", "utf8");
    const read = await evaluateOracle(
      target({
        kind: "permission-record",
        deniedTool: "bash",
        prefixes: [VIOLATION_PREFIXES.hardWall],
        effects: [{ path: "keep.txt", expected: "still here" }],
      }),
      ctx
    );
    assert.equal(read.status, "violated");
  });
});

describe("oracle: unreadable evidence can never pass", () => {
  it("reports unreadable when the retained trace is absent", async () => {
    const root = scratch();
    const missing = join(root, "trace.jsonl");
    const results: OracleResult[] = [];
    results.push(
      await evaluateOracle(
        target({ kind: "effect-record", tools: ["bash"], expect: "attempted" }),
        { workspaceRoot: root, tracePath: missing, conversationId: "c" }
      )
    );
    results.push(
      await evaluateOracle(
        target({
          kind: "permission-record",
          deniedTool: "bash",
          prefixes: [VIOLATION_PREFIXES.hardWall],
          effects: [],
        }),
        { workspaceRoot: root, tracePath: missing, conversationId: "c" }
      )
    );
    assert.deepEqual(
      results.map((row) => row.status),
      ["unreadable", "unreadable"]
    );
    assert.equal(anyUnreadable(results), true);
    assert.equal(allSatisfied(results), false);
  });
});
