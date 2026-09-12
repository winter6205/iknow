/**
 * #408 real-LLM smoke (T2 + T3 + T4 + T5).
 *
 * 目的:在 settings.llm.apiKey 配齐的真实流量下跑通 SessionGoal 闭环,
 * 为 #408 (Session-level Goal for Verify-Loop Task Field) 提供 real-LLM
 * e2e 证据;覆盖 hub-verify.test.ts / goal-seam.test.ts / goal-status-
 * writeback.test.ts 在 stub / vi.mock 下未触达的两个真实面:
 *
 *   (1) T4 verify-loop seam 真把 session.goal.text 喂给真实模型
 *       (不是 vi.mock 的 runVerifyLoop,而是真 runVerifyLoop 真 bwrap);
 *   (2) T5 终态写回经真 verify 闭环 (passed) 真实落到 session goal.status。
 *
 * 观测通道 (per user direction):运行期产物
 *   - JSONL trace (<traceOut>/<conversationId>.jsonl) 中的
 *     `record_type: "llm_call"` → 携带 messages 字段,即"模型本步实际
 *     看到的 messages"(loop-engine.ts:1285 encodeUserText(userText))。
 *     第一条 llm_call 的最后一条 user 消息 = runFn 的 userText = verify-loop
 *     真正喂给模型的 task field。
 *   - `record_type: "verification"` → 携带 verdict + finalOutcome,
 *     证明真 runVerifyLoop 跑过且产出 "passed"。
 *   - SessionStore 文件 → goal 落盘形态 (T2 seed / T3 re-pin / T5 write-back)。
 *
 * 边界:
 *   - host-layer guard:本脚本仅 import src/config + src/harness + src/session-api
 *     (subject under test);禁词 src/cli / src/interaction / web/。
 *     与 i11 同向纪律,目标层差异由 forbidden 列表差异区分。
 *   - 用 buildHarnessEngine({...})? 不 —— 该工厂会拉 skill scanner / MCP /
 *     subagent manager(慢 + 真实 ~/.iknow 副作用);改走最小装配
 *     createRealAnthropicAdapter + 空 registry + 最小 executor + 裸 runDeps,
 *     仅验证 goal × verify-loop × trace 这一窄契约。SessionHub 仍是真 hub。
 *   - verify 命令 = `true`(bwrap 沙箱执行,exit 0)→ 闭环 1 轮 passed。
 *     真闭环:runVerifyLoop 真包 run() + 真 bwrap sandbox + 真 verify 命令。
 *   - 缺 apiKey → stdout "key missing, smoke skipped" + exit 0
 *     (与 i11 同:Ci 无 key 不应 fail;settings.llm.apiKey 占位符
 *     ${ANTHROPIC_AUTH_TOKEN} 须在本进程 env 内可解析)。
 *   - 不 log key/baseURL 完整值;baseURL 只截 host;goal.text 完整可 log
 *     (非凭据,只是测试用字符串)。
 *   - 落 docs/handoff/i408-smoke/session-goal.{json,md};失败落 fail 文件 +
 *     打 trace 路径 + exit 1。
 *
 * 独立运行:npx tsx scripts/i408-session-goal-real-llm.ts
 * (不进 npm scripts,不进 vitest collection,符合 archive/tests-real-llm
 *  README + scripts/i*-smoke.ts 同向纪律)
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
import { SessionHub } from "../src/session-api/hub.js";
import { SessionStore } from "../src/session-api/store/index.js";
import { deriveProjectIdentityRoot } from "../src/harness/session-roots.js";
import type { GoalState } from "../src/session-api/store/index.js";
import type { VerifyConfig } from "../src/harness/verify/types.js";

const __filename = fileURLToPath(import.meta.url);
const OUT_DIR = join("docs", "handoff", "i408-smoke");
const JSON_PATH = join(OUT_DIR, "session-goal.json");
const MD_PATH = join(OUT_DIR, "session-goal.md");

/** host-layer guard:i408 smoke 必须只 import subject-under-test 层。 */
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
            `i408 smoke must stay in src/config + src/harness + src/session-api only.`
        );
      }
    }
  }
}

/** bwrap 可用性守卫: 缺省 runVerify (runInSandbox) 仅在 bwrap 存在时可用。 */
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
 * 从 JSONL llm_call 记录抽出 messages 数组;轮空 / 字段缺席 → []。
 * messages 字段依 loop-engine.ts:1285 = effectiveState.messages,
 * 含 encodeUserText(userText) 注入的 user 消息,正是 verify-loop 真喂给模型的输入。
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
  readonly stopReason: string;
  readonly llmCalls: number;
  readonly userTexts: ReadonlyArray<string>;
  readonly goalOnDisk: GoalState | undefined;
  readonly assertions: ReadonlyArray<AssertionCheck>;
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

async function buildHub(opts: {
  readonly dataDir: string;
  readonly traceOut: string;
  readonly verifyConfig: VerifyConfig;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly maxTokens: number;
}): Promise<SessionHub> {
  // 最小 deps: createRealAnthropicAdapter (真 Anthropic SDK) + 空 registry +
  // 最小 executor + maxTurns。SessionHub 仍是真 hub,verify-loop 仍是真 loop。
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
  });
  const adapter = createRealAnthropicAdapter({
    client,
    model: opts.model,
    maxTokens: opts.maxTokens,
    stream: false,
  });
  const tool = {
    name: "noop",
    description: "",
    input_schema: { type: "object" as const, properties: {} },
    execute: async () => ({}),
  };
  const registry = {
    list: () => [tool],
    get: (n: string) => (n === "noop" ? tool : undefined),
  };
  const executor = {
    execute: async () => ({ ok: true as const, output: {} }),
  };
  const deps = {
    adapter,
    executor: executor as never,
    registry: registry as never,
    maxTurns: opts.maxTurns,
  };
  // T1 (session-folder-consolidation)：store 命名空间按 projectIdentityRoot 分组，
  // 不是 cwd。本脚本无独立 workspace 根（dataDir 是会话池 scratch），会话文件里
  // 记的 cwd 就是 process.cwd() → 身份根同源取它，保证 store 与 hub 同一个项目桶。
  const store = new SessionStore(
    opts.dataDir,
    deriveProjectIdentityRoot({ cwd: process.cwd() })
  );
  return new SessionHub({
    store,
    deps,
    traceOut: opts.traceOut,
    verifyConfig: opts.verifyConfig,
  });
}

async function main(): Promise<void> {
  assertHostLayerGuard();
  if (!hasBwrap()) {
    // 真 runVerifyLoop 走 bwrap;缺则本 smoke 无意义。
    // 与 i9/i11 的 "key missing skip" 同语义:环境不具备真闭环前提即 skip 而非 fail。
    console.log(
      "bwrap not available, smoke skipped (verify-loop requires sandbox)"
    );
    mkdirSync(OUT_DIR, { recursive: true });
    const skip: SmokeResult = {
      result: "skipped",
      reason: "bwrap_missing",
      timestamp: new Date().toISOString(),
      model: "(n/a)",
      baseUrl: "(n/a)",
      key_source: "settings.llm.apiKey",
      maxTurns: 0,
      durationMs: 0,
      sections: [],
      notes: [
        "bwrap not available on PATH; runVerifyLoop real sandbox path unrunnable.",
      ],
    };
    writeFileSync(JSON_PATH, JSON.stringify(skip, null, 2) + "\n", "utf8");
    writeFileSync(
      MD_PATH,
      "# I408 smoke - session goal (real LLM)\n\n**SKIPPED** (bwrap missing)\n\n",
      "utf8"
    );
    return;
  }

  const env = loadIknowEnv(process.cwd());
  const apiKey = env.llm.apiKey;
  if (!apiKey) {
    // 与 i11 同:Ci 无 key skip 而非 fail。
    console.log(
      "key missing, smoke skipped (need settings.llm.apiKey to run real model)"
    );
    mkdirSync(OUT_DIR, { recursive: true });
    const skip: SmokeResult = {
      result: "skipped",
      reason: "key_missing",
      timestamp: new Date().toISOString(),
      model: env.llm.model,
      baseUrl: hostOf(env.llm.baseUrl),
      key_source: "settings.llm.apiKey",
      maxTurns: 0,
      durationMs: 0,
      sections: [],
      notes: [
        "key missing, smoke skipped per project convention (CI without key should not fail).",
      ],
    };
    writeFileSync(JSON_PATH, JSON.stringify(skip, null, 2) + "\n", "utf8");
    writeFileSync(
      MD_PATH,
      "# I408 smoke - session goal (real LLM)\n\n**SKIPPED** (key missing)\n\n",
      "utf8"
    );
    return;
  }

  // -- workspace: dataDir + traceDir
  const dataDir = mkdtempSync(join(tmpdir(), "i408-data-"));
  const traceDir = mkdtempSync(join(tmpdir(), "i408-trace-"));
  // verify 命令: `bash -c "true"` (shell builtin) → exit 0 deterministically。
  // bwrap 在 /tmp 上挂 --tmpfs,任何写在 /tmp 的 verify-script 在沙箱内都不可见;
  // 用 shell builtin 避开文件路径依赖,sandbox-run 仍走真 bwrap 真 run。
  const verifyConfig: VerifyConfig = { command: "true" };

  const start = Date.now();
  const notes: string[] = [];

  // ============================================================================
  // Section A — T2 (seed) + T4 (seam via real trace) + T5 (write-back)
  // ============================================================================
  // 设计: 同一会话先发一条 goal 文本 (T2 落种 → goal.text = 该文本),
  // 再发一条与 goal 无关的 query → T4 bind verify-loop userText = goal.text
  // (不是 query)。观测通道:
  //   - 第二条 turn 的 llm_call.messages 最后一条 user 消息 = goal.text
  //   - 第二条 turn 后 store.goal.status === "achieved" (verify passed → T5)
  // ============================================================================

  const conversationId = randomUUID();
  // createSession 写空 session file,然后第一条 postMessage 触发 T2 seed。
  const { listening: hubFor_A } = await (async (): Promise<{
    listening: SessionHub;
  }> => {
    // 用一个 stub hub 仅写空 session 文件 + 拿到 store,然后丢;真 hub 重读。
    const preStore = new SessionStore(
      dataDir,
      deriveProjectIdentityRoot({ cwd: process.cwd() })
    );
    const file = await preStore.save({
      id: conversationId,
      file: {
        schemaVersion: 5,
        conversation_id: conversationId,
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        summary: "",
        cwd: process.cwd(),
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
      },
    });
    void file;
    const hubA = await buildHub({
      dataDir,
      traceOut: traceDir,
      verifyConfig,
      apiKey,
      baseUrl: env.llm.baseUrl,
      model: env.llm.model,
      maxTokens: env.llm.maxOutputTokens,
    });
    return { listening: hubA };
  })();
  const hub = hubFor_A;

  const goalText = `Please reply with exactly the word ACK (goal-text-${randomUUID().slice(0, 6)})`;
  // Turn 1: text = goalText → T2 seeds goal = goalText, T5 promotes status to
  // 'achieved' (verify passed round 1). 模型被喂 goalText (因为 verify-loop 的
  // userText = session.goal.text ?? query,而此时 goal 尚 undefined → userText = query = goalText)
  const turnA1 = await hub.postMessage({
    conversationId,
    text: goalText,
  });
  const afterA1 = await new SessionStore(
    dataDir,
    deriveProjectIdentityRoot({ cwd: process.cwd() })
  ).load(conversationId);

  // Turn 2: 故意发一个与 goalText 完全不同的 query → T4 bind userText = goalText
  // (注意 goalText 在末尾带 UUID 后缀,query 是固定短串 → 可严格区分)。
  const decoyQuery = "DISTRACTION-QUERY-IGNORE-EVERYTHING";
  const turnA2 = await hub.postMessage({
    conversationId,
    text: decoyQuery,
  });
  const afterA2 = await new SessionStore(
    dataDir,
    deriveProjectIdentityRoot({ cwd: process.cwd() })
  ).load(conversationId);

  // 观测:读 trace JSONL 找 turn 2 的 llm_call messages。
  const traceFile = join(traceDir, `${conversationId}.jsonl`);
  const records = readJsonl(traceFile);
  const userMessages = userTextsOf(messagesOf(records));

  const sectionAAssertions: AssertionCheck[] = [
    {
      name: "turn1 stopReason === completed",
      pass: turnA1.turn.answer.stopReason === "completed",
      detail: `actual=${turnA1.turn.answer.stopReason}`,
    },
    {
      name: "T2 seed: turn1 后 store.goal.text === goalText",
      pass: afterA1.goal?.text === goalText,
      detail: `actual=${JSON.stringify(afterA1.goal?.text)}`,
    },
    {
      name: "T2 seed: source === 'user_initial'",
      pass: afterA1.goal?.source === "user_initial",
      detail: `actual=${afterA1.goal?.source}`,
    },
    {
      name: "T5 write-back: turn1 后 store.goal.status === 'achieved'",
      pass: afterA1.goal?.status === "achieved",
      detail: `actual=${afterA1.goal?.status}`,
    },
    {
      name: "turn2 stopReason === completed",
      pass: turnA2.turn.answer.stopReason === "completed",
      detail: `actual=${turnA2.turn.answer.stopReason}`,
    },
    {
      name: "T4 seam (real trace): turn2 末位 user message === goalText (非 query)",
      pass:
        userMessages.length > 0 &&
        userMessages[userMessages.length - 1] === goalText &&
        !userMessages.includes(decoyQuery),
      detail: `userTexts=[${userMessages.map((t) => JSON.stringify(t.slice(0, 40))).join(", ")}]`,
    },
    {
      name: "T5 write-back: turn2 后 store.goal.status 保持 'achieved'",
      pass: afterA2.goal?.status === "achieved",
      detail: `actual=${afterA2.goal?.status}`,
    },
    {
      name: "trace 含 record_type 'verification' (真 runVerifyLoop 跑过)",
      pass: records.some((r) => r["record_type"] === "verification"),
      detail: `verification_records=${records.filter((r) => r["record_type"] === "verification").length}`,
    },
  ];

  const sectionA: SectionResult = {
    section: "A: T2 + T4 + T5 (real LLM + real runVerifyLoop)",
    stopReason: turnA2.turn.answer.stopReason,
    llmCalls: records.filter((r) => r["record_type"] === "llm_call").length,
    userTexts: userMessages,
    goalOnDisk: afterA2.goal,
    assertions: sectionAAssertions,
  };

  // ============================================================================
  // Section B — T3 re-pin via ## GOAL: directive
  // ============================================================================
  // 设计: 同会话再发一条 `## GOAL: <new text>` 指令 → parseGoalCommand 切到
  // pinGoal,goal.text = new text, source = user_pin, history[0] = prior (superseded)。
  // 验证后 write-back 把 status 推回 'achieved'。query 在 re-pin 指令下是 new text
  // 本身(模型看到 new text),但 goal 持久化为 new text + source=user_pin + history。
  // ============================================================================

  const newGoalText = `Reply with exactly the word REPIN-${randomUUID().slice(0, 6)}`;
  const turnB = await hub.postMessage({
    conversationId,
    text: `## GOAL: ${newGoalText}`,
  });
  const afterB = await new SessionStore(
    dataDir,
    deriveProjectIdentityRoot({ cwd: process.cwd() })
  ).load(conversationId);

  const priorGoalSnapshot: GoalState | undefined = afterB.goal?.history?.[0];
  const sectionBAssertions: AssertionCheck[] = [
    {
      name: "turnB stopReason === completed",
      pass: turnB.turn.answer.stopReason === "completed",
      detail: `actual=${turnB.turn.answer.stopReason}`,
    },
    {
      name: "T3 re-pin: store.goal.text === newGoalText",
      pass: afterB.goal?.text === newGoalText,
      detail: `actual=${JSON.stringify(afterB.goal?.text)}`,
    },
    {
      name: "T3 re-pin: source === 'user_pin'",
      pass: afterB.goal?.source === "user_pin",
      detail: `actual=${afterB.goal?.source}`,
    },
    {
      name: "T3 re-pin: history[0].text === prior goalText (section A 的)",
      pass: priorGoalSnapshot?.text === goalText,
      detail: `prior=${JSON.stringify(priorGoalSnapshot?.text)}`,
    },
    {
      name: "T3 re-pin: history[0].status === 'superseded'",
      pass: priorGoalSnapshot?.status === "superseded",
      detail: `actual=${priorGoalSnapshot?.status}`,
    },
    {
      name: "T5 write-back: re-pin 后 status === 'achieved'",
      pass: afterB.goal?.status === "achieved",
      detail: `actual=${afterB.goal?.status}`,
    },
  ];

  const sectionB: SectionResult = {
    section: "B: T3 re-pin via ## GOAL: (real LLM + real runVerifyLoop)",
    stopReason: turnB.turn.answer.stopReason,
    llmCalls: records.filter((r) => r["record_type"] === "llm_call").length,
    userTexts: userMessages,
    goalOnDisk: afterB.goal,
    assertions: sectionBAssertions,
  };

  const durationMs = Date.now() - start;
  const allPass = [...sectionAAssertions, ...sectionBAssertions].every(
    (a) => a.pass
  );
  const sections = [sectionA, sectionB];

  const result: SmokeResult = {
    result: allPass ? "pass" : "fail",
    reason: "ran",
    timestamp: new Date().toISOString(),
    model: env.llm.model,
    baseUrl: hostOf(env.llm.baseUrl),
    key_source: "settings.llm.apiKey",
    maxTurns: 5,
    durationMs,
    sections,
    notes: [
      ...notes,
      "Real e2e for #408 (Session-level Goal for Verify-Loop Task Field).",
      "Observation channel: JSONL trace llm_call.messages (model's actual view) + SessionStore (goal persistence).",
      `Workspace: dataDir=${dataDir}, traceDir=${traceDir}, traceFile=${traceFile}`,
      "verify.command = `true` → runVerifyLoop exits 0 on round 1 → outcome 'passed' → T5 write-back fires.",
      ...(allPass
        ? []
        : [
            `FAIL: workspace preserved for inspection: dataDir=${dataDir}, traceDir=${traceDir}`,
          ]),
    ],
  };

  // -- 落证据 ----------------------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(JSON_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");

  const md =
    `# I408 smoke - session goal (real LLM)\n\n` +
    `**Result: ${result.result.toUpperCase()}**\n\n` +
    `| Field | Value |\n|-------|-------|\n` +
    `| model | ${result.model} |\n` +
    `| baseUrl host | ${result.baseUrl} |\n` +
    `| key_source | ${result.key_source} |\n` +
    `| maxTurns | ${result.maxTurns} |\n` +
    `| durationMs | ${result.durationMs} |\n\n` +
    sections
      .map(
        (s) =>
          `## ${s.section}\n\n` +
          `stopReason=${s.stopReason} llmCalls=${s.llmCalls} ` +
          `goal.status=${s.goalOnDisk?.status ?? "(none)"} ` +
          `goal.source=${s.goalOnDisk?.source ?? "(none)"}\n\n` +
          `| Assertion | Outcome |\n|-----------|---------|\n` +
          s.assertions
            .map(
              (a) =>
                `| ${a.name}${a.detail ? ` _(detail: ${a.detail})_` : ""} | ${a.pass ? "PASS" : "FAIL"} |`
            )
            .join("\n") +
          `\n\nUser-text messages in trace:\n\n` +
          s.userTexts
            .map((t, i) => `${i + 1}. ${JSON.stringify(t.slice(0, 120))}`)
            .join("\n") +
          `\n`
      )
      .join("\n") +
    `## Notes\n\n` +
    result.notes.map((n) => `- ${n}`).join("\n") +
    `\n`;
  writeFileSync(MD_PATH, md, "utf8");

  console.log(
    `result=${result.result} key_source=${result.key_source} model=${result.model} ` +
      `sectionA_pass=${sectionAAssertions.every((a) => a.pass)} ` +
      `sectionB_pass=${sectionBAssertions.every((a) => a.pass)} ` +
      `durationMs=${durationMs}`
  );
  if (!allPass) {
    console.error(`see ${MD_PATH}`);
    process.exitCode = 1;
  }

  // Cleanup: only on PASS. On FAIL, keep tmpdirs on disk so the operator /
  // downstream verifier / axis2 re-run can inspect the JSONL trace and
  // SessionFileV1. Paths are already written into result.notes[] above.
  if (allPass) {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(traceDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
