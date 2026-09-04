// B4 / ADR-0043 §3 — `<mcp_name_directory>` 段（渐进式披露"索引常驻档"）装配层单测。
//
// 行为真值（ADR-0043 / plan B4 acceptance）：
//   - 加性段（LOCKED 循环后追加），不触碰 IKNOW_ASSEMBLY_ORDER。
//   - 每 connected service 一行（名字），其下每工具一行（裸名 `- <tool>`）。
//   - 名字目录 = lazy 工具名（无 schema、无 description），符合 B4 披露分层：
//     schema 须 tool_search 按需加载，未 discover 调用由 gate 拦截为
//     ToolExecutionError(MCP_TOOL_NOT_LOADED_MESSAGE)。
//   - 五类边界：
//     ① 服务名 / 工具名字母序（字节稳定，便于 KV cache）；
//     ② 空服务列表 / 全失败 / pending → 段整体缺席（不写空串、不破前缀）；
//     ③ 异步连接 — 装配期快照，下一装配周期自然出现，不阻塞不空等；
//     ④ 元数据读错 — resolver 抛错 → 段缺席（对齐 memory resolver 降级）；
//     ⑤ 服务状态过滤 — failed / disabled / pending 不渲染。
//   - `<available_skills>` 段不受影响。

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IKNOW_ASSEMBLY_ORDER,
  assembleIdentityContext,
  createIknowSystemResolver,
  mcpNameDirectorySegment,
  type AssemblyContext,
  type McpServiceSummary,
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

describe("mcpNameDirectorySegment 渲染（装配层纯函数）", () => {
  it("渲染服务行 + 工具行（裸名，无 schema/description）+ tool_search 引导末行", () => {
    const out = mcpNameDirectorySegment([
      svc("beta", { tools: ["mcp__beta__search", "mcp__beta__fetch"] }),
      svc("alpha", { tools: ["mcp__alpha__run"] }),
    ]);
    expect(out).toBeDefined();
    const text = out as string;
    // 服务名字母序渲染
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("beta"));
    // 工具行：仅裸名字（"-" 前缀），无 description，无 schema
    expect(text).toContain("- mcp__beta__fetch");
    expect(text).toContain("- mcp__beta__search");
    expect(text.indexOf("- mcp__beta__fetch")).toBeLessThan(
      text.indexOf("- mcp__beta__search")
    );
    expect(text).toContain("- mcp__alpha__run");
    expect(text).not.toContain("inputSchema");
    // 末行引导 tool_search 精查
    expect(text).toContain("tool_search");
    expect(text).toContain("Use tool_search");
  });

  it("① 服务名 / 工具名 — 字母序稳定，便于 KV cache 前缀复用", () => {
    const out = mcpNameDirectorySegment([
      svc("zeta", { tools: ["mcp__zeta__z", "mcp__zeta__a"] }),
      svc("alpha", { tools: ["mcp__alpha__y", "mcp__alpha__b"] }),
    ]);
    const text = out as string;
    // 服务序：alpha < zeta
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("zeta"));
    // 工具序：每服务内字母升序
    expect(text.indexOf("- mcp__alpha__b")).toBeLessThan(
      text.indexOf("- mcp__alpha__y")
    );
    expect(text.indexOf("- mcp__zeta__a")).toBeLessThan(
      text.indexOf("- mcp__zeta__z")
    );
  });

  it("工具名稳定渲染（无 description 字段依赖，B4 披露分层）", () => {
    const out = mcpNameDirectorySegment([
      svc("s", { tools: ["mcp__s__bare"] }),
    ]);
    const text = out as string;
    expect(text).toContain("- mcp__s__bare");
    // 不渲染 description 字段（不再有 description 字段）
    expect(text).not.toContain("mcp__s__bare:");
  });

  it("⑤ failed / disabled 状态服务 → 整个服务不渲染", () => {
    const out = mcpNameDirectorySegment([
      svc("bad", { state: "failed", tools: ["mcp__bad__t"] }),
      svc("off", { state: "disabled", tools: ["mcp__off__t"] }),
      svc("good", { tools: ["mcp__good__t"] }),
    ]);
    const text = out as string;
    expect(text).toContain("- mcp__good__t");
    expect(text).not.toContain("bad");
    expect(text).not.toContain("off");
    expect(text).not.toContain("mcp__bad__t");
    expect(text).not.toContain("mcp__off__t");
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

  it("提供非空服务 → 段渲染且 <available_skills> 段不受影响（无 schema 暴露）", async () => {
    workDir = await makeWorkDir();
    const out = await assembleIdentityContext({
      ...baseCtx(),
      skills: () => [{ name: "demo-skill", description: "demo" }],
      mcp: () => [
        svc("stubsvc", {
          tools: ["mcp__stubsvc__ping"],
        }),
      ],
    });
    expect(out).toContain("<available_skills>");
    expect(out).toContain("demo-skill: demo");
    expect(out).toContain("<mcp_name_directory>");
    expect(out).toContain("stubsvc");
    expect(out).toContain("- mcp__stubsvc__ping");
    expect(out).toContain("tool_search");
    // schema / description 不进名字目录（B4 披露分层）
    expect(out).not.toContain("inputSchema");
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
      tools: ["mcp__late__t"],
    });
    const second = await assembleIdentityContext(ctx);
    expect(second).toContain("late");
    expect(second).toContain("- mcp__late__t");
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
      expect(out).not.toContain("tool_search");
      expect(out).toContain("## Project path");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
      mcp: () => [svc("viasolver", { tools: ["mcp__viasolver__t"] })],
    });
    const text = await withMcp();
    expect(text).toContain("<mcp_name_directory>");
    expect(text).toContain("viasolver");
    expect(text).toContain("- mcp__viasolver__t");

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
