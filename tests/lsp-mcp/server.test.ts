import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createLspMcpServer } from "../../src/lsp-mcp/server.ts";
import { SYMBOL_QUERY_TOOL_NAMES } from "../../src/harness/aci/tools/symbol.ts";

const { mockGetClientDetailed } = vi.hoisted(() => ({
  mockGetClientDetailed: vi.fn(),
}));

vi.mock("../../src/harness/lsp/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/harness/lsp/client.js")>();
  return {
    ...actual,
    getClientDetailed: (...args: unknown[]) => mockGetClientDetailed(...args),
  };
});

const scratch: string[] = [];

afterEach(() => {
  mockGetClientDetailed.mockReset();
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 工具面与 `src/harness/aci/tools/symbol.ts` 的 `SYMBOL_QUERY_TOOL_NAMES`
// 一一对齐（spec `symbol-primary-aci` Assumption 12 + T6 acceptance）：
// MCP `tools/list` 返回 10 件符号查询名，与 ACI 查询面同构（无 lsp_*）。
// 直接 import SSOT —— 不再内联复刻名单，避免 drift。

async function connectServer(directory: string): Promise<{
  readonly client: Client;
  readonly close: () => Promise<void>;
}> {
  const { server, close } = createLspMcpServer({
    directory,
    warmup: false,
  });
  const client = new Client({ name: "lsp-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await close();
    },
  };
}

describe("lsp MCP server (SDK 2.0)", () => {
  it("registers the 10 read-only symbol-query tools (no lsp_*)", async () => {
    const directory = mkdtempSync(join(tmpdir(), "iknow-lsp-mcp-list-"));
    scratch.push(directory);
    const connected = await connectServer(directory);
    try {
      const result = await connected.client.listTools();
      expect(result.tools.map((t) => t.name)).toEqual([
        ...SYMBOL_QUERY_TOOL_NAMES,
      ]);
      expect(
        result.tools.every((t) => t.annotations?.readOnlyHint === true)
      ).toBe(true);
    } finally {
      await connected.close();
    }
  });

  it("returns a B3 sentinel string for hover when no language server matches", async () => {
    mockGetClientDetailed.mockResolvedValue({
      failure: { reason: "no-server" },
    });
    const directory = mkdtempSync(join(tmpdir(), "iknow-lsp-mcp-hover-"));
    scratch.push(directory);
    mkdirSync(join(directory, "src"), { recursive: true });
    const connected = await connectServer(directory);
    try {
      const result = await connected.client.callTool({
        name: "get_hover",
        arguments: {
          file: join(directory, "src", "a.ts"),
          symbol_path: "Class/method",
        },
      });
      const text = result.content[0];
      expect(text?.type).toBe("text");
      if (text?.type !== "text") throw new Error("expected text");
      expect(text.text).toMatch(/no LSP server configured/);
      expect(result.isError).not.toBe(true);
    } finally {
      await connected.close();
    }
  });

  it("returns isError for invalid tool arguments without dropping the session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "iknow-lsp-mcp-err-"));
    scratch.push(directory);
    const connected = await connectServer(directory);
    try {
      // 缺 query → schema 拒绝（find_symbol 必填 query）；session 不掉。
      const invalid = await connected.client.callTool({
        name: "find_symbol",
        arguments: {},
      });
      mockGetClientDetailed.mockResolvedValue({
        failure: { reason: "no-server" },
      });
      // 合法 find_symbol（query 非空 + 可选 file 锚定）→ 不应报错。
      const valid = await connected.client.callTool({
        name: "find_symbol",
        arguments: {
          query: "Foo",
          file: join(directory, "src", "a.ts"),
        },
      });
      expect(invalid.isError).toBe(true);
      expect(valid.isError).not.toBe(true);
    } finally {
      await connected.close();
    }
  });

  it("documents config in README and does not register iknow-lsp in repo mcp.json", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme).toMatch(/iknow-lsp-mcp/);
    expect(readme).toMatch(/--root/);
    const mcp = JSON.parse(
      readFileSync(join(repoRoot, ".iknow", "mcp.json"), "utf8")
    ) as { mcpServers?: Record<string, unknown> };
    expect(mcp.mcpServers?.["iknow-lsp"]).toBeUndefined();
  });
});
