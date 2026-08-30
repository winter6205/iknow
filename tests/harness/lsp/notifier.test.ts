/**
 * notifier.ts 单测 — lsp-optimization plan T2。
 *
 * 覆盖（plan T2 + 降级契约）：
 *   1. invalidate → client.notifyChange(file)（标准 didChange 同步，
 *      取代旧的非标准 `workspace/xrefs` —— 断言迁移至此，见 client.ts
 *      notifyChange 测试的 version 递增细节）。
 *   2. fire-and-forget：invalidate 同步返回 void，发送在后台完成。
 *   3. 降级：无 client / notifyChange reject 都不抛回调用方，仅 stderr 留痕。
 *
 * Mock 策略：模块级 `vi.mock` stub `getClient`（对齐 aci/lsp.test.ts 手法）。
 */
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

import { createLspNotifier } from "../../../src/harness/lsp/notifier.ts";

const ctx = { directory: "/work" };

/** 读走一个 microtask，让 invalidate 内部的 void promise 完成执行。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mockGetClient.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLspNotifier (plan T2)", () => {
  it("invalidate forwards the file to client.notifyChange (standard didChange path)", async () => {
    const notifyChange = vi.fn(async (_file: string) => undefined);
    mockGetClient.mockResolvedValue({ notifyChange });
    const { invalidate } = createLspNotifier(ctx);

    invalidate("/work/src/a.ts");
    await flush();

    expect(mockGetClient).toHaveBeenCalledWith(ctx, "/work/src/a.ts");
    expect(notifyChange).toHaveBeenCalledWith("/work/src/a.ts");
  });

  it("invalidate returns void synchronously (fire-and-forget)", async () => {
    let resolveChange: () => void = () => undefined;
    mockGetClient.mockResolvedValue({
      notifyChange: () =>
        new Promise<void>((resolve) => {
          resolveChange = resolve;
        }),
    });
    const { invalidate } = createLspNotifier(ctx);

    let returned = false;
    const ret = invalidate("/work/src/a.ts");
    returned = true; // invalidate 同步返回（未等待后台发送）
    expect(ret).toBeUndefined();
    expect(returned).toBe(true);
    resolveChange();
    await flush();
  });

  it("no client for file → silent skip, no throw", async () => {
    mockGetClient.mockResolvedValue(undefined);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { invalidate } = createLspNotifier(ctx);

    expect(() => invalidate("/work/none.xyz")).not.toThrow();
    await flush();

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("notifyChange rejection is swallowed with a stderr trace (best-effort)", async () => {
    mockGetClient.mockResolvedValue({
      notifyChange: async () => {
        throw new Error("read ENOENT");
      },
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { invalidate } = createLspNotifier(ctx);

    expect(() => invalidate("/work/src/gone.ts")).not.toThrow();
    await flush();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[lsp-notifier] invalidate failed for /work/src/gone.ts: read ENOENT")
    );
  });
});
