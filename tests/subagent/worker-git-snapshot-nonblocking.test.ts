/**
 * Worker boundary proof for the async git snapshot.
 *
 * Contract (this branch's plan): while the git snapshot is still incomplete
 * the SUBAGENT must be able to start, and the first use must get the complete
 * result. The provider-level half ("the factory does not block on the read")
 * is pinned in tests/harness/identity/git-snapshot.test.ts through the
 * injectable exec seam. This file pins the WORKER half: `createWorkerDeps`
 * must resolve while the git read is still in flight, and the first assembled
 * system prompt must carry the COMPLETE `## Git` block.
 *
 * Technique: the git read is held pending at the OS process boundary —
 * `node:child_process` is module-mocked, and ONLY the three argv sets the
 * snapshot capture uses are parked until the test releases them. Every other
 * invocation (e.g. the worktree gate's own `git` calls) is delegated to the
 * real `execFile`, so the code under test stays the real worker / provider /
 * assembly — nothing in src/ is mocked or stubbed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, ExecFileException } from "node:child_process";

import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { GIT_SEGMENT_TITLE } from "../../src/harness/identity/git-snapshot.ts";
import type { IknowEnv } from "../../src/config/env.ts";

// ---------------------------------------------------------------------------
// Process-boundary mock: park the snapshot's three git reads, delegate the rest
// ---------------------------------------------------------------------------

const gitMock = vi.hoisted(() => {
  /** The three argv sets the snapshot capture uses (src/harness/identity/git-snapshot.ts). */
  const STATUS_KEY = "--no-pager status --porcelain=v1 -b";
  const MAIN_BRANCH_KEY =
    "--no-pager symbolic-ref --short refs/remotes/origin/HEAD";
  const LOG_KEY = "--no-pager log --oneline -5";

  /** Synthetic stdout per snapshot command — the content the block must carry. */
  const OUTPUTS = new Map<string, string>([
    [STATUS_KEY, "## feature/nonblocking-branch\n M README.md\n"],
    [MAIN_BRANCH_KEY, "origin/main\n"],
    [LOG_KEY, "abc1234 nonblocking snapshot commit\n"],
  ]);

  type ExecCallback = (
    error: ExecFileException | null,
    stdout: string,
    stderr: string
  ) => void;

  interface ParkedCall {
    readonly key: string;
    readonly callback: ExecCallback;
  }

  const state = {
    realExecFile: undefined as unknown as (
      ...args: unknown[]
    ) => ChildProcess,
    requests: [] as string[],
    parked: [] as ParkedCall[],
    completed: [] as string[],
    released: false,
  };
  const waiters: Array<{ key: string; resolve: () => void }> = [];

  function recordRequest(key: string): void {
    state.requests.push(key);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter === undefined || waiter.key !== key) continue;
      waiters.splice(i, 1);
      waiter.resolve();
    }
  }

  /** Resolves once `key` has been requested (immediately if it already was). */
  function waitForRequest(key: string): Promise<void> {
    if (state.requests.includes(key)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      waiters.push({ key, resolve });
    });
  }

  /** A parked call owns no OS process; the snapshot capture ignores execFile's
   *  return value. */
  function parkedProcess(): ChildProcess {
    return new EventEmitter() as unknown as ChildProcess;
  }

  /**
   * The only interception point: `git` with one of the three snapshot argv
   * sets. Everything else (any other binary, any other git argv) goes to the
   * real execFile with the original arguments.
   */
  function execFile(file: string, ...rest: unknown[]): ChildProcess {
    const rawArgs = Array.isArray(rest[0]) ? rest[0] : [];
    const key = (rawArgs as readonly unknown[]).map(String).join(" ");
    const last = rest[rest.length - 1];
    const callback =
      typeof last === "function" ? (last as ExecCallback) : undefined;
    if (file === "git" && callback !== undefined && OUTPUTS.has(key)) {
      recordRequest(key);
      if (state.released) {
        state.completed.push(key);
        callback(null, OUTPUTS.get(key) ?? "", "");
      } else {
        state.parked.push({ key, callback });
      }
      return parkedProcess();
    }
    if (state.realExecFile === undefined) {
      throw new Error("child_process mock used before the real execFile was installed");
    }
    return state.realExecFile(file, ...rest);
  }

  /** Release every held read; the capture then runs to completion. */
  function release(): void {
    state.released = true;
    const pending = state.parked.splice(0, state.parked.length);
    for (const call of pending) {
      state.completed.push(call.key);
      call.callback(null, OUTPUTS.get(call.key) ?? "", "");
    }
  }

  function reset(): void {
    state.requests.length = 0;
    state.parked.length = 0;
    state.completed.length = 0;
    state.released = false;
    waiters.length = 0;
  }

  function setRealExecFile(fn: unknown): void {
    state.realExecFile = fn as (...args: unknown[]) => ChildProcess;
  }

  return {
    STATUS_KEY,
    MAIN_BRANCH_KEY,
    LOG_KEY,
    execFile,
    release,
    reset,
    setRealExecFile,
    waitForRequest,
    get requests(): string[] {
      return state.requests;
    },
    get parked(): ParkedCall[] {
      return state.parked;
    },
    get completed(): string[] {
      return state.completed;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  gitMock.setRealExecFile(actual.execFile);
  return { ...actual, execFile: gitMock.execFile };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_ENV = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off" as const,
    thinking: { type: "disabled" as const },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
} as unknown as IknowEnv;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-worker-git-snap-nonblocking-"));
  await mkdir(join(workDir, ".iknow"), { recursive: true });
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

function hermeticOpts(
  extra?: Partial<Parameters<typeof createWorkerDeps>[0]>
): Parameters<typeof createWorkerDeps>[0] {
  return {
    env: TEST_ENV,
    sandboxRoot: workDir,
    cwd: workDir,
    userHome: workDir,
    projectIdentityRoot: workDir,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    trace: createNoopTraceService(),
    ...extra,
  };
}

/**
 * Yields the event loop until `predicate` turns true, bounded by `turns`
 * event-loop turns (not wall clock): a worker that does not wait for the git
 * read settles within the first turn, a worker that waits never settles.
 */
async function waitUntil(
  predicate: () => boolean,
  turns = 20
): Promise<boolean> {
  for (let i = 0; i < turns; i += 1) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// The worker boundary
// ---------------------------------------------------------------------------

describe("worker — the git snapshot does not block subagent startup", () => {
  beforeEach(() => {
    gitMock.reset();
  });

  afterEach(() => {
    // Safety net: a held read is always released, so the pending capture
    // never stays unresolved and no promise is left dangling.
    gitMock.release();
  });

  it("resolves the worker deps while the git read is still in flight, then serves the complete ## Git block on first use", async () => {
    const depsPromise = createWorkerDeps(hermeticOpts());
    let depsSettled = false;
    void depsPromise.then(
      () => {
        depsSettled = true;
      },
      () => {
        depsSettled = true;
      }
    );

    // The worker starts the git read in the background: the snapshot's first
    // command is requested while the deps are still being assembled.
    await gitMock.waitForRequest(gitMock.STATUS_KEY);

    // The read was requested and is still held — it has not completed.
    const settledWhileReading = await waitUntil(() => depsSettled);
    expect(gitMock.requests).toContain(gitMock.STATUS_KEY);
    expect(gitMock.parked.map((call) => call.key)).toContain(
      gitMock.STATUS_KEY
    );
    expect(gitMock.completed).toEqual([]);

    // The worker did NOT wait for the read: the deps resolved anyway.
    expect(settledWhileReading).toBe(true);
    expect(depsSettled).toBe(true);

    // Release the held read → the capture completes with the full result.
    gitMock.release();
    const deps = await depsPromise;
    const system = await deps.system?.();
    expect(system).toBeDefined();
    expect(system).toContain(GIT_SEGMENT_TITLE);
    expect(system).toContain("main-branch: feature/nonblocking-branch");
    expect(system).toContain("pr-base: origin/main");
    expect(system).toContain("status:\n M README.md");
    expect(system).toContain("abc1234 nonblocking snapshot commit");
  });

  it("delegates git calls outside the three snapshot argv sets to the real execFile", async () => {
    const childProcess = await import("node:child_process");
    // A parked call would never call back before the test releases it, so the
    // resolution of this promise is itself the proof that the call was
    // delegated to the real execFile.
    const outcome = await new Promise<{ error: unknown; stdout: string }>(
      (resolve) => {
        childProcess.execFile(
          "git",
          ["--version"],
          { cwd: workDir, encoding: "utf8" },
          (error, stdout) => {
            resolve({ error, stdout });
          }
        );
      }
    );
    expect(gitMock.requests).toEqual([]);
    expect(gitMock.parked).toEqual([]);
    if (outcome.error === null) {
      expect(outcome.stdout.length).toBeGreaterThan(0);
    } else {
      expect(outcome.error).toBeInstanceOf(Error);
    }
  });
});
