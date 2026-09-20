/**
 * ADR-0111 — exit routing of the production entry `runSubagentWorker`
 * (in-process entry walk-through; same technique as
 * tests/subagent/fs-mode-propagation-entry.test.ts: real stdin / stdout /
 * exit stand-ins, only the model surface is stubbed).
 *
 * Pinned invariants (ADR-0111 invariant (b) + Decision 2(a)/(c)):
 *   1. stubbed stream cut (ModelStreamIncompleteError thrown directly,
 *      visible=true, no retry) → loop converges on protocolError + apiError →
 *      failed envelope reason=modelTransient, **exit 0** (structured failure
 *      derived from run() goes through the envelope, never borrows exit 2);
 *      stderr has no `[subagent-worker] fatal`.
 *   2. assembly-stage escape after parse (loadIknowEnv throws a plain-object
 *      typed error) → best-effort failed envelope on stdout + **exit 1**;
 *      exit 2 is no longer borrowed; summary renders field by field, never
 *      collapsing to [object Object] (typed-error catch contract).
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Model-surface stand-in: createRealAnthropicAdapter returns a stub whose
// step throws ModelStreamIncompleteError(visible=true) directly — reproducing
// the "upstream stream cut before a complete message" shape without depending
// on a real LLM key.
// withTransportRetry / translateAnthropicTransportFault / loop convergence stay real.
vi.mock(
  "../../src/harness/model-adapter/anthropic-adapter.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/harness/model-adapter/anthropic-adapter.ts")
      >();
    const { createStubModel } =
      await import("../../src/harness/stubs/stub-model.ts");
    const { ModelStreamIncompleteError } =
      await import("../../src/harness/errors.ts");
    const stub = createStubModel({ responses: [] });
    const streamIncompleteAdapter = {
      ...stub,
      step: async () => {
        throw new ModelStreamIncompleteError(
          true,
          new Error(
            "stream ended without producing a Message with role=assistant"
          )
        );
      },
    };
    return {
      ...actual,
      createRealAnthropicAdapter: () => streamIncompleteAdapter,
    };
  }
);

import { runSubagentWorker } from "../../src/harness/subagent/worker.ts";
import {
  installTestProviderApiKey,
  llmSettingsJson,
} from "../_helpers/test-llm-settings.ts";

const ENV_KEYS = [
  "HOME",
  "IKNOW_WORKSPACE_ROOT",
  "IKNOW_PRODUCT_ROOT",
  "IKNOW_TRACE_OUT",
  "IKNOW_LLM_BASE_URL",
  "IKNOW_LLM_MAX_OUTPUT_TOKENS",
  "IKNOW_LLM_TIMEOUT_MS",
  "IKNOW_LLM_STREAM",
  "IKNOW_TEST_API_KEY",
  "IKNOW_T4_UNSET_KEY",
] as const;

const scratchPaths: string[] = [];
const savedEnv = new Map<string, string | undefined>();

const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

/** PATH-prefix dir holding only a bwrap shim (assembly probes never touch the real sandbox). */
function makeBwrapShimDir(): string {
  const dir = scratch("iknow-t4-exit-bin-");
  const shim = join(dir, "bwrap");
  writeFileSync(shim, "#!/bin/sh\nexit 0\n");
  chmodSync(shim, 0o755);
  return dir;
}

async function runWorkerEntry(opts: {
  readonly home: string;
  readonly sandboxRoot: string;
  readonly settingsJson: object;
  readonly stdinEnvelope: object;
  readonly installApiKey: boolean;
}): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly threw: unknown;
}> {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
  process.env.HOME = opts.home;
  if (opts.installApiKey) installTestProviderApiKey();
  else delete process.env.IKNOW_TEST_API_KEY;
  delete process.env.IKNOW_T4_UNSET_KEY;
  process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS = "1024";
  process.env.IKNOW_LLM_TIMEOUT_MS = "5000";
  process.env.IKNOW_LLM_STREAM = "off";
  delete process.env.IKNOW_WORKSPACE_ROOT;
  delete process.env.IKNOW_PRODUCT_ROOT;
  const traceDir = join(opts.home, ".iknow", "projects", "t4-exit-fixture");
  mkdirSync(traceDir, { recursive: true });
  process.env.IKNOW_TRACE_OUT = traceDir;

  mkdirSync(join(opts.home, ".iknow"), { recursive: true });
  writeFileSync(
    join(opts.home, ".iknow", "settings.json"),
    JSON.stringify(opts.settingsJson)
  );

  const savedPath = process.env.PATH;
  process.env.PATH = `${makeBwrapShimDir()}:${savedPath ?? ""}`;
  writeFileSync(join(opts.sandboxRoot, ".keep"), "");

  const stdinPath = join(
    scratch("iknow-t4-exit-stdin-"),
    "envelope.jsonl"
  );
  writeFileSync(stdinPath, JSON.stringify(opts.stdinEnvelope) + "\n");

  let exitCode = -1;
  let stderr = "";
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown): boolean => {
      stderr += String(chunk);
      return true;
    });
  let stdout = "";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown): boolean => {
      stdout += String(chunk);
      return true;
    });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number
  ) => {
    exitCode = code ?? 0;
    throw new Error(`__worker_exit_${exitCode}__`);
  }) as never);

  let threw: unknown = null;
  try {
    const stdinReal = readFileSync(stdinPath);
    const fakeStdin = new (await import("node:stream")).PassThrough();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });
    fakeStdin.end(stdinReal);
    try {
      await runSubagentWorker();
    } catch (err) {
      if (!String(err).includes("__worker_exit_")) threw = err;
    }
    Object.defineProperty(process, "stdin", {
      value: undefined,
      configurable: true,
    });
  } finally {
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

  return { exitCode, stdout, stderr, threw };
}

afterEach(() => {
  process.exit = originalExit;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  if (process.env.KEEP_SCRATCH === "1") {
    for (const path of scratchPaths) console.error(`KEEP ${path}`);
    scratchPaths.length = 0;
    return;
  }
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("runSubagentWorker 出口（ADR-0111 不变式 (b)：exit 2 归还）", () => {
  it("stub 断流 worker → exit 0 + stdout failed envelope reason=modelTransient + stderr 无 fatal", async () => {
    const home = scratch("iknow-t4-exit-home-");
    const sandboxRoot = scratch("iknow-t4-exit-task-");
    const result = await runWorkerEntry({
      home,
      sandboxRoot,
      settingsJson: llmSettingsJson({ model: "test/stub-model" }),
      stdinEnvelope: {
        task: "trigger stream cut",
        sandboxRoot,
        maxTurns: 3,
      },
      installApiKey: true,
    });
    expect(result.threw).toBe(null);
    // Structured failure derived from run() -> exit 0 (exit 2 is not
    // borrowed; exit != 0 belongs to the protocol/process layer).
    expect(
      result.exitCode,
      `stdout=${result.stdout} stderr=${result.stderr}`
    ).toBe(0);
    const envelope = JSON.parse(result.stdout.trim()) as {
      status: string;
      reason?: string;
      stop_reason?: string;
    };
    expect(envelope.status).toBe("failed");
    expect(envelope.reason).toBe("modelTransient");
    expect(envelope.stop_reason).toBe("protocolError");
    expect(result.stderr.includes("[subagent-worker] fatal")).toBe(false);
  }, 90_000);

  it("parse 后装配逃逸（provider key 未设）→ exit 1 + best-effort failed envelope（reason=crashed，summary 不塌缩 [object Object]）", async () => {
    const home = scratch("iknow-t4-exit-home-");
    const sandboxRoot = scratch("iknow-t4-exit-task-");
    const result = await runWorkerEntry({
      home,
      sandboxRoot,
      // provider `acme`'s apiKeyEnv is deliberately unset → loadIknowEnv
      // must throw a plain-object typed error (run-stage escape, not an
      // envelope protocol error).
      settingsJson: {
        llm: {
          model: "acme/foo",
          providers: [
            {
              id: "acme",
              baseUrl: "http://127.0.0.1:41999/v1",
              apiKeyEnv: "IKNOW_T4_UNSET_KEY",
              models: [{ id: "foo" }],
            },
          ],
        },
      },
      stdinEnvelope: { task: "any", sandboxRoot, maxTurns: 3 },
      installApiKey: false,
    });
    expect(result.threw).toBe(null);
    // run-stage escapes no longer borrow exit 2 (ADR-0111 invariant (b)).
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout.trim()) as {
      status: string;
      reason?: string;
      summary: string;
    };
    expect(envelope.status).toBe("failed");
    expect(envelope.reason).toBe("crashed");
    expect(envelope.summary.includes("[object Object]")).toBe(false);
    expect(envelope.summary).toMatch(/acme/);
    expect(result.stderr.includes("[subagent-worker] fatal")).toBe(false);
  }, 90_000);
});
