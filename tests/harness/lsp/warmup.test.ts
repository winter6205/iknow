/**
 * warmup.ts unit tests — warmup success/failure must be observable.
 *
 * Pinned invariants: `getWarmupOutcome()` is the only readable snapshot of the
 * warmup settle — `undefined` before settle; `ok` requires genuinely pinned
 * samples; **any non-`ok` outcome has non-empty failures** (making the three
 * silent degradations visible: readdir fallback, no samples, spawn failure
 * normalized to undefined); `pinnedSamples` lists only servers with a live
 * client. Also pins fire-and-forget: `startLspWarmup` returns synchronously,
 * never awaiting spawn.
 *
 * Test strategy (mirrors client.test.ts / aci/lsp.test.ts): `vi.mock` stubs
 * `getClient` so real tsserver is never touched. Sample files are really
 * created in a temp dir (warmup scans the disk); `readdir` passes through to
 * the real implementation by default, failure cases inject a one-shot
 * rejection / sync throw. The module-level outcome snapshot is shared across
 * tests — each case does `vi.resetModules()` + dynamic import for a fresh
 * module instance, reads the snapshot only from that instance, and waits for
 * settle before asserting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── module-level mocks (vi.hoisted so the mock factories can reference them) ──

const { mockGetClient, mockEnsureOpen, mockReaddir } = vi.hoisted(() => ({
  mockGetClient: vi.fn(),
  mockEnsureOpen: vi.fn(),
  mockReaddir: vi.fn(),
}));

vi.mock("../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/harness/lsp/client.js")>();
  return {
    ...actual,
    getClient: (...args: unknown[]) => mockGetClient(...args),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Pass through to the real readdir by default; failure cases inject a
  // one-shot rejection / sync throw, hitting respectively the degraded catch
  // inside collectSampleFiles and warmup's outer catch.
  mockReaddir.mockImplementation((...args: unknown[]) =>
    (actual.readdir as (...a: unknown[]) => unknown)(...args)
  );
  return {
    ...actual,
    readdir: (...args: unknown[]) => mockReaddir(...args),
  };
});

type WarmupModule = typeof import("../../../src/harness/lsp/warmup.ts");

let warmup: WarmupModule;
/** stderr lines collected this run (written by the spy); cleared per case. */
const stderrLinesSeen: string[] = [];
/** Restore only the stderr spy (vi.restoreAllMocks would also tear down the module-level readdir passthrough). */
let restoreStderrWrite: (() => void) | undefined;
const tempDirs: string[] = [];

/** Fresh module instance: the module-level outcome snapshot must not leak across tests. */
async function freshWarmupModule(): Promise<WarmupModule> {
  vi.resetModules();
  return await import("../../../src/harness/lsp/warmup.ts");
}

/** Real temp dir: warmup scans actual disk state, so samples aren't mocked. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "lsp-warmup-"));
  tempDirs.push(dir);
  return dir;
}

/** Wait for this run's warmup to settle (fire-and-forget: poll the snapshot). */
async function settled(mod: WarmupModule) {
  await vi.waitFor(() => expect(mod.getWarmupOutcome()).toBeDefined(), {
    timeout: 5_000,
  });
  return mod.getWarmupOutcome();
}

/** This run's stderr lines (the human-readable trace must stay in place; the snapshot is incremental). */
function stderrLines(): string[] {
  return stderrLinesSeen;
}

beforeEach(async () => {
  mockGetClient.mockReset();
  mockEnsureOpen.mockReset();
  mockEnsureOpen.mockResolvedValue(undefined);
  mockGetClient.mockResolvedValue({ ensureOpen: mockEnsureOpen });
  mockReaddir.mockClear();
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrLinesSeen.push(String(chunk));
      return true;
    });
  restoreStderrWrite = () => stderrSpy.mockRestore();
  warmup = await freshWarmupModule();
});

afterEach(() => {
  restoreStderrWrite?.();
  restoreStderrWrite = undefined;
  stderrLinesSeen.length = 0;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

// ── 1. before settle: undefined ──────────────────────────────────────────────

describe("getWarmupOutcome before settle", () => {
  it("returns undefined when no warmup has settled", () => {
    expect(warmup.getWarmupOutcome()).toBeUndefined();
  });
});

// ── 2. ok: every matched server pins a real sample ───────────────────────────

describe("getWarmupOutcome ok", () => {
  it("records `ok` with the pinned real sample file", async () => {
    const dir = makeTempDir();
    const sample = join(dir, "a.ts");
    writeFileSync(sample, "export const a = 1;\n");

    warmup.startLspWarmup({ directory: dir });

    expect(await settled(warmup)).toEqual({
      status: "ok",
      pinnedSamples: [{ serverId: "typescript", file: sample }],
      failures: [],
    });
  });
});

// ── 3. partial: one server fails (spawn normalized to undefined / throws) ────

describe("getWarmupOutcome partial", () => {
  it("records `partial` and does not pin the server whose client is undefined", async () => {
    const dir = makeTempDir();
    const tsSample = join(dir, "a.ts");
    writeFileSync(tsSample, "export const a = 1;\n");
    writeFileSync(join(dir, "b.py"), "b = 1\n");
    // getClient contract: spawn failure normalizes to undefined (no throw).
    // This silent path must surface in the outcome — it is one of the
    // root-cause candidates for "warmup silently failed".
    mockGetClient.mockImplementation(async (_ctx: unknown, file: unknown) => {
      if (typeof file === "string" && file.endsWith(".py")) return undefined;
      return { ensureOpen: mockEnsureOpen };
    });

    warmup.startLspWarmup({ directory: dir });

    expect(await settled(warmup)).toEqual({
      status: "partial",
      pinnedSamples: [{ serverId: "typescript", file: tsSample }],
      failures: [expect.stringContaining("pyright")],
    });
    expect(stderrLines().some((l) => l.includes("[lsp-warmup] partial:"))).toBe(
      true
    );
  });

  it("records `partial` when getClient throws for one server", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "b.py"), "b = 1\n");
    mockGetClient.mockImplementation(async (_ctx: unknown, file: unknown) => {
      if (typeof file === "string" && file.endsWith(".py")) {
        throw new Error("spawn ENOENT");
      }
      return { ensureOpen: mockEnsureOpen };
    });

    warmup.startLspWarmup({ directory: dir });

    const outcome = await settled(warmup);
    expect(outcome?.status).toBe("partial");
    expect(outcome?.failures).toEqual([expect.stringContaining("pyright")]);
    expect(outcome?.failures[0]).toContain("spawn ENOENT");
  });
});

// ── 4. skipped: no samples / unreadable dir / total failure ──────────────────

describe("getWarmupOutcome skipped", () => {
  it("records `skipped` with a failure when no sample file matches", async () => {
    const dir = makeTempDir();

    warmup.startLspWarmup({ directory: dir });

    const outcome = await settled(warmup);
    expect(outcome?.status).toBe("skipped");
    expect(outcome?.pinnedSamples).toEqual([]);
    expect(outcome?.failures).not.toEqual([]);
  });

  it("records `skipped` with a failure when readdir rejects (degraded scan)", async () => {
    const dir = makeTempDir();
    mockReaddir.mockRejectedValueOnce(
      new Error("EACCES: permission denied, scandir")
    );

    warmup.startLspWarmup({ directory: dir });

    const outcome = await settled(warmup);
    expect(outcome?.status).toBe("skipped");
    expect(outcome?.pinnedSamples).toEqual([]);
    expect(outcome?.failures).toEqual([
      expect.stringContaining("readdir failed for"),
    ]);
    // The degraded path's stderr text is unchanged and writes no extra line:
    // only "readdir failed for".
    expect(
      stderrLines().some((l) => l.includes("[lsp-warmup] readdir failed for"))
    ).toBe(true);
    expect(stderrLines().some((l) => l.includes("[lsp-warmup] partial:"))).toBe(
      false
    );
  });

  it("records `skipped` when every matched server fails, keeping the stderr trace", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    mockGetClient.mockResolvedValue(undefined);

    warmup.startLspWarmup({ directory: dir });

    const outcome = await settled(warmup);
    expect(outcome?.status).toBe("skipped");
    expect(outcome?.pinnedSamples).toEqual([]);
    expect(outcome?.failures).toEqual([expect.stringContaining("typescript")]);
    expect(stderrLines().some((l) => l.includes("[lsp-warmup] partial:"))).toBe(
      true
    );
  });

  it("records `skipped` with a failure when readdir throws synchronously", async () => {
    const dir = makeTempDir();
    mockReaddir.mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied, scandir");
    });

    warmup.startLspWarmup({ directory: dir });

    const outcome = await settled(warmup);
    expect(outcome?.status).toBe("skipped");
    expect(outcome?.pinnedSamples).toEqual([]);
    expect(outcome?.failures).not.toEqual([]);
  });
});

// ── 5. fire-and-forget: returns synchronously, never awaits spawn ────────────

describe("startLspWarmup fire-and-forget", () => {
  it("returns synchronously without awaiting the client", () => {
    // Inject the scan result directly (no disk write): this case only cares
    // that the return precedes getClient settling; reading the real disk
    // would race the background scan against afterEach cleanup.
    mockReaddir.mockResolvedValueOnce([
      {
        name: "a.ts",
        isDirectory: () => false,
        isFile: () => true,
      } as unknown as import("node:fs").Dirent,
    ]);
    // spawn never settles: if startLspWarmup blocked on that await, the
    // synchronous return would be untestable.
    mockGetClient.mockReturnValue(new Promise(() => {}));

    expect(warmup.startLspWarmup({ directory: "/fake-root" })).toBeUndefined();
    expect(warmup.getWarmupOutcome()).toBeUndefined();
  });
});
