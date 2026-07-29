/**
 * 019 T4 smoke:i9 real Anthropic adapter 端到端冒烟。
 *
 * 目的:在真实流量下跑通 harness 多 step 闭环(real adapter + demo tools),
 * 为 020 CLI 切到 harness 提供可注入的真实 adapter 证据。
 *
 * 边界(与 plan T4 对齐):
 *   - host-layer guard:读自身源码,扫禁词 src/cli / src/session-api /
 *     src/interaction / web/,命中即 throw + exit 1(不污染 host 层)。
 *   - 不走 fetch/parseLlmResponseJson;直接用 @anthropic-ai/sdk 的
 *     client.messages.create(经 createRealAnthropicAdapter 注入)。
 *   - 7 条断言(Q5.2):① stopReason==="completed" ② turnCount>=2
 *     ③ trace.turns.length>=2 ④ 至少一次 toolCalls[].kind==="ok"
 *     ⑤ finalText 非空 ⑥ echo 与 get_time 都至少被调一次
 *     ⑦ 每个 turn supplierStop !== undefined。
 *   - 成功落 docs/handoff/i9-smoke/real-anthropic-adapter.{json,md};
 *     失败落 fail 文件 + 打 trace + exit 1。
 *   - 缺 apiKey -> stderr 提示 + exit 1,不抛。
 *   - 不 log key/baseURL 完整值;baseURL 只截到 host。
 *
 * 真实失败回流(plan out-of-scope):若模型偶发撞 maxTurns / 9router 不支持
 * /v1/messages 等,不在此修复,留档 notes + 开后续 ticket。
 *
 * 独立运行:npx tsx scripts/i9-real-anthropic-adapter-smoke.ts
 * (不进 npm scripts,不进 vitest)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { loadIknowEnv } from "../src/config/env.js";
import { createRealAnthropicAdapter } from "../src/harness/model-adapter/anthropic-adapter.js";
import { createRegistry } from "../src/harness/tools/registry.js";
import { createExecutor } from "../src/harness/tools/executor.js";
import { createLoopEngine } from "../src/harness/loop-engine.js";
import {
  createEchoTool,
  createGetTimeTool,
} from "../src/harness/stubs/demo-tools.js";

const __filename = fileURLToPath(import.meta.url);
const OUT_DIR = join("docs", "handoff", "i9-smoke");
const JSON_PATH = join(OUT_DIR, "real-anthropic-adapter.json");
const MD_PATH = join(OUT_DIR, "real-anthropic-adapter.md");

// host-layer guard:smoke 自身不得引用 host 层(src/cli / src/session-api /
// src/interaction / web/)。读自身源码扫禁词。
function assertHostLayerGuard(): void {
  const self = readFileSync(__filename, "utf8");
  const forbidden = ["src/cli", "src/session-api", "src/interaction", "web/"];
  // 豁免:本 guard 声明行 + 注释里的字面量(它们是断言对象,不是 import)。
  const lines = self.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 跳过本 guard 函数自身声明的字面量行与注释
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
            `i9 smoke must stay in harness layer only.`
        );
      }
    }
  }
}

/** 截断 baseURL 到 host(不带 path),避免日志泄露完整端点。 */
function hostOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.host;
  } catch {
    return baseUrl.replace(/\/.*$/, "");
  }
}

interface TraceTurn {
  readonly supplierStop?: string;
  readonly toolCalls: ReadonlyArray<{
    readonly toolName: string;
    readonly kind: string;
  }>;
}

interface AssertionCheck {
  readonly name: string;
  readonly pass: boolean;
}

interface AssertionContext {
  readonly stopReason: string;
  readonly turnCount: number;
  readonly traceTurns: ReadonlyArray<TraceTurn>;
  readonly finalText: string | null;
  readonly toolNamesCalled: ReadonlyArray<string>;
}

const FINAL_TEXT_EXCERPT_MAX = 200;

interface SmokeResult {
  readonly result: "pass" | "fail";
  readonly timestamp: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly key_env: string;
  readonly maxTurns: number;
  readonly turns: number;
  readonly stopReason: string;
  readonly finalText_excerpt: string;
  readonly toolNames: ReadonlyArray<string>;
  readonly durationMs: number;
  readonly assertions: ReadonlyArray<AssertionCheck>;
  readonly notes: ReadonlyArray<string>;
}

function buildAssertions(ctx: AssertionContext): {
  readonly list: ReadonlyArray<AssertionCheck>;
  readonly allPass: boolean;
} {
  const hasOk = ctx.traceTurns.some((t) =>
    t.toolCalls.some((c) => c.kind === "ok")
  );
  const everyStopDefined = ctx.traceTurns.every(
    (t) => t.supplierStop !== undefined && t.supplierStop !== null
  );
  const list: ReadonlyArray<AssertionCheck> = [
    { name: "stopReason === completed", pass: ctx.stopReason === "completed" },
    { name: "turnCount >= 2", pass: ctx.turnCount >= 2 },
    { name: "trace.turns.length >= 2", pass: ctx.traceTurns.length >= 2 },
    { name: ">=1 toolCalls[].kind === ok", pass: hasOk },
    {
      name: "finalText non-empty",
      pass: typeof ctx.finalText === "string" && ctx.finalText.length > 0,
    },
    { name: "echo called >=1", pass: ctx.toolNamesCalled.includes("echo") },
    {
      name: "get_time called >=1",
      pass: ctx.toolNamesCalled.includes("get_time"),
    },
    { name: "every turn supplierStop defined", pass: everyStopDefined },
  ];
  return { list, allPass: list.every((a) => a.pass) };
}

async function main(): Promise<void> {
  assertHostLayerGuard();

  const env = loadIknowEnv(process.cwd());
  const apiKey = env.llm.apiKey;
  const keyEnv = env.llm.apiKeyEnv;
  if (!apiKey || apiKey.length === 0) {
    console.error("set NINE_ROUTER_API_KEY or ANTHROPIC_API_KEY");
    process.exitCode = 1;
    return;
  }

  const client = new Anthropic({ apiKey, baseURL: env.llm.baseUrl });
  const adapter = createRealAnthropicAdapter({
    client,
    model: env.llm.model,
    maxTokens: 1024,
  });
  const registry = createRegistry([createEchoTool(), createGetTimeTool()]);
  const executor = createExecutor(registry);
  const engine = createLoopEngine({
    adapter,
    executor,
    registry,
    maxTurns: 6,
  });

  const userText = "echo 'hello harness' 然后告诉我当前时间";
  const start = Date.now();
  let stopReason = "unknown";
  let turnCount = 0;
  let finalText: string | null = null;
  let traceTurns: ReadonlyArray<TraceTurn> = [];
  let runError: unknown = undefined;

  try {
    const { result, trace } = await engine.run(userText);
    stopReason = result.stopReason;
    turnCount = result.turnCount;
    finalText = result.finalText;
    traceTurns = trace.turns as ReadonlyArray<TraceTurn>;
  } catch (e) {
    runError = e;
    stopReason = "run_error";
  }

  const durationMs = Date.now() - start;
  const toolNamesCalled = Array.from(
    new Set(traceTurns.flatMap((t) => t.toolCalls.map((c) => c.toolName)))
  ).sort();
  const { list, allPass } = buildAssertions({
    stopReason,
    turnCount,
    traceTurns,
    finalText,
    toolNamesCalled,
  });

  const result: SmokeResult = {
    result: allPass && !runError ? "pass" : "fail",
    timestamp: new Date().toISOString(),
    model: env.llm.model,
    baseUrl: hostOf(env.llm.baseUrl),
    key_env: keyEnv,
    maxTurns: 6,
    turns: turnCount,
    stopReason,
    finalText_excerpt:
      typeof finalText === "string"
        ? finalText.slice(0, FINAL_TEXT_EXCERPT_MAX)
        : "",
    toolNames: toolNamesCalled,
    durationMs,
    assertions: list,
    notes: runError
      ? [
          `run() rejected: ${runError instanceof Error ? runError.message : String(runError)}`,
          "Real failure reflow (plan out-of-scope): not fixed here; open followup ticket if needed.",
        ]
      : [
          "adapter=createRealAnthropicAdapter (SDK client.messages.create, stream:false).",
          "7-assertion gate (Q5.2) over real multi-step loop.",
        ],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(JSON_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");

  const checkRows = list
    .map((a) => `| ${a.name} | ${a.pass ? "PASS" : "FAIL"} |`)
    .join("\n");
  const md =
    `# I9 smoke - real anthropic adapter\n\n` +
    `**Result: ${result.result.toUpperCase()}**\n\n` +
    `| Field | Value |\n|-------|-------|\n` +
    `| model | ${result.model} |\n` +
    `| baseUrl host | ${result.baseUrl_host} |\n` +
    `| key_env | ${result.key_env} |\n` +
    `| turns | ${result.turns} |\n` +
    `| stopReason | ${result.stopReason} |\n` +
    `| toolNames | ${result.toolNames.join(",")} |\n` +
    `| durationMs | ${result.durationMs} |\n\n` +
    `| Assertion | Outcome |\n|-----------|---------|\n` +
    `${checkRows}\n\n` +
    `## Notes\n\n` +
    result.notes.map((n) => `- ${n}`).join("\n") +
    "\n";
  writeFileSync(MD_PATH, md, "utf8");

  // stdout 摘要(操作员可读,不含 key)
  console.log(
    `result=${result.result} key_env=${result.key_env} model=${result.model} ` +
      `turns=${result.turns} stop_reason=${result.stopReason} ` +
      `tools=${result.toolNames.join(",")} durationMs=${result.durationMs}`
  );
  if (runError) {
    console.error(
      "trace JSON (fail):",
      JSON.stringify({
        traceTurns,
        runError:
          runError instanceof Error ? runError.message : String(runError),
      })
    );
    console.error(`see ${MD_PATH}`);
  }
  if (result.result !== "pass") {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
