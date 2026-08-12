/**
 * #392 T5 — 真 LLM E2E: Ctrl+C 打断后 transcript 持久化含 system 项。
 *
 * 验收:
 *  1. session file 持久化的 messages 末尾含 role:"system" 项
 *  2. 加载 v4 session file 后 system 项仍在 + rewind 锚点正确
 *     (splitTurns 按 role==="user" 且非 tool_result 切片,system 不构成 turn)
 *  3. SDK wire body 不含 role:"system"(provider 边界守门,T2)
 *  4. 缺 key → describe.skip + 显式 skip 守卫(不得删测试或 stub 替身)
 *
 * 触发: `npm run test:real-llm`(默认 vitest 不收集 archive/)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { initializeIknowWorkspace } from "../../src/harness/identity/index.ts";
import { SessionStore } from "../../src/session-api/store/session-store.ts";
import { buildMessageParams } from "../../src/harness/model-adapter/anthropic-adapter.ts";
import { randomUUID } from "node:crypto";
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
  describe.skip("#392 T5 (skipped: " + skipGuard + ")", () => {
    it("skip 守卫", () => {});
  });
} else {
  describe("#392 T5 真 LLM E2E: abort → system 消息进 transcript + wire 守门", () => {
    let origHome: string | undefined;
    let home: string;
    let cwdDir: string;
    let baseDir: string;
    let conversationId: string;
    let skipReason: string | undefined;

    beforeAll(async () => {
      // 探测 router 可用性,缺则全 suite skip
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

      origHome = process.env.HOME;
      home = await mkdtemp(join(tmpdir(), "iknow-392-home-"));
      cwdDir = await mkdtemp(join(tmpdir(), "iknow-392-cwd-"));
      baseDir = await mkdtemp(join(tmpdir(), "iknow-392-base-"));
      process.env.HOME = home;
      await initializeIknowWorkspace({ workspace: join(home, ".iknow") });
      conversationId = randomUUID();
    });

    afterAll(async () => {
      process.env.HOME = origHome;
      if (home)
        await rm(home, { recursive: true, force: true }).catch(() => {});
      if (cwdDir)
        await rm(cwdDir, { recursive: true, force: true }).catch(() => {});
      if (baseDir)
        await rm(baseDir, { recursive: true, force: true }).catch(() => {});
    });

    it("abort → system 消息 append + 落盘 + reload 仍在 + wire 守门", async () => {
      if (skipReason) throw new Error(skipReason);

      const built = await buildHarnessEngine({
        env: makeEnv(realKey!),
        askUser: createNoAskUser(),
        surface: "chat",
        userHome: home,
        cwd: cwdDir,
      });
      try {
        // ---- run A:先完成一轮带真实 tool_call 的 turn(满足 plan T5
        //      "≥1 多 turn + ≥1 真实 tool_call" 验收)。生产 registry 只暴露
        //      真实工具(如 bash);demo/stub 工具(get_time/echo)不在装配内,
        //      所以用 bash 完成真实工具调用(bootstrap e2e 已验证该路径)。----
        const turnA = await run(
          "Please use the bash tool to run `echo real-tool-call-marker`, then report " +
            "what it printed in one short sentence.",
          built.deps,
          undefined,
          { maxTurns: 4 }
        );
        const toolCalls = turnA.result.messages.flatMap((m) =>
          m.role === "assistant"
            ? m.content.flatMap((b) => (b.type === "tool_use" ? [b.name] : []))
            : []
        );
        expect(
          toolCalls.length > 0,
          `run A 未发生真实 tool_call: ${toolCalls.join(",")}`
        ).toBe(true);
        expect(toolCalls).toContain("bash");
        expect(turnA.result.turnCount).toBeGreaterThanOrEqual(2);
        expect(turnA.result.messages.length).toBeGreaterThan(2);

        // ---- run B:以 run A 的 messages 为 priorMessages 续跑,在 in-flight
        //      中断 → system 消息 append 到权威历史末尾 ----
        const controller = new AbortController();
        const pending = run(
          "Please call the bash tool to run `sleep 3 && echo done`.",
          built.deps,
          controller.signal,
          {
            priorMessages: turnA.result.messages,
            maxTurns: 4,
          }
        );
        // 给模型 ~1.5s 进入 in-flight 后 abort(cancelled 归因)
        await new Promise<void>((r) => setTimeout(r, 1500));
        controller.abort();

        const { result } = await pending;

        // (1) stopReason === cancelled
        expect(result.stopReason).toBe("cancelled");

        // (2) messages 末尾含 role:"system" 项,文案固定(run A 历史 + system)
        const lastMsg = result.messages[result.messages.length - 1];
        expect(lastMsg?.role).toBe("system");
        if (lastMsg?.role === "system") {
          const firstBlock = lastMsg.content[0];
          expect(firstBlock?.type).toBe("text");
          if (firstBlock?.type === "text") {
            expect(firstBlock.text).toBe("Interrupted by user.");
          }
        }

        // (3) 落盘 + reload 后 system 项仍在(schema v4 持久化),run A tool
        //     turn 完整保留
        const store = new SessionStore(baseDir, cwdDir);
        await store.save({
          id: conversationId,
          file: {
            schemaVersion: 4,
            conversation_id: conversationId,
            messages: result.messages,
            jsonMode: false,
            turnCount: result.turnCount,
            updatedAt: new Date().toISOString(),
            summary: "",
            cwd: cwdDir,
            sanitized_at: new Date().toISOString(),
            checkpoints: [],
          },
        });
        const reloaded = await store.load(conversationId);
        const reloadedLast = reloaded.messages[reloaded.messages.length - 1];
        expect(reloadedLast?.role).toBe("system");
        expect(reloaded.schemaVersion).toBe(4);
        // run A 的 tool_use 在 reload 后完整在场(system 不破坏历史)
        const reloadedToolUses = reloaded.messages.flatMap((m) =>
          m.role === "assistant"
            ? m.content.filter((b) => b.type === "tool_use")
            : []
        );
        expect(reloadedToolUses.length).toBeGreaterThanOrEqual(
          toolCalls.length
        );

        // (4) buildMessageParams filter(system) 后 SDK wire body 不含 system
        const params = buildMessageParams(
          {
            client: {} as never,
            model: "test-model",
            maxTokens: 256,
          },
          { messages: result.messages, turnCount: result.turnCount },
          {}
        );
        const wireRoles = (
          params.messages as ReadonlyArray<{ role: string }>
        ).map((m) => m.role);
        expect(wireRoles).not.toContain("system");
      } finally {
        if (built?.shutdown) await built.shutdown();
      }
    }, 90_000);
  });
}
