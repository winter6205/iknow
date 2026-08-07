/**
 * #224 W4:identity 装配层 工具名录段注入缝 单测。
 *
 * 本期为空壳接线 — 验证三件事:
 *  1) seam 缺席 → 输出与既有流水线字节级一致 (KV 缓存稳定契约)。
 *  2) seam 提供且返回非空名录 → 追加名录段;基底段保留 + 顺序不变。
 *  3) seam 返回空数组 / undefined → 跳过;字节级与缺席一致。
 *
 * 测试策略:不读 ~/.iknow/(临时 HOME,user.md / state.json 均缺席,
 * user_profile + bootstrap 自然返回 undefined),所以 segments 必有
 * IKNOW_IDENTITY_DEFAULT + IKNOW_SOUL_DEFAULT 两段,便于锚定顺序断言。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleIdentityContext,
  createIknowSystemResolver,
  type AssemblyContext,
} from "../../../src/harness/identity/assemble.ts";
import { IKNOW_IDENTITY_DEFAULT } from "../../../src/harness/identity/identity.ts";
import { IKNOW_SOUL_DEFAULT } from "../../../src/harness/identity/soul.ts";

let origHome: string | undefined;
let workDir: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  workDir = await mkdtemp(join(tmpdir(), "iknow-tool-list-seam-"));
  // 故意 mkdir 但**不** initIknowWorkspace —— user.md 与 state.json 均缺席,
  // user_profile / bootstrap 自然返回 undefined,基底只有 identity + soul。
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
    bootstrapActive: false, // 关掉 BOOTSTRAP 段,基底只剩 identity + soul
  };
}

describe("#224 W4 tool-list injection seam (empty shell)", () => {
  it("seam absent (no toolList field) → output is baseline", async () => {
    const out = await assembleIdentityContext(baseCtx());
    expect(out).toBeDefined();
    // 基底恒等段必须出现
    expect(out).toContain(IKNOW_IDENTITY_DEFAULT);
    expect(out).toContain(IKNOW_SOUL_DEFAULT);
  });

  it("seam absent is byte-identical to seam present returning undefined", async () => {
    const baseline = await assembleIdentityContext(baseCtx());
    const withSeamUndef = await assembleIdentityContext({
      ...baseCtx(),
      toolList: () => undefined,
    });
    expect(withSeamUndef).toBe(baseline);
  });

  it("seam present returning empty array → byte-identical to absent", async () => {
    const baseline = await assembleIdentityContext(baseCtx());
    const withEmpty = await assembleIdentityContext({
      ...baseCtx(),
      toolList: () => [],
    });
    expect(withEmpty).toBe(baseline);
  });

  it("seam present returning non-empty array → tool names appear, order appended", async () => {
    const out = await assembleIdentityContext({
      ...baseCtx(),
      toolList: () => ["bash", "read_file", "glob"],
    });
    expect(out).toBeDefined();
    // 基底恒等段保留
    expect(out).toContain(IKNOW_IDENTITY_DEFAULT);
    expect(out).toContain(IKNOW_SOUL_DEFAULT);
    // 名录段文本存在
    expect(out).toContain("Available tools:");
    expect(out).toContain("bash");
    expect(out).toContain("read_file");
    expect(out).toContain("glob");
    // 顺序 LOCKED:基底段 < 名录段。基底 identity < soul(既有),
    // 名录段 append 在最末。
    const idxIdentity = out!.indexOf(IKNOW_IDENTITY_DEFAULT);
    const idxSoul = out!.indexOf(IKNOW_SOUL_DEFAULT);
    const idxHeader = out!.indexOf("Available tools:");
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxSoul).toBeGreaterThan(idxIdentity);
    expect(idxHeader).toBeGreaterThan(idxSoul);
  });

  it("createIknowSystemResolver opts.toolList threads through to assemble output", async () => {
    const resolver = createIknowSystemResolver({
      cwd: process.cwd(),
      userHome: workDir,
      surface: "ask", // ask surface → bootstrapActive=false
      toolList: () => ["alpha", "beta"],
    });
    const out = await resolver();
    expect(out).toBeDefined();
    expect(out).toContain("Available tools:");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    // 基底段仍在
    expect(out).toContain(IKNOW_IDENTITY_DEFAULT);
  });

  it("createIknowSystemResolver without opts.toolList → byte-identical to undefined-returning seam", async () => {
    const resolverBaseline = createIknowSystemResolver({
      cwd: process.cwd(),
      userHome: workDir,
      surface: "ask",
    });
    const resolverSeamUndef = createIknowSystemResolver({
      cwd: process.cwd(),
      userHome: workDir,
      surface: "ask",
      toolList: () => undefined,
    });
    const a = await resolverBaseline();
    const b = await resolverSeamUndef();
    expect(b).toBe(a);
    // 且确认不含名录段(守 KV 缓存稳定契约:build-engine 暂不传 → 不渲染)
    expect(a).not.toContain("Available tools:");
  });
});
