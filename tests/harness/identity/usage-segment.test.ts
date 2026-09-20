/**
 * Usage-segment assembly tests.
 *
 *   1. resolveSegment must have a "usage" case → IKNOW_USAGE_DEFAULT,
 *      injected on every surface (chat / tui / serve / ask). Assembled
 *      output always contains the usage text (code LOCKED).
 *   2. Declaration-vs-output consistency: every segment declared in
 *      IKNOW_ASSEMBLY_ORDER must appear in the assembled output, or be
 *      listed in the explicit conditional-segment manifest.
 *      The manifest is an assembly invariant — a new conditional segment
 *      must document its absence condition here; without a documented
 *      condition = the segment must always be present (LOCKED contract).
 *
 * Anchors: derived from IKNOW_ASSEMBLY_ORDER + SSOT constants; no hardcoded
 * segment-name arrays.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IKNOW_ASSEMBLY_ORDER,
  assembleIdentityContext,
  createIknowSystemResolver,
  type AssemblyContext,
} from "../../../src/harness/identity/assemble.ts";
import { IKNOW_IDENTITY_DEFAULT } from "../../../src/harness/identity/identity.ts";
import { IKNOW_SOUL_DEFAULT } from "../../../src/harness/identity/soul.ts";
import { IKNOW_USAGE_DEFAULT } from "../../../src/harness/identity/usage.ts";

let origHome: string | undefined;
let workDir: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  workDir = await mkdtemp(join(tmpdir(), "iknow-usage-segment-"));
  await mkdir(join(workDir, ".iknow"), { recursive: true });
  process.env.HOME = workDir;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await rm(workDir, { recursive: true, force: true });
});

/** Default test ctx: the ask-surface equivalent minimal set
 *  (bootstrapActive=false / memoryEnabled=false). Bootstrap absence is needed
 *  so "bootstrap" stays in the conditional-segment manifest. */
function baseCtx(): AssemblyContext {
  return {
    cwd: process.cwd(),
    projectIdentityRoot: process.cwd(),
    userHome: workDir,
    bootstrapActive: false,
    memoryEnabled: false,
  };
}

/** Chat/tui/serve equivalent ctx: bootstrapActive=true + memoryEnabled=false. */
function chatCtx(): AssemblyContext {
  return {
    cwd: process.cwd(),
    projectIdentityRoot: process.cwd(),
    userHome: workDir,
    bootstrapActive: true,
    memoryEnabled: false,
  };
}

describe("usage 段 — IKNOW_ASSEMBLY_ORDER 声明位置", () => {
  it("usage 段 LOCKED 在 soul 之后、user_profile 之前 (顺序不变)", () => {
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

describe("usage 段 — 装配产物 (T0 修复)", () => {
  it("装配产物含 IKNOW_USAGE_DEFAULT 全文 (SSOT 引用,不切片)", async () => {
    const out = await assembleIdentityContext(baseCtx());
    expect(out).toBeDefined();
    expect(out).toContain(IKNOW_USAGE_DEFAULT);
  });

  it("usage 段在 soul 之后、projectPath 加性段之前 (LOCKED 顺序保留)", async () => {
    const out = await assembleIdentityContext(baseCtx());
    expect(out).toBeDefined();
    const idxSoul = out!.indexOf(IKNOW_SOUL_DEFAULT);
    const idxUsage = out!.indexOf(IKNOW_USAGE_DEFAULT);
    const idxPath = out!.indexOf("## Project path");
    expect(idxSoul).toBeGreaterThanOrEqual(0);
    expect(idxUsage).toBeGreaterThan(idxSoul);
    expect(idxPath).toBeGreaterThan(idxUsage);
  });

  it("usage 段关键句入场 (代码主路径走符号工具 / grep 三类回退 / edit_file 让位)", async () => {
    const out = await assembleIdentityContext(baseCtx());
    expect(out).toBeDefined();
    expect(out).toContain("Use the symbol tools — do not start with grep.");
    expect(out).toContain("Fallbacks: grep and read_file");
    expect(out).toContain(
      "`grep` and `read_file` are restricted to three fallback situations"
    );
    expect(out).toContain("`edit_file` only for text patches");
    expect(out).toContain("# Usage rules");
  });

  it("ask surface (createIknowSystemResolver surface=ask) 注入 usage 段", async () => {
    const resolver = createIknowSystemResolver({
      cwd: process.cwd(),
      projectIdentityRoot: process.cwd(),
      userHome: workDir,
      surface: "ask",
      memoryEnabled: false,
    });
    const out = await resolver();
    expect(out).toBeDefined();
    expect(out).toContain(IKNOW_USAGE_DEFAULT);
  });

  it("chat surface (createIknowSystemResolver surface=chat) 注入 usage 段", async () => {
    const resolver = createIknowSystemResolver({
      cwd: process.cwd(),
      projectIdentityRoot: process.cwd(),
      userHome: workDir,
      surface: "chat",
      memoryEnabled: false,
    });
    const out = await resolver();
    expect(out).toBeDefined();
    expect(out).toContain(IKNOW_USAGE_DEFAULT);
  });

  it("tui / serve surface 同样注入 usage 段 (SC1 全表面)", async () => {
    for (const surface of ["tui", "serve"] as const) {
      const resolver = createIknowSystemResolver({
        cwd: process.cwd(),
        projectIdentityRoot: process.cwd(),
        userHome: workDir,
        surface,
        memoryEnabled: false,
      });
      const out = await resolver();
      expect(out).toBeDefined();
      expect(out).toContain(IKNOW_USAGE_DEFAULT);
    }
  });
});

describe("断言 ① — IKNOW_ASSEMBLY_ORDER 声明↔产物一致性", () => {
  /** Conditional-segment manifest: segment name → absence condition. The SSOT
   *  lives at the top of this describe; new entries append here with a source
   *  note. */
  const CONDITIONAL_SEGMENTS: Record<string, string> = {
    bootstrap:
      "bootstrapActive=false → 段缺席 (ask surface);或 BOOTSTRAP.md 文件缺失/空 → 段缺席 (chat/tui/serve)",
    user_profile:
      "userHome/.iknow/user.md 缺失/空 → 段缺席 (assemble.ts:346-361 readUserProfile 行为契约)",
    memory_layer:
      "memoryEnabled=false → 段缺席 (或 memoryResolver 缺席/抛错 → warn + skip)",
    // The git block is an additive segment (ctx.git seam): seam absent /
    // provider degraded (not a git repo / git unavailable) → segment absent.
    // See src/harness/identity/git-snapshot.ts GIT_SEGMENT_TITLE = "## Git".
    git: "ctx.git 缝缺席 → 段缺席;或 git 快照退化 (cwd 不可用 / 非 git 仓库 / git 不可用) → provider 返 undefined → 段缺席",
    // The MCP name directory (ADR-0043) is an additive segment (ctx.mcp seam):
    // seam absent / no connected service after filtering → segment absent.
    // See src/harness/identity/assemble.ts mcpNameDirectorySegment.
    mcp_name_directory:
      "ctx.mcp 缝缺席 (ask / 无 manager) → 段缺席;或快照过滤后无 state=connected 服务 → 段缺席",
  };

  /** SSOT-derived anchors: each segment's presence condition comes from its
   *  SSOT constant / render signature. user_profile uses user.md-absence
   *  semantics as its absence condition (userHome read, no user.md →
   *  undefined → the whole segment is absent). */
  const ANCHORS: Record<(typeof IKNOW_ASSEMBLY_ORDER)[number], string> = {
    identity: IKNOW_IDENTITY_DEFAULT,
    soul: IKNOW_SOUL_DEFAULT,
    usage: IKNOW_USAGE_DEFAULT,
    user_profile: "User Profile", // user.md template header (read from ~/.iknow/user.md)
    bootstrap: "First Contact", // BOOTSTRAP.md template header
    memory_layer: "memory_recall", // memory channel marker
  };

  it("condition-segment manifest covers all expected conditional kinds", () => {
    // The manifest covers every IKNOW_ASSEMBLY_ORDER member this test expects
    // to be conditional, preventing a newly added LOCKED segment from silently
    // slipping into the conditional set unregistered. git / mcp_name_directory
    // are additive segments (not in IKNOW_ASSEMBLY_ORDER); registering them
    // here removes the drift between this check and the spec manifest
    // (seam absent → segment absent, conditions above).
    expect(Object.keys(CONDITIONAL_SEGMENTS).sort()).toEqual(
      [
        "bootstrap",
        "memory_layer",
        "user_profile",
        "git",
        "mcp_name_directory",
      ].sort()
    );
  });

  it("ask-like ctx: 无条件 LOCKED 段 (identity/soul/usage) 全部在场", async () => {
    const out = await assembleIdentityContext(baseCtx());
    expect(out).toBeDefined();
    for (const seg of ["identity", "soul", "usage"] as const) {
      expect(out).toContain(ANCHORS[seg]);
    }
  });

  it("ask-like ctx: user_profile 段因 user.md 缺席而缺席 (条件段清单扩展)", async () => {
    const out = await assembleIdentityContext(baseCtx());
    expect(out).toBeDefined();
    // user_profile is the 4th IKNOW_ASSEMBLY_ORDER segment, but current
    // behavior is: userHome/.iknow/user.md missing → segment absent. This is a
    // pre-existing contract, so it is registered here as conditional
    // (absence condition = user.md missing/empty).
    expect(out).not.toContain("User Profile");
  });

  it("chat-like ctx (bootstrapActive=true 但无 BOOTSTRAP.md): bootstrap 缺席属条件段清单", async () => {
    const out = await assembleIdentityContext(chatCtx());
    expect(out).toBeDefined();
    // bootstrapActive=true but BOOTSTRAP.md absent → segment absent.
    // bootstrap is registered as conditional (absence condition = file missing).
    expect(out).not.toContain("First Contact");
  });

  it("chat-like ctx: 无条件 LOCKED 段在场 + memory_layer 缺席 (条件段)", async () => {
    const out = await assembleIdentityContext(chatCtx());
    expect(out).toBeDefined();
    for (const seg of ["identity", "soul", "usage"] as const) {
      expect(out).toContain(ANCHORS[seg]);
    }
    expect(out).not.toContain(ANCHORS.memory_layer);
  });

  it("声明↔产物矩阵:每段要么锚点出现,要么属于条件段清单", async () => {
    const out = await assembleIdentityContext(baseCtx());
    expect(out).toBeDefined();
    for (const seg of IKNOW_ASSEMBLY_ORDER) {
      const anchor = ANCHORS[seg];
      const conditional = seg in CONDITIONAL_SEGMENTS;
      const present = out!.includes(anchor);
      // Proposition: every segment is either present or in the conditional
      // manifest. The two are not exclusive (a conditional segment may be
      // present), but a LOCKED segment must never be both absent and absent
      // from the conditional manifest.
      if (!present) {
        expect(
          conditional,
          `IKNOW_ASSEMBLY_ORDER 段 '${seg}' 在 ask-like 装配产物中缺席,但未登记为条件段。请在 CONDITIONAL_SEGMENTS 注明缺席条件,或修复装配使该段在场。`
        ).toBe(true);
      }
    }
  });
});

describe("usage 段 — KV 缓存字节级稳定契约", () => {
  it("usage 段无条件在场 → 同 ctx 两次装配输出字节级一致", async () => {
    const ctx = baseCtx();
    const a = await assembleIdentityContext(ctx);
    const b = await assembleIdentityContext(ctx);
    expect(b).toBe(a);
  });
});
