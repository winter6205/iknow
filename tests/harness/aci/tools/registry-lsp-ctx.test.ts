/**
 * createDefaultAciRegistry 必须把完整 LspCtx 交给 createLspToolSet。
 *
 * 复现：build-engine 组了 settings.lsp（disabledServers 等），registry
 * 仍只传 `{ directory }` → 工具路径上的 B7 配置不生效。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetClientDetailed } = vi.hoisted(() => ({
  mockGetClientDetailed: vi.fn(),
}));

vi.mock("../../../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/harness/lsp/client.js")
    >();
  return {
    ...actual,
    getClientDetailed: (...args: unknown[]) => mockGetClientDetailed(...args),
  };
});

import { createDefaultAciRegistry } from "../../../../src/harness/aci/tools/registry.ts";
import type { IknowEnv } from "../../../../src/config/env.ts";

function makeWebEnv(): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined } };
}

describe("createDefaultAciRegistry lspCtx threading (B7 closeout)", () => {
  beforeEach(() => {
    mockGetClientDetailed.mockReset();
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "no-server", serverId: "typescript" },
    });
  });

  it("passes disabledServers from lspCtx into getClientDetailed (not directory-only)", async () => {
    const lspCtx = {
      directory: "/work",
      disabledServers: ["typescript"] as const,
      requestTimeoutMs: 5_000,
    };
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/other-root",
      lspCtx,
    });
    const def = reg.inner.get("lsp_hover");
    expect(def).toBeDefined();
    await def!.handler({
      file: "/work/src/a.ts",
      line: 1,
      character: 0,
    });
    expect(mockGetClientDetailed).toHaveBeenCalled();
    const passedCtx = mockGetClientDetailed.mock.calls[0]?.[0] as {
      directory: string;
      disabledServers?: readonly string[];
      requestTimeoutMs?: number;
    };
    expect(passedCtx.directory).toBe("/work");
    expect(passedCtx.disabledServers).toEqual(["typescript"]);
    expect(passedCtx.requestTimeoutMs).toBe(5_000);
  });

  it("falls back to { directory: sandboxRoot } when lspCtx is omitted", async () => {
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/tmp/root",
    });
    await reg.inner.get("lsp_hover")!.handler({
      file: "/tmp/root/a.ts",
      line: 1,
      character: 0,
    });
    expect(mockGetClientDetailed.mock.calls[0]?.[0]).toEqual({
      directory: "/tmp/root",
    });
  });
});
