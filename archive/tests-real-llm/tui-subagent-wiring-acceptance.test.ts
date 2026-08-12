/**
 * tests/e2e/tui-subagent-wiring-acceptance.test.ts — #365 TUI 入口 subagent
 * 接线清理 真实 LLM 接通 e2e（持久版,进 CI 默认;缺 key 显式 skip + Not run）。
 *
 * 背景:测试规范更新 —— LLM-touching 代码改动必须配套真实模型 e2e。本文件是
 * 方案 B(方案 A = scripts/t4-spawn-subagent-real-llm-smoke.ts 一次性探针),
 * 用 `createRealAnthropicAdapter`(真实 build-engine 装配,surface:chat 与
 * TUI 同一份 25 件工具集)跑多 turn + 真实 tool_call。
 *
 * 验收点(等价于 smoke,但持久进 vitest):
 *   T1 hooks 透传真实模型触发 —— buildHarnessEngine({surface:"chat", hooks})
 *     装配后,真实 LLM 读文件(不可猜测内容)→ bash echo → stubHook 记录 ≥1 次
 *     调用,含 toolUseId / name / kind。
 *   T2 25 件工具面完整 —— deps.registry.list().length === 25,list 含
 *     spawn_subagent / subagent_result / skill / skill_search。
 *   T4 registerShutdown 真实信号触发 —— process.emit('SIGINT') → counter +1;
 *     dispose() 一次 → counter 不变(幂等);再 dispose() → counter 不变。
 *   T5 subagent manager 真实装配存在 —— built.subagentManager 真存在;
 *     built.shutdown 是函数;调用后不抛。
 *   spawn_subagent 真实模型触发 —— 模型 fork worker(真实 tsx cli 重入),
 *     前景 wait:true 阻塞至 envelope,断言 finalText 含 subagent-ok。
 *
 * 缺 key(env.llm.apiKey 为空 / placeholder)→ `it.skip` + 记录 Not run
 * (spec 假设 14 格式),不得删 / stub 替身。全部断言仅在真实模型可跑时执行。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadIknowEnv } from "../../src/config/env.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { registerShutdown } from "../../src/cli/runtime.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { createLoopEngine } from "../../src/harness/index.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import type { PostToolUseHook } from "../../src/harness/permission/types.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";

const __filename = fileURLToPath(import.meta.url);
const HERE = dirname(__filename);
const TSX_BIN = join(HERE, "..", "..", "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(HERE, "..", "..", "src", "cli.ts");

const env = loadIknowEnv(process.cwd());
const HAS_KEY = typeof env.llm.apiKey === "string" && env.llm.apiKey.length > 0;

/** 结果清单:真实断言逐项记录(缺 key → 整个 suite skip)。 */
const asserts: Array<{ name: string; pass: boolean; detail?: string }> = [];
function recordAssert(name: string, pass: boolean, detail?: string): void {
  asserts.push({ name, pass, detail });
  if (!pass) console.error(`[FAIL] ${name}: ${detail ?? ""}`);
}

let root: string | undefined;
const cleanup: Array<() => Promise<void>> = [];
const SKIP_REASON = "IKNOW LLM key not set (ANTHROPIC_AUTH_TOKEN); Not run";

afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
  if (root) await rm(root, { recursive: true, force: true });
  // 汇总真实断言(仅当本文件真实跑过 LLM)。
  if (asserts.length > 0) {
    const passed = asserts.filter((a) => a.pass).length;
    const total = asserts.length;
    console.log(
      `\ntui-subagent-wiring acceptance: ${passed}/${total} real-LLM asserts`
    );
    for (const a of asserts) {
      console.log(
        `  ${a.pass ? "[PASS]" : "[FAIL]"} ${a.name}${a.detail ? `: ${a.detail}` : ""}`
      );
    }
  }
});

/** 生产等价 spawn 工厂:worker 重入 `node tsx src/cli.ts --subagent-worker`。 */
function productionLikeSpawn(): ReturnType<typeof spawn> {
  return spawn(process.execPath, [TSX_BIN, CLI_ENTRY, "--subagent-worker"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
}

describe("#365 TUI subagent wiring — 真实 LLM 接通 acceptance", () => {
  const runIt = HAS_KEY ? it : it.skip;
  if (!HAS_KEY) console.log(`[SKIP] ${SKIP_REASON}`);

  runIt(
    "T1 hooks + T2 25 件 + T4 registerShutdown + T5 subagent 装配 + spawn_subagent 真实模型触发",
    async () => {
      root = await mkdtemp(join(tmpdir(), "iknow-t365-e2e-"));

      // T4 registerShutdown:先于 LLM,不依赖模型。
      let sigCount = 0;
      {
        const builtShutdown = {
          deps: {} as unknown as LoopEngineDeps,
          engine: createLoopEngine({} as unknown as LoopEngineDeps),
          shutdown: async () => {
            sigCount += 1;
          },
        };
        const h = registerShutdown(builtShutdown);
        process.emit("SIGINT");
        await new Promise((r) => setImmediate(r));
        const afterSig = sigCount;
        await h.dispose();
        const afterDispose = sigCount;
        await h.dispose();
        const afterDispose2 = sigCount;
        recordAssert(
          "T4 registerShutdown SIGINT→dispose→dispose 幂等 +1/+0/+0",
          afterSig === 1 && afterDispose === 1 && afterDispose2 === 1,
          `afterSig=${afterSig} afterDispose=${afterDispose} afterDispose2=${afterDispose2}`
        );
      }
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");

      // 装配:真实 build-engine,chat surface(与 TUI 同一份 25 件工具集)。
      const sandboxRoot = join(root, "ws");
      await mkdir(sandboxRoot, { recursive: true });
      const fixturePath = join(sandboxRoot, "fixture.txt");
      const marker = "T365-MARK-" + Math.random().toString(36).slice(2, 10);
      await writeFile(fixturePath, marker + "\n", "utf8");

      const hookCalls: Array<{
        toolUseId?: string;
        name: string;
        kind: string;
      }> = [];
      const stubHook: PostToolUseHook = (result) => {
        hookCalls.push({
          toolUseId: result.toolUseId,
          name: result.name,
          kind: result.kind,
        });
      };

      const manager = createSubAgentManager({
        spawn: productionLikeSpawn as never,
      });
      const built = await buildHarnessEngine({
        env,
        askUser: createNoAskUser(),
        surface: "chat",
        hooks: stubHook,
        subagentManager: manager,
        userHome: join(root, "home"),
        cwd: sandboxRoot,
        sandboxRoot,
      });
      cleanup.push(async () => {
        if (built.shutdown) await built.shutdown();
      });

      // T2 25 件工具面。
      recordAssert(
        "T2 25 件工具面完整",
        built.deps.registry.list().length === 25,
        `count=${built.deps.registry.list().length}`
      );
      const names = built.deps.registry.list().map((d) => d.name);
      recordAssert("T2 含 spawn_subagent", names.includes("spawn_subagent"));
      recordAssert("T2 含 subagent_result", names.includes("subagent_result"));
      recordAssert(
        "T2 含 skill + skill_search",
        names.includes("skill") && names.includes("skill_search")
      );
      recordAssert(
        "T5 subagentManager 真实存在",
        typeof built.subagentManager === "object" &&
          built.subagentManager !== null
      );
      recordAssert(
        "T5 built.shutdown 真实函数",
        typeof built.shutdown === "function"
      );

      const deps = built.deps;
      const runDeps: LoopEngineDeps = { ...deps, maxTurns: 8 };

      // T1:真实 LLM 读文件(不可猜测内容)→ bash echo → hook 真实触发。
      let t1Stop = "unknown";
      let t1FinalText: string | null = null;
      try {
        const { result } = await run(
          `Use the read_file tool to read ${JSON.stringify(
            fixturePath
          )}, then use the bash tool to run \`echo <file-contents>\` verbatim. Report the exact bash output to me and stop. Do not use any other tools.`,
          runDeps
        );
        t1Stop = result.stopReason;
        t1FinalText = result.finalText;
      } catch (e) {
        recordAssert(
          "T1 real run 未抛错",
          false,
          e instanceof Error ? e.message : String(e)
        );
      }
      recordAssert(
        "T1 stopReason completed",
        t1Stop === "completed",
        `stop=${t1Stop}`
      );
      recordAssert(
        "T1 hook 被调 ≥1 次",
        hookCalls.length >= 1,
        `calls=${hookCalls.length}`
      );
      recordAssert(
        "T1 hook 含 toolUseId/name/kind",
        hookCalls.some(
          (c) =>
            typeof c.toolUseId === "string" &&
            c.toolUseId.length > 0 &&
            typeof c.name === "string" &&
            typeof c.kind === "string"
        ),
        `first=${JSON.stringify(hookCalls[0] ?? null)}`
      );
      recordAssert(
        "T1 hook 含 read_file + bash",
        hookCalls.some((c) => c.name === "read_file") &&
          hookCalls.some((c) => c.name === "bash"),
        `names=[${[...new Set(hookCalls.map((c) => c.name))].join(",")}]`
      );
      recordAssert(
        "T1 finalText 含真实 marker(不可猜测内容经工具面回流)",
        typeof t1FinalText === "string" && t1FinalText.includes(marker),
        `final=${JSON.stringify((t1FinalText ?? "").slice(0, 120))}`
      );

      // spawn_subagent 真实模型触发:worker 内 bash echo。
      let spawnStop = "unknown";
      let spawnFinalText: string | null = null;
      try {
        const { result } = await run(
          'Use the spawn_subagent tool exactly once with task: "Use the bash tool to run the single command `echo subagent-ok`. Report the output to me in one sentence and stop. Do not use any other tools." Wait for it to finish (default). Then report the sub-agent\'s result to me in one sentence and stop.',
          runDeps
        );
        spawnStop = result.stopReason;
        spawnFinalText = result.finalText;
      } catch (e) {
        recordAssert(
          "spawn real run 未抛错",
          false,
          e instanceof Error ? e.message : String(e)
        );
      }
      recordAssert(
        "spawn stopReason completed",
        spawnStop === "completed",
        `stop=${spawnStop}`
      );
      recordAssert(
        "spawn finalText 含 subagent-ok(真实 worker envelope)",
        typeof spawnFinalText === "string" &&
          spawnFinalText.includes("subagent-ok"),
        `final=${JSON.stringify((spawnFinalText ?? "").slice(0, 120))}`
      );

      // T5 真实 shutdown 不抛。
      let shutdownError: unknown = null;
      try {
        if (built.shutdown) await built.shutdown();
      } catch (e) {
        shutdownError = e;
      }
      recordAssert(
        "T5 built.shutdown() 不抛",
        shutdownError === null,
        shutdownError instanceof Error ? shutdownError.message : ""
      );

      // 汇总:任何 FAIL → 测试失败(真实断言,不跳过)。
      const failed = asserts.filter((a) => !a.pass);
      expect(failed).toEqual([]);
    },
    300_000
  );
});
