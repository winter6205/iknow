/**
 * #361 T8 (ADR-0014 决策 3 / 6):subagent coordinator 加性段。
 *
 *  行为真值 (docs/plans/361-subagent-v1.5-foreground-spawn-contract.md
 *  「引导层（T8）硬约束」节):
 *
 *   - 加性段:置于 IKNOW_ASSEMBLY_ORDER 五段 LOCKED 之后、skills / projectPath
 *     加性段之末,不触碰 LOCKED 顺序;复用 projectPathSegment / skillsSegment
 *     加性段模式 (缺席 → 字节级零变化,守 KV 缓存稳定契约)。
 *
 *   - 注入条件:仅 subagentManager 装配时 (build-engine 经
 *     createIknowSystemResolver opts.coordinatorText 传入 IKNOW_COORDINATOR_TEXT);
 *     ask (surface !== chat / tui / serve,无 manager) 不传入 → 段缺席。
 *
 *   - 文案含验收 6 硬挂钩 (model 实际可见的 system prompt 含):
 *       proactive (proactively) · parallelizable · blocks until finished
 *     真链路 messages_captured 断言 model 实际 system prompt 含 proactive
 *     关键词即挂此段。
 *
 *   - 措辞用 "Default contract today" 为 V2 追加异步纪律段留空间。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IKNOW_ASSEMBLY_ORDER,
  IKNOW_COORDINATOR_TEXT,
  assembleIdentityContext,
  createIknowSystemResolver,
  coordinatorSegment,
  type AssemblyContext,
} from "../../../src/harness/identity/assemble.ts";

let origHome: string | undefined;
let workDir: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  workDir = await mkdtemp(join(tmpdir(), "iknow-coordinator-"));
  await mkdir(join(workDir, ".iknow"), { recursive: true });
  process.env.HOME = workDir;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await rm(workDir, { recursive: true, force: true });
});

function baseCtx(): AssemblyContext {
  return {
    cwd: process.cwd(),
    userHome: workDir,
    bootstrapActive: false,
  };
}

describe("coordinator 加性段 — seam 缺席 / 字节级零变化", () => {
  it("seam 缺席 (coordinatorText 未传) → 输出与基线字节级一致,无 coordinator 段", async () => {
    const baseline = await assembleIdentityContext(baseCtx());
    expect(baseline).toBeDefined();
    expect(baseline).not.toContain("## Sub-agent coordination");
    expect(baseline).not.toContain("Sub-agent coordination");
    expect(baseline).not.toContain("spawn_subagent");
    expect(baseline).not.toContain("proactively");
    expect(baseline).not.toContain("parallelizable");
  });

  it("coordinatorText 显式传 undefined → 与 baseline 字节级一致 (seam 缺席语义)", async () => {
    const baseline = await assembleIdentityContext(baseCtx());
    const seamUndef = await assembleIdentityContext({
      ...baseCtx(),
      coordinatorText: undefined,
    });
    expect(seamUndef).toBe(baseline);
  });

  it("coordinatorText 传空串 → 与 baseline 字节级一致 (空串视为缺席)", async () => {
    const baseline = await assembleIdentityContext(baseCtx());
    const seamEmpty = await assembleIdentityContext({
      ...baseCtx(),
      coordinatorText: "",
    });
    expect(seamEmpty).toBe(baseline);
  });

  it("不触碰 IKNOW_ASSEMBLY_ORDER (LOCKED 顺序保持 5 段)", () => {
    expect([...IKNOW_ASSEMBLY_ORDER]).toEqual([
      "identity",
      "soul",
      "user_profile",
      "bootstrap",
      "memory_layer",
    ]);
  });
});

describe("coordinator 加性段 — seam 提供时渲染", () => {
  it("coordinatorText 提供 → 段渲染,含 ## Sub-agent coordination 标题 + 验收关键词", async () => {
    const out = await assembleIdentityContext({
      ...baseCtx(),
      coordinatorText: IKNOW_COORDINATOR_TEXT,
    });
    expect(out).toBeDefined();
    expect(out).toContain("## Sub-agent coordination");
    // 验收 6 硬挂钩:proactive / parallelizable / blocks until finished
    expect(out).toContain("proactively");
    expect(out).toContain("parallelizable");
    expect(out).toContain("blocks until finished");
    // 两工具名 (ADR 决策 3 ①)
    expect(out).toContain("spawn_subagent");
    expect(out).toContain("subagent_result");
  });

  it("coordinator 段置于 LOCKED 段之后 (顺序不破)", async () => {
    const out = await assembleIdentityContext({
      ...baseCtx(),
      coordinatorText: IKNOW_COORDINATOR_TEXT,
    });
    const idxCoord = out!.indexOf("## Sub-agent coordination");
    expect(idxCoord).toBeGreaterThanOrEqual(0);
    // projectPath 段先于 coordinator
    expect(out!.indexOf("## Project path")).toBeLessThan(idxCoord);
    // LOCKED 段 (identity) 先于 coordinator
    expect(out!.indexOf("iknow Identity")).toBeLessThan(idxCoord);
  });

  it("coordinator 段置于 projectPath / skills 加性段之末", async () => {
    const out = await assembleIdentityContext({
      ...baseCtx(),
      skills: () => [{ name: "alpha", description: "first" }],
      coordinatorText: IKNOW_COORDINATOR_TEXT,
    });
    const idxPath = out!.indexOf("## Project path");
    const idxSkills = out!.indexOf("<available_skills>");
    const idxCoord = out!.indexOf("## Sub-agent coordination");
    expect(idxPath).toBeGreaterThanOrEqual(0);
    expect(idxSkills).toBeGreaterThan(idxPath);
    expect(idxCoord).toBeGreaterThan(idxSkills);
  });

  it("cross-turn byte-stable (KV 缓存契约):相同输入二次调用字符串相等", async () => {
    const ctx = {
      ...baseCtx(),
      coordinatorText: IKNOW_COORDINATOR_TEXT,
    };
    const a = await assembleIdentityContext(ctx);
    const b = await assembleIdentityContext(ctx);
    expect(b).toBe(a);
  });

  it("createIknowSystemResolver 透传 opts.coordinatorText 到装配输出", async () => {
    const resolver = createIknowSystemResolver({
      cwd: process.cwd(),
      userHome: workDir,
      surface: "ask",
      coordinatorText: IKNOW_COORDINATOR_TEXT,
    });
    const out = await resolver();
    expect(out).toBeDefined();
    expect(out).toContain("## Sub-agent coordination");
    expect(out).toContain("proactively");
    expect(out).toContain("parallelizable");
    expect(out).toContain("blocks until finished");
  });

  it("createIknowSystemResolver 不传 coordinatorText → 段缺席", async () => {
    const resolver = createIknowSystemResolver({
      cwd: process.cwd(),
      userHome: workDir,
      surface: "ask",
    });
    const out = await resolver();
    expect(out).toBeDefined();
    expect(out).not.toContain("## Sub-agent coordination");
    expect(out).not.toContain("proactively");
  });
});

describe("coordinator 段 renderer — coordinatorSegment", () => {
  it("渲染段标题 + 正文 (projectPathSegment / skillsSegment 同形态)", () => {
    expect(coordinatorSegment("hello")).toBe(
      "## Sub-agent coordination\nhello"
    );
  });
});

describe("IKNOW_COORDINATOR_TEXT — SSOT 文案验收", () => {
  it("含验收 6 关键词:proactive (proactively) / parallelizable / blocks until finished", () => {
    expect(IKNOW_COORDINATOR_TEXT).toContain("proactively");
    expect(IKNOW_COORDINATOR_TEXT).toContain("parallelizable");
    expect(IKNOW_COORDINATOR_TEXT).toContain("blocks until finished");
  });

  it("ADR 决策 3 五要点覆盖:两工具 + 何时派 + 前景默认阻塞 + 并行 + 结果处置", () => {
    // ① 两工具是谁
    expect(IKNOW_COORDINATOR_TEXT).toContain("spawn_subagent");
    expect(IKNOW_COORDINATOR_TEXT).toContain("subagent_result");
    // ② 何时派:多步探索 / 独立验证 / 可并行工作
    expect(IKNOW_COORDINATOR_TEXT).toContain("multi-step exploration");
    expect(IKNOW_COORDINATOR_TEXT).toContain("independent verification");
    // ③ 前景默认"阻塞等待结果"
    expect(IKNOW_COORDINATOR_TEXT).toContain("blocks until finished");
    expect(IKNOW_COORDINATOR_TEXT).toMatch(/same turn/);
    // ④ 一回合多 spawn 并行
    expect(IKNOW_COORDINATOR_TEXT).toMatch(
      /multiple spawn_subagent calls in one turn/
    );
    expect(IKNOW_COORDINATOR_TEXT).toMatch(/concurrently/);
    // ⑤ 结果处置:envelope 直接 / 失败是数据读 reason + summary
    expect(IKNOW_COORDINATOR_TEXT).toMatch(/status: "ok"/);
    expect(IKNOW_COORDINATOR_TEXT).toMatch(/status: "failed"/);
    expect(IKNOW_COORDINATOR_TEXT).toContain("reason");
    expect(IKNOW_COORDINATOR_TEXT).toContain("summary");
    expect(IKNOW_COORDINATOR_TEXT).toMatch(/data, not an error/);
  });

  it("措辞用 'Default contract today' 为 V2 异步纪律段留空间", () => {
    expect(IKNOW_COORDINATOR_TEXT).toContain("Default contract today");
  });
});
