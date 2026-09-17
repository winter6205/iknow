/**
 * warmup.ts 单测 — plans/lsp-silent-degradation.md T1（warmup 成败可观测）。
 *
 * 钉住的不变式：`getWarmupOutcome()` 是 warmup settle 的唯一可读快照 ——
 * settle 前 `undefined`；`ok` 必须有真实 pin 住的样本；**任何非 `ok` 结局
 * failures 必非空**（readdir 降级 / 无样本 / spawn 失败归一 undefined 三种
 * 静默退化都在此显形）；`pinnedSamples` 只列真的拿到活 client 的 server。
 * 另钉 fire-and-forget：`startLspWarmup` 同步返回，不等 spawn。
 *
 * 测试策略（对齐 client.test.ts / aci/lsp.test.ts）：`vi.mock` stub `getClient`
 * 避免触碰真实 tsserver。样本文件真建在临时目录（warmup 扫描的是磁盘）；
 * `readdir` 默认透传真实实现，失败态用例注入一次性 rejection / sync throw。
 * 模块级 outcome 快照跨测试共享 —— 每例 `vi.resetModules()` + 动态 import 取
 * 全新模块实例，读快照一律用该实例，等 settle 后再断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 模块级 mock（vi.hoisted 保证 mock 工厂能引用这些） ────────────────────────

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
  // 缺省透传真实 readdir；失败态用例注入一次性 rejection / sync throw，
  // 分别命中 collectSampleFiles 内的降级 catch 与 warmup 的外层 catch。
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
/** 本轮收集到的 stderr 行（spy 写入）；每例清空。 */
const stderrLinesSeen: string[] = [];
/** 只还原 stderr spy（别用 vi.restoreAllMocks：会连带拆掉模块级 readdir 透传）。 */
let restoreStderrWrite: (() => void) | undefined;
const tempDirs: string[] = [];

/** 全新模块实例：模块级 outcome 快照不跨测试泄漏。 */
async function freshWarmupModule(): Promise<WarmupModule> {
  vi.resetModules();
  return await import("../../../src/harness/lsp/warmup.ts");
}

/** 真临时目录：warmup 扫描的是磁盘现状，样本文件不用 mock 造。 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "lsp-warmup-"));
  tempDirs.push(dir);
  return dir;
}

/** 等本轮 warmup settle（fire-and-forget，只能轮询快照）。 */
async function settled(mod: WarmupModule) {
  await vi.waitFor(() => expect(mod.getWarmupOutcome()).toBeDefined(), {
    timeout: 5_000,
  });
  return mod.getWarmupOutcome();
}

/** 本轮 stderr 行（人读的 trace 必须留在原地；快照是增量）。 */
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

// ── 1. settle 前：undefined ───────────────────────────────────────────────────

describe("getWarmupOutcome before settle", () => {
  it("returns undefined when no warmup has settled", () => {
    expect(warmup.getWarmupOutcome()).toBeUndefined();
  });
});

// ── 2. ok：所有命中 server 都 pin 住样本 ──────────────────────────────────────

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

// ── 3. partial：单个 server 失败（spawn 归一 undefined / throw） ──────────────

describe("getWarmupOutcome partial", () => {
  it("records `partial` and does not pin the server whose client is undefined", async () => {
    const dir = makeTempDir();
    const tsSample = join(dir, "a.ts");
    writeFileSync(tsSample, "export const a = 1;\n");
    writeFileSync(join(dir, "b.py"), "b = 1\n");
    // getClient 契约：spawn 失败归一为 undefined（不抛）。这条静默路径必须
    // 在 outcome 里显形 —— 正是「warmup 静默失败」的根因候选之一。
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

// ── 4. skipped：无样本 / 目录不可读 / 整体失败 ────────────────────────────────

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
    // 降级路径的 stderr 原文不变，且不额外多写一行：只有 readdir failed for。
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

// ── 5. fire-and-forget：同步返回，不等 spawn ────────────────────────────────

describe("startLspWarmup fire-and-forget", () => {
  it("returns synchronously without awaiting the client", () => {
    // 扫描结果直接注入（不落盘）：本用例只关心「返回早于 getClient settle」，
    // 真读盘会让后台扫描与 afterEach 的清理赛跑。
    mockReaddir.mockResolvedValueOnce([
      {
        name: "a.ts",
        isDirectory: () => false,
        isFile: () => true,
      } as unknown as import("node:fs").Dirent,
    ]);
    // spawn 永不 settle：若 startLspWarmup 阻塞在该 await 上就测不出返回。
    mockGetClient.mockReturnValue(new Promise(() => {}));

    expect(warmup.startLspWarmup({ directory: "/fake-root" })).toBeUndefined();
    expect(warmup.getWarmupOutcome()).toBeUndefined();
  });
});
