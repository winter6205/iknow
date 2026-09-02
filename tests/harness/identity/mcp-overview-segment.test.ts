// #631 T2 — MCP 概览段（渐进式披露"索引常驻档"）装配层单测。
//
// 行为真值（plan T2 acceptance）：
//   - 加性段（LOCKED 循环后追加），不触碰 IKNOW_ASSEMBLY_ORDER。
//   - 每 connected service 一行（名字 [+ description]），其下每工具一行
//     （名字 + 短描述），末行引导 tool_search 精查。
//   - 五类边界：
//     ① 短描述截断 —— 取首行，~120 字符截断（含限值边界）；
//     ② 空服务列表 —— 段整体缺席（不写空串、不破前缀）；
//     ③ 异步连接 —— 装配期快照，下一装配周期自然出现，不阻塞不空等；
//     ④ 元数据读错 —— resolver 抛错 → 段缺席（对齐 memory resolver 降级）；
//     ⑤ 工具缺 description → 只渲染名字；failed 服务 → 整个不渲染。
//   - `<available_skills>` 段不受影响。

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IKNOW_ASSEMBLY_ORDER,
  MCP_TOOL_SHORT_DESCRIPTION_MAX,
  assembleIdentityContext,
  createIknowSystemResolver,
  mcpOverviewSegment,
  type AssemblyContext,
  type McpServiceSummary,
} from "../../../src/harness/identity/assemble.ts";

let workDir: string;

async function makeWorkDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iknow-mcp-overview-"));
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

describe("mcpOverviewSegment 渲染（装配层纯函数）", () => {
  it("渲染 service 行 + 工具行（名字 + 短描述）+ tool_search 引导末行", () => {
    const out = mcpOverviewSegment([
      svc("beta", {
        tools: [
          { name: "mcp__beta__search", description: "Search things" },
          { name: "mcp__beta__fetch" },
        ],
      }),
      svc("alpha", {
        description: "Alpha service",
        tools: [{ name: "mcp__alpha__run", description: "Run alpha" }],
      }),
    ]);
    expect(out).toBeDefined();
    const text = out as string;
    // service 名字序渲染；有 description 时同行附带
    expect(text).toContain("alpha: Alpha service");
    expect(text).toContain("beta");
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("beta"));
    // 工具行：名字 + 短描述；同 service 下名字序
    expect(text).toContain("mcp__beta__fetch");
    expect(text).toContain("mcp__beta__search: Search things");
    expect(text.indexOf("mcp__beta__fetch")).toBeLessThan(
      text.indexOf("mcp__beta__search")
    );
    expect(text).toContain("mcp__alpha__run: Run alpha");
    // 末行（闭合标签前最后一行内容）引导 tool_search 精查
    const contentLines = text
      .split("\n")
      .filter((l) => l.length > 0 && !l.startsWith("<"));
    const guidance = contentLines[contentLines.length - 1];
    expect(guidance).toContain("tool_search");
  });

  it("① 短描述取首行，多行 description 只保留第一行", () => {
    const out = mcpOverviewSegment([
      svc("s", {
        tools: [{ name: "mcp__s__t", description: "first line\nsecond line" }],
      }),
    ]);
    expect(out).toContain("mcp__s__t: first line");
    expect(out).not.toContain("second line");
  });

  it("① 短描述恰好等于限值 → 原样保留不截断（边界值）", () => {
    const exact = "x".repeat(MCP_TOOL_SHORT_DESCRIPTION_MAX);
    const out = mcpOverviewSegment([
      svc("s", { tools: [{ name: "mcp__s__t", description: exact }] }),
    ]);
    expect(out).toContain(`mcp__s__t: ${exact}`);
    expect(out).not.toContain("…");
  });

  it("① 短描述超限值 1 字符 → 截断到限值 + 省略号（边界值）", () => {
    const over = "y".repeat(MCP_TOOL_SHORT_DESCRIPTION_MAX + 1);
    const out = mcpOverviewSegment([
      svc("s", { tools: [{ name: "mcp__s__t", description: over }] }),
    ]);
    expect(out).toContain(
      `mcp__s__t: ${"y".repeat(MCP_TOOL_SHORT_DESCRIPTION_MAX)}…`
    );
    expect(out).not.toContain(over);
  });

  it("⑤ 工具缺 description → 只渲染工具名", () => {
    const out = mcpOverviewSegment([
      svc("s", { tools: [{ name: "mcp__s__bare" }] }),
    ]);
    expect(out).toContain("mcp__s__bare");
    // 无 description 时不渲染名字后的冒号分隔
    expect(out).not.toContain("mcp__s__bare:");
  });

  it("⑤ failed 状态服务 → 整个服务不渲染", () => {
    const out = mcpOverviewSegment([
      svc("bad", {
        state: "failed",
        tools: [{ name: "mcp__bad__t", description: "should vanish" }],
      }),
      svc("good", { tools: [{ name: "mcp__good__t" }] }),
    ]);
    expect(out).toContain("mcp__good__t");
    expect(out).not.toContain("bad");
    expect(out).not.toContain("should vanish");
  });

  it("② connected 过滤后为空（全 failed / 空列表）→ undefined（段缺席）", () => {
    expect(mcpOverviewSegment([])).toBeUndefined();
    expect(
      mcpOverviewSegment([svc("bad", { state: "failed" })])
    ).toBeUndefined();
    expect(
      mcpOverviewSegment([svc("off", { state: "disabled" })])
    ).toBeUndefined();
    expect(
      mcpOverviewSegment([svc("slow", { state: "pending" })])
    ).toBeUndefined();
  });
});

describe("assembleIdentityContext MCP 概览段注入", () => {
  it("不触碰 IKNOW_ASSEMBLY_ORDER（LOCKED 顺序数组内容不变）", () => {
    // IKNOW-symbol-primary T1: "usage" 段在 soul 与 user_profile 之间。
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
    expect(baseline).not.toContain("<mcp_tools_overview>");
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

  it("提供非空服务 → 段渲染且 <available_skills> 段不受影响", async () => {
    workDir = await makeWorkDir();
    const out = await assembleIdentityContext({
      ...baseCtx(),
      skills: () => [{ name: "demo-skill", description: "demo" }],
      mcp: () => [
        svc("stubsvc", {
          tools: [{ name: "mcp__stubsvc__ping", description: "Ping it" }],
        }),
      ],
    });
    expect(out).toContain("<available_skills>");
    expect(out).toContain("demo-skill: demo");
    expect(out).toContain("stubsvc");
    expect(out).toContain("mcp__stubsvc__ping: Ping it");
    expect(out).toContain("tool_search");
  });

  it("③ 装配期快照：resolver 每次装配现读，后连接的服务下一周期自然出现", async () => {
    workDir = await makeWorkDir();
    // 模拟异步连接：首装配时服务还在 pending，随后转 connected + 工具注册
    const live: McpServiceSummary[] = [svc("late", { state: "pending" })];
    const ctx: AssemblyContext = { ...baseCtx(), mcp: () => live };

    const first = await assembleIdentityContext(ctx);
    expect(first).not.toContain("late");

    live[0] = svc("late", {
      state: "connected",
      tools: [{ name: "mcp__late__t", description: "late tool" }],
    });
    const second = await assembleIdentityContext(ctx);
    expect(second).toContain("late");
    expect(second).toContain("mcp__late__t: late tool");
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
      expect(out).not.toContain("tool_search");
      expect(out).toContain("## Project path");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createIknowSystemResolver opts.mcp 透传", () => {
  it("opts.mcp 在场 → 装配文本含概览段；缺席 → 段缺席", async () => {
    workDir = await makeWorkDir();
    const withMcp = createIknowSystemResolver({
      cwd: process.cwd(),
      projectIdentityRoot: process.cwd(),
      userHome: workDir,
      surface: "chat",
      memoryEnabled: false,
      mcp: () => [
        svc("viasolver", {
          tools: [{ name: "mcp__viasolver__t", description: "d" }],
        }),
      ],
    });
    const text = await withMcp();
    expect(text).toContain("viasolver");
    expect(text).toContain("mcp__viasolver__t: d");

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
  });
});
