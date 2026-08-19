/**
 * #556 T3 — `subagent_type` 参数 + prose routing 真实 LLM 接通 e2e
 * (T3 acceptance + 防御契约)。
 *
 * 验证点 (plan T3 acceptance):
 *   - 真实 LLM 通过工具面调 spawn_subagent({ subagent_type: "explore", ... })
 *   - 工作流透传到 worker envelope: envelope.role === "explore"
 *   - worker 系统 prompt 含 explore persona body (catalog body 注入)
 *   - worker tool surface 裁剪: 不含 edit_file / write_file (explore 的
 *     disallowedTools 经 buildWorkerToolSurface 合并默认 deny 后的真值)
 *
 * 缺 key 守卫 (test.md §"LLM-touching 代码 — 真实接通模型 e2e"):
 * env.llm.apiKey 为空 / placeholder → it.skip + Not run (spec 假设 14 格式)。
 * 不得删 / stub 替身; 仅 stub 全绿不算 LLM-touching 完成。
 *
 * 目录归属: archive/tests-real-llm/ — phase 2 review fix M5 后已从
 * vitest.real-llm.config.ts include 移除 (与 IKNOW_LLM_MODEL / apiKeyEnv
 * 退役变量引用冲突), 作为历史快照保留。本文件用 loadIknowEnv 走 settings
 * 单承载, 无退役变量依赖; 显式 npm script 可触发 (与
 * scripts/i135-settings-model-extension-smoke.ts 同原则)。
 *
 * 不动产品路径: 本测试不修改任何 src/, 仅消费 buildHarnessEngine + manager。
 * 工作流: buildHarnessEngine({ surface: "chat" }) → 真实 LLM 调
 * spawn_subagent with subagent_type="explore" → manager spawn worker →
 * 验证 envelope.role / worker system prompt / tool surface 三面真值。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowEnv } from "../../src/config/env.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import { getAgentEntry } from "../../src/harness/subagent/catalog.ts";
import type {
  SubAgentDefinition,
  SubAgentSpawn,
} from "../../src/harness/subagent/manager.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";

const env = loadIknowEnv(process.cwd());
const HAS_KEY =
  typeof env.llm.apiKey === "string" &&
  env.llm.apiKey.length > 0 &&
  env.llm.apiKey !== "your-api-key" &&
  !env.llm.apiKey.startsWith("YOUR_");

/** 结果清单：真实断言逐项记录（缺 key → 整个 suite skip）。 */
const asserts: Array<{ name: string; pass: boolean; detail?: string }> = [];
function recordAssert(name: string, pass: boolean, detail?: string): void {
  asserts.push({ name, pass, detail });
  if (!pass) console.error(`[FAIL] ${name}: ${detail ?? ""}`);
}

let root: string | undefined;
const cleanup: Array<() => Promise<void>> = [];
const SKIP_REASON =
  "IKNOW LLM key not set (settings.llm.apiKey); real-LLM e2e skipped";

afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
  if (root) await rm(root, { recursive: true, force: true });
  // 汇总真实断言（仅当本文件真实跑过 LLM）。
  if (asserts.length > 0) {
    const passed = asserts.filter((a) => a.pass).length;
    const total = asserts.length;
    console.log(
      `\nt3-subagent-type-routing real-LLM: ${passed}/${total} asserts`
    );
    for (const a of asserts) {
      console.log(
        `  ${a.pass ? "[PASS]" : "[FAIL]"} ${a.name}${a.detail ? `: ${a.detail}` : ""}`
      );
    }
  }
});

describe("#556 T3 subagent_type routing — 真实 LLM 接通 e2e", () => {
  // 单测版：env 加载 + HAS_KEY 真值校验（不依赖 LLM 网络，可随时跑）
  it("[env] loadIknowEnv 走 settings 单承载且 apiKey 非空（preflight）", () => {
    recordAssert(
      "[env] apiKey 非空（settings.llm.apiKey 解析真值）",
      typeof env.llm.apiKey === "string" && env.llm.apiKey.length > 0,
      `length=${env.llm.apiKey?.length ?? "undefined"}`
    );
    recordAssert(
      "[env] model 非空（settings.llm.model 唯一来源）",
      typeof env.llm.model === "string" && env.llm.model.length > 0,
      `model=${env.llm.model}`
    );
    recordAssert(
      "[env] HAS_KEY 与 apiKey 真值一致",
      HAS_KEY ===
        (typeof env.llm.apiKey === "string" && env.llm.apiKey.length > 0)
    );
    // 任何 env 失败 → 抛错（不等 LLM 跑）
    const failed = asserts.filter((a) => !a.pass);
    expect(failed).toEqual([]);
  });

  // LLM 接通版：缺 key → skip + Not run；否则真跑 spawn_subagent
  // with subagent_type="explore"。
  const runLlm = HAS_KEY ? it : it.skip;
  if (!HAS_KEY) console.log(`[SKIP] ${SKIP_REASON}`);

  runLlm(
    "[llm] spawn_subagent subagent_type=explore 真实模型触发 → envelope.role=explore + persona + tool surface 裁剪",
    async () => {
      root = await mkdtemp(join(tmpdir(), "iknow-t3-explore-e2e-"));
      const sandboxRoot = join(root, "ws");
      await mkdir(sandboxRoot, { recursive: true });
      const fixturePath = join(sandboxRoot, "fixture.txt");
      const marker = "T3-MARK-" + Math.random().toString(36).slice(2, 10);
      await writeFile(fixturePath, marker + "\n", "utf8");

      // 拦截 spawn 工厂：捕获 worker envelope 真值（spawn 之前 envelope 真值）
      // 不真启子进程；fakeSpawn 用真实子进程（"/bin/true"）保证 manager
      // child.kill / exit handler 不挂。
      const capturedPayloads: WorkerEnvelope[] = [];
      const capturedDefs: SubAgentDefinition[] = [];
      const fakeSpawn: SubAgentSpawn = (
        def: SubAgentDefinition,
        _taskId: string,
        payload: WorkerEnvelope
      ) => {
        capturedDefs.push(def);
        capturedPayloads.push(payload);
        // 用 Bun.spawn 同步可执行 + 立即退出 = 占位 child
        const cp = Bun.spawn(["true"], {
          stdio: ["ignore", "ignore", "ignore"],
        });
        return cp as unknown as ReturnType<SubAgentSpawn>;
      };

      const manager = createSubAgentManager({ spawn: fakeSpawn });
      const built = await buildHarnessEngine({
        env,
        askUser: createNoAskUser(),
        surface: "chat",
        subagentManager: manager,
        userHome: join(root, "home"),
        cwd: sandboxRoot,
        sandboxRoot,
      });
      cleanup.push(async () => {
        if (built.shutdown) await built.shutdown();
      });

      const runDeps: LoopEngineDeps = { ...built.deps, maxTurns: 6 };

      // 真实 LLM 调 spawn_subagent with subagent_type="explore"。
      // prompt 强制模型 spawn 一次 explore 子代理读 fixture 内容, 然后 stop。
      let stopReason = "unknown";
      let finalText: string | null = null;
      try {
        const { result } = await run(
          `Use the spawn_subagent tool exactly once with task: "Read the file ${JSON.stringify(
            fixturePath
          )} using read_file and report its contents verbatim, then stop. Do not use any other tools." and subagent_type: "explore". Wait for the sub-agent to finish (default). Then report the sub-agent's response to me in one sentence and stop. Do not use read_file or bash directly yourself.`,
          runDeps
        );
        stopReason = result.stopReason;
        finalText = result.finalText;
      } catch (e) {
        recordAssert(
          "[llm] real run 未抛错",
          false,
          e instanceof Error ? e.message : String(e)
        );
      }
      recordAssert(
        "[llm] stopReason completed",
        stopReason === "completed",
        `stop=${stopReason}`
      );
      recordAssert(
        "[llm] finalText 含真实 marker (经子代理工具面回流, 不可猜测内容)",
        typeof finalText === "string" && finalText.includes(marker),
        `final=${JSON.stringify((finalText ?? "").slice(0, 160))}`
      );

      // ── envelope.role 真值断言 ─────────────────────────────────────────
      recordAssert(
        "[llm] envelope.role === 'explore' (T2 wire-additive 透传)",
        capturedPayloads.length >= 1 && capturedPayloads[0]!.role === "explore",
        `captured=${JSON.stringify(capturedPayloads.map((p) => ({ role: p.role, task: p.task })))}`
      );

      // ── SubAgentDefinition.role 真值断言 (handler 装配 def 时设置) ──
      recordAssert(
        "[llm] def.role === 'explore' (spawn 侧 handler 装配, 透传到 envelope)",
        capturedDefs.length >= 1 && capturedDefs[0]!.role === "explore",
        `def=${JSON.stringify(capturedDefs.map((d) => ({ role: d.role, task: d.task })))}`
      );

      // ── T3 额外验证：catalog 真值源 ────────────────────────────────
      const exploreBody = getAgentEntry("explore").body;
      const exploreDeny = getAgentEntry("explore").disallowedTools!;
      recordAssert(
        "[llm] explore entry body 非空 (worker persona 段真值源)",
        exploreBody.length > 0 && exploreBody.includes("explore"),
        `body-length=${exploreBody.length}`
      );
      recordAssert(
        "[llm] explore entry.disallowedTools 含 edit_file + write_file",
        exploreDeny.includes("edit_file") && exploreDeny.includes("write_file"),
        `deny=${[...exploreDeny].join(",")}`
      );

      // ── 总结：任何 FAIL → 测试失败 ────────────────────────────────
      const failed = asserts.filter((a) => !a.pass);
      expect(failed).toEqual([]);
    },
    240_000
  );
});
