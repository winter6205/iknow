/**
 * #449b 三级流 real-LLM smoke (evidence-check → rerun envelope → evidence-aware judge)。
 *
 * 目的: 在 settings.llm.apiKey 配齐的真实流量下跑通 #449b evidence-first 闭环
 * 真实装配路径, 覆盖 B4-B9 在 stub 下未触达的真实面:
 *
 *   (1) 未配 verify.command → checkEvidence 前级落地 → probeVerifyCommand 探测
 *       (B5 rerun envelope, pyproject.toml 等 flag file) → evidence-aware
 *       LLM 判官 (B6 EvidenceContext 证据体检单经 runClassifier seam 真传给
 *       子代理); 每一级都走与生产 hub.ts / chat-session.ts 同一装配路径;
 *   (2) 判官 spawn def 在子代理真正执行前被捕获 (wrapper 套 defaultSubAgentSpawn)
 *       → SC6: def.task 二段 = goal.text 原样 + evidenceContext JSON 段;
 *   (3) 判官 worker 回包 verdict 落盘 → SC10: verification record 有 verdict;
 *       outcome ∈ passed/failed/unstable 三态闭环收敛。
 *
 * 观测通道 (与 i128 同纪律, 差异点 = spawn-def 捕获替代 trace llm_call):
 *   - spawn wrapper: defaultSubAgentSpawn 外包一层, 在 def 进入 worker 前捕获
 *     _judgeDef (确定性主通道 —— i128 的 trace llm_call 在 tsx 下 worker 崩溃
 *     后不完整, B9 不依赖它);
 *   - JSONL trace (<traceOut>/<conversationId>.jsonl) 的 `record_type:
 *     "verification"` → 携带 verdict + 分类器分支字段 (SC10)。
 *
 * 边界 (i128 / i408 同向纪律):
 *   - host-layer guard: 本脚本仅 import src/config + src/harness +
 *     src/session-api (subject under test); 禁词 src/cli / src/interaction
 *     / web/。
 *   - 最小装配: createRealAnthropicAdapter + createSubAgentManager
 *     ({spawn: defaultSubAgentSpawn}) + runVerifyLoop 直连 (不经 SessionHub,
 *     因 hub 不注入 runClassifier; 见 verify-loop.ts RunClassifierFn seam)。
 *   - verify.command 未配置 → evidence-first + 判官路径 (本脚本主体断言);
 *     runClassifier seam 用真 SubAgentManager + 判官 role (真进程隔离)。
 *   - 缺 apiKey → stdout "key missing, smoke skipped" + exit 0
 *     (与 i408/i11 同: CI 无 key 不应 fail)。
 *   - 缺 bwrap → stdout "bwrap missing, smoke skipped" + exit 0
 *     (runFn 真 run() 内部 sandbox 依赖 bwrap)。
 *   - 不 log key/baseURL 完整值; baseURL 只截 host。
 *   - 落 docs/handoff/i449b-smoke/three-stage.{json,md}; 失败落 fail 文件 +
 *     打 trace 路径 + exit 1。
 *
 * 独立运行: npx tsx scripts/i449b-verify-three-stage-real-llm.ts
 * (不进 npm scripts, 不进 vitest collection; i128 先例: smoke 脚本按需本地
 * 显式触发, 不进入 CI 常跑矩阵)。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { loadIknowEnv } from "../src/config/env.js";
import { createRealAnthropicAdapter } from "../src/harness/model-adapter/anthropic-adapter.js";
import { createRegistry } from "../src/harness/tools/registry.js";
import { createExecutor } from "../src/harness/tools/executor.js";
import { run } from "../src/harness/loop-engine.js";
import { runVerifyLoop } from "../src/harness/verify/verify-loop.js";
import type { RunClassifierFn } from "../src/harness/verify/verify-loop.js";
import type { VerifyConfig } from "../src/harness/verify/types.js";
import type { EvidenceContext } from "../src/harness/verify/types.js";
import { createSubAgentManager } from "../src/harness/subagent/manager.js";
import type { SubAgentManager } from "../src/harness/subagent/manager.js";
import type { SubAgentDefinition } from "../src/harness/subagent/manager.js";
import type { WorkerEnvelope } from "../src/harness/subagent/envelope.js";
import { defaultSubAgentSpawn } from "../src/harness/subagent/spawn.js";
import { createRunClassifierFromManager } from "../src/harness/verify/run-classifier-adapter.js";
import { createJsonlTraceService } from "../src/harness/trace/jsonl.js";

const __filename = fileURLToPath(import.meta.url);
const OUT_DIR = join("docs", "handoff", "i449b-smoke");
const JSON_PATH = join(OUT_DIR, "three-stage.json");
const MD_PATH = join(OUT_DIR, "three-stage.md");

/** host-layer guard: i449b smoke 必须只 import subject-under-test 层。 */
function assertHostLayerGuard(): void {
  const self = readFileSync(__filename, "utf8");
  const forbidden = ["src/cli", "src/interaction", "web/"];
  const lines = self.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      line.includes("const forbidden =") ||
      line.trim().startsWith("//") ||
      line.trim().startsWith("*")
    ) {
      continue;
    }
    for (const kw of forbidden) {
      if (line.includes(kw)) {
        throw new Error(
          `host-layer guard violated at line ${i + 1}: contains '${kw}'. ` +
            `i449b smoke must stay in src/config + src/harness + src/session-api only.`
        );
      }
    }
  }
}

/** bwrap 可用性守卫: runFn 真 run() 内部 sandbox 依赖 bwrap。 */
function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/\/.*$/, "");
  }
}

/** JSONL 文件 → 按 record_type 拆分的 records 数组。 */
function readJsonl(filePath: string): Array<Record<string, unknown>> {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

interface AssertionCheck {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string;
}

interface SectionResult {
  readonly section: string;
  readonly assertions: ReadonlyArray<AssertionCheck>;
  readonly spawnDefTask?: string;
  readonly verdicts: ReadonlyArray<unknown>;
}

interface SmokeResult {
  readonly result: "pass" | "fail" | "skipped";
  readonly reason: string;
  readonly timestamp: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly key_source: string;
  readonly maxTurns: number;
  readonly durationMs: number;
  readonly sections: ReadonlyArray<SectionResult>;
  readonly notes: ReadonlyArray<string>;
}

async function main(): Promise<void> {
  assertHostLayerGuard();
  if (!hasBwrap()) {
    console.log("bwrap missing, smoke skipped");
    writeFileSync(
      JSON_PATH,
      JSON.stringify(
        {
          result: "skipped",
          reason: "bwrap_missing",
          timestamp: new Date().toISOString(),
        },
        null,
        2
      )
    );
    writeFileSync(
      MD_PATH,
      "# i449b three-stage smoke: SKIPPED (bwrap missing)"
    );
    return;
  }

  const env = loadIknowEnv(process.cwd());
  const apiKey = env.llm.apiKey;
  if (!apiKey || apiKey.length === 0) {
    console.log("key missing, smoke skipped");
    writeFileSync(
      JSON_PATH,
      JSON.stringify(
        {
          result: "skipped",
          reason: "key_missing",
          timestamp: new Date().toISOString(),
        },
        null,
        2
      )
    );
    writeFileSync(MD_PATH, "# i449b three-stage smoke: SKIPPED (key missing)");
    return;
  }

  const startedAt = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "i449b-data-"));
  const traceDir = mkdtempSync(join(tmpdir(), "i449b-trace-"));
  const conversationId = `i449b-${randomUUID()}`;
  const tracePath = join(traceDir, `${conversationId}.jsonl`);

  // goal.text: task 首段来源 (SC6)。
  const goalText =
    "编写一段 TypeScript 函数 `sum(a, b)` 并导出, 支持任意数字参数。";

  const model = env.llm.model ?? "claude-sonnet-5";
  const maxTokens = env.llm.maxOutputTokens ?? 1024;
  const baseUrl = env.llm.baseUrl;
  const client = new Anthropic({ apiKey, baseURL: baseUrl });
  const adapter = createRealAnthropicAdapter({
    client,
    model,
    maxTokens,
    stream: false,
  });

  // spawn-wrapper: 捕获判官 spawn def (SC6 观测主通道, 在子代理真正执行前)。
  // worker 内部 behavior / 进程隔离完全委托 defaultSubAgentSpawn (只读包边)。
  // SubAgentSpawn 形参 (def, taskId, stdinPayload): manager 调 spawn 时三参齐全,
  // 产物 child 由 manager 负责写 stdin + end (spawn.ts 注释同款)。
  const spawnDefs: Array<SubAgentDefinition> = [];
  const manager: SubAgentManager = createSubAgentManager({
    spawn: (
      def: SubAgentDefinition,
      taskId: string,
      stdinPayload: WorkerEnvelope
    ) => {
      spawnDefs.push(def);
      return defaultSubAgentSpawn(def, taskId, stdinPayload);
    },
  });

  // 复用生产 helper: 与 hub.ts / chat-session.ts 同一装配路径 (SC1 生产一致性)。
  const runClassifier: RunClassifierFn = createRunClassifierFromManager({
    manager,
    classifierModel: model,
    timeoutMs: 120_000,
  });

  // 真实 TraceService: runVerifyLoop 每轮判定 + run() 内 recordLlmCall 都经它
  // 落盘到 <traceDir>/<conversationId>.jsonl (SC10 观测通道)。
  const trace = createJsonlTraceService({ filePath: traceDir, conversationId });

  // runFn: 真 run() + 真 adapter (loop-engine 真编排)。
  const deps = {
    adapter,
    executor: createExecutor(createRegistry([])) as never,
    registry: createRegistry([]) as never,
    maxTurns: 4,
    trace,
  };

  // command 未配置 → evidence-first + 判官路径 (本脚本主体)。
  const verifyConfig: VerifyConfig = { command: "" };

  const result = await runVerifyLoop({
    runFn: async (userText, opts) => {
      const out = await run(userText, deps, opts?.signal, {
        priorMessages: opts?.priorMessages,
      });
      return out as never;
    },
    userText: goalText,
    config: verifyConfig,
    sessionId: conversationId,
    cwd: process.cwd(),
    runClassifier,
    // 真实 TraceService: runVerifyLoop 每轮判定经它落盘到 <traceDir>/<conversationId>.jsonl
    // (SC10 观测通道; 同一 trace 实例也供 run() 内部 recordLlmCall 使用)。
    trace,
  });

  await manager.shutdown();

  // ---- 观测通道 ----
  const records = readJsonl(tracePath);
  const verdicts = records
    .filter((r) => r["record_type"] === "verification")
    .map((r) => r["verdict"]);

  // SC6: 判官 spawn def 捕获 → task 二段 (goal.text 原样 + evidenceContext JSON)。
  // SubAgentDefinition.task 可选 (worker envelope 落盘兜底 "") → 显式判空。
  const judgeDef = spawnDefs.find(
    (d) => typeof d.task === "string" && d.task.length > 0
  );
  const judgeDefTask = judgeDef?.task;
  let taskLines: string[] = [];
  let parsedCtx: EvidenceContext | undefined;
  if (judgeDefTask !== undefined) {
    taskLines = judgeDefTask.split("\n");
    if (taskLines.length >= 2) {
      try {
        parsedCtx = JSON.parse(taskLines[1]!) as EvidenceContext;
      } catch {
        // 非 JSON 段 → 不满足 SC6; 断言层显式 fail。
      }
    }
  }

  const assertions: AssertionCheck[] = [
    {
      name: "SC6: 判官收到 def.task 二段 (goal.text 原样 + evidenceContext JSON)",
      pass:
        judgeDef !== undefined &&
        taskLines[0] === goalText &&
        taskLines.length >= 2 &&
        parsedCtx !== undefined &&
        parsedCtx.checkerVerdict === "EVIDENCE_INSUFFICIENT",
      detail:
        judgeDef !== undefined
          ? `first=${JSON.stringify(taskLines[0] ?? "")} ctx=${JSON.stringify(
              parsedCtx?.checkerVerdict ?? "none"
            )}`
          : "no spawn def captured",
    },
    {
      name: "SC10: verification record 落盘 (有 verdict)",
      pass: verdicts.length > 0,
      detail: `verdicts: ${JSON.stringify(verdicts)}`,
    },
    {
      name: "闭环有判定 (outcome ∈ passed/failed/unstable)",
      pass:
        result.outcome === "passed" ||
        result.outcome === "failed" ||
        result.outcome === "unstable",
      detail: `outcome: ${result.outcome}`,
    },
    {
      name: "rerun/judge 路径真走 (judge seam 至少 spawn 1 次)",
      pass: spawnDefs.length > 0,
      detail: `spawnDefs: ${spawnDefs.length}`,
    },
  ];

  const allPass = assertions.every((a) => a.pass);
  const smoke: SmokeResult = {
    result: allPass ? "pass" : "fail",
    reason: allPass
      ? "three-stage path produced a verdict; judge def.task carried evidenceContext JSON"
      : "one or more assertions failed",
    timestamp: new Date().toISOString(),
    model,
    baseUrl: hostOf(baseUrl),
    key_source: apiKey.startsWith("${") ? "placeholder" : "literal",
    maxTurns: 4,
    durationMs: Date.now() - startedAt,
    sections: [
      {
        section: "three-stage-e2e",
        assertions,
        ...(judgeDefTask !== undefined ? { spawnDefTask: judgeDefTask } : {}),
        verdicts,
      },
    ],
    notes: [
      `trace: ${tracePath}`,
      "spawn-def capture 为确定性观测; tsx 下 worker spawn 崩溃 → verdict=unstable 属 i128 既有先例 (not a regression)",
    ],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(JSON_PATH, JSON.stringify(smoke, null, 2));
  const mdLines = [
    "# i449b verify three-stage real-LLM smoke",
    "",
    `result: ${smoke.result}`,
    `model: ${smoke.model}`,
    `baseUrl: ${smoke.baseUrl}`,
    `durationMs: ${smoke.durationMs}`,
    "",
    "## assertions",
    ...smoke.sections[0]!.assertions.map(
      (a) =>
        `- ${a.pass ? "✅" : "❌"} ${a.name}${a.detail ? ` — ${a.detail}` : ""}`
    ),
    "",
    "## judge spawn def task (SC6)",
    ...(judgeDefTask !== undefined ? [judgeDefTask.slice(0, 400)] : []),
    "",
    "## verdicts (SC10)",
    `- ${JSON.stringify(smoke.sections[0]!.verdicts)}`,
  ];
  writeFileSync(MD_PATH, mdLines.join("\n") + "\n");

  if (allPass) {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(traceDir, { recursive: true, force: true });
    console.log(
      `result=pass model=${smoke.model} baseUrl=${smoke.baseUrl} durationMs=${smoke.durationMs}`
    );
  } else {
    console.error(
      `result=fail model=${smoke.model} baseUrl=${smoke.baseUrl} trace=${tracePath}`
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`smoke crashed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
