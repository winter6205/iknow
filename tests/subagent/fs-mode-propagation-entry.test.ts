/**
 * ADR-0092 Amendment — verification of the **production entry** for fs-mode propagation.
 *
 * `fs-mode-propagation.test.ts` covers both channel ends (spawn writes env /
 * `fsModeOptionFromEnv` reads env) and an "equivalent assembly entry" (the test
 * itself calls `createWorkerDeps` + helper). The equivalent entry has a
 * discriminating-power gap: delete the `...fsModeOptionFromEnv(process.env)`
 * line in `runSubagentWorker` and the equivalent entry stays green — because
 * the test called the helper once when assembling deps itself, and no test
 * exercises that one call at the prod entry. That is exactly this bug's class
 * (seam present, production wiring broken).
 *
 * This file runs the real `runSubagentWorker()` (one envelope line in on stdin,
 * one result line out on stdout) and asserts on the **fence argv bwrap actually
 * receives** (the bash tool's real execution surface; the fence is spawned
 * through the server layer with argv[0] = `bwrap`, so a PATH shim is the
 * outermost observable point). Therefore:
 *
 *   - fs-mode wiring present (env=workspace) → fence argv contains
 *     `--ro-bind <home>` + `--bind <sandboxRoot>`;
 *   - delete that line in `runSubagentWorker` → fence argv falls back to the
 *     global mode (`--bind / /` present, home ro-bind absent) → this file goes red.
 *
 * Boundary choices (why not stub env/stdin):
 *   - stdin: `process`'s `stdin` is getter-only and unsettable, so it can't be
 *     spied (verified: `Object.getOwnPropertyDescriptor(process, "stdin")` →
 *     `{get, configurable, set: false}`); `vi.mock("node:process")` would also
 *     swap the `process.env` / `process.cwd()` / `process.stderr` the production
 *     path really uses, violating the real boundary. So we feed the real stdin
 *     (same shape as the `cli.ts --subagent-worker` child process).
 *   - env: `loadIknowEnv()` reads `process.env` (ADR-0001: worker inherits
 *     parent env); this file mutates ambient env per the real boundary and
 *     redirects HOME into scratch, restoring after the run.
 *   - Only the model surface is shimmed (`createRealAnthropicAdapter` → local
 *     deterministic stub): no LLM key on this machine, and this test's subject
 *     is fs-mode wiring, not adapter behavior.
 *     `buildThinkingParams` / `withTransportRetry` / `translateAnthropicTransportFault`
 *     stay real (only the adapter body is swapped — the same abstraction level
 *     as stub-model injection in `createWorkerDeps` tests).
 *   - bash really executes: the `bwrap` on the parent's PATH is replaced by a
 *     shim that records argv and returns `{}` (bwrap is outside the workspace,
 *     not part of the system under test). System under test = worker assembly
 *     + registry + bash factory + fence construction + server protocol. The
 *     shim is not real bwrap, so naturally no real sandbox side effects — this
 *     test only takes the argv surface.
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

// Model-surface shim: worker assembly uses createStubModel as the adapter
// (no LLM key on this machine). All other exports (buildThinkingParams /
// createExecutor / withTransportRetry / translateAnthropicTransportFault) stay real.
vi.mock(
  "../../src/harness/model-adapter/anthropic-adapter.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/harness/model-adapter/anthropic-adapter.ts")
      >();
    const { createStubModel } =
      await import("../../src/harness/stubs/stub-model.ts");

    return {
      ...actual,
      createRealAnthropicAdapter: () =>
        createStubModel({
          responses: [
            {
              nativeMessage: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "call_bash_1",
                    name: "bash",
                    input: { command: "echo hi" },
                  },
                ],
              },
              projection: {
                nativeMessage: {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: "call_bash_1",
                      name: "bash",
                      input: { command: "echo hi" },
                    },
                  ],
                },
                texts: [],
                toolCalls: [
                  {
                    id: "call_bash_1",
                    name: "bash",
                    input: { command: "echo hi" },
                  },
                ],
              },
              supplierStop: "success",
              needsTools: true,
              isEmptyFinalResponse: false,
            },
            {
              nativeMessage: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
              },
              projection: {
                nativeMessage: {
                  role: "assistant",
                  content: [{ type: "text", text: "done" }],
                },
                texts: ["done"],
                toolCalls: [],
              },
              supplierStop: "success",
              needsTools: false,
              isEmptyFinalResponse: false,
            },
          ],
        }),
    };
  }
);

import { runSubagentWorker } from "../../src/harness/subagent/worker.ts";
import { FS_MODE_ENV_KEY } from "../../src/config/workspace-root.ts";
import {
  installTestProviderApiKey,
  llmSettingsJson,
} from "../_helpers/test-llm-settings.ts";

/** Ambient env keys this file mutates (restored verbatim after each run). */
const ENV_KEYS = [
  "HOME",
  "IKNOW_FS_MODE",
  "IKNOW_WORKSPACE_ROOT",
  "IKNOW_PRODUCT_ROOT",
  "IKNOW_TRACE_OUT",
  "IKNOW_LLM_BASE_URL",
  "IKNOW_LLM_MAX_OUTPUT_TOKENS",
  "IKNOW_LLM_TIMEOUT_MS",
  "IKNOW_LLM_STREAM",
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

/**
 * Replace PATH with a directory containing only the bwrap shim (real bash/echo still resolve via the real PATH).
 *
 * The shim appends the argv it receives into `argvLog`: the path is **hard-coded
 * at generation time**, not read from env — bash launches bwrap with the fence
 * env (`--clearenv` + whitelist), where keys in `process.env` are invisible
 * (that is exactly the fence's semantics).
 */
function makeBwrapShimDir(argvLog: string): string {
  const dir = scratch("iknow-fs-mode-entry-bin-");
  const shim = join(dir, "bwrap");
  // Each call writes a separator line before the argv —— this separates the
  // assembly-time bwrap probe call from the real fence call (both append into
  // the same log). This file prepends a PATH directory containing only this
  // shim, so whether the host has bwrap installed doesn't matter (no real fence runs).
  writeFileSync(
    shim,
    `#!/bin/sh\nprintf '###ARGS###\\n' >> ${JSON.stringify(argvLog)}\nprintf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}\n`
  );
  chmodSync(shim, 0o755);
  return dir;
}

async function runWorkerEntry(opts: {
  readonly fsModeToken?: string;
  readonly argvLog: string;
  readonly home: string;
  readonly sandboxRoot: string;
  readonly task: string;
  readonly bwrapShimDir: string;
}): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const { home, sandboxRoot, task } = opts;
  // 1) ambient env: worker inherits parent env (ADR-0001), same shape as spawn.ts writes.
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
  process.env.HOME = home;
  installTestProviderApiKey();
  // Retired global output-token knob: a non-empty value now fails config load.
  delete process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS;
  process.env.IKNOW_LLM_TIMEOUT_MS = "5000";
  process.env.IKNOW_LLM_STREAM = "off";
  delete process.env.IKNOW_WORKSPACE_ROOT;
  delete process.env.IKNOW_PRODUCT_ROOT;
  const traceDir = join(home, ".iknow", "projects", "entry-fixture");
  mkdirSync(traceDir, { recursive: true });
  process.env.IKNOW_TRACE_OUT = traceDir;
  if (opts.fsModeToken === undefined) delete process.env[FS_MODE_ENV_KEY];
  else process.env[FS_MODE_ENV_KEY] = opts.fsModeToken;

  // 2) settings: loadIknowEnv's sole model source = user-level settings.llm.model.
  mkdirSync(join(home, ".iknow"), { recursive: true });
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify(llmSettingsJson({ model: "test/stub-model" }))
  );

  // 3) PATH = bwrap shim dir + real PATH (bash / echo etc. remain reachable).
  const savedPath = process.env.PATH;
  process.env.PATH = `${opts.bwrapShimDir}:${savedPath ?? ""}`;
  // 4) sandbox root = live taskRoot shape (bash fence's taskRoot / cwd).
  writeFileSync(join(sandboxRoot, ".keep"), "");

  // 5) real stdin: one envelope line (worker protocol), read to EOF.
  const envelope = JSON.stringify({
    task,
    sandboxRoot,
    maxTurns: 3,
  });
  const stdinPath = join(
    scratch("iknow-fs-mode-entry-stdin-"),
    "envelope.jsonl"
  );
  writeFileSync(stdinPath, envelope + "\n");

  let exitCode = 0;
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
      if (!String(err).includes("__worker_exit_")) throw err;
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

  return { exitCode, stderr, stdout };
}

function roBindIndex(argv: readonly string[], root: string): number {
  return argv.findIndex(
    (arg, i) =>
      arg === "--ro-bind" && argv[i + 1] === root && argv[i + 2] === root
  );
}

function bindIndex(argv: readonly string[], root: string): number {
  return argv.findIndex(
    (arg, i) => arg === "--bind" && argv[i + 1] === root && argv[i + 2] === root
  );
}

function hasHostRootBind(argv: readonly string[]): boolean {
  return argv.some(
    (arg, i) => arg === "--bind" && argv[i + 1] === "/" && argv[i + 2] === "/"
  );
}

function shimFenceArgv(argvLog: string): readonly string[] {
  let raw = "";
  try {
    raw = readFileSync(argvLog, "utf8");
  } catch {
    return [];
  }
  const calls = raw
    .split("###ARGS###\n")
    .map((chunk) => chunk.split("\n").filter(Boolean))
    .filter((argv) => argv.length > 0);
  // Probe call = `bwrap --version` (argv[0] === "--version"); real fence calls start with `--unshare-user-try`.
  const fence = calls.find((argv) => argv[0] === "--unshare-user-try");
  return fence ?? [];
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

describe("runSubagentWorker（生产入口）— IKNOW_FS_MODE 决定 bash fence", () => {
  it("env=workspace → 真 worker 跑完，bwrap 收到 home ro-bind + taskRoot 写白名单", async () => {
    const home = scratch("iknow-fs-mode-entry-home-");
    const sandboxRoot = scratch("iknow-fs-mode-entry-task-");
    const argvLog = join(scratch("iknow-fs-mode-entry-log-"), "argv.txt");
    const bwrapShimDir = makeBwrapShimDir(argvLog);

    const result = await runWorkerEntry({
      fsModeToken: "workspace",
      argvLog,
      home,
      sandboxRoot,
      task: "run a harmless command",
      bwrapShimDir,
    });

    // First pin "the entry really reached the bash fence" — otherwise the argv assertions below are vacuous on an empty set.
    const argv = shimFenceArgv(argvLog);
    expect(
      argv.length,
      `exit=${result.exitCode} stdout=${result.stdout} stderr=${result.stderr}`
    ).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    // Home read-only visible + live taskRoot writable.
    expect(roBindIndex(argv, home)).toBeGreaterThan(-1);
    expect(bindIndex(argv, home)).toBe(-1);
    expect(bindIndex(argv, sandboxRoot)).toBeGreaterThan(-1);
    // Mount order is last-mount-wins: home ro-bind must precede the taskRoot writable bind.
    expect(roBindIndex(argv, home)).toBeLessThan(bindIndex(argv, sandboxRoot));
  }, 60_000);

  it("env 缺席 → 同一入口走全局档 fence（home ro-bind 不出现）", async () => {
    const home = scratch("iknow-fs-mode-entry-home-");
    const sandboxRoot = scratch("iknow-fs-mode-entry-task-");
    const argvLog = join(scratch("iknow-fs-mode-entry-log-"), "argv.txt");
    const bwrapShimDir = makeBwrapShimDir(argvLog);

    const result = await runWorkerEntry({
      argvLog,
      home,
      sandboxRoot,
      task: "run a harmless command",
      bwrapShimDir,
    });

    const argv = shimFenceArgv(argvLog);
    expect(argv.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    expect(hasHostRootBind(argv)).toBe(true);
    expect(roBindIndex(argv, home)).toBe(-1);
    expect(bindIndex(argv, sandboxRoot)).toBe(-1);
  }, 60_000);

  it("env=非法值 → fail-closed 到全局档（与缺席同形）", async () => {
    const home = scratch("iknow-fs-mode-entry-home-");
    const sandboxRoot = scratch("iknow-fs-mode-entry-task-");
    const argvLog = join(scratch("iknow-fs-mode-entry-log-"), "argv.txt");
    const bwrapShimDir = makeBwrapShimDir(argvLog);

    const result = await runWorkerEntry({
      fsModeToken: "workspace!",
      argvLog,
      home,
      sandboxRoot,
      task: "run a harmless command",
      bwrapShimDir,
    });

    const argv = shimFenceArgv(argvLog);
    expect(argv.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    expect(roBindIndex(argv, home)).toBe(-1);
    expect(bindIndex(argv, sandboxRoot)).toBe(-1);
  }, 60_000);
});
