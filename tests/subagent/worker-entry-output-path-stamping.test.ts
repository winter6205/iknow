/**
 * End-to-end handoff stamping: production worker ENTRY → wire → host dispatch →
 * pad → parent-visible `output_path`.
 *
 * Every other test in this area drives one stage with a hand-built input:
 * `worker.test.ts` calls `runWorkerOnce` with stub deps, `pad-final-text.test.ts`
 * feeds the manager a hand-written frame line. Neither proves the stages CONNECT
 * — a frame dropped at the entry, an envelope folded before the raw copy is
 * taken, or a stamp lost in projection would each leave the other suites green.
 *
 * This file closes that gap offline: the real `runSubagentWorker` runs against a
 * stubbed model, its actual stdout is captured, and that captured text — byte
 * for byte, with no re-serialization — is fed through the real manager dispatch
 * into a temporary pad root. The assertions then read what the parent ends up
 * seeing.
 *
 * Both size classes are covered: a report under the IPC fold limit (the envelope
 * body is the whole report) and one over it (the raw body only reaches the host
 * through the `final_text` frame). The folded case carries supplementary
 * (astral) and combining characters, because a hand-built frame never has to
 * survive JSON round-tripping of a real serializer.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

// Model-surface stand-in at the seam the production entry resolves (the same
// technique as tests/subagent/worker-production-exit.test.ts): everything below
// `createRealAnthropicAdapter` — the loop engine, the executor, the worker's
// fold and its stdout sinks — stays real.
//
// The final text is read from `scriptedFinalText` at step time, not derived from
// the model id: the entry normalizes the route through `wireModelFromRoute`
// before the adapter sees it, so the id that arrives is not the id configured.
let scriptedFinalText = "";

vi.mock(
  "../../src/harness/model-adapter/anthropic-adapter.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/harness/model-adapter/anthropic-adapter.ts")
      >();
    const { createStubModel } =
      await import("../../src/harness/stubs/stub-model.ts");
    const { assistantResult } = await import("../cli/_fixtures.ts");
    return {
      ...actual,
      createRealAnthropicAdapter: () =>
        createStubModel({
          responses: [assistantResult({ texts: [scriptedFinalText] })],
        }),
    };
  }
);

import {
  TRUNCATION_LIMIT,
  parseFinalTextFrame,
  parseParentEnvelope,
  frameTag,
} from "../../src/harness/subagent/envelope.ts";
import {
  createSubAgentManager,
  type SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import { runSubagentWorker } from "../../src/harness/subagent/worker.ts";
import { PAD_ROSTER_LINE_LIMIT } from "../../src/harness/subagent/pad-inspect.ts";
import { createSubAgentResultTool } from "../../src/harness/subagent/subagent-result-tool.ts";
import { workerFenceTmpPath } from "../../src/harness/sandbox/fence-tmp.ts";
import { hasLoneSurrogate } from "./pad-text-invariants.ts";
import {
  installTestProviderApiKey,
  llmSettingsJson,
} from "../_helpers/test-llm-settings.ts";

/** Fixed settings id; the report text is scripted, not model-keyed. */
const ENTRY_MODEL = "test/entry-stamp";

/**
 * A report below the IPC fold limit: the envelope body IS the whole report.
 */
const SHORT_FINAL_TEXT =
  "SHORT-ENTRY-REPORT line one\nline two: the whole body rides the envelope\n";

/**
 * A report above the IPC fold limit AND above the pad's line window, with the
 * witness past both cuts: the shape a real long report has. Astral code points
 * (supplementary plane) and combining sequences sit inside the body, so the
 * frame → pad → page path has to survive JSON serialization and a code-unit
 * page edge without splitting a code point.
 */
function foldedFinalText(): string {
  const lines: string[] = ["# FOLDED-ENTRY-REPORT"];
  for (let i = 1; i <= 500; i += 1) {
    // Width is chosen so the whole body clears the IPC fold limit while the
    // 200-line decorated window stays inside the executor's serialized cap:
    // the budgeted branch under test is the raw page chain, not the first window.
    lines.push(
      `L${String(i).padStart(3, "0")} 🙂 folded-entry filler e\u0301 cafe\u0301 obs ${i}`
    );
  }
  lines.push("<<TAIL-WITNESS-ENTRY-FOLDED>>");
  const body = `${lines.join("\n")}\n`;
  // The scenario premise: over the fold limit. If the limit ever moves above
  // this body, the case would silently stop covering folding.
  assert.ok(
    body.length > TRUNCATION_LIMIT,
    `fixture must exceed the fold limit: ${body.length} <= ${TRUNCATION_LIMIT}`
  );
  assert.ok(
    lines.length > PAD_ROSTER_LINE_LIMIT,
    `fixture must exceed the pad line window: ${lines.length} <= ${PAD_ROSTER_LINE_LIMIT}`
  );
  return body;
}

const ENV_KEYS = [
  "HOME",
  "IKNOW_WORKSPACE_ROOT",
  "IKNOW_PRODUCT_ROOT",
  "IKNOW_TRACE_OUT",
  "IKNOW_LLM_BASE_URL",
  "IKNOW_LLM_TIMEOUT_MS",
  "IKNOW_LLM_STREAM",
  "IKNOW_TEST_API_KEY",
] as const;

const scratchPaths: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

/** PATH-prefix dir holding only a bwrap shim, so no real sandbox is probed. */
function makeBwrapShimDir(): string {
  const dir = scratch("iknow-entry-stamp-bin-");
  writeFileSync(join(dir, "bwrap"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

/**
 * Run the real production entry to its terminal `process.exit`, capturing the
 * exact stdout bytes the host would read off the child's pipe.
 */
async function captureWorkerStdout(): Promise<string> {
  const home = scratch("iknow-entry-stamp-home-");
  const sandboxRoot = scratch("iknow-entry-stamp-task-");
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
  process.env.HOME = home;
  installTestProviderApiKey();
  delete process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS;
  process.env.IKNOW_LLM_TIMEOUT_MS = "5000";
  process.env.IKNOW_LLM_STREAM = "off";
  delete process.env.IKNOW_WORKSPACE_ROOT;
  delete process.env.IKNOW_PRODUCT_ROOT;
  const traceDir = join(home, ".iknow", "projects", "entry-stamp");
  mkdirSync(traceDir, { recursive: true });
  process.env.IKNOW_TRACE_OUT = traceDir;
  mkdirSync(join(home, ".iknow"), { recursive: true });
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify(llmSettingsJson({ model: ENTRY_MODEL }))
  );

  const savedPath = process.env.PATH;
  process.env.PATH = `${makeBwrapShimDir()}:${savedPath ?? ""}`;
  writeFileSync(join(sandboxRoot, ".keep"), "");
  const stdinPath = join(scratch("iknow-entry-stamp-stdin-"), "envelope.jsonl");
  writeFileSync(
    stdinPath,
    JSON.stringify({ task: "write the report", sandboxRoot, maxTurns: 3 }) +
      "\n"
  );

  let stdout = "";
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((): boolean => true);
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown): boolean => {
      stdout += String(chunk);
      return true;
    });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number
  ) => {
    throw new Error(`__worker_exit_${code ?? 0}__`);
  }) as never);

  try {
    const fakeStdin = new PassThrough();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });
    fakeStdin.end(readFileSync(stdinPath));
    try {
      await runSubagentWorker();
    } catch (err) {
      if (!String(err).includes("__worker_exit_")) throw err;
    }
  } finally {
    Object.defineProperty(process, "stdin", {
      value: undefined,
      configurable: true,
    });
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    process.env.PATH = savedPath;
    for (const key of ENV_KEYS) {
      const previous = savedEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    savedEnv.clear();
  }
  return stdout;
}

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
    pid: 4242,
  }) as unknown as FakeChild;
}

function flushTicks(): Promise<void> {
  return new Promise((r) => setImmediate(r)).then(
    () => new Promise((r) => setImmediate(r))
  );
}

/**
 * Feed captured wire text through the REAL manager dispatch (the same
 * `child.stdout` data handler a spawned worker drives) into a temp pad root.
 */
async function dispatchThroughManager(wire: string): Promise<{
  readonly manager: SubAgentManager;
  readonly taskId: string;
  readonly pad: string;
}> {
  const root = scratch("iknow-entry-stamp-pad-");
  const subagentsDir = join(root, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const child = makeFakeChild();
  const manager = createSubAgentManager({
    spawn: () => child as unknown as ChildProcess,
    subagentsDir,
  });
  const { taskId } = manager.spawn({ task: "entry stamping" });
  child.stdout.write(wire);
  child.emit("exit", 0, null);
  await flushTicks();
  return { manager, taskId, pad: workerFenceTmpPath(subagentsDir, taskId) };
}

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("worker entry → host dispatch → pad → output_path", () => {
  it("a report under the fold limit still stamps output_path from its own envelope body", async () => {
    scriptedFinalText = SHORT_FINAL_TEXT;
    const wire = await captureWorkerStdout();
    const lines = wire.split("\n").filter((line) => line.trim().length > 0);
    // The short path needs no side channel: the envelope already carries it.
    expect(lines.map((line) => frameTag(line))).toEqual([undefined]);
    const envelope = parseParentEnvelope(lines[0]!);
    expect(envelope.status).toBe("ok");
    expect(envelope.result).toBe(SHORT_FINAL_TEXT);

    const { manager, taskId, pad } = await dispatchThroughManager(wire);
    const env = await manager.waitFor(taskId);
    expect(env.output_path).toBe("final.md");
    expect(readFileSync(join(pad, env.output_path!), "utf8")).toBe(
      SHORT_FINAL_TEXT
    );
    await manager.shutdown();
  });

  it("a folded report writes the frame then the envelope, in that order, on one wire", async () => {
    scriptedFinalText = foldedFinalText();
    const wire = await captureWorkerStdout();
    const lines = wire.split("\n").filter((line) => line.trim().length > 0);
    const tags = lines.map((line) => frameTag(line));
    // Exactly the framed lines: the raw report first, the parseable envelope last.
    expect(tags).toEqual(["final_text", undefined]);
    const frame = parseFinalTextFrame(lines[0]!);
    expect(frame.text).toBe(foldedFinalText());
    const envelope = parseParentEnvelope(lines[1]!);
    expect(envelope.status).toBe("ok");
    expect(envelope.truncated).toBe(true);
    expect(envelope.result.length).toBeLessThanOrEqual(TRUNCATION_LIMIT);
  });

  it("a folded report lands its RAW body on the pad and stamps output_path", async () => {
    scriptedFinalText = foldedFinalText();
    const wire = await captureWorkerStdout();
    const raw = foldedFinalText();
    const { manager, taskId, pad } = await dispatchThroughManager(wire);

    const env = await manager.waitFor(taskId);
    // The parent-visible envelope stays a bounded handoff...
    expect(env.truncated).toBe(true);
    expect(env.totalLength).toBe(raw.length);
    expect(env.result).not.toContain("<<TAIL-WITNESS-ENTRY-FOLDED>>");
    // ...while the pad holds the original, recoverable and byte-exact.
    expect(env.output_path).toBe("final.md");
    const onDisk = readFileSync(join(pad, env.output_path!), "utf8");
    expect(onDisk).toBe(raw);
    expect(onDisk.length).toBe(raw.length);
    expect(hasLoneSurrogate(onDisk)).toBe(false);
    expect(onDisk.includes("\uFFFD")).toBe(false);
    await manager.shutdown();
  });

  it("the stamped path reads back through the model-visible reader, witness included", async () => {
    scriptedFinalText = foldedFinalText();
    const wire = await captureWorkerStdout();
    const { manager, taskId } = await dispatchThroughManager(wire);
    const env = await manager.waitFor(taskId);
    assert.ok(env.output_path, "the receipt must name a file the host wrote");
    const tool = createSubAgentResultTool({ manager });
    const raw = foldedFinalText();

    const read = JSON.parse(
      String(tool.handler({ task_id: taskId, tmp_path: env.output_path }))
    ) as {
      status: string;
      content: string;
      truncated: boolean;
      eof?: boolean;
      next_offset?: number;
    };
    expect(read.status).toBe("ok");
    expect(read.truncated).toBe(true);
    // The first window stops before the tail witness, and hands over the cursor
    // that model-visible wording tells it to pass back.
    expect(read.content).not.toContain("<<TAIL-WITNESS-ENTRY-FOLDED>>");
    expect(read.eof).toBe(false);
    assert.equal(typeof read.next_offset, "number");

    let offset = read.next_offset!;
    let rest = "";
    for (let page = 0; page < 40; page += 1) {
      const view = JSON.parse(
        String(
          tool.handler({
            task_id: taskId,
            tmp_path: env.output_path,
            offset,
          })
        )
      ) as {
        status: string;
        content: string;
        eof: boolean;
        next_offset?: number;
      };
      expect(view.status).toBe("ok");
      expect(hasLoneSurrogate(view.content)).toBe(false);
      rest += view.content;
      if (view.eof) break;
      offset = view.next_offset!;
    }
    // Decorated window + raw continuation == the file, with the witness last:
    // the folded report is genuinely recoverable end to end.
    expect(raw.slice(read.next_offset!)).toBe(rest);
    expect(rest).toContain("<<TAIL-WITNESS-ENTRY-FOLDED>>");
    await manager.shutdown();
  });
});
