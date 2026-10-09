/**
 * Locked sentence 2 — final-text landing on the host.
 *
 * Invariant: the envelope visible to the parent stays a short summary, not the
 * final text. At worker terminal state the **host** writes the raw final text to
 * the stable relative path `FINAL_TEXT_PAD_NAME` inside that worker's pad, and
 * the envelope carries `output_path` (pad-relative, consumed by
 * `subagent_result(tmp_path)`). The raw source is the `final_text` frame the
 * worker sends beside a folded envelope; with no frame the host persists the
 * `result` exactly as received — it folds its own parent-visible copy only
 * afterwards (T3, `plans/subagent-output-handoff.md`).
 *
 *   - final text longer than the envelope → pad file readable, content === terminal assistant body;
 *   - `truncated: true` still means `status: "ok"`, no `reason`, file readable
 *     (same truncation semantics as existing pad reads; truncation is **not** task failure);
 *   - empty / whitespace-only result (timeout fallback shape) → no file written, `output_path` key absent, never fabricate an empty file;
 *   - pad write failure (simulated here by making the pad root un-writable) → envelope still produced, `output_path` absent, task status unchanged, never throws through locateEnvelope;
 *   - round trip: feed the `output_path` value back into `subagent_result(tmp_path)` to retrieve the body.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import {
  FINAL_TEXT_PAD_NAME,
  TRUNCATION_LIMIT,
  truncateEnvelopeResult,
} from "../../src/harness/subagent/envelope.ts";
import type { SubAgentEnvelope } from "../../src/harness/subagent/envelope.ts";
import {
  createSubAgentManager,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import { inspectWorkerPad } from "../../src/harness/subagent/pad-inspect.ts";
import { createSubAgentResultTool } from "../../src/harness/subagent/subagent-result-tool.ts";
import { workerFenceTmpPath } from "../../src/harness/sandbox/fence-tmp.ts";
import { hasLoneSurrogate } from "./pad-text-invariants.ts";

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

function emitEnvelope(child: FakeChild, env: SubAgentEnvelope): void {
  child.stdout.write(`${JSON.stringify(env)}\n`);
  child.emit("exit", env.status === "ok" ? 0 : 1, null);
}

/**
 * The production wire of an over-limit ok report: the worker writes one
 * `final_text` frame line (its raw pre-fold body) and then the single terminal
 * envelope line, which the worker already folded.
 */
function emitFoldedEnvelopeWithFrame(
  child: FakeChild,
  raw: string,
  summary: string
): void {
  const folded = truncateEnvelopeResult({ status: "ok", summary, result: raw });
  child.stdout.write(`${JSON.stringify({ type: "final_text", text: raw })}\n`);
  child.stdout.write(`${JSON.stringify(folded)}\n`);
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

let subagentsDir: string;

beforeEach(() => {
  const root = makeScratch("iknow-pad-final-");
  subagentsDir = join(root, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
});

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
    rmSync(`${path}.unwritable`, { recursive: true, force: true });
  }
});

describe("host pad final text (Locked sentence 2)", () => {
  it("terminal settle writes the final assistant text to the pad and stamps output_path", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "long final" });
    const finalText = "final assistant body\n".repeat(60);
    emitEnvelope(child, {
      status: "ok",
      summary: "short summary",
      result: finalText,
    });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    assert.equal(env.output_path, FINAL_TEXT_PAD_NAME);

    // the read side uses the real inspectWorkerPad (same implementation as subagent_result(tmp_path)).
    const read = inspectWorkerPad(pad, env.output_path);
    assert.equal(read.status, "read");
    assert.ok(read.status === "read");
    // pad reads add a 6-digit line-number prefix and a 200-line window; assert byte-equality via the first line inside the window.
    assert.match(read.content, /^\s*1\tfinal assistant body$/m);
    assert.equal(read.truncated, false);
    assert.ok(read.content.length > "short summary".length);
    await manager.shutdown();
  });

  it("truncated:true stays status ok with no reason, and the pad file is readable", async () => {
    // T3 supersedes this case's original contract ("the pad holds the copy the
    // worker folded on the wire"): the pad now holds the RAW final text while the
    // parent-visible envelope keeps the folded, bounded handoff.
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "wire folded" });
    // One past the IPC fold limit: the worker's condensation folds this copy,
    // so the envelope arriving here is the raw pre-fold text.
    const longResult = "x".repeat(20_001);
    emitEnvelope(child, {
      status: "ok",
      summary: "folded handoff",
      result: longResult,
    });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    assert.equal(env.truncated, true);
    assert.equal(env.status, "ok");
    assert.equal("reason" in env, false);
    assert.equal(env.output_path, FINAL_TEXT_PAD_NAME);

    const pad = workerFenceTmpPath(subagentsDir, taskId);
    // The pad holds the original the host received — longer than the parent's
    // handoff, with no fold marker of its own.
    const onDisk = readFileSync(join(pad, FINAL_TEXT_PAD_NAME), "utf8");
    assert.equal(onDisk, longResult);
    assert.equal(statSync(join(pad, FINAL_TEXT_PAD_NAME)).size, onDisk.length);
    assert.equal(onDisk.includes("report folded"), false);

    // The parent-visible copy stays the folded handoff.
    assert.ok(env.result.length <= TRUNCATION_LIMIT);
    assert.match(env.result, /report folded/);
    assert.equal(env.totalLength, longResult.length);

    const read = inspectWorkerPad(pad, env.output_path!);
    assert.equal(read.status, "read");
    assert.ok(read.status === "read");
    assert.equal(read.content.includes("report folded"), false);
    await manager.shutdown();
  });

  it("failure with empty result writes no file and omits output_path", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "crash" });
    child.stderr.end();
    child.emit("exit", 1, null);
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    assert.equal(env.status, "failed");
    assert.equal(env.reason, "crashed");
    assert.equal(env.output_path, undefined);
    assert.equal("output_path" in env, false);

    const pad = workerFenceTmpPath(subagentsDir, taskId);
    assert.equal(existsSync(join(pad, FINAL_TEXT_PAD_NAME)), false);
    const names = existsSync(pad) ? readdirSync(pad) : [];
    assert.ok(
      !names.includes(FINAL_TEXT_PAD_NAME),
      `no fabricated pad file, got ${names.join(",")}`
    );
    await manager.shutdown();
  });

  it("timeout fallback (whitespace-only result) fabricates no empty file", async () => {
    vi.useFakeTimers();
    try {
      const child = makeFakeChild();
      const manager = createSubAgentManager({
        spawn: () => child as unknown as ChildProcess,
        subagentsDir,
      });
      const { taskId } = manager.spawn({ task: "slow", timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      const env = await manager.waitFor(taskId);
      assert.equal(env.status, "failed");
      assert.equal(env.reason, "timeout");
      assert.equal("output_path" in env, false);

      const pad = workerFenceTmpPath(subagentsDir, taskId);
      assert.equal(existsSync(join(pad, FINAL_TEXT_PAD_NAME)), false);
      await manager.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pad write failure degrades to no output_path without failing the task", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "unwritable pad" });
    // The target file name is occupied by a **directory** → writeFileSync EISDIR.
    // locateEnvelope must swallow it: envelope still produced, no output_path,
    // task status unchanged.
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    mkdirSync(join(pad, FINAL_TEXT_PAD_NAME), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      emitEnvelope(child, { status: "ok", summary: "done", result: "body" });
      await flushTwoTicks();

      const env = await manager.waitFor(taskId);
      assert.equal(env.status, "ok");
      assert.equal(env.summary, "done");
      assert.equal("output_path" in env, false);
      assert.equal(env.task_id, taskId);
      // the real failure is named (warn-once channel), not a silently fabricated path.
      assert.ok(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("final text pad write skipped")
        ),
        `expected a warn trail, got ${JSON.stringify(warn.mock.calls)}`
      );
    } finally {
      warn.mockRestore();
    }
    await manager.shutdown();
  });

  it("round-trips through the model-facing subagent_result reader", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "round trip" });
    const finalText = "round-trip final body";
    emitEnvelope(child, {
      status: "ok",
      summary: "short",
      result: finalText,
    });
    await flushTwoTicks();

    const tool = createSubAgentResultTool({ manager });
    const poll = JSON.parse(String(tool.handler({ task_id: taskId }))) as {
      output_path?: string;
    };
    assert.equal(poll.output_path, FINAL_TEXT_PAD_NAME);

    const readBack = JSON.parse(
      String(tool.handler({ task_id: taskId, tmp_path: poll.output_path }))
    ) as { status: string; content?: string };
    assert.equal(readBack.status, "ok");
    assert.match(readBack.content ?? "", /round-trip final body/);
    await manager.shutdown();
  });

  it("terminal notice carries output_path so a drained/woken envelope can read it", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const notices: { taskId: string; output_path?: string }[] = [];
    manager.subscribe((notice) => {
      notices.push({
        taskId: notice.taskId,
        ...(notice.output_path !== undefined
          ? { output_path: notice.output_path }
          : {}),
      });
    });
    const { taskId } = manager.spawn({ task: "wake me" });
    emitEnvelope(child, {
      status: "ok",
      summary: "short",
      result: "woken final body",
    });
    await flushTwoTicks();

    assert.deepEqual(notices, [{ taskId, output_path: FINAL_TEXT_PAD_NAME }]);
    const drained = manager.drainCompleted();
    assert.equal(drained[0]!.envelope.output_path, FINAL_TEXT_PAD_NAME);
    assert.equal(
      existsSync(
        join(
          workerFenceTmpPath(subagentsDir, taskId),
          drained[0]!.envelope.output_path!
        )
      ),
      true
    );
    await manager.shutdown();
  });
});

// ── T3 target contract: the pad keeps the RAW final text ────────────────────
//
// A completed worker's original final text must stay recoverable from its
// fenced `final.md` even when its IPC result is folded, while the
// parent-visible envelope stays a bounded short handoff with truthful
// `truncated` / `totalLength`. The cases below are the deterministic half of
// that contract: whatever raw text the host holds — the `final_text` frame's
// body, or an envelope `result` that has not been folded yet — is what lands
// on the pad, before the host folds its own parent-visible copy.
//
// The fold threshold is the production `TRUNCATION_LIMIT` (imported from
// envelope.ts), so a changed limit cannot leave these asserting an old band.

/** The fold marker as rendered by `projectParentVisibleEnvelope`. */
const FOLD_MARKER_TOTAL = /\[report folded; total (\d+) chars\]/;

/**
 * Drive one worker to a terminal `ok` landing whose final text is `result`,
 * and hand back everything the assertions read: the buffered envelope, the
 * model-visible projection through the real `subagent_result` tool, and the
 * on-disk pad file path.
 */
async function landFinalText(
  result: string,
  taskLabel = "final text"
): Promise<{
  readonly manager: SubAgentManager;
  readonly taskId: string;
  readonly env: SubAgentEnvelope;
  readonly padFile: string;
  readonly visible: Record<string, unknown>;
}> {
  const child = makeFakeChild();
  const manager = createSubAgentManager({
    spawn: () => child as unknown as ChildProcess,
    subagentsDir,
  });
  const { taskId } = manager.spawn({ task: taskLabel });
  emitEnvelope(child, {
    status: "ok",
    summary: "short handoff",
    result,
  });
  await flushTwoTicks();
  const env = await manager.waitFor(taskId);
  const visible = JSON.parse(
    String(createSubAgentResultTool({ manager }).handler({ task_id: taskId }))
  ) as Record<string, unknown>;
  return {
    manager,
    taskId,
    env,
    visible,
    padFile: join(
      workerFenceTmpPath(subagentsDir, taskId),
      FINAL_TEXT_PAD_NAME
    ),
  };
}

/** Assert the on-disk pad file is byte-for-byte the original text. */
function assertPadIsTheOriginal(padFile: string, original: string): string {
  const onDisk = readFileSync(padFile, "utf8");
  assert.equal(
    onDisk.length,
    original.length,
    "the pad body must be measured in the same UTF-16 code units as the original"
  );
  assert.equal(onDisk, original);
  assert.equal(hasLoneSurrogate(onDisk), false, "no split code point may land");
  assert.equal(onDisk.includes("\uFFFD"), false, "no replacement character");
  assert.equal(
    statSync(padFile).size,
    Buffer.byteLength(original, "utf8"),
    "the persisted byte size matches the original UTF-8 encoding"
  );
  return onDisk;
}

describe("long-report raw final text on the pad (T3 target contract)", () => {
  it("a >20000-unit original lands complete on the pad while the parent-visible handoff stays folded", async () => {
    const original = `# report head\n${"b".repeat(TRUNCATION_LIMIT)}\n<<TAIL-WITNESS-LONG-REPORT>>\n`;
    const { manager, env, padFile } = await landFinalText(original);
    try {
      assert.equal(env.output_path, FINAL_TEXT_PAD_NAME);
      const onDisk = assertPadIsTheOriginal(padFile, original);
      assert.ok(
        onDisk.includes("<<TAIL-WITNESS-LONG-REPORT>>"),
        "the original tail witness must survive into the pad"
      );
      assert.ok(
        onDisk.length > TRUNCATION_LIMIT,
        `the pad is not merely the folded handoff (got ${onDisk.length} units)`
      );
      // The parent-visible envelope keeps its bounded shape: folded, ok, truthful total.
      assert.equal(env.truncated, true);
      assert.equal(env.status, "ok");
      assert.equal(env.totalLength, original.length);
    } finally {
      await manager.shutdown();
    }
  });

  it("the model-visible handoff stays bounded and restates the ORIGINAL length, not the folded copy's", async () => {
    const original = `${"c".repeat(TRUNCATION_LIMIT + 1)}\n<<TAIL-WITNESS-TOTAL>>`;
    const { manager, visible, padFile } = await landFinalText(original);
    try {
      assertPadIsTheOriginal(padFile, original);
      const body = String(visible.result);
      assert.equal(visible.truncated, true);
      assert.ok(
        body.length <= TRUNCATION_LIMIT,
        `the parent-visible handoff must stay bounded (got ${body.length} units)`
      );
      assert.equal(
        visible.totalLength,
        original.length,
        "re-projecting an already folded envelope must not restate a smaller total"
      );
      // The marker's own wording is not pinned here (tests/subagent/envelope.test.ts
      // and worker.test.ts lock it); this case pins the number beside it.
      const marker = FOLD_MARKER_TOTAL.exec(body);
      if (marker !== null) {
        assert.equal(Number(marker[1]), original.length);
      }
    } finally {
      await manager.shutdown();
    }
  });

  it("two concurrent workers each keep their own full original (no cross-pad overwrite)", async () => {
    const originalA = `${"a".repeat(TRUNCATION_LIMIT + 1)}\n<<TAIL-WITNESS-A>>`;
    const originalB = `${"b".repeat(TRUNCATION_LIMIT + 7)}\n<<TAIL-WITNESS-B>>`;
    const children = new Map<string, FakeChild>();
    const manager = createSubAgentManager({
      spawn: (_def, taskId) => {
        const child = makeFakeChild();
        children.set(taskId, child);
        return child as unknown as ChildProcess;
      },
      subagentsDir,
    });
    const taskA = manager.spawn({ task: "report A" }).taskId;
    const taskB = manager.spawn({ task: "report B" }).taskId;
    try {
      emitEnvelope(children.get(taskA)!, {
        status: "ok",
        summary: "A done",
        result: originalA,
      });
      emitEnvelope(children.get(taskB)!, {
        status: "ok",
        summary: "B done",
        result: originalB,
      });
      await flushTwoTicks();

      const padA = join(
        workerFenceTmpPath(subagentsDir, taskA),
        FINAL_TEXT_PAD_NAME
      );
      const padB = join(
        workerFenceTmpPath(subagentsDir, taskB),
        FINAL_TEXT_PAD_NAME
      );
      const bodyA = assertPadIsTheOriginal(padA, originalA);
      const bodyB = assertPadIsTheOriginal(padB, originalB);
      assert.equal(bodyA.includes("<<TAIL-WITNESS-B>>"), false);
      assert.equal(bodyB.includes("<<TAIL-WITNESS-A>>"), false);
    } finally {
      await manager.shutdown();
    }
  });
});

describe("UTF-16 boundary fidelity of the host-written pad (T3 target contract)", () => {
  it("19999 code units: below the limit, the pad holds the exact original and the wire does not fold", async () => {
    const original = "x".repeat(19_999);
    const { manager, env, visible, padFile } = await landFinalText(original);
    try {
      assertPadIsTheOriginal(padFile, original);
      assert.equal(env.truncated, undefined, "no fold below the limit");
      assert.equal(visible.totalLength, 19_999);
    } finally {
      await manager.shutdown();
    }
  });

  it("20000 code units: exactly at the limit, the pad still holds the exact original", async () => {
    const original = "x".repeat(20_000);
    const { manager, env, visible, padFile } = await landFinalText(original);
    try {
      assertPadIsTheOriginal(padFile, original);
      assert.equal(
        env.truncated,
        undefined,
        "the limit itself is not an overflow"
      );
      assert.equal(visible.totalLength, 20_000);
    } finally {
      await manager.shutdown();
    }
  });

  it("20001 code units: one past the limit, the pad still holds the exact original", async () => {
    const original = `${"x".repeat(20_000)}\n<<TAIL-WITNESS-20001>>`;
    const { manager, env, visible, padFile } = await landFinalText(original);
    try {
      assertPadIsTheOriginal(padFile, original);
      assert.equal(env.truncated, true, "one past the limit folds the handoff");
      assert.equal(visible.totalLength, original.length);
    } finally {
      await manager.shutdown();
    }
  });

  it("supplementary (astral) characters land as intact surrogate pairs and count as two UTF-16 units each", async () => {
    // 10 001 astral code points = 20 002 UTF-16 code units: over the fold limit
    // while the code-POINT count stays under it, so a code-point-based measure
    // would show up as a different totalLength.
    const original = "😀".repeat(10_001);
    assert.equal(original.length, 20_002);
    assert.equal(Array.from(original).length, 10_001);
    const { manager, env, visible, padFile } = await landFinalText(
      original,
      "astral report"
    );
    try {
      assertPadIsTheOriginal(padFile, original);
      assert.equal(env.truncated, true);
      assert.equal(
        visible.totalLength,
        20_002,
        "totalLength is UTF-16 code units, not code points"
      );
    } finally {
      await manager.shutdown();
    }
  });

  it("combining marks survive the pad write without normalization", async () => {
    // Decomposed `e` + COMBINING ACUTE U+0301 next to precomposed U+00E9: an
    // NFC/NFD-normalizing write or read would silently rewrite the report body.
    const original = `${"e\u0301".repeat(9_000)}${"\u00e9".repeat(2_002)}`;
    assert.equal(original.length, 20_002);
    const { manager, visible, padFile } = await landFinalText(
      original,
      "combining report"
    );
    try {
      const onDisk = assertPadIsTheOriginal(padFile, original);
      assert.equal(
        onDisk === onDisk.normalize("NFC"),
        false,
        "the pad body stays decomposed, not normalization-folded"
      );
      assert.equal(Array.from(onDisk).length, Array.from(original).length);
      assert.equal(visible.totalLength, original.length);
    } finally {
      await manager.shutdown();
    }
  });
});

describe("final-text failure surfaces at the pad boundary (T3 target contract)", () => {
  it("a manager with no session layout (no pad root) stamps no output_path and writes nothing", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      // No subagentsDir / projectDir → the task has no pad root at all.
    });
    const { taskId } = manager.spawn({ task: "no pad root" });
    emitEnvelope(child, {
      status: "ok",
      summary: "done",
      result: "body with nowhere to land",
    });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    assert.equal(env.status, "ok");
    assert.equal(
      "output_path" in env,
      false,
      "never point at a file not written"
    );
    assert.equal("tmp_root" in env, false);
    const visible = JSON.parse(
      String(createSubAgentResultTool({ manager }).handler({ task_id: taskId }))
    ) as Record<string, unknown>;
    assert.equal("output_path" in visible, false);
    await manager.shutdown();
  });

  it("a whitespace-only ok result fabricates no final.md and no output_path", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "blank final" });
    emitEnvelope(child, {
      status: "ok",
      summary: "done",
      result: "   \n\t  ",
    });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    assert.equal(env.status, "ok");
    assert.equal("output_path" in env, false);
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    assert.equal(existsSync(join(pad, FINAL_TEXT_PAD_NAME)), false);
    const names = existsSync(pad) ? readdirSync(pad) : [];
    assert.ok(
      !names.includes(FINAL_TEXT_PAD_NAME),
      `no fabricated empty pad file, got ${names.join(",")}`
    );
    await manager.shutdown();
  });

  it("a failed pad write keeps the terminal state truthfully and stamps no output_path", async () => {
    // The EXIT arm of `writeFinalTextToPad`: bookkeeping failure must degrade the
    // handoff, never invent a readable report or restate the task status. The
    // case above (a directory occupying the target name) locks the same shape on
    // the buffered envelope; this one locks it on the model-visible surface.
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "unwritable pad, model-visible" });
    const pad = workerFenceTmpPath(subagentsDir, taskId);
    mkdirSync(join(pad, FINAL_TEXT_PAD_NAME), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      emitEnvelope(child, {
        status: "ok",
        summary: "done",
        result: "x".repeat(TRUNCATION_LIMIT + 1),
      });
      await flushTwoTicks();

      const env = await manager.waitFor(taskId);
      assert.equal(env.status, "ok");
      assert.equal("output_path" in env, false);
      const visible = JSON.parse(
        String(
          createSubAgentResultTool({ manager }).handler({
            task_id: taskId,
            tmp_path: FINAL_TEXT_PAD_NAME,
          })
        )
      ) as Record<string, unknown>;
      assert.equal(
        visible.status,
        "rejected",
        "reading a non-file stays typed"
      );
      assert.equal(typeof visible.reason, "string");
      assert.equal(String(JSON.stringify(visible)).includes(pad), false);
    } finally {
      warn.mockRestore();
      await manager.shutdown();
    }
  });
});

// ── T3: the `final_text` side-channel frame ─────────────────────────────────
//
// The production wire of an over-limit ok report is two lines on the same
// stdout: one `final_text` frame carrying the raw pre-fold body, then the single
// terminal envelope line the worker already folded. The host must persist the
// frame's body while the parent-visible copy stays the folded handoff.

describe("final_text frame recovery on the host (T3)", () => {
  it("a folded envelope plus its final_text frame lands the frame's raw body", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "frame recovery" });
    const raw = `# long report\n${"d".repeat(TRUNCATION_LIMIT)}\n<<TAIL-WITNESS-FRAME>>\n`;
    emitFoldedEnvelopeWithFrame(child, raw, "frame handoff");
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    try {
      assertPadIsTheOriginal(
        join(workerFenceTmpPath(subagentsDir, taskId), FINAL_TEXT_PAD_NAME),
        raw
      );
      assert.equal(env.status, "ok");
      assert.equal(env.output_path, FINAL_TEXT_PAD_NAME);
      // The parent-visible copy stays the folded handoff, with the raw total.
      assert.equal(env.truncated, true);
      assert.equal(env.totalLength, raw.length);
      assert.ok(env.result.length <= TRUNCATION_LIMIT);
      const marker = FOLD_MARKER_TOTAL.exec(env.result);
      assert.ok(marker !== null, "the handoff must restate the fold");
      assert.equal(Number(marker[1]), raw.length);
      assert.equal(env.result.includes("<<TAIL-WITNESS-FRAME>>"), false);
    } finally {
      await manager.shutdown();
    }
  });

  it("a second landing never re-attaches the consumed raw body", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "repeated landing" });
    const raw = `${"e".repeat(TRUNCATION_LIMIT + 3)}\n<<TAIL-WITNESS-FIRST>>`;
    emitFoldedEnvelopeWithFrame(child, raw, "first landing");
    await flushTwoTicks();
    const padFile = join(
      workerFenceTmpPath(subagentsDir, taskId),
      FINAL_TEXT_PAD_NAME
    );
    assertPadIsTheOriginal(padFile, raw);

    // A later envelope on the same task carries its own (unfolded) body: the pad
    // must take that, never the stale raw of the earlier frame.
    emitEnvelope(child, {
      status: "ok",
      summary: "second landing",
      result: "second body",
    });
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    try {
      assert.equal(readFileSync(padFile, "utf8"), "second body");
      assert.equal(env.output_path, FINAL_TEXT_PAD_NAME);
      assert.equal(env.truncated, undefined);
    } finally {
      await manager.shutdown();
    }
  });

  it("a legacy folded envelope with no frame degrades to the body as received", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "legacy worker" });
    const raw = `${"f".repeat(TRUNCATION_LIMIT + 5)}\n<<TAIL-WITNESS-LEGACY>>`;
    // What a pre-T3 worker sends: the folded envelope alone, no side channel.
    emitEnvelope(
      child,
      truncateEnvelopeResult({ status: "ok", summary: "legacy", result: raw })
    );
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    try {
      const onDisk = readFileSync(
        join(workerFenceTmpPath(subagentsDir, taskId), FINAL_TEXT_PAD_NAME),
        "utf8"
      );
      assert.equal(onDisk, env.result);
      assert.ok(onDisk.includes("report folded"));
      assert.equal(env.truncated, true);
      assert.equal(env.totalLength, raw.length);
      assert.equal(env.output_path, FINAL_TEXT_PAD_NAME);
    } finally {
      await manager.shutdown();
    }
  });

  it("with no pad root the frame body is dropped, never folded into the envelope", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      // No subagentsDir / projectDir → no pad root for this task.
    });
    const { taskId } = manager.spawn({ task: "frame, no pad" });
    const raw = `${"g".repeat(TRUNCATION_LIMIT + 1)}\n<<TAIL-WITNESS-NOPAD>>`;
    emitFoldedEnvelopeWithFrame(child, raw, "no pad");
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    try {
      assert.equal(env.status, "ok");
      assert.equal("output_path" in env, false);
      assert.equal("tmp_root" in env, false);
      // The raw body must not surface anywhere on the parent-visible envelope.
      assert.equal(
        JSON.stringify(env).includes("<<TAIL-WITNESS-NOPAD>>"),
        false
      );
      assert.equal(env.truncated, true);
      assert.equal(env.totalLength, raw.length);
    } finally {
      await manager.shutdown();
    }
  });

  it("a malformed final_text frame is a ProtocolError, never a partial report", async () => {
    const child = makeFakeChild();
    const manager = createSubAgentManager({
      spawn: () => child as unknown as ChildProcess,
      subagentsDir,
    });
    const { taskId } = manager.spawn({ task: "bad frame" });
    // `text` missing → outside FINAL_TEXT_FRAME_SCHEMA (required ["type","text"]).
    // The frame grammar is closed: a tagged line that fails its schema is a
    // protocol error, not a report to guess at.
    child.stdout.write(`${JSON.stringify({ type: "final_text" })}\n`);
    child.stderr.end();
    child.emit("exit", 0, null);
    await flushTwoTicks();

    const env = await manager.waitFor(taskId);
    try {
      assert.equal(env.status, "failed");
      assert.equal(env.reason, "protocolError");
      assert.match(env.summary, /final_text/);
      assert.equal("output_path" in env, false);
      const pad = workerFenceTmpPath(subagentsDir, taskId);
      assert.equal(existsSync(join(pad, FINAL_TEXT_PAD_NAME)), false);
    } finally {
      await manager.shutdown();
    }
  });
});
