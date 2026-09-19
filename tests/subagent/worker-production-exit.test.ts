/**
 * ADR-0111 T4 — 生产入口 `runSubagentWorker` 的出口分流（进程内入口走读，
 * 手法同 tests/subagent/fs-mode-propagation-entry.test.ts：真 stdin / stdout /
 * exit 替身，唯一被替身的是模型面）。
 *
 * 钉住的不变式（ADR-0111 不变式 (b) + Decision 2(a)/(c)）：
 *   1. stub 断流（ModelStreamIncompleteError 直抛，visible=true 不重试）
 *      → loop 收口 protocolError + apiError → failed envelope
 *      reason=modelTransient，**exit 0**（run() 派生的结构化失败走信封，
 *      不冒用 exit 2）；stderr 无 `[subagent-worker] fatal`。
 *   2. parse 之后的装配阶段逃逸（loadIknowEnv 抛 plain-object typed error）
 *      → best-effort failed envelope 写 stdout + **exit 1**；不再冒用 2；
 *      summary 按字段渲染，不塌缩成 [object Object]
 *      （code-quality typed-error catch 契约）。
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

// 模型面替身：createRealAnthropicAdapter 返回 step 直接抛
// ModelStreamIncompleteError(visible=true) 的 stub —— 复现 issue #1065 的
// 「上游流断而未产出完整 message」形态，且不依赖真 LLM key。
// withTransportRetry / translateAnthropicTransportFault / loop 收口保持真实现。
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

/** 只含 bwrap 替身的 PATH 前缀目录（装配期探针调用不触真沙箱）。 */
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
    // run() 派生的结构化失败 → exit 0（不冒用 2；exit≠0 属协议层/进程级）。
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
      // provider `acme` 的 apiKeyEnv 显式不设 → loadIknowEnv 必抛
      // plain-object typed error（run 阶段逃逸，非信封协议错误）。
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
    // run 阶段逃逸不再冒用 exit 2（ADR-0111 不变式 (b)）。
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
