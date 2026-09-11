/**
 * git 作业加性纪律段（specs/git-work.md）。
 *
 * 行为真值:
 *   - 加性段，不触碰 IKNOW_ASSEMBLY_ORDER 六段 LOCKED。
 *   - isolation ON → chat / tui / serve 含标题与本地作业要点。
 *   - ask 即使传入 gitWorkDiscipline 也不注入（无工作树工具）。
 *   - gate 缺席 / OFF → 段缺席，不写空串，不补「如何用 git」教程。
 *   - 正文不含 push / network / force-push。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  IKNOW_ASSEMBLY_ORDER,
  IKNOW_GIT_WORK_TEXT,
  assembleIdentityContext,
  createIknowSystemResolver,
  type AssemblyContext,
} from "../../../src/harness/identity/assemble.ts";

let origHome: string | undefined;
let workDir: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  workDir = await mkdtemp(join(tmpdir(), "iknow-git-work-"));
  await mkdir(join(workDir, ".iknow"), { recursive: true });
  process.env.HOME = workDir;
});

afterAll(async () => {
  process.env.HOME = origHome;
  await rm(workDir, { recursive: true, force: true });
});

function baseCtx(extra?: Partial<AssemblyContext>): AssemblyContext {
  return {
    cwd: workDir,
    projectIdentityRoot: workDir,
    userHome: workDir,
    bootstrapActive: false,
    memoryEnabled: false,
    ...extra,
  };
}

function resolver(
  surface: "chat" | "tui" | "ask" | "serve",
  extra?: { gitWorkDiscipline?: boolean }
) {
  return createIknowSystemResolver({
    cwd: workDir,
    projectIdentityRoot: workDir,
    userHome: workDir,
    surface,
    memoryEnabled: false,
    ...(extra?.gitWorkDiscipline ? { gitWorkDiscipline: true } : {}),
  });
}

function expectGitWorkPoints(out: string): void {
  expect(out).toContain("## Git work");
  expect(out).toContain(IKNOW_GIT_WORK_TEXT);
  expect(out).toContain("bash");
  expect(out).toContain("create-worktree");
  expect(out).toContain("--no-verify");
  expect(out).toMatch(/readonly|read-only/i);
  expect(out).not.toContain("network: true");
  expect(out).not.toMatch(/force-push|force push|--force-with-lease/i);
  expect(IKNOW_GIT_WORK_TEXT).not.toMatch(/git push|optional push/i);
  expect(IKNOW_GIT_WORK_TEXT).not.toMatch(/Isolation off/i);
}

describe("git work additive segment — LOCKED order", () => {
  it("does not reorder IKNOW_ASSEMBLY_ORDER (six LOCKED segments)", () => {
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

describe("git work additive segment — isolation ON parent surfaces", () => {
  it("chat assembly with gitWorkDiscipline includes title and local SOP points", async () => {
    const out = (await resolver("chat", { gitWorkDiscipline: true })()) ?? "";
    expectGitWorkPoints(out);
  });

  it("tui and serve assembly with gitWorkDiscipline include the same segment body", async () => {
    const tui = (await resolver("tui", { gitWorkDiscipline: true })()) ?? "";
    const serve =
      (await resolver("serve", { gitWorkDiscipline: true })()) ?? "";
    expectGitWorkPoints(tui);
    expectGitWorkPoints(serve);
  });

  it("ask omits the segment even when gitWorkDiscipline is passed", async () => {
    const out = (await resolver("ask", { gitWorkDiscipline: true })()) ?? "";
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("## Git work");
    expect(out).not.toContain(IKNOW_GIT_WORK_TEXT);
  });
});

describe("git work additive segment — absence does not write empty system", () => {
  it("gate absent → no Git work heading; baseline system still defined", async () => {
    const baseline = await assembleIdentityContext(baseCtx());
    expect(baseline).toBeDefined();
    expect(baseline).not.toBe("");
    expect(baseline).not.toContain("## Git work");
  });

  it("gitWorkDiscipline false/undefined matches baseline byte-for-byte", async () => {
    const baseline = await assembleIdentityContext(baseCtx());
    const undef = await assembleIdentityContext({
      ...baseCtx(),
      gitWorkDiscipline: undefined,
    });
    const off = await assembleIdentityContext({
      ...baseCtx(),
      gitWorkDiscipline: false,
    });
    expect(undef).toBe(baseline);
    expect(off).toBe(baseline);
    expect(off).not.toContain("## Git work");
  });

  it("createIknowSystemResolver without gitWorkDiscipline omits the segment", async () => {
    const out = (await resolver("chat")()) ?? "";
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("## Git work");
  });
});

describe("git work additive segment — immutable body (concurrent/pure)", () => {
  it("two assembly calls with the same constant yield identical text", async () => {
    const a = await assembleIdentityContext(
      baseCtx({ gitWorkDiscipline: true })
    );
    const b = await assembleIdentityContext(
      baseCtx({ gitWorkDiscipline: true })
    );
    expect(a).toBe(b);
    expect(a).toContain(IKNOW_GIT_WORK_TEXT);
  });
});
