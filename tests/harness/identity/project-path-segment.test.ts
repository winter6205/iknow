/**
 * identity assembly — additive "## Project path" segment.
 *
 * The agent has no direct way to know its own project path (cwd) from the
 * system prompt; it would otherwise have to run `bash pwd` (execute → ask).
 * The assembly injects an additive segment that renders the **stable**
 * `projectIdentityRoot` (ADR-0037) so the agent can sense which
 * project it is in by default without exposing the rebind-volatile live
 * taskRoot — that surface belongs to the `env_snapshot` stream.
 *
 * Additive, parallel to `toolListSegment`: does NOT touch IKNOW_ASSEMBLY_ORDER
 * (locked at 5: identity / soul / user_profile / bootstrap / memory_layer).
 * projectIdentityRoot is constant per process → output stays byte-stable
 * across turns AND across rebinds (KV cache contract preserved).
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

let workDir: string;
let origHome: string | undefined;

beforeAll(async () => {
  origHome = process.env.HOME;
  workDir = await mkdtemp(join(tmpdir(), "iknow-project-path-"));
  await mkdir(join(workDir, ".iknow"), { recursive: true });
  process.env.HOME = workDir;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await rm(workDir, { recursive: true, force: true });
});

/** Default `projectIdentityRoot` = `cwd` for tests that don't care about
 *  byte-stability across rebinds. Byte-stability tests must pass an explicit,
 *  separate `projectIdentityRoot`. */
function baseCtx(cwd: string): AssemblyContext {
  return {
    cwd,
    projectIdentityRoot: cwd,
    userHome: workDir,
    bootstrapActive: false,
  };
}

describe("identity assembly — project path additive segment", () => {
  it("renders the configured project path (agent senses which project it is in)", async () => {
    const fakePath = "/some/project/dir";
    const out = await assembleIdentityContext(baseCtx(fakePath));
    expect(out).toBeDefined();
    expect(out).toContain("## Project path");
    expect(out).toContain(fakePath);
  });

  it("project path segment appears AFTER the locked identity segment (order preserved)", async () => {
    const out = await assembleIdentityContext(baseCtx("/x"));
    const idxIdentity = out!.indexOf(IKNOW_IDENTITY_DEFAULT);
    const idxPath = out!.indexOf("## Project path");
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxPath).toBeGreaterThan(idxIdentity);
  });

  it("createIknowSystemResolver threads projectIdentityRoot through to the project path segment", async () => {
    const fakePath = "/another/project";
    const resolver = createIknowSystemResolver({
      cwd: fakePath,
      projectIdentityRoot: fakePath,
      userHome: workDir,
      surface: "ask",
    });
    const out = await resolver();
    expect(out).toBeDefined();
    expect(out).toContain("## Project path");
    expect(out).toContain(fakePath);
  });

  it("uses the real process cwd by default in the resolver (no override)", async () => {
    const resolver = createIknowSystemResolver({
      cwd: process.cwd(),
      projectIdentityRoot: process.cwd(),
      userHome: workDir,
      surface: "ask",
    });
    const out = await resolver();
    expect(out).toContain("## Project path");
    expect(out).toContain(process.cwd());
  });

  // ── ADR-0037 acceptance ────────────────────────────────────────────────
  // The "## Project path" segment must pin the stable projectIdentityRoot —
  // even after the active cwd (== live taskRoot) flips on rebind, the segment
  // stays byte-identical so the KV-cache prefix does not churn.
  it("T9: 活 taskRoot 翻转前后 system prompt 字节级不变(## Project path 钉稳定根)", async () => {
    const stableRoot = "/stable/project-identity";
    const beforeRebind = await assembleIdentityContext({
      cwd: "/active/worktree-before",
      projectIdentityRoot: stableRoot,
      userHome: workDir,
      bootstrapActive: false,
    });
    const afterRebind = await assembleIdentityContext({
      cwd: "/active/worktree-after",
      projectIdentityRoot: stableRoot,
      userHome: workDir,
      bootstrapActive: false,
    });

    expect(beforeRebind).toBeDefined();
    expect(afterRebind).toBeDefined();
    // The whole system prompt is byte-identical, not just the Project path
    // segment — the live taskRoot could only ever be injected there, and it
    // has been switched to the stable root.
    expect(afterRebind).toBe(beforeRebind);
    // While "## Project path" renders the stable root, no active-cwd field
    // may leak (neither before/after active cwd appears in the system prompt).
    expect(beforeRebind).toContain(`## Project path\n${stableRoot}`);
    expect(beforeRebind).not.toContain("/active/worktree-before");
    expect(beforeRebind).not.toContain("/active/worktree-after");
  });
});
