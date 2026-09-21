/**
 * Sub-agent coordinator additive segment (ADR-0014 decisions 3 & 6).
 *
 *  Behavior ground truth ("guidance layer" hard constraints):
 *
 *   - Additive segment: placed after the six LOCKED segments of
 *     IKNOW_ASSEMBLY_ORDER, at the tail of the skills / projectPath additive
 *     segments; the LOCKED order is never touched. Reuses the
 *     projectPathSegment / skillsSegment additive pattern (absent → byte-level
 *     zero change, upholding the KV-cache stability contract).
 *
 *   - Injection condition: only when subagentManager is assembled (build-engine
 *     passes IKNOW_COORDINATOR_TEXT via createIknowSystemResolver
 *     opts.coordinatorText); ask surfaces (not chat / tui / serve, no manager)
 *     pass nothing → the segment is absent.
 *
 *   - The copy carries the model-visible hard hooks in the assembled system
 *     prompt: proactive (proactively) · parallelizable · blocks until finished.
 *     The real-link acceptance for these keywords reads the `system` field
 *     captured on the llm_call row (ADR-0014 D6 amended 2026-09-21 by
 *     ADR-0116) — never `messages`, which is not allowed to impersonate the
 *     system channel.
 *
 *   - The wording "Default contract today" leaves room for a future async
 *     discipline segment in V2.
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
    projectIdentityRoot: process.cwd(),
    userHome: workDir,
    bootstrapActive: false,
    memoryEnabled: false,
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

  it("不触碰 IKNOW_ASSEMBLY_ORDER (LOCKED 顺序保持 6 段)", () => {
    // The "usage" segment (code primary path uses symbol tools + grep
    // three-category fallback + edit_file defers) sits between soul and user_profile.
    expect([...IKNOW_ASSEMBLY_ORDER]).toEqual([
      "identity",
      "soul",
      "usage",
      "user_profile",
      "bootstrap",
      "memory_layer",
    ]);
  });
});

describe("coordinator 加性段 — seam 提供时渲染", () => {
  it("coordinatorText 提供 → 段渲染,含 ## Sub-agent coordination 标题 + 测试本地正文", async () => {
    // Seam cases use a test-local short string, independent of the production
    // IKNOW_COORDINATOR_TEXT content (default-path injection is off; the
    // production constant only serves as the SSOT copy for the keyword cases).
    const localText = "explicit coordinator seam text for T2 regression";
    const out = await assembleIdentityContext({
      ...baseCtx(),
      coordinatorText: localText,
    });
    expect(out).toBeDefined();
    expect(out).toContain("## Sub-agent coordination");
    expect(out).toContain(localText);
    // These hard hooks are the seam-render contract, decoupled from the
    // IKNOW_COORDINATOR_TEXT content (coordinatorSegment renders only
    // title + verbatim body).
    expect(out).not.toContain("proactively");
    expect(out).not.toContain("parallelizable");
  });

  it("coordinator 段置于 LOCKED 段之后 (顺序不破)", async () => {
    const localText = "order-check text";
    const out = await assembleIdentityContext({
      ...baseCtx(),
      coordinatorText: localText,
    });
    const idxCoord = out!.indexOf("## Sub-agent coordination");
    expect(idxCoord).toBeGreaterThanOrEqual(0);
    // projectPath segment precedes coordinator
    expect(out!.indexOf("## Project path")).toBeLessThan(idxCoord);
    // LOCKED segment (identity) precedes coordinator
    expect(out!.indexOf("iknow Identity")).toBeLessThan(idxCoord);
  });

  it("coordinator 段置于 projectPath / skills 加性段之末", async () => {
    const localText = "tail-check text";
    const out = await assembleIdentityContext({
      ...baseCtx(),
      skills: () => [{ name: "alpha", description: "first" }],
      coordinatorText: localText,
    });
    const idxPath = out!.indexOf("## Project path");
    const idxSkills = out!.indexOf("<available_skills>");
    const idxCoord = out!.indexOf("## Sub-agent coordination");
    expect(idxPath).toBeGreaterThanOrEqual(0);
    expect(idxSkills).toBeGreaterThan(idxPath);
    expect(idxCoord).toBeGreaterThan(idxSkills);
  });

  it("cross-turn byte-stable (KV 缓存契约):相同输入二次调用字符串相等", async () => {
    const localText = "byte-stable seam text";
    const ctx = {
      ...baseCtx(),
      coordinatorText: localText,
    };
    const a = await assembleIdentityContext(ctx);
    const b = await assembleIdentityContext(ctx);
    expect(b).toBe(a);
  });

  it("createIknowSystemResolver 透传 opts.coordinatorText 到装配输出", async () => {
    const localText = "resolver seam text for T2 regression";
    const resolver = createIknowSystemResolver({
      cwd: process.cwd(),
      projectIdentityRoot: process.cwd(),
      userHome: workDir,
      surface: "ask",
      memoryEnabled: false,
      coordinatorText: localText,
    });
    const out = await resolver();
    expect(out).toBeDefined();
    expect(out).toContain("## Sub-agent coordination");
    expect(out).toContain(localText);
  });

  it("createIknowSystemResolver 不传 coordinatorText → 段缺席", async () => {
    const resolver = createIknowSystemResolver({
      cwd: process.cwd(),
      projectIdentityRoot: process.cwd(),
      userHome: workDir,
      surface: "ask",
      memoryEnabled: false,
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
    // (1) which two tools
    expect(IKNOW_COORDINATOR_TEXT).toContain("spawn_subagent");
    expect(IKNOW_COORDINATOR_TEXT).toContain("subagent_result");
    // (2) when to spawn: multi-step exploration / independent verification / parallelizable work
    expect(IKNOW_COORDINATOR_TEXT).toContain("multi-step exploration");
    expect(IKNOW_COORDINATOR_TEXT).toContain("independent verification");
    // (3) foreground default blocks for the result
    expect(IKNOW_COORDINATOR_TEXT).toContain("blocks until finished");
    expect(IKNOW_COORDINATOR_TEXT).toMatch(/same turn/);
    // (4) multiple spawns run in parallel within one turn
    expect(IKNOW_COORDINATOR_TEXT).toMatch(
      /multiple spawn_subagent calls in one turn/
    );
    expect(IKNOW_COORDINATOR_TEXT).toMatch(/concurrently/);
    // (5) result handling: read the envelope directly; a failure is data —
    // read reason + summary
    expect(IKNOW_COORDINATOR_TEXT).toMatch(/status: "ok"/);
    expect(IKNOW_COORDINATOR_TEXT).toMatch(/status: "failed"/);
    expect(IKNOW_COORDINATOR_TEXT).toContain("reason");
    expect(IKNOW_COORDINATOR_TEXT).toContain("summary");
    expect(IKNOW_COORDINATOR_TEXT).toMatch(/data, not an error/);
  });

  it("wait:false 引导 chat/tui/serve 走 terminal wake + silent run", () => {
    expect(IKNOW_COORDINATOR_TEXT).toMatch(
      /wait:false.*terminal completion wakes a silent run through the host mailbox\/subscription/s
    );
    expect(IKNOW_COORDINATOR_TEXT).toMatch(
      /subagent_result only for an explicit status query/
    );
    expect(IKNOW_COORDINATOR_TEXT).not.toContain(
      "A future version may add an explicit asynchronous mode"
    );
  });
});
