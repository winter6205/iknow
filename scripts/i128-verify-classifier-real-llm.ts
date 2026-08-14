/**
 * #128 verify 分类器 real-LLM smoke (T6, command-absent → 子代理 LLM 判官)。
 *
 * 目的: 在 settings.llm.apiKey 配齐的真实流量下跑通 verify 分类器闭环,
 * 为 #128 (SC7 透明关闭填空: 子代理 LLM 判官) 提供 real-LLM e2e 证据;
 * 覆盖 T2-T5 在 stub 下未触达的两个真实面:
 *
 *   (1) 未配 verify.command 时, runVerifyLoop 经 runClassifier seam 真
 *       调子代理 worker (进程隔离, A2), 真 LLM 判官产出 verdict;
 *   (2) 判官收到的 task 字段 = session.goal.text ?? query (SC3, 408 绑定)。
 *
 * 观测通道 (per i408 先例 + #128 spec):
 *   - JSONL trace (<traceOut>/<conversationId>.jsonl) 的
 *     `record_type: "llm_call"` → 携带 messages 字段, 即"模型本步实际
 *     看到的 messages"。classifier 子代理的 llm_call 里最后一条 user 消息
 *     = 判官实际看到的 task 输入 (SC3)。
 *   - `record_type: "verification"` → 携带 verdict + 分类器分支字段
 *     (reason/evidence/missing, SC10)。
 *
 * 边界 (i408 同向纪律):
 *   - host-layer guard: 本脚本仅 import src/config + src/harness +
 *     src/session-api (subject under test); 禁词 src/cli / src/interaction
 *     / web/。
 *   - 最小装配: createRealAnthropicAdapter + createSubAgentManager
 *     ({spawn: defaultSubAgentSpawn}) + runVerifyLoop 直连 (不经 SessionHub,
 *     因 hub 不注入 runClassifier; 见 verify-loop.ts RunClassifierFn seam)。
 *   - verify.command 未配置 → 分类器路径 (本脚本主体断言);
 *     runClassifier seam 用真 SubAgentManager + 判官 role (真进程隔离)。
 *   - 缺 apiKey → stdout "key missing, smoke skipped" + exit 0
 *     (与 i408/i11 同: CI 无 key 不应 fail)。
 *   - 缺 bwrap → stdout "bwrap missing, smoke skipped" + exit 0
 *     (runFn 真 run() 内部 sandbox 依赖 bwrap)。
 *   - 不 log key/baseURL 完整值; baseURL 只截 host。
 *   - 落 docs/handoff/i128-smoke/classifier.{json,md}; 失败落 fail 文件 +
 *     打 trace 路径 + exit 1。
 *
 * 独立运行: npx tsx scripts/i128-verify-classifier-real-llm.ts
 * (不进 npm scripts, 不进 vitest collection)。
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
import { createSubAgentManager } from "../src/harness/subagent/manager.js";
import type { SubAgentManager } from "../src/harness/subagent/manager.js";
import { defaultSubAgentSpawn } from "../src/harness/subagent/spawn.js";
import { createRunClassifierFromManager } from "../src/harness/verify/run-classifier-adapter.js";
import { createJsonlTraceService } from "../src/harness/trace/jsonl.js";
import type { GoalState } from "../src/session-api/store/index.js";

const __filename = fileURLToPath(import.meta.url);
const OUT_DIR = join("docs", "handoff", "i128-smoke");
const JSON_PATH = join(OUT_DIR, "classifier.json");
const MD_PATH = join(OUT_DIR, "classifier.md");

/** host-layer guard: i128 smoke 必须只 import subject-under-test 层。 */
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
            `i128 smoke must stay in src/config + src/harness + src/session-api only.`
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

/**
 * 从 JSONL llm_call 记录抽出 messages 数组。classifier 子代理的 llm_call
 * 里最后一条 user 消息 = 判官实际看到的 task 输入 (SC3)。
 */
function messagesOf(
  records: ReadonlyArray<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const r of records) {
    if (r["record_type"] !== "llm_call") continue;
    const m = r["messages"];
    if (Array.isArray(m)) out.push(...(m as Array<Record<string, unknown>>));
  }
  return out;
}

/** 从 messages 数组里抽出所有 role==="user" 消息的第一个 text block。 */
function userTextsOf(msgs: ReadonlyArray<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (m["role"] !== "user") continue;
    const content = m["content"];
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>)["type"] === "text"
      ) {
        const t = (b as Record<string, unknown>)["text"];
        if (typeof t === "string") {
          out.push(t);
          break;
        }
      }
    }
  }
  return out;
}

interface AssertionCheck {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string;
}

interface SectionResult {
  readonly section: string;
  readonly assertions: ReadonlyArray<AssertionCheck>;
  readonly userTexts: ReadonlyArray<string>;
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
    writeFileSync(MD_PATH, "# i128 classifier smoke: SKIPPED (bwrap missing)");
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
    writeFileSync(MD_PATH, "# i128 classifier smoke: SKIPPED (key missing)");
    return;
  }

  const startedAt = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "i128-data-"));
  const traceDir = mkdtempSync(join(tmpdir(), "i128-trace-"));
  const conversationId = `i128-${randomUUID()}`;
  const tracePath = join(traceDir, `${conversationId}.jsonl`);

  // goal.text: 判官 task 字段来源 (SC3 / 408 绑定)。
  const goalText =
    "编写一段 TypeScript 函数 `sum(a, b)` 并导出, 支持任意数字参数。";
  const decoyQuery = "这是被 goal.text 覆盖的 query, 不应出现在判官 task 里。";

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

  // 真 sub-agent manager (进程隔离 A2): worker 走真子进程 + 真 LLM 判官。
  const manager: SubAgentManager = createSubAgentManager({
    spawn: defaultSubAgentSpawn,
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

  // command 未配置 → 分类器路径 (本脚本主体)。
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
  const msgs = messagesOf(records);
  const userTexts = userTextsOf(msgs);
  const verdicts = records
    .filter((r) => r["record_type"] === "verification")
    .map((r) => r["verdict"]);

  const assertions: AssertionCheck[] = [
    {
      name: "SC3: 判官收到 task = goal.text",
      pass: userTexts.some((t) => t.includes(goalText)),
      detail: `userTexts 样例: ${JSON.stringify(userTexts.slice(0, 3))}`,
    },
    {
      name: "SC3: 判官未收到 decoyQuery",
      pass: !userTexts.some((t) => t.includes(decoyQuery)),
    },
    {
      name: "SC10: verification record 落盘 (有 verdict)",
      pass: verdicts.length > 0,
      detail: `verdicts: ${JSON.stringify(verdicts)}`,
    },
    {
      name: "分类器闭环有判定 (outcome ∈ passed/failed/unstable)",
      pass:
        result.outcome === "passed" ||
        result.outcome === "failed" ||
        result.outcome === "unstable",
      detail: `outcome: ${result.outcome}`,
    },
  ];

  const allPass = assertions.every((a) => a.pass);
  const smoke: SmokeResult = {
    result: allPass ? "pass" : "fail",
    reason: allPass
      ? "classifier path produced a verdict; task field bound to goal.text"
      : "one or more assertions failed",
    timestamp: new Date().toISOString(),
    model,
    baseUrl: hostOf(baseUrl),
    key_source: apiKey.startsWith("${") ? "placeholder" : "literal",
    maxTurns: 4,
    durationMs: Date.now() - startedAt,
    sections: [
      {
        section: "classifier-e2e",
        assertions,
        userTexts,
        verdicts,
      },
    ],
    notes: [`trace: ${tracePath}`],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(JSON_PATH, JSON.stringify(smoke, null, 2));
  const mdLines = [
    "# i128 verify classifier real-LLM smoke",
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
    "## user texts (judge saw)",
    ...smoke.sections[0]!.userTexts.slice(0, 10).map(
      (t) => `- ${t.slice(0, 200)}`
    ),
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
