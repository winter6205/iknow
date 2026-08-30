/**
 * warmup.ts 单测 — lsp-optimization plan T4（含 review 修复：不早退，遍历
 * 所有扩展名命中的 server 逐个预热）。
 *
 * 覆盖：
 *   1. 混合语言项目（.ts + .py）→ Typescript 与 Pyright **都**被 getClient
 *      预热（旧实现「成功即止」只预热排位靠前的 Typescript）。
 *   2. 单个 server 预热失败（undefined / reject）→ 继续下一个，不中断。
 *   3. 失败统一 stderr 留痕（S3 禁空 catch）。
 *   4. 无候选样本 → 不调 getClient，静默放弃。
 *
 * Mock 策略：模块级 `vi.mock` stub `getClient`（对齐 notifier.test.ts 手法），
 * 不触真实 server spawn。
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetClient } = vi.hoisted(() => ({
  mockGetClient: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/harness/lsp/client.js")>();
  return {
    ...actual,
    getClient: (...args: unknown[]) => mockGetClient(...args),
  };
});

import { startLspWarmup } from "../../../src/harness/lsp/warmup.ts";
import { Pyright, Typescript } from "../../../src/harness/lsp/server.ts";
import type { LspServerInfo } from "../../../src/harness/lsp/types.ts";

const ctx = { directory: "/work" };

/** 读走 microtask/timer，让 fire-and-forget 的 warmup 完成一轮。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

/** 建混合语言 fixture：dir 下一个 .ts 与一个 .py 文件。 */
function makeMixedProject(): { dir: string; tsFile: string; pyFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-warmup-"));
  const tsFile = join(dir, "a.ts");
  const pyFile = join(dir, "b.py");
  writeFileSync(tsFile, "export const a = 1;\n", "utf8");
  writeFileSync(pyFile, "x = 1\n", "utf8");
  return { dir, tsFile, pyFile };
}

function callsForServer(id: string): Array<unknown[]> {
  return mockGetClient.mock.calls.filter(
    (c) => (c[2] as { server: LspServerInfo } | undefined)?.server.id === id
  );
}

beforeEach(() => {
  mockGetClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startLspWarmup (plan T4)", () => {
  it("warms up every server whose extensions hit a sample (mixed ts+py project)", async () => {
    const { dir, tsFile, pyFile } = makeMixedProject();
    try {
      const ensureOpen = vi.fn(async (_file: string) => undefined);
      mockGetClient.mockResolvedValue({ connection: {}, process: {}, ensureOpen });
      startLspWarmup({ directory: dir });
      await vi.waitFor(() => expect(mockGetClient).toHaveBeenCalledTimes(2));

      // Typescript 命中 .ts 样本、Pyright 命中 .py 样本，各自恰好一次。
      const tsCalls = callsForServer(Typescript.id);
      const pyCalls = callsForServer(Pyright.id);
      expect(tsCalls).toHaveLength(1);
      expect(pyCalls).toHaveLength(1);
      expect(tsCalls[0]![1]).toBe(tsFile);
      expect(pyCalls[0]![1]).toBe(pyFile);
      // 二期 B4：getClient 成功后对样本 ensureOpen（预热 project 加载）。
      await vi.waitFor(() => expect(ensureOpen).toHaveBeenCalledTimes(2));
      expect(ensureOpen).toHaveBeenCalledWith(tsFile);
      expect(ensureOpen).toHaveBeenCalledWith(pyFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues to the next server when one warms up to undefined", async () => {
    const { dir } = makeMixedProject();
    try {
      // 全部返回 undefined（server 不可用）→ 不中断，两个 server 都被尝试。
      mockGetClient.mockResolvedValue(undefined);
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      startLspWarmup({ directory: dir });
      await vi.waitFor(() => expect(mockGetClient).toHaveBeenCalledTimes(2));
      expect(callsForServer(Typescript.id)).toHaveLength(1);
      expect(callsForServer(Pyright.id)).toHaveLength(1);
      expect(stderrSpy).not.toHaveBeenCalled(); // undefined 不算 throw，无留痕
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues to the next server when one throws, and traces the failure", async () => {
    const { dir } = makeMixedProject();
    try {
      // 首个（Typescript）reject → 继续 Pyright；失败 stderr 留痕一行。
      mockGetClient.mockRejectedValue(new Error("spawn boom"));
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      startLspWarmup({ directory: dir });
      await vi.waitFor(() => expect(mockGetClient).toHaveBeenCalledTimes(2));
      expect(callsForServer(Pyright.id)).toHaveLength(1);
      const lines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("[lsp-warmup] partial:"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("typescript: spawn boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues to the next server when ensureOpen throws (phase2 B4)", async () => {
    const { dir } = makeMixedProject();
    try {
      // Typescript 的 ensureOpen 抛错 → 只留痕一行并继续 Pyright。
      mockGetClient.mockImplementation(async (_ctx: unknown, _file: string, opts?: { server?: { id: string } }) => {
        if (opts?.server?.id === Typescript.id) {
          return { ensureOpen: async () => { throw new Error("open boom"); } };
        }
        return { ensureOpen: async () => undefined };
      });
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      startLspWarmup({ directory: dir });
      await vi.waitFor(() => expect(mockGetClient).toHaveBeenCalledTimes(2));
      expect(callsForServer(Pyright.id)).toHaveLength(1);
      const lines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((st) => st.includes("[lsp-warmup] partial:"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("typescript: open boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives up silently when no sample file matches any server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-warmup-empty-"));
    writeFileSync(join(dir, "readme.txt"), "hello\n", "utf8");
    try {
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      startLspWarmup({ directory: dir });
      await settle();
      expect(mockGetClient).not.toHaveBeenCalled();
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips node_modules and hidden directories when collecting samples", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iknow-lsp-warmup-skip-"));
    // 只有被跳过目录里有 .ts 样本 → 视为无候选，不预热。
    const nm = join(dir, "node_modules", "pkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "index.ts"), "export {};\n", "utf8");
    try {
      startLspWarmup({ directory: dir });
      await settle();
      expect(mockGetClient).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
