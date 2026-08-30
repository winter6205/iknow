/**
 * symbol-primary-aci T5 后：createDefaultAciRegistry 必须把完整 LspCtx
 * 透给符号面工具工厂（symbol.ts / symbol-resolver.ts），吃下 settings.lsp
 * 的 disabledServers / requestTimeoutMs / directory。spec symbol-primary-aci
 * B7 语义扩展到符号面（坐标 lsp_* 已退役，lsp.ts 实现作 SSOT 不变）。
 *
 * 复现：build-engine 组了 settings.lsp（disabledServers 等），registry 仍
 * 只传 `{ directory }` → 工具路径上的 B7 配置不生效。测试用符号面工具
 * `find_declaration` / `find_symbol`（lsp_hover 已退役），符号工具共享
 * 一份 lspCtx（T2+T4 构造期已确认）。
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

  it("passes disabledServers from lspCtx into symbol tools (find_declaration) (not directory-only)", async () => {
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
    const def = reg.inner.get("find_declaration");
    expect(def).toBeDefined();
    await def!.handler({ file: "/work/src/a.ts", symbol_path: "Class/m" });
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
    await reg.inner.get("find_declaration")!.handler({
      file: "/tmp/root/a.ts",
      symbol_path: "Class/m",
    });
    expect(mockGetClientDetailed.mock.calls[0]?.[0]).toEqual({
      directory: "/tmp/root",
    });
  });

  // symbol-primary-aci T5：坐标 lsp_* 已退役；符号面工具仍继承 B7 语义。
  it("find_symbol also forwards disabledServers (B7 closeout extension)", async () => {
    const lspCtx = {
      directory: "/work",
      disabledServers: ["typescript"] as const,
      requestTimeoutMs: 7_000,
    };
    const reg = createDefaultAciRegistry({
      env: makeWebEnv(),
      sandboxRoot: "/other-root",
      lspCtx,
    });
    const def = reg.inner.get("find_symbol");
    expect(def).toBeDefined();
    await def!.handler({ query: "Foo" });
    expect(mockGetClientDetailed).toHaveBeenCalled();
    const passedCtx = mockGetClientDetailed.mock.calls.at(-1)?.[0] as {
      directory: string;
      disabledServers?: readonly string[];
      requestTimeoutMs?: number;
    };
    expect(passedCtx.directory).toBe("/work");
    expect(passedCtx.disabledServers).toEqual(["typescript"]);
    expect(passedCtx.requestTimeoutMs).toBe(7_000);
  });
});
