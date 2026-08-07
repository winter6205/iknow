/**
 * #196 IKNOW T4: build-engine 4 入口 surface → deps.system → assembleIdentityContext
 * 链路集成测试。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessEngine } from "../../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import {
  initializeIknowWorkspace,
  writeIknowState,
} from "../../../src/harness/identity/index.js";
import type { IknowEnv } from "../../../src/config/env.ts";

function makeEnv(apiKey: string | undefined): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
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
  };
}

let origHome: string | undefined;
let workDir: string;

beforeAll(async () => {
  origHome = process.env.HOME;
  workDir = await mkdtemp(join(tmpdir(), "iknow-identity-test-"));
  process.env.HOME = workDir;
  await mkdir(join(workDir, ".iknow"), { recursive: true });
});

afterAll(async () => {
  process.env.HOME = origHome;
  await rm(workDir, { recursive: true, force: true });
});

async function buildSystem(surface: "chat" | "tui" | "ask" | "serve") {
  const { deps } = await buildHarnessEngine({
    env: makeEnv("sk-test-identity-" + surface),
    askUser: createNoAskUser(),
    surface,
  });
  return (await (deps.system as () => Promise<string | undefined>)()) ?? "";
}

describe("buildHarnessEngine surface → deps.system", () => {
  it("chat: system includes identity + soul + user_profile + bootstrap (not seeded)", async () => {
    const out = await buildSystem("chat");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).toContain("First-run bootstrap");
  });

  it("tui: same as chat (bootstrap active)", async () => {
    const out = await buildSystem("tui");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).toContain("First-run bootstrap");
  });

  it("ask: system excludes bootstrap but keeps identity/soul/user_profile", async () => {
    const out = await buildSystem("ask");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).not.toContain("First-run bootstrap");
  });

  it("serve: same as ask (bootstrap inactive)", async () => {
    const out = await buildSystem("serve");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).not.toContain("First-run bootstrap");
  });

  it("order: identity < soul < user_profile < bootstrap", async () => {
    const out = await buildSystem("chat");
    expect(out.indexOf("iknow Identity")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("iknow Identity")).toBeLessThan(
      out.indexOf("iknow Soul")
    );
    expect(out.indexOf("iknow Soul")).toBeLessThan(out.indexOf("User Profile"));
    expect(out.indexOf("User Profile")).toBeLessThan(
      out.indexOf("First-run bootstrap")
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

  it("second skip: bootstrap_seeded=true → system excludes bootstrap", async () => {
    await initializeIknowWorkspace();
    await writeIknowState({ bootstrap_seeded: true });
    const out = await buildSystem("chat");
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).not.toContain("First-run bootstrap");
  });

  it("default surface (no opts.surface) is chat → bootstrap active", async () => {
    // Reset state — earlier test flipped bootstrap_seeded=true.
    await writeIknowState({ bootstrap_seeded: false });
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-identity-default"),
      askUser: createNoAskUser(),
    });
    const out =
      (await (deps.system as () => Promise<string | undefined>)()) ?? "";
    expect(out).toContain("First-run bootstrap");
  });

  it("ask: memory_layer inactive — deps.system still carries identity layers", async () => {
    const { deps } = await buildHarnessEngine({
      env: makeEnv("sk-test-identity-ask-mem"),
      askUser: createNoAskUser(),
      surface: "ask",
      memory: { enabled: false },
    });
    expect(typeof deps.system).toBe("function");
    const out = (await deps.system?.()) ?? "";
    expect(out).toContain("iknow Identity");
    expect(out).toContain("iknow Soul");
    expect(out).toContain("User Profile");
    expect(out).not.toContain("memory_recall(query)");
  });
});
