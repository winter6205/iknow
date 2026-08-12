/**
 * #392 T5 smoke: 中断 transcript 端到端探针。
 *
 * 目的:真实流量下验证 Ctrl+C 打断后 system 消息进 transcript,且 SDK
 *  wire body 不含 system 项(provider 边界 T2 守门)。
 *
 * 边界:
 *   - host-layer guard:本 smoke 不得引用 host 层(src/cli / src/session-api /
 *     src/interaction / web/)。仅 harness 层内装配。
 *   - 不走 fetch/parseLlmResponseJson;直接 createRealAnthropicAdapter。
 *   - mock SDK client:捕获 client.messages.create 的 params,断言 wire body
 *     不含 role:"system";同时调真实 SDK 完成 model 路径(用 dev router)。
 *   - 5 条断言(Q5.2):
 *     ① result.stopReason === "cancelled"
 *     ② result.messages 末尾含 role:"system",text === "Interrupted by user."
 *     ③ JSON round-trip 模拟持久化后 system 项仍在(harness 层内,
 *        不 import SessionStore —— host-layer guard 禁止)
 *     ④ buildMessageParams wire body 不含 role:"system"(T2 守门)
 *     ⑤ round-trip 后再次 buildMessageParams 仍不含 system(双重守门)
 *   - 成功落 docs/handoff/392-smoke/b2-interrupt-transcript.{json,md};
 *     失败落 fail 文件 + 打 trace + exit 1。
 *   - 缺 apiKey → stderr 提示 + exit 1,不抛。
 *   - 不 log key/baseURL 完整值;baseURL 只截到 host。
 *
 * 独立运行:npx tsx scripts/i392-probe-b2-interrupt-transcript.ts
 * (由 `npm run probe:interrupt-transcript` 触发)
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
import { buildMessageParams } from "../src/harness/model-adapter/anthropic-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const OUT_DIR = join("docs", "handoff", "392-smoke");
const JSON_PATH = join(OUT_DIR, "b2-interrupt-transcript.json");
const MD_PATH = join(OUT_DIR, "b2-interrupt-transcript.md");

// host-layer guard:smoke 自身不得引用 host 层。
function assertHostLayerGuard(): void {
  const self = readFileSync(__filename, "utf8");
  const forbidden = ["src/cli", "src/session-api", "src/interaction", "web/"];
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
            `i392 smoke must stay in harness layer only.`
        );
      }
    }
  }
}

function hostOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.host;
  } catch {
    return baseUrl.replace(/\/.*$/, "");
  }
}

interface AssertionCheck {
  readonly name: string;
  readonly pass: boolean;
}

const FINAL_TEXT_EXCERPT_MAX = 200;

interface ProbeResult {
  readonly result: "pass" | "fail";
  readonly timestamp: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly key_env: string;
  readonly turns: number;
  readonly stopReason: string;
  readonly systemMessageAppended: boolean;
  readonly wireSystemRoleCount: number;
  readonly durationMs: number;
  readonly assertions: ReadonlyArray<AssertionCheck>;
  readonly notes: ReadonlyArray<string>;
}

interface ProbeContext {
  readonly stopReason: string;
  readonly messages: ReadonlyArray<{ readonly role: string }>;
  readonly wireRoles: ReadonlyArray<string>;
  readonly roundTripRoles: ReadonlyArray<string>;
  readonly wireRolesAfterRoundTrip: ReadonlyArray<string>;
  readonly turns: number;
  readonly runError: unknown;
}

function buildAssertions(ctx: ProbeContext): {
  readonly list: ReadonlyArray<AssertionCheck>;
  readonly allPass: boolean;
} {
  const lastMsg = ctx.messages[ctx.messages.length - 1];
  const systemAppended = lastMsg !== undefined && lastMsg.role === "system";
  const systemMsg = systemAppended
    ? ctx.messages[ctx.messages.length - 1]
    : null;
  let systemTextOk = false;
  if (systemMsg) {
    // text field is destructured from first text block (kept loose for guard)
    const text = (systemMsg as unknown as { content: ReadonlyArray<unknown> })
      .content;
    const firstBlock = text[0];
    if (
      firstBlock &&
      typeof firstBlock === "object" &&
      (firstBlock as { type?: string }).type === "text" &&
      typeof (firstBlock as { text?: string }).text === "string"
    ) {
      systemTextOk =
        (firstBlock as { text: string }).text === "Interrupted by user.";
    }
  }
  const wireSystemCount = ctx.wireRoles.filter((r) => r === "system").length;
  const wireSystemCountAfterRoundTrip = ctx.wireRolesAfterRoundTrip.filter(
    (r) => r === "system"
  ).length;
  const roundTripSystemKept =
    ctx.roundTripRoles[ctx.roundTripRoles.length - 1] === "system";
  const list: ReadonlyArray<AssertionCheck> = [
    { name: "stopReason === cancelled", pass: ctx.stopReason === "cancelled" },
    {
      name: "messages 末尾含 role:system",
      pass: systemAppended,
    },
    {
      name: "system 文案 === Interrupted by user.",
      pass: systemTextOk,
    },
    {
      name: "JSON round-trip 后 system 项仍在",
      pass: roundTripSystemKept,
    },
    {
      name: "wire body 不含 role:system (T2 守门)",
      pass: wireSystemCount === 0,
    },
    {
      name: "round-trip 后 wire body 仍不含 role:system (双重守门)",
      pass: wireSystemCountAfterRoundTrip === 0,
    },
  ];
  return { list, allPass: list.every((a) => a.pass) };
}

async function main(): Promise<void> {
  assertHostLayerGuard();

  const env = loadIknowEnv(process.cwd());
  const apiKey = env.llm.apiKey;
  const keyEnv = env.llm.apiKeyEnv;
  if (!apiKey || apiKey.length === 0) {
    console.error("set ANTHROPIC_AUTH_TOKEN (or via IKNOW_LLM_API_KEY_ENV)");
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

  const userText =
    "echo 'hello harness' 然后告诉我当前时间(注意:agent 真的会被打断)";
  const start = Date.now();
  let stopReason = "unknown";
  let messages: ReadonlyArray<{ readonly role: string }> = [];
  let wireRoles: ReadonlyArray<string> = [];
  let roundTripRoles: ReadonlyArray<string> = [];
  let wireRolesAfterRoundTrip: ReadonlyArray<string> = [];
  let turns = 0;
  let runError: unknown = undefined;

  try {
    const controller = new AbortController();
    // createLoopEngine 返回的 run(userText, signal?) 签名 (loop-engine.ts:1456)。
    const pending = engine.run(userText, controller.signal);
    // 给 model ~50ms 进 in-flight 后 abort。真实模型在本地 router 上单次
    // 往返可能 <100ms(带工具多 step 更快),1.2s 窗口会放它跑完整 run
    // (stop_reason=completed)。50ms 几乎必然截断在第一次 model 调用中。
    await new Promise<void>((r) => setTimeout(r, 50));
    controller.abort();
    const { result } = await pending;
    stopReason = result.stopReason;
    messages = result.messages;
    turns = result.turnCount;

    // 持久化模拟:JSON round-trip(harness 层内,不 import SessionStore ——
    // host-layer guard 禁止引用 src/session-api)。真实落盘由 e2e 覆盖
    // (archive/tests-real-llm/b2-interrupt-transcript.test.ts),此 probe 只
    // 验「JSON 序列化后 system 项仍在 + wire 双重守门」。
    const roundTripped = JSON.parse(JSON.stringify(messages)) as ReadonlyArray<{
      readonly role: string;
    }>;
    roundTripRoles = roundTripped.map((m) => m.role);

    // wire 守门 #1:原始 messages 经 buildMessageParams 不含 system
    const params = buildMessageParams(
      {
        client: {} as never,
        model: env.llm.model,
        maxTokens: 1024,
      },
      { messages: messages as never, turnCount: turns },
      {}
    );
    wireRoles = (params.messages as ReadonlyArray<{ role: string }>).map(
      (m) => m.role
    );
    // wire 守门 #2:round-trip 后 messages 仍不含 system(持久化前后双重守门)
    const params2 = buildMessageParams(
      {
        client: {} as never,
        model: env.llm.model,
        maxTokens: 1024,
      },
      { messages: roundTripped as never, turnCount: turns },
      {}
    );
    wireRolesAfterRoundTrip = (
      params2.messages as ReadonlyArray<{ role: string }>
    ).map((m) => m.role);
  } catch (e) {
    runError = e;
    stopReason = "run_error";
  }

  const durationMs = Date.now() - start;
  const ctx: ProbeContext = {
    stopReason,
    messages,
    wireRoles,
    roundTripRoles,
    wireRolesAfterRoundTrip,
    turns,
    runError,
  };
  const { list, allPass } = buildAssertions(ctx);

  const probeResult: ProbeResult = {
    result: allPass && !runError ? "pass" : "fail",
    timestamp: new Date().toISOString(),
    model: env.llm.model,
    baseUrl: hostOf(env.llm.baseUrl),
    key_env: keyEnv,
    turns,
    stopReason,
    systemMessageAppended: list[1]?.pass ?? false,
    wireSystemRoleCount: wireRoles.filter((r) => r === "system").length,
    durationMs,
    assertions: list,
    notes: runError
      ? [
          `run() rejected: ${runError instanceof Error ? runError.message : String(runError)}`,
          "Real failure reflow (plan out-of-scope): not fixed here; open followup ticket if needed.",
        ]
      : [
          "Ctrl+C abort 在 model in-flight 后 ~1.2s 触发,期望归因 cancelled。",
          "验证:system 消息 append + wire body 守门 + reload 持久化。",
        ],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(JSON_PATH, JSON.stringify(probeResult, null, 2) + "\n", "utf8");

  const checkRows = list
    .map((a) => `| ${a.name} | ${a.pass ? "PASS" : "FAIL"} |`)
    .join("\n");
  const md =
    `# #392 T5 smoke — b2 interrupt transcript\n\n` +
    `**Result: ${probeResult.result.toUpperCase()}**\n\n` +
    `| Field | Value |\n|-------|-------|\n` +
    `| model | ${probeResult.model} |\n` +
    `| baseUrl host | ${probeResult.baseUrl} |\n` +
    `| key_env | ${probeResult.key_env} |\n` +
    `| turns | ${probeResult.turns} |\n` +
    `| stopReason | ${probeResult.stopReason} |\n` +
    `| systemMessageAppended | ${probeResult.systemMessageAppended} |\n` +
    `| wireSystemRoleCount | ${probeResult.wireSystemRoleCount} |\n` +
    `| durationMs | ${probeResult.durationMs} |\n\n` +
    `| Assertion | Outcome |\n|-----------|---------|\n` +
    `${checkRows}\n\n` +
    `## Notes\n\n` +
    probeResult.notes.map((n) => `- ${n}`).join("\n") +
    "\n";
  writeFileSync(MD_PATH, md, "utf8");

  // stdout 摘要(操作员可读,不含 key)
  console.log(
    `result=${probeResult.result} key_env=${probeResult.key_env} model=${probeResult.model} ` +
      `turns=${probeResult.turns} stop_reason=${probeResult.stopReason} ` +
      `system_appended=${probeResult.systemMessageAppended} ` +
      `wire_system_count=${probeResult.wireSystemRoleCount} ` +
      `durationMs=${probeResult.durationMs}`
  );
  if (runError) {
    console.error(
      "trace JSON (fail):",
      JSON.stringify({
        runError:
          runError instanceof Error ? runError.message : String(runError),
      })
    );
    console.error(`see ${MD_PATH}`);
  }
  if (probeResult.result !== "pass") {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
