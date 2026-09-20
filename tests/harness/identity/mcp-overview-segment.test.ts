// Assembly-layer unit tests for the `<mcp_name_directory>` segment (the
// persistent index tier of progressive disclosure).
//
// Pinned contract:
//   - One line per connected service: name, or "name: <service description>"
//     (description absent → bare name).
//   - One line per tool: `- <name>` or `- <name>: <short desc>` (first line +
//     120-char cap + trailing … when over).
//   - Description absent (tool or service) → render the bare name (a
//     contract-legal state).
//   - failed / pending / disabled services are not rendered; if everything is
//     filtered out → the whole segment is absent (undefined).
//   - The guidance last line is "Call a listed tool directly to load its
//     schema and use it." (with descriptions present, calling tools directly
//     suffices; no forced "Use tool_search ...").
//   - Additive segment: does not touch IKNOW_ASSEMBLY_ORDER, which is locked
//     at 6 segments.
//   - Byte stability: service / tool names alphabetical; adjacent-turn
//     snapshots deep-equal.

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IKNOW_ASSEMBLY_ORDER,
  MCP_TOOL_SHORT_DESCRIPTION_MAX,
  assembleIdentityContext,
  createIknowSystemResolver,
  mcpNameDirectorySegment,
  shortToolDescription,
  type AssemblyContext,
  type McpServiceSummary,
  type McpToolSummary,
} from "../../../src/harness/identity/assemble.ts";

let workDir: string;

async function makeWorkDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iknow-mcp-dir-"));
  await mkdir(join(dir, ".iknow"), { recursive: true });
  return dir;
}

function baseCtx(): AssemblyContext {
  return {
    cwd: process.cwd(),
    projectIdentityRoot: process.cwd(),
    userHome: workDir,
    bootstrapActive: false,
    memoryEnabled: false,
  };
}

function tool(name: string, description?: string): McpToolSummary {
  return description === undefined ? { name } : { name, description };
}

function svc(
  name: string,
  overrides: Partial<McpServiceSummary> = {}
): McpServiceSummary {
  return {
    name,
    state: "connected",
    tools: [],
    ...overrides,
  };
}

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("shortToolDescription（短描述工具函数）", () => {
  it("undefined / 空字符串 → undefined", () => {
    expect(shortToolDescription(undefined)).toBeUndefined();
    expect(shortToolDescription("")).toBeUndefined();
  });

  it("首行为空白 → undefined（视为缺席）", () => {
    expect(shortToolDescription("   \nReal second line")).toBeUndefined();
    expect(shortToolDescription("\nReal second line")).toBeUndefined();
  });

  it("首行 ≤ 120 字 → 原样返回（trim 后）", () => {
    expect(shortToolDescription("  hello world  ")).toBe("hello world");
  });

  it("首行 > 120 字 → 截到 120 + 单字符省略号", () => {
    const long = "a".repeat(MCP_TOOL_SHORT_DESCRIPTION_MAX + 30);
    const out = shortToolDescription(long);
    expect(out).toBeDefined();
    expect(out!.length).toBe(MCP_TOOL_SHORT_DESCRIPTION_MAX + 1);
    expect(out!.endsWith("…")).toBe(true);
    expect(out!.startsWith("a".repeat(MCP_TOOL_SHORT_DESCRIPTION_MAX))).toBe(
      true
    );
  });

  it("只取首行（多行 description → 丢弃第二行及之后）", () => {
    const out = shortToolDescription("First line only\nSecond line ignored");
    expect(out).toBe("First line only");
  });

  it("CRLF 首行后跟 LF 第二行 → 只取首行", () => {
    const out = shortToolDescription("First line\r\nSecond line");
    expect(out).toBe("First line");
  });
});

describe("mcpNameDirectorySegment 渲染（装配层纯函数）", () => {
  it("服务描述在场 → ': <service desc>'；工具描述在场 → ': <short desc>'；末行引导直呼工具", () => {
    const out = mcpNameDirectorySegment([
      svc("stubsvc", {
        description: "Stub MCP server for tests",
        tools: [
          tool("mcp__stubsvc__alpha", "Alpha tool does many useful things"),
          tool("mcp__stubsvc__beta"),
        ],
      }),
    ]);
    expect(out).toBeDefined();
    const text = out as string;
    // service line: name + description
    expect(text).toContain("stubsvc: Stub MCP server for tests");
    // tool lines: alpha carries the short description, beta is bare
    expect(text).toContain(
      "- mcp__stubsvc__alpha: Alpha tool does many useful things"
    );
    expect(text).toContain("- mcp__stubsvc__beta");
    // last-line guidance: calling the tool directly suffices, tool_search is no longer forced
    expect(text).toContain(
      "Call a listed tool directly to load its schema and use it."
    );
    expect(text).not.toContain("Use tool_search");
  });

  it("服务描述缺席 → 服务行只剩裸名（契约允许态）", () => {
    const out = mcpNameDirectorySegment([
      svc("plain", {
        tools: [tool("mcp__plain__t", "a tool")],
      }),
    ]);
    const text = out as string;
    // service line: bare name (no "- " prefix at line start)
    expect(text).toMatch(/^plain$/m);
    expect(text).not.toMatch(/^plain:/m);
    // tool line: description still present
    expect(text).toContain("- mcp__plain__t: a tool");
  });

  it("工具描述缺席 → 工具行只剩 '- <name>'（契约允许态）", () => {
    const out = mcpNameDirectorySegment([
      svc("s", { tools: [tool("mcp__s__bare")] }),
    ]);
    const text = out as string;
    expect(text).toContain("- mcp__s__bare");
    // the name + colon + description shape must not appear (here on the tool
    // line; same idea as a bare service line without ":")
    expect(text).not.toMatch(/^- mcp__s__bare:/m);
  });

  it("工具首行超 120 字 → 截断 + '…'；第二行及之后丢弃", () => {
    const longFirst = "x".repeat(150);
    const out = mcpNameDirectorySegment([
      svc("s", {
        tools: [tool("mcp__s__big", `${longFirst}\nignored second line`)],
      }),
    ]);
    const text = out as string;
    expect(text).toContain(
      "- mcp__s__big: " + "x".repeat(MCP_TOOL_SHORT_DESCRIPTION_MAX) + "…"
    );
    expect(text).not.toContain("ignored second line");
  });

  it("工具描述仅含首行空白 → 工具行只剩裸名（首行 trim 后视为空）", () => {
    const out = mcpNameDirectorySegment([
      svc("s", { tools: [tool("mcp__s__blank", "   \nreal")] }),
    ]);
    const text = out as string;
    // shortToolDescription("   \nreal"): first line is "   ", trims to empty →
    // undefined → the tool line stays bare "- mcp__s__blank", no ": real"
    expect(text).toContain("- mcp__s__blank");
    expect(text).not.toMatch(/^- mcp__s__blank:/m);
    // "real" is the second line; dropped by the first-line cut, never enters the segment
    expect(text).not.toContain("real");
  });

  it("① 服务名 / 工具名 — 字母序稳定，便于 KV cache 前缀复用", () => {
    const out = mcpNameDirectorySegment([
      svc("zeta", { tools: [tool("mcp__zeta__z"), tool("mcp__zeta__a")] }),
      svc("alpha", { tools: [tool("mcp__alpha__y"), tool("mcp__alpha__b")] }),
    ]);
    const text = out as string;
    // service order: alpha < zeta
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("zeta"));
    // tool order: ascending alphabetical within each service
    expect(text.indexOf("- mcp__alpha__b")).toBeLessThan(
      text.indexOf("- mcp__alpha__y")
    );
    expect(text.indexOf("- mcp__zeta__a")).toBeLessThan(
      text.indexOf("- mcp__zeta__z")
    );
  });

  it("⑤ failed / disabled / pending 服务 → 不渲染", () => {
    const out = mcpNameDirectorySegment([
      svc("bad", { state: "failed", tools: [tool("mcp__bad__t")] }),
      svc("off", { state: "disabled", tools: [tool("mcp__off__t")] }),
      svc("slow", { state: "pending", tools: [tool("mcp__slow__t")] }),
      svc("good", { tools: [tool("mcp__good__t")] }),
    ]);
    const text = out as string;
    expect(text).toContain("- mcp__good__t");
    expect(text).not.toContain("bad");
    expect(text).not.toContain("off");
    expect(text).not.toContain("slow");
    expect(text).not.toContain("mcp__bad__t");
    expect(text).not.toContain("mcp__off__t");
    expect(text).not.toContain("mcp__slow__t");
  });

  it("② connected 过滤后为空（全 failed / 全 pending / 空列表）→ undefined（段缺席）", () => {
    expect(mcpNameDirectorySegment([])).toBeUndefined();
    expect(
      mcpNameDirectorySegment([svc("bad", { state: "failed" })])
    ).toBeUndefined();
    expect(
      mcpNameDirectorySegment([svc("off", { state: "disabled" })])
    ).toBeUndefined();
    expect(
      mcpNameDirectorySegment([svc("slow", { state: "pending" })])
    ).toBeUndefined();
  });
});

describe("assembleIdentityContext MCP 名字目录段注入", () => {
  it("不触碰 IKNOW_ASSEMBLY_ORDER（LOCKED 顺序保持 6 段）", () => {
    expect([...IKNOW_ASSEMBLY_ORDER]).toEqual([
      "identity",
      "soul",
      "usage",
      "user_profile",
      "bootstrap",
      "memory_layer",
    ]);
  });

  it("seam 缺席 → 段缺席，输出与无 seam 基线字节一致", async () => {
    workDir = await makeWorkDir();
    const baseline = await assembleIdentityContext(baseCtx());
    expect(baseline).toBeDefined();
    expect(baseline).not.toContain("<mcp_name_directory>");
    const again = await assembleIdentityContext(baseCtx());
    expect(again).toBe(baseline);
  });

  it("② seam 返回空数组 → 段整体缺席且不写空串（前缀不破）", async () => {
    workDir = await makeWorkDir();
    const baseline = await assembleIdentityContext(baseCtx());
    const out = await assembleIdentityContext({
      ...baseCtx(),
      mcp: () => [],
    });
    expect(out).toBe(baseline);
  });

  it("提供非空服务 → 段渲染 + 工具描述 + 末行直呼引导；<available_skills> 段不受影响", async () => {
    workDir = await makeWorkDir();
    const out = await assembleIdentityContext({
      ...baseCtx(),
      skills: () => [{ name: "demo-skill", description: "demo" }],
      mcp: () => [
        svc("stubsvc", {
          description: "Stub MCP server",
          tools: [
            tool("mcp__stubsvc__alpha", "Alpha tool"),
            tool("mcp__stubsvc__beta"),
          ],
        }),
      ],
    });
    expect(out).toContain("<available_skills>");
    expect(out).toContain("demo-skill: demo");
    expect(out).toContain("<mcp_name_directory>");
    expect(out).toContain("stubsvc: Stub MCP server");
    expect(out).toContain("- mcp__stubsvc__alpha: Alpha tool");
    expect(out).toContain("- mcp__stubsvc__beta");
    expect(out).toContain(
      "Call a listed tool directly to load its schema and use it."
    );
    // schemas never enter the name directory (disclosure tiering)
    expect(out).not.toContain("inputSchema");
    // the old tool_search guidance is retired
    expect(out).not.toContain("Use tool_search");
  });

  it("③ 装配期快照：resolver 每次装配现读，后连接的服务下一周期自然出现", async () => {
    workDir = await makeWorkDir();
    const live: McpServiceSummary[] = [svc("late", { state: "pending" })];
    const ctx: AssemblyContext = { ...baseCtx(), mcp: () => live };

    const first = await assembleIdentityContext(ctx);
    expect(first).not.toContain("late");

    live[0] = svc("late", {
      state: "connected",
      tools: [tool("mcp__late__t", "late tool")],
    });
    const second = await assembleIdentityContext(ctx);
    expect(second).toContain("late");
    expect(second).toContain("- mcp__late__t: late tool");
  });

  it("④ resolver 抛错 → 段缺席 + warn，不污染其余段（对齐 memory resolver 降级）", async () => {
    workDir = await makeWorkDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await assembleIdentityContext({
        ...baseCtx(),
        mcp: () => {
          throw new Error("mcp metadata exploded");
        },
      });
      expect(out).toBeDefined();
      expect(out).not.toContain("<mcp_name_directory>");
      expect(out).not.toContain("Call a listed tool directly");
      expect(out).toContain("## Project path");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("会话冻结：相邻装配 round 输出 byte-stable", async () => {
    workDir = await makeWorkDir();
    const ctx: AssemblyContext = {
      ...baseCtx(),
      mcp: () => [
        svc("stubsvc", {
          description: "Stable server",
          tools: [
            tool("mcp__stubsvc__alpha", "Alpha"),
            tool("mcp__stubsvc__beta"),
          ],
        }),
      ],
    };
    const a = await assembleIdentityContext(ctx);
    const b = await assembleIdentityContext(ctx);
    expect(b).toBe(a);
  });
});

describe("createIknowSystemResolver opts.mcp 透传", () => {
  it("opts.mcp 在场 → 装配文本含名字目录段；缺席 → 段缺席", async () => {
    workDir = await makeWorkDir();
    const withMcp = createIknowSystemResolver({
      cwd: process.cwd(),
      projectIdentityRoot: process.cwd(),
      userHome: workDir,
      surface: "chat",
      memoryEnabled: false,
      mcp: () => [
        svc("viasolver", {
          tools: [tool("mcp__viasolver__t", "via resolver")],
        }),
      ],
    });
    const text = await withMcp();
    expect(text).toContain("<mcp_name_directory>");
    expect(text).toContain("viasolver");
    expect(text).toContain("- mcp__viasolver__t: via resolver");
    expect(text).toContain(
      "Call a listed tool directly to load its schema and use it."
    );

    const withoutMcp = createIknowSystemResolver({
      cwd: process.cwd(),
      projectIdentityRoot: process.cwd(),
      userHome: workDir,
      surface: "chat",
      memoryEnabled: false,
    });
    const bare = await withoutMcp();
    expect(bare).toBeDefined();
    expect(bare).not.toContain("viasolver");
    expect(bare).not.toContain("<mcp_name_directory>");
  });
});
