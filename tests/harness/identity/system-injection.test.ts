/**
 * #196 IKNOW T4: build-engine 4 入口 surface → deps.system → assembleIdentityContext
 * 链路集成测试。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
    web: { searchUrl: undefined },
    // #119 T7: IknowCompressEnv 必填(T1 接入),build-engine 透传给 deps.compress。
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    // #378 根因 B: MCP 连接超时(默认 60_000)。
    mcp: { connectTimeoutMs: 60_000 },
    // #358 T2: subagent 配置臂 (build-engine 读取 taskTimeoutMs)。
    subagent: { taskTimeoutMs: undefined },
  };
}

let origHome: string | undefined;
let workDir: string;
// ADR-0019 (T2): 显式注入 workspaceRoot = workDir 只服务 memory/sessions;
// persona seed 走 HOME 测试缝 (userHome = workDir)。

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
    // ADR-0019 (T2):per-root identity seed 锚 workDir,默认 cwd 已不适用。
    workspaceRoot: workDir,
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
    expect(out).toContain("Usage rules");
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

  it("order: identity < soul < usage < user_profile < bootstrap", async () => {
    const out = await buildSystem("chat");
    expect(out.indexOf("iknow Identity")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("iknow Identity")).toBeLessThan(
      out.indexOf("iknow Soul")
    );
    expect(out.indexOf("iknow Soul")).toBeLessThan(out.indexOf("Usage rules"));
    expect(out.indexOf("Usage rules")).toBeLessThan(
      out.indexOf("User Profile")
    );
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
    // rev 2026-08-11 隐式完成:agent 引导对话后 rm BOOTSTRAP.md。
    // ADR-0019 (T2):显式 workspaceRoot=workDir,与 buildSystem 的 per-root
    // identity seam 同锚(默认 iknowWorkspaceRoot() = cwd 不再指向 workDir)。
    await initializeIknowWorkspace({ workspace: join(workDir, ".iknow") });
    await unlink(join(process.env.HOME!, ".iknow", "BOOTSTRAP.md"));
    const out = await buildSystem("chat");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).not.toContain("First Contact");
  });

  it("default surface (no opts.surface) is chat → bootstrap active when file present", async () => {
    // rev 2026-08-11 文件驱动:BOOTSTRAP.md 存在 → 注入。上一测试 unlink 了文件,
    // 这里重建 seed 的文件(bs=true 已翻,但文件缺失→不注入;重建文件→注入)。
    // ADR-0019 (T2):workspaceRoot=workDir 锚 per-root identity(默认 cwd 已不适用)。
    await initializeIknowWorkspace({ workspace: join(workDir, ".iknow") });
    await writeFile(
      join(process.env.HOME!, ".iknow", "BOOTSTRAP.md"),
      "# BOOTSTRAP.md - First Contact\n\nseed again"
    );
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-identity-default"),
      askUser: createNoAskUser(),
      workspaceRoot: workDir,
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
