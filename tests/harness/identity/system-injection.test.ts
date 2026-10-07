/**
 * Integration test for the build-engine entry chain:
 * surface → deps.system → assembleIdentityContext.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  unlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessEngine } from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import { initializeIknowWorkspace } from "../../../src/harness/identity/index.js";
import type { IknowEnv } from "../../../src/config/env.ts";

// Every case really assembles buildHarnessEngine once (real identity
// assembly + skill scan): ~3s standalone, and under full parallelism
// (forks×3) it can exceed vitest's default 5s — relaxed the same way as
// hub-worktree-isolation / build-engine so assembly time is not misread
// as a failure.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

function makeEnv(apiKey: string | undefined): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    // IknowCompressEnv is required (build-engine forwards it to deps.compress).
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    // MCP connect timeout (default 60_000).
    mcp: { connectTimeoutMs: 60_000 },
    // Subagent config arm (build-engine reads taskTimeoutMs).
    subagent: { taskTimeoutMs: undefined },
    // Roots are supplied explicitly to buildHarnessEngine; the env
    // side keeps its "unset" default.
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

let origHome: string | undefined;
let workDir: string;
// ADR-0019: explicitly injecting workspaceRoot = workDir only serves
// memory/sessions; persona seeding goes through the HOME test seam
// (userHome = workDir).

beforeAll(async () => {
  origHome = process.env.HOME;
  workDir = await mkdtemp(join(tmpdir(), "iknow-identity-test-"));
  process.env.HOME = workDir;
  await mkdir(join(workDir, ".iknow"), { recursive: true });
});

afterAll(async () => {
  process.env.HOME = origHome;
  await rm(workDir, { recursive: true, force: true }).catch(() => {
    /* MCP/npm may still hold files under the fake HOME */
  });
});

async function buildSystem(surface: "chat" | "tui" | "ask" | "serve") {
  const { deps } = await buildHarnessEngine({
    env: makeEnv("sk-test-identity-" + surface),
    askUser: createNoAskUser(),
    surface,
    // ADR-0019: per-root identity seeding anchors on workDir; the old cwd
    // default no longer applies.
    workspaceRoot: workDir,
    // This file verifies deps.system's identity assembly only, not overflow
    // eviction / index demotion. countTokens through the real adapter would
    // hit the unreachable fixture baseUrl; the SDK's built-in maxRetries=2 +
    // backoff would burn ~2.5s per assembly for nothing.
    skipCountTokens: true,
  });
  return (await (deps.system as () => Promise<string | undefined>)()) ?? "";
}

describe("buildHarnessEngine surface → deps.system", () => {
  it("chat: system includes identity + soul + user_profile + bootstrap (not seeded)", async () => {
    const out = await buildSystem("chat");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).toContain("First Contact");
  });

  it("tui: same as chat (bootstrap active)", async () => {
    const out = await buildSystem("tui");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).toContain("First Contact");
  });

  it("ask: system excludes bootstrap but keeps identity/soul/user_profile", async () => {
    const out = await buildSystem("ask");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).not.toContain("First Contact");
  });

  it("serve: bootstrap active (same as chat/tui; 2026-08-08 裁定对话型入口共享身份状态机)", async () => {
    const out = await buildSystem("serve");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).toContain("First Contact");
  });

  it("order: identity < soul < user_profile < bootstrap", async () => {
    const out = await buildSystem("chat");
    expect(out.indexOf("iknow Identity")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("iknow Identity")).toBeLessThan(
      out.indexOf("iknow Soul")
    );
    expect(out.indexOf("iknow Soul")).toBeLessThan(out.indexOf("User Profile"));
    expect(out.indexOf("User Profile")).toBeLessThan(
      out.indexOf("First Contact")
    );
  });

  it("memory_layer slot: no raw #121 segment tokens leak; empty tmp workspace → memory content absent", async () => {
    const out = await buildSystem("chat");
    expect(out).not.toContain("user_agents");
    expect(out).not.toContain("priority_dec");
    expect(out).not.toContain("project_agents");
    expect(out).not.toContain("existence_pointer");
    expect(out).not.toContain("memory_recall(query)");
  });

  it("second skip: BOOTSTRAP.md deleted → system excludes bootstrap", async () => {
    // Implicit completion: the agent rm's BOOTSTRAP.md after the guidance
    // conversation.
    // ADR-0019: explicit workspaceRoot=workDir shares the same per-root
    // identity-seam anchor as buildSystem (the default
    // iknowWorkspaceRoot() = cwd no longer points at workDir).
    await initializeIknowWorkspace({ workspace: join(workDir, ".iknow") });
    await unlink(join(process.env.HOME!, ".iknow", "BOOTSTRAP.md"));
    const out = await buildSystem("chat");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).not.toContain("First Contact");
  });

  it("default surface (no opts.surface) is chat → bootstrap active when file present", async () => {
    // File-driven: BOOTSTRAP.md present → injected. The previous test
    // unlink'ed the file; here we re-seed it (bs=true already flipped, but a
    // missing file → no injection; recreated file → injection).
    // ADR-0019: workspaceRoot=workDir anchors per-root identity (the old cwd
    // default no longer applies).
    await initializeIknowWorkspace({ workspace: join(workDir, ".iknow") });
    await writeFile(
      join(process.env.HOME!, ".iknow", "BOOTSTRAP.md"),
      "# BOOTSTRAP.md - First Contact\n\nseed again"
    );
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-identity-default"),
      askUser: createNoAskUser(),
      workspaceRoot: workDir,
      skipCountTokens: true,
    });
    const out =
      (await (deps.system as () => Promise<string | undefined>)()) ?? "";
    expect(out).toContain("First Contact");
  });

  it("ask: memory_layer inactive — deps.system still carries identity layers", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-identity-ask-mem"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
      workspaceRoot: workDir,
      skipCountTokens: true,
    });
    expect(typeof deps.system).toBe("function");
    const out = (await deps.system?.()) ?? "";
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).not.toContain("memory_recall(query)");
  });

  it("negative: workspaceRoot/cwd does not receive user.md seed (#584 T2)", async () => {
    const project = await mkdtemp(join(tmpdir(), "iknow-identity-proj-"));
    try {
      const { deps, shutdown } = await buildHarnessEngine({
        env: makeEnv("sk-test-identity-global-home"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: project,
        workspaceRoot: project,
      });
      try {
        await readFile(join(workDir, ".iknow", "user.md"), "utf8");
        await expect(
          readFile(join(project, ".iknow", "user.md"), "utf8")
        ).rejects.toThrow();
        const out =
          (await (deps.system as () => Promise<string | undefined>)()) ?? "";
        expect(out).toContain("User Profile");
        expect(out).not.toContain(join(project, ".iknow"));
      } finally {
        await shutdown?.();
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
