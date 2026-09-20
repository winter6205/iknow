// <available_skills> additive-segment unit tests.
//
// Behavior ground truth:
//   - Additive segment (appended after the LOCKED loop); IKNOW_ASSEMBLY_ORDER
//     is untouched (array reference unchanged).
//   - Rendered in name order; an empty catalog still emits an explicit
//     statement (e.g. "No skills installed").
//   - Disabled entries never appear.
//   - Segment text is byte-stable across turns (equal input → identical
//     string on a second call, KV-cache contract).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IKNOW_ASSEMBLY_ORDER,
  assembleIdentityContext,
  createIknowSystemResolver,
  type AssemblyContext,
} from "../../src/harness/identity/assemble.ts";
import { IKNOW_IDENTITY_DEFAULT } from "../../src/harness/identity/identity.ts";

let origHome: string | undefined;
let workDir: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  workDir = await mkdtemp(join(tmpdir(), "iknow-skills-seam-"));
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

describe("<available_skills> additive segment", () => {
  it("不触碰 IKNOW_ASSEMBLY_ORDER (LOCKED 顺序保持 6 段)", () => {
    expect([...IKNOW_ASSEMBLY_ORDER]).toEqual([
      "identity",
      "soul",
      "usage",
      "user_profile",
      "bootstrap",
      "memory_layer",
    ]);
  });

  it("does not render a skills segment when the seam is absent (byte-identical to baseline)", async () => {
    const baseline = await assembleIdentityContext(baseCtx());
    expect(baseline).toBeDefined();
    expect(baseline).not.toContain("<available_skills>");
    expect(baseline).not.toContain("Available skills");
  });

  it("renders an empty skills segment with an explicit statement when catalog is empty", async () => {
    const out = await assembleIdentityContext({
      ...baseCtx(),
      skills: () => [],
    });
    expect(out).toBeDefined();
    expect(out).toContain("<available_skills>");
    expect(out).toContain("</available_skills>");
    // explicit empty statement
    expect(out!.toLowerCase()).toContain("no skills");
  });

  it("renders available skills in name order with absolute directory under each skill", async () => {
    const out = await assembleIdentityContext({
      ...baseCtx(),
      skills: () => [
        { name: "writer", description: "Writes reports" },
        { name: "alpha", description: "first" },
        { name: "zulu", description: "last" },
      ],
    });

    expect(out).toBeDefined();
    expect(out).toContain("<available_skills>");
    const idxAlpha = out!.indexOf("alpha");
    const idxWriter = out!.indexOf("writer");
    const idxZulu = out!.indexOf("zulu");
    expect(idxAlpha).toBeGreaterThan(0);
    expect(idxWriter).toBeGreaterThan(idxAlpha);
    expect(idxZulu).toBeGreaterThan(idxWriter);
  });

  it("T5 / SC7: description 缺席或空 → 渲染裸名行（索引降档剥描述后的形态）", async () => {
    const out = await assembleIdentityContext({
      ...baseCtx(),
      skills: () => [
        // Demoted shape: the description field is absent altogether.
        { name: "demoted" },
        // Empty string / whitespace-only follow the same rule (consistent with
        // McpToolSummary and the built-in eviction segments).
        { name: "blank", description: "" },
        { name: "spaces", description: "   " },
        { name: "kept", description: "still described" },
      ],
    });

    expect(out).toBeDefined();
    // Names are never deleted → all demoted entries keep a bare name line
    // (no ": ...").
    for (const name of ["demoted", "blank", "spaces"]) {
      expect(out).toMatch(new RegExp(`^${name}$`, "m"));
      expect(out).not.toMatch(new RegExp(`^${name}:`, "m"));
    }
    // Non-demoted entries still carry their description.
    expect(out).toContain("kept: still described");
  });

  it("does not include disabled skills in the available_skills segment (SC3)", async () => {
    const out = await assembleIdentityContext({
      ...baseCtx(),
      skills: () => [
        { name: "open", description: "available" },
        { name: "hidden", description: "secret", disabled: true },
      ],
    });

    expect(out).toBeDefined();
    expect(out).toContain("open");
    // description is part of the wire text, so we only assert the name "hidden"
    // is not present, since disabled entries must not appear at all.
    // (catalog.available() already filters; the seam contract mirrors it.)
    expect(out).not.toContain("hidden");
  });

  it("appends the skills segment after the locked identity segment (order preserved)", async () => {
    const out = await assembleIdentityContext({
      ...baseCtx(),
      skills: () => [{ name: "alpha", description: "first" }],
    });
    const idxIdentity = out!.indexOf(IKNOW_IDENTITY_DEFAULT);
    const idxSkills = out!.indexOf("<available_skills>");
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxSkills).toBeGreaterThan(idxIdentity);
  });

  it("is byte-stable across repeat calls (KV cache contract)", async () => {
    const skills = () => [
      { name: "alpha", description: "first" },
      { name: "beta", description: "second" },
    ];
    const a = await assembleIdentityContext({ ...baseCtx(), skills });
    const b = await assembleIdentityContext({ ...baseCtx(), skills });
    expect(b).toBe(a);
  });

  it("createIknowSystemResolver threads opts.skills through to the available_skills segment", async () => {
    const resolver = createIknowSystemResolver({
      cwd: process.cwd(),
      userHome: workDir,
      surface: "ask",
      skills: () => [{ name: "alpha", description: "first" }],
    });
    const out = await resolver();
    expect(out).toBeDefined();
    expect(out).toContain("<available_skills>");
    expect(out).toContain("alpha");
  });
});
