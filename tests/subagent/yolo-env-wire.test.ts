/**
 * ADR-0119 / specs/yolo-mode.md — the env wire on the subagent-worker route
 * (route 4 of four).
 *
 * Invariants pinned here (Contract §4, ADR-0119 §wire hygiene): the
 * parent-side env block in spawn.ts **normalizes** `IKNOW_YOLO` — holder wired →
 * `"1"` / `"0"` both written; holder absent → the key stays absent — and an
 * inherited ambient `IKNOW_YOLO` is always scrubbed from the child env (a stray
 * host value can never retire the worker's fence under a non-yolo parent,
 * fail-closed). -> the child side reads it back via `yoloOptionFromEnv`
 * (`parseYoloFlag` is fail-closed: a holder is produced only on a true hit,
 * otherwise the key is absent) -> handing that holder to the bash factory
 * yields a bare fence argv. **Both ends are asserted**, not just one hop.
 *
 * Technique: intercept node:child_process to capture the parent-side spawn env;
 * a runner.ts stand-in captures the real fence argv the child-side bash factory
 * passes to runInSandbox (bwrap is never actually spawned).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});
vi.mock("../../src/harness/sandbox/runner.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/sandbox/runner.ts")
    >();
  return {
    ...actual,
    requireBwrap: vi.fn(),
    runInSandbox: vi.fn(),
  };
});

const childProcessMock = await import("node:child_process");
const spawnMock = childProcessMock.spawn as unknown as ReturnType<typeof vi.fn>;
import * as sandboxRunner from "../../src/harness/sandbox/runner.ts";
import { createDefaultSubAgentSpawn } from "../../src/harness/subagent/spawn.ts";
import {
  yoloOptionFromEnv,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import {
  YOLO_ENV_KEY,
  createYoloContext,
} from "../../src/harness/sandbox/yolo.ts";
import { createBashTool } from "../../src/harness/aci/tools/bash.ts";

const FIX_CWD = mkdtempSync(join(tmpdir(), "yolo-env-wire-cwd-"));
const FIX_TMP = mkdtempSync(join(tmpdir(), "yolo-env-wire-tmp-"));

afterAll(() => {
  rmSync(FIX_CWD, { recursive: true, force: true });
  rmSync(FIX_TMP, { recursive: true, force: true });
});

function makeFakeChild(pid = 97001): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as ChildProcess;
}

/** Parent side: drive createDefaultSubAgentSpawn's spawn closure and capture the child env. */
function parentSpawnEnv(opts: {
  readonly yolo?: CreateWorkerDepsOptions["yolo"];
}): Record<string, string | undefined> {
  spawnMock.mockImplementation(() => makeFakeChild());
  const spawnFn = createDefaultSubAgentSpawn({
    traceDir: join(FIX_TMP, "trace"),
    ...(opts.yolo !== undefined ? { yolo: opts.yolo } : {}),
  });
  spawnFn(
    { name: "test", prompt: "p" } as never,
    "task-yolo-wire",
    "" as never
  );
  const call = spawnMock.mock.calls[0];
  expect(call).toBeDefined();
  const env = call?.[2]?.env as Record<string, string | undefined>;
  expect(env).toBeDefined();
  spawnMock.mockClear();
  return env;
}

/** Child side: feed the holder read back from the env wire into the bash factory and capture runInSandbox's fence. */
async function childFenceArgv(
  env: Record<string, string | undefined>
): Promise<readonly string[]> {
  const tool = createBashTool(FIX_CWD, {
    tmpDir: FIX_TMP,
    ...yoloOptionFromEnv(env),
  });
  await tool.handler(
    { command: "echo hi" },
    { conversationId: "yolo-env-wire" }
  );
  const calls = vi.mocked(sandboxRunner.runInSandbox).mock.calls;
  expect(calls).toHaveLength(1);
  const argv = [...calls[0]![0]!.fence.argv];
  vi.mocked(sandboxRunner.runInSandbox).mockClear();
  return argv;
}

beforeEach(() => {
  vi.mocked(sandboxRunner.requireBwrap).mockReset();
  vi.mocked(sandboxRunner.runInSandbox)
    .mockReset()
    .mockResolvedValue({ exitCode: 0, stdout: "hi\n", stderr: "" });
});

afterEach(() => {
  spawnMock.mockReset();
  vi.clearAllMocks();
});

describe("subagent worker route — both ends of the yolo env wire (ADR-0119)", () => {
  it("parent side: holder wired normalizes the key — true -> '1', false -> '0'; holder absent -> key not written", () => {
    const on = parentSpawnEnv({ yolo: createYoloContext(true) });
    expect(on[YOLO_ENV_KEY]).toBe("1");
    const off = parentSpawnEnv({ yolo: createYoloContext(false) });
    expect(off[YOLO_ENV_KEY]).toBe("0");
    const absent = parentSpawnEnv({});
    expect(YOLO_ENV_KEY in absent).toBe(false);
  });

  it("parent side: an inherited ambient IKNOW_YOLO is scrubbed — only this parent's holder decides the wire (ADR-0119 fail-closed)", () => {
    const previous = process.env[YOLO_ENV_KEY];
    process.env[YOLO_ENV_KEY] = "1";
    try {
      // Non-yolo parents must not launder the ambient value into the child.
      const absent = parentSpawnEnv({});
      expect(YOLO_ENV_KEY in absent).toBe(false);
      const off = parentSpawnEnv({ yolo: createYoloContext(false) });
      expect(off[YOLO_ENV_KEY]).toBe("0");
      // A true holder still wins.
      const on = parentSpawnEnv({ yolo: createYoloContext(true) });
      expect(on[YOLO_ENV_KEY]).toBe("1");
    } finally {
      if (previous === undefined) {
        delete process.env[YOLO_ENV_KEY];
      } else {
        process.env[YOLO_ENV_KEY] = previous;
      }
    }
  });

  it("child side: yoloOptionFromEnv reads '1' back -> holder true; absent / invalid value -> key absent (fail-closed)", () => {
    expect(yoloOptionFromEnv({ [YOLO_ENV_KEY]: "1" }).yolo?.get()).toBe(true);
    expect(yoloOptionFromEnv({ [YOLO_ENV_KEY]: "TRUE" }).yolo?.get()).toBe(
      true
    );
    expect("yolo" in yoloOptionFromEnv({})).toBe(false);
    expect("yolo" in yoloOptionFromEnv({ [YOLO_ENV_KEY]: "garbage" })).toBe(
      false
    );
    expect("yolo" in yoloOptionFromEnv({ [YOLO_ENV_KEY]: "0" })).toBe(false);
  });

  it("end to end: parent writes '1' -> child reads the holder back -> the bash factory fence is bare (argv[0] = bash)", async () => {
    const env = parentSpawnEnv({ yolo: createYoloContext(true) });
    expect(env[YOLO_ENV_KEY]).toBe("1");
    const argv = await childFenceArgv(env);
    expect(argv).toEqual(["bash", "-c", "echo hi"]);
  });

  it("control: env without the key goes through the same child-side chain -> the fence is still the bwrap baseline (fail-closed)", async () => {
    const argv = await childFenceArgv({});
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("--unshare-net");
  });

  it("end-to-end scrub: ambient IKNOW_YOLO=1 + holder false -> child env carries '0' -> the fence is still the bwrap baseline", async () => {
    const previous = process.env[YOLO_ENV_KEY];
    process.env[YOLO_ENV_KEY] = "1";
    try {
      const env = parentSpawnEnv({ yolo: createYoloContext(false) });
      expect(env[YOLO_ENV_KEY]).toBe("0");
      const argv = await childFenceArgv(env);
      expect(argv[0]).toBe("bwrap");
      expect(argv).toContain("--unshare-net");
    } finally {
      if (previous === undefined) {
        delete process.env[YOLO_ENV_KEY];
      } else {
        process.env[YOLO_ENV_KEY] = previous;
      }
    }
  });
});
