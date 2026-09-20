/**
 * Unit tests for the identity assembly's tool-catalog injection seam.
 *
 * This phase wires an empty shell — verifies three things:
 *  1) seam absent → output byte-identical to the existing pipeline
 *     (KV-cache stability contract).
 *  2) seam present returning a non-empty catalog → catalog segment appended;
 *     base segments kept, order unchanged.
 *  3) seam returning [] / undefined → skipped; byte-identical to absent.
 *
 * Test strategy: never read ~/.iknow/ (temp HOME, user.md / state.json both
 * absent, so user_profile + bootstrap naturally return undefined). Therefore
 * segments always contain exactly IKNOW_IDENTITY_DEFAULT +
 * IKNOW_SOUL_DEFAULT as anchors for the order assertions.
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
  // Deliberately mkdir but do NOT initIknowWorkspace — user.md and
  // state.json both absent, so user_profile / bootstrap return undefined and
  // the base is only identity + soul.
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
    bootstrapActive: false, // disable BOOTSTRAP segment; base is identity + soul only
  };
}

describe("#224 W4 tool-list injection seam (empty shell)", () => {
  it("seam absent (no toolList field) → output is baseline", async () => {
    const out = await assembleIdentityContext(baseCtx());
    expect(out).toBeDefined();
    // base identity segments must appear
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
    // base identity segments kept
    expect(out).toContain(IKNOW_IDENTITY_DEFAULT);
    expect(out).toContain(IKNOW_SOUL_DEFAULT);
    // catalog segment text present
    expect(out).toContain("Available tools:");
    expect(out).toContain("bash");
    expect(out).toContain("read_file");
    expect(out).toContain("glob");
    // LOCKED order: base segments < catalog segment. Base identity < soul
    // (pre-existing); the catalog segment is appended last.
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
    // base segments still present
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
    // and confirm no catalog segment (KV-cache stability contract: build-engine
    // does not pass the seam yet → nothing renders)
    expect(a).not.toContain("Available tools:");
  });
});
