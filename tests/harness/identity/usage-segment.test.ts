/**
 * model-prefix-layering B1 (spec Boundaries #1, plan B1):
 *
 *   1. T0 usage 段修复:resolveSegment 补 case "usage" → IKNOW_USAGE_DEFAULT,
 *      所有 surface (chat / tui / serve / ask) 同注入。装配产物必含 usage 段
 *      文本 (代码 LOCKED, IKNOW-symbol-primary T1)。
 *   2. 断言 ① —— 声明↔产物一致性:IKNOW_ASSEMBLY_ORDER 每个声明段必须出现
 *      在装配产物,或属于显式条件段清单 (本 bullet 初版:bootstrap / memory_layer)。
 *      条件段清单为组装不变量 —— 新加条件段必须在此说明缺席条件;不加说明
 *      = 该段必须无条件在场 (LOCKED 段的行为契约)。
 *
 * 锚点:从 IKNOW_ASSEMBLY_ORDER + SSOT 常量派生,不硬编码段名数组。
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

/** Default 测试 ctx:surface=ask 的等价最小集 (bootstrapActive=false / memoryEnabled=false)。
 *  T0 用例需要 bootstrap 缺席以让 "bootstrap" 进条件段清单。 */
function baseCtx(): AssemblyContext {
  return {
    cwd: process.cwd(),
    projectIdentityRoot: process.cwd(),
    userHome: workDir,
    bootstrapActive: false,
    memoryEnabled: false,
  };
}

/** Chat/tui/serve 等价 ctx:bootstrapActive=true + memoryEnabled=false。 */
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
  /** 条件段清单 (初版):segment 名 → 缺席条件。SSOT 集中在 describe 顶部,
   *  后续 bullet (git 块 / MCP 名字目录) 在此追加 + 注明引用。 */
  const CONDITIONAL_SEGMENTS: Record<string, string> = {
    bootstrap:
      "bootstrapActive=false → 段缺席 (ask surface);或 BOOTSTRAP.md 文件缺失/空 → 段缺席 (chat/tui/serve)",
    user_profile:
      "userHome/.iknow/user.md 缺失/空 → 段缺席 (assemble.ts:346-361 readUserProfile 行为契约)",
    memory_layer:
      "memoryEnabled=false → 段缺席 (或 memoryResolver 缺席/抛错 → warn + skip)",
    // B5 引入 → 当前未在场:不参与本测试断言,仅为后续 bullet 预留声明位。
    // B4 引入 MCP 名字目录 → 同上。
  };

  /** SSOT 派生锚点:从 IKNOW_ASSEMBLY_ORDER 各段的 SSOT 常量 / 渲染特征派生
   *  出现条件。user_profile 用 user.md 缺席语义作为缺席条件 (已读 userHome,
   *  无 user.md → undefined → 段整体不出现)。 */
  const ANCHORS: Record<(typeof IKNOW_ASSEMBLY_ORDER)[number], string> = {
    identity: IKNOW_IDENTITY_DEFAULT,
    soul: IKNOW_SOUL_DEFAULT,
    usage: IKNOW_USAGE_DEFAULT,
    user_profile: "User Profile", // user.md 模板头 (模板从 ~/.iknow/user.md 读)
    bootstrap: "First Contact", // BOOTSTRAP.md 模板头
    memory_layer: "memory_recall", // memory 通道标识
  };

  it("condition-segment manifest covers all expected conditional kinds", () => {
    // 清单覆盖 IKNOW_ASSEMBLY_ORDER 中本测试预期为条件段的所有成员,
    // 防止新增 LOCKED 段默默归入条件段集合而漏登记。
    expect(Object.keys(CONDITIONAL_SEGMENTS).sort()).toEqual(
      ["bootstrap", "memory_layer", "user_profile"].sort()
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
    // user_profile 是 IKNOW_ASSEMBLY_ORDER 第 4 段,但当前行为是
    // userHome/.iknow/user.md 不存在 → 段缺席。这是已存在契约 (assemble.ts:346-361),
    // 视为条件段 (缺席条件 = user.md missing/empty),在此登记。
    expect(out).not.toContain("User Profile");
  });

  it("chat-like ctx (bootstrapActive=true 但无 BOOTSTRAP.md): bootstrap 缺席属条件段清单", async () => {
    const out = await assembleIdentityContext(chatCtx());
    expect(out).toBeDefined();
    // bootstrapActive=true 但 BOOTSTRAP.md 不存在 → 段缺席 (assemble.ts:367-386)。
    // bootstrap 进条件段清单 (缺席条件 = file missing),登记于此。
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
      // 命题:每段要么在场,要么属于条件段清单。两者不互斥 (条件段也可在场),
      // 但 LOCKED 段绝不可"既缺席又不在条件段清单中"。
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
