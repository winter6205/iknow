/**
 * #228 / SC16: memory_layer slot 降级契约 — 对齐 #196 readUserProfile 模式
 * (assemble.ts:117-131)：resolver throw → warn + skip + 不毒化下一 turn。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  assembleIdentityContext,
  createIknowSystemResolver,
} from "../../../src/harness/identity/assemble.ts";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory_layer slot — resolver 降级契约", () => {
  afterEach(() => vi.restoreAllMocks());

  it("staticInstructions=true + memoryEnabled=false → 注入项目说明书且不启用记忆", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "iknow-static-project-"));
    const userHome = await mkdtemp(join(tmpdir(), "iknow-static-home-"));
    try {
      const marker = "PROJECT_STATIC_INSTRUCTIONS";
      await writeFile(join(cwd, "AGENTS.md"), marker);
      const resolver = createIknowSystemResolver({
        cwd,
        projectIdentityRoot: cwd,
        userHome,
        surface: "ask",
        memoryEnabled: false,
        staticInstructions: true,
      });

      const out = (await resolver()) ?? "";

      expect(out).toContain(marker);
      expect(out).not.toContain("memory_recall");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(userHome, { recursive: true, force: true });
    }
  });

  it("memoryEnabled=false → memory_layer absent (ask 全 opt-out)", async () => {
    const resolver = createIknowSystemResolver({
      cwd: "/tmp",
      projectIdentityRoot: "/tmp",
      userHome: "/tmp",
      surface: "ask",
      memoryEnabled: false,
    });
    const out = (await resolver()) ?? "";
    expect(out).toContain("iknow Identity");
    expect(out).not.toContain("memory_recall(query)");
  });

  it("resolver throws → console.warn emitted, undefined returned, no rethrow", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolver = createIknowSystemResolver({
      cwd: "/tmp",
      projectIdentityRoot: "/tmp",
      userHome: "/tmp",
      surface: "ask",
      memoryEnabled: true,
      memoryResolver: async () => {
        throw new Error("resolver boom");
      },
    });
    const out = (await resolver()) ?? "";
    expect(out).toContain("iknow Identity"); // identity 层不受影响
    expect(out).not.toContain("resolver boom"); // 错误内容不入 prompt
    expect(warn).toHaveBeenCalled();
    const warnMsg = warn.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(warnMsg).toContain("memory_layer resolver failed");
  });

  it("memoryEnabled=true 但 memoryResolver 缺席 → memory_layer absent, 不抛", async () => {
    const resolver = createIknowSystemResolver({
      cwd: "/tmp",
      projectIdentityRoot: "/tmp",
      userHome: "/tmp",
      surface: "ask",
      memoryEnabled: true,
    });
    const out = (await resolver()) ?? "";
    expect(out).toContain("iknow Identity");
    expect(out).not.toContain("memory_recall(query)");
  });
});

// #584 T2: persona files live only under userHome/.iknow (ignore workspaceRoot).
describe("assemble persona root is userHome (issue #584 T2)", () => {
  it("empty: missing user.md skips user_profile segment", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-assemble-empty-"));
    try {
      const out =
        (await assembleIdentityContext({
          cwd: home,
          projectIdentityRoot: home,
          userHome: home,
          workspaceRoot: join(home, "project"),
          bootstrapActive: false,
          memoryEnabled: false,
        })) ?? "";
      expect(out).toContain("iknow Identity");
      expect(out).not.toContain("User Profile");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("negative: workspaceRoot/.iknow/user.md is not assembled", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-assemble-home-"));
    const project = await mkdtemp(join(tmpdir(), "iknow-assemble-proj-"));
    try {
      await mkdir(join(home, ".iknow"), { recursive: true });
      await mkdir(join(project, ".iknow"), { recursive: true });
      await writeFile(join(home, ".iknow", "user.md"), "HOME_PERSONA_MARKER\n");
      await writeFile(
        join(project, ".iknow", "user.md"),
        "PROJECT_PERSONA_MARKER\n"
      );
      const out =
        (await assembleIdentityContext({
          cwd: project,
          projectIdentityRoot: project,
          userHome: home,
          workspaceRoot: project,
          bootstrapActive: true,
          memoryEnabled: false,
        })) ?? "";
      expect(out).toContain("HOME_PERSONA_MARKER");
      expect(out).not.toContain("PROJECT_PERSONA_MARKER");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it("negative: workspaceRoot BOOTSTRAP.md is ignored; home file is assembled", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-assemble-bs-home-"));
    const project = await mkdtemp(join(tmpdir(), "iknow-assemble-bs-proj-"));
    try {
      await mkdir(join(home, ".iknow"), { recursive: true });
      await mkdir(join(project, ".iknow"), { recursive: true });
      await writeFile(
        join(home, ".iknow", "BOOTSTRAP.md"),
        "HOME_BOOTSTRAP_MARKER First Contact\n"
      );
      await writeFile(
        join(project, ".iknow", "BOOTSTRAP.md"),
        "PROJECT_BOOTSTRAP_MARKER First Contact\n"
      );
      const out =
        (await assembleIdentityContext({
          cwd: project,
          projectIdentityRoot: project,
          userHome: home,
          workspaceRoot: project,
          bootstrapActive: true,
          memoryEnabled: false,
        })) ?? "";
      expect(out).toContain("HOME_BOOTSTRAP_MARKER");
      expect(out).not.toContain("PROJECT_BOOTSTRAP_MARKER");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it("overflow: extra-long userHome does not throw (warn + skip)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const longHome = join("/tmp", "x".repeat(8000));
    const out = await assembleIdentityContext({
      cwd: "/tmp",
      projectIdentityRoot: "/tmp",
      userHome: longHome,
      workspaceRoot: "/tmp/short-project",
      bootstrapActive: true,
      memoryEnabled: false,
    });
    expect(out).toBeDefined();
    expect(typeof out).toBe("string");
    warn.mockRestore();
  });

  it("exception: unreadable user.md skips + warns, does not throw", async () => {
    const home = await mkdtemp(join(tmpdir(), "iknow-assemble-exc-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(home, ".iknow"), { recursive: true });
      // Directory at user.md path → EISDIR on read
      await mkdir(join(home, ".iknow", "user.md"));
      await expect(
        assembleIdentityContext({
          cwd: home,
          projectIdentityRoot: home,
          userHome: home,
          workspaceRoot: join(home, "project"),
          bootstrapActive: false,
          memoryEnabled: false,
        })
      ).resolves.toBeDefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });
});
