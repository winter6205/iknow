/**
 * #196 rev 2026-08-11 T12b — 真 LLM E2E: agent 按模板走 bash 完成引导闭环。
 * 验收: 真实 LLM 读到 BOOTSTRAP 模板 → 走 bash 写 user.md + rm BOOTSTRAP.md →
 * 二次装配不含 bootstrap 段。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import {
  initializeIknowWorkspace,
  readIknowState,
} from "../../src/harness/identity/index.ts";
import { run } from "../../src/harness/loop-engine.ts";
import type { IknowEnv } from "../../src/config/env.ts";

const realKey = process.env.ANTHROPIC_AUTH_TOKEN;
const llmBase = process.env.IKNOW_LLM_BASE_URL ?? "http://localhost:20128/v1";

function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: llmBase,
      model: process.env.IKNOW_LLM_MODEL ?? "m3-combo",
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      apiKey,
      maxOutputTokens: 4096,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    // #378 根因 B: MCP 连接超时(默认 60_000)。
    mcp: { connectTimeoutMs: 60_000 },
  };
}

const skipGuard = (() => {
  let bwrapOk = false;
  try {
    execSync("command -v bwrap", { stdio: "ignore" });
    bwrapOk = true;
  } catch {
    bwrapOk = false;
  }
  if (!realKey) return "ANTHROPIC_AUTH_TOKEN 未设置";
  if (!bwrapOk) return "bwrap 缺失";
  return undefined;
})();

if (skipGuard) {
  describe.skip("#196 T12b (skipped: " + skipGuard + ")", () => {
    it("skip 守卫", () => {});
  });
} else {
  describe("#196 T12b 真 LLM E2E: agent 按模板走 bash 完成引导", () => {
    let origHome: string | undefined;
    let home: string;
    let cwdDir: string;
    let built: Awaited<ReturnType<typeof buildHarnessEngine>>;
    let skipReason: string | undefined;

    beforeAll(async () => {
      let routerOk = false;
      try {
        await Promise.race([
          fetch(llmBase + "/models", { method: "HEAD" }).then(
            () => (routerOk = true)
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("probe timeout")), 2_000)
          ),
        ]);
      } catch {
        routerOk = false;
      }
      skipReason = !routerOk ? "LLM 后端离线" : undefined;
      if (skipReason) return;
      console.log("[probe] router ok, assembling");
      origHome = process.env.HOME;
      home = await mkdtemp(join(tmpdir(), "iknow-real-llm-home-"));
      cwdDir = await mkdtemp(join(tmpdir(), "iknow-real-llm-cwd-"));
      process.env.HOME = home;
      await initializeIknowWorkspace({ workspace: join(home, ".iknow") });
      built = await buildHarnessEngine({
        env: makeEnv(realKey),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: home,
        cwd: cwdDir,
      });
      console.log("[probe] built done");
    });

    afterAll(async () => {
      if (built?.shutdown) await built.shutdown();
      process.env.HOME = origHome;
      if (home)
        await rm(home, { recursive: true, force: true }).catch(() => {});
      if (cwdDir)
        await rm(cwdDir, { recursive: true, force: true }).catch(() => {});
    });

    it("agent 按模板走 bash 写 user.md + rm BOOTSTRAP.md", async () => {
      if (skipReason) throw new Error(skipReason);
      expect(
        (await readIknowState(join(home, ".iknow"))).bootstrap_seeded
      ).toBe(true);
      const firstSystem = (await built.deps.system()) ?? "";
      expect(firstSystem).toContain("First Contact");
      expect(firstSystem).toContain("use the bash shell");

      const { result } = await run(
        "BOOTSTRAP.md says write_file/edit_file are cwd-scoped and will reject ~/.iknow paths. I'm a new user; please write my profile into ~/.iknow/user.md (Name: T12b, working context: TypeScript), then delete ~/.iknow/BOOTSTRAP.md. Use the bash tool — write_file/edit_file won't work here.",
        built.deps,
        undefined,
        { maxTurns: 6 }
      );

      // 核心增量: 模型真实调用了 bash 工具
      const bashCalls = result.messages.flatMap((m) =>
        m.role === "assistant"
          ? m.content.flatMap((b) =>
              b.type === "tool_use" && b.name === "bash"
                ? [String((b.input as { command?: unknown })?.command ?? "")]
                : []
            )
          : []
      );
      expect(bashCalls.length > 0, `agent 未调 bash: ${result.finalText}`).toBe(
        true
      );
      expect(bashCalls.join("\n")).toMatch(/user\.md/);
      expect(bashCalls.join("\n")).toMatch(/BOOTSTRAP\.md/);

      const userContent = await readFile(
        join(home, ".iknow", "user.md"),
        "utf8"
      ).catch(() => "");
      expect(userContent).toMatch(/t12b/i);
      const bsGone = await readFile(
        join(home, ".iknow", "BOOTSTRAP.md"),
        "utf8"
      ).catch(() => null);
      expect(bsGone).toBeNull();
      const secondSystem = (await built.deps.system()) ?? "";
      expect(secondSystem).not.toContain("First Contact");
      expect(secondSystem).toMatch(/t12b/i);
    }, 120_000);
  });
}
