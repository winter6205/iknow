/**
 * identity assembly — additive "## Project path" segment.
 *
 * The agent has no direct way to know its own project path (cwd) from the
 * system prompt; it would otherwise have to run `bash pwd` (execute → ask).
 * The assembly now injects an additive segment that renders cwd so the agent
 * can sense which project it is in by default.
 *
 * Additive, parallel to `toolListSegment`: does NOT touch IKNOW_ASSEMBLY_ORDER
 * (locked at 6: identity / soul / usage / user_profile / bootstrap / memory_layer).
 * cwd is constant per process → output stays byte-stable across turns (KV
 * cache contract preserved).
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
import { IKNOW_USAGE_DEFAULT } from "../../../src/harness/identity/usage.ts";

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

function baseCtx(cwd: string): AssemblyContext {
  return {
    cwd,
    userHome: workDir,
    bootstrapActive: false,
  };
}

describe("identity assembly — project path additive segment", () => {
  it("renders the configured cwd (agent senses which project it is in)", async () => {
    const fakeCwd = "/some/project/dir";
    const out = await assembleIdentityContext(baseCtx(fakeCwd));
    expect(out).toBeDefined();
    expect(out).toContain("## Project path");
    expect(out).toContain(fakeCwd);
  });

  it("project path segment appears AFTER the locked identity segment (order preserved)", async () => {
    const out = await assembleIdentityContext(baseCtx("/x"));
    const idxIdentity = out!.indexOf(IKNOW_IDENTITY_DEFAULT);
    const idxPath = out!.indexOf("## Project path");
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxPath).toBeGreaterThan(idxIdentity);
  });

  it("project path segment appears AFTER the 6-segment LOCKED base (usage last)", async () => {
    const out = await assembleIdentityContext(baseCtx("/x"));
    const idxUsage = out!.indexOf(IKNOW_USAGE_DEFAULT);
    const idxPath = out!.indexOf("## Project path");
    expect(idxUsage).toBeGreaterThanOrEqual(0);
    expect(idxPath).toBeGreaterThan(idxUsage);
  });

  it("createIknowSystemResolver threads cwd through to the project path segment", async () => {
    const fakeCwd = "/another/project";
    const resolver = createIknowSystemResolver({
      cwd: fakeCwd,
      userHome: workDir,
      surface: "ask",
    });
    const out = await resolver();
    expect(out).toBeDefined();
    expect(out).toContain("## Project path");
    expect(out).toContain(fakeCwd);
  });

  it("uses the real process cwd by default in the resolver (no override)", async () => {
    const resolver = createIknowSystemResolver({
      cwd: process.cwd(),
      userHome: workDir,
      surface: "ask",
    });
    const out = await resolver();
    expect(out).toContain("## Project path");
    expect(out).toContain(process.cwd());
  });
});
