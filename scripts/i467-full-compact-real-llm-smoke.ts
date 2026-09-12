/**
 * #467 真实 LLM full-compact smoke：用真实模型测量压缩耗时并验证端到端契约。
 *
 * 背景:full-compact 不设默认 client-side 超时(wait 逻辑参考 Claude Code:
 * 压缩等模型自然完成,上限 = SDK 默认 HTTP timeout + 用户 signal 取消;
 * 默认 25s/attempt + retries 模型在长上下文下不够)。本 smoke 在
 * 真实 LLM 上测两条 case(中等 fixture / ~80KB 长 fixture)的 latencyMs,
 * 同时验证摘要结构化 / 提取 / 重组装契约与真实 SDK abort 传播。
 *
 * adapter 装配:loadIknowEnv → createAdapterFromEnv(env) —— 与生产
 * buildHarnessEngine / hub.reloadFromEnv 共用的 SSOT 工厂,流式臂开关 /
 * thinking / maxTokens 与生产逐字节一致。
 *
 * 三阶段(缺 key exit 1;fail exit 1):
 *   A. functional — 中等量 dropped,user/assistant/tool 交错;断言
 *      summarized + 9 节结构 + 种子事实保留 + 重装配几何;
 *   B. long-context latency — ~40 条 / ~80KB dropped,测真实 latencyMs;
 *      断言 summarized(无默认超时 → adapter 自然 settle);
 *   C. abort — timeoutMs=100ms 必须真 abort 飞行 HTTP(wall clock < 1s),
 *      验证 runFullCompact 注入缝 + 内部 AbortController 经 adapter 信号参数
 *      生效(adapter 两臂都把 signal 传给 SDK RequestOptions)。
 *
 * host-layer guard:smoke 自身不得引用 src/cli / src/session-api /
 * src/interaction / web/(harness 层独立性,同 i9 smoke)。
 *
 * 产物:docs/handoff/i467-full-compact/real-llm-full-compact.{json,md}
 * 独立运行:npx tsx scripts/i467-full-compact-real-llm-smoke.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIknowEnv } from "../src/config/env.js";
import type { IknowEnv } from "../src/config/env.js";
import { createAdapterFromEnv } from "../src/harness/build-engine.js";
import {
  splitForCompaction,
  buildCompactedMessages,
  runFullCompact,
} from "../src/harness/compress/index.js";
import type {
  AnthropicNativeMessage,
  TokenUsage,
} from "../src/harness/model-adapter/types.js";

const __filename = fileURLToPath(import.meta.url);
const OUT_DIR = join("docs", "handoff", "i467-full-compact");
const JSON_PATH = join(OUT_DIR, "real-llm-full-compact.json");
const MD_PATH = join(OUT_DIR, "real-llm-full-compact.md");

function assertHostLayerGuard(): void {
  const raw = readFileSync(__filename, "utf8");
  // 把注释内容替换为同长度空白(保留换行),错误行号仍对齐源码。
  // code-review #1 High:旧实现豁免 `*`/`//` 前缀行,JSDoc 顶部列禁词的注释
  // 被绕开;修复后扫描纯代码区,仅本守卫自身声明行豁免。
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
  const forbidden = ["src/cli", "src/session-api", "src/interaction", "web/"];
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes("const forbidden =")) continue;
    for (const kw of forbidden) {
      if (line.includes(kw)) {
        throw new Error(
          `host-layer guard violated at line ${i + 1}: contains '${kw}'. ` +
            `i467 smoke must stay in harness layer only.`
        );
      }
    }
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/\/.*$/, "");
  }
}

// -- fixture helpers ---------------------------------------------------------

const text = (value: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: value }],
});

const assistantText = (value: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [{ type: "text", text: value }],
});

const toolUse = (
  id: string,
  name: string,
  input: Record<string, unknown>
): AnthropicNativeMessage => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }],
});

const toolResult = (id: string, content: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
});

/** 真实编程会话 fixture:16 条 user/assistant/tool 交错,> DEFAULT_KEEP_RECENT。
 * 种子事实(断言摘要质量用):src/parser/lexer.ts、ZWJ identifier、#459 taskFocus。 */
function buildFunctionalConversation(): AnthropicNativeMessage[] {
  return [
    text(
      "调试一个 tokenization bug:src/parser/lexer.ts 第 142 行,identifier 的 " +
        "token 边界判定吞掉了 emoji 的 zero-width joiner。"
    ),
    assistantText(
      "已复现。isIdentStart 把 ZWJ 当成合字组合分隔符;下一步先写 isolation " +
        "test 把 case 锁死再修。"
    ),
    text("先写 isolation test,跑 regression 看是否确实复现这条边界。"),
    assistantText(
      "isolation test 已加 cases/parser/zwj-identifier.test.ts,当前 fail," +
        "证明 ZWJ 吞字符。"
    ),
    toolUse("t1", "run_tests", { path: "cases/parser/zwj-identifier.test.ts" }),
    toolResult("t1", "FAIL: expected single token, got 3 tokens"),
    text(
      "改成把 ZWJ 视为 identifier 内的有效 code point;同步检查 #459 taskFocus " +
        "是否要求 identifier 透传到编译后端。"
    ),
    assistantText(
      "#459 taskFocus:identifier 应作为 atomic symbol 传给后端,不在 lexer 侧" +
        "切分。修复策略:lexer 把 ZWJ 与上一个 identifier code point 合并为同一 token。"
    ),
    text("改 src/parser/lexer.ts 后再跑 isolation test + 全量 regression。"),
    assistantText(
      "改了 line 167;isolation case 过;全量 412 case 命中一条新 fail:keyword " +
        "'await' 在 emoji 上下文被错误合并。"
    ),
    toolUse("t2", "run_tests", {
      path: "tests/parser/regression-full.test.ts",
    }),
    toolResult(
      "t2",
      "FAIL: keyword 'await' merged with preceding emoji (1 of 412)"
    ),
    text(
      "那条 regression 单独看,是 keyword 优先级被破坏;不要为它退掉 ZWJ 修复。"
    ),
    assistantText(
      "同意不退掉。改成把 emoji 簇视为 own token class(symbol-emoji)," +
        "不进 identifier 也不进 keyword 路径,keyword 优先级守门还在。"
    ),
    text("重跑全量 regression 验证无新增 fail。"),
    assistantText(
      "全量 412 case 通过;新增 4 个 emoji identifier 单元测试覆盖主要簇。"
    ),
    text("收工。把修复点写成 handoff note,标注 ZWJ 簇的回归覆盖范围。"),
  ];
}

/** 长上下文压力 fixture:~80 条 / ~80KB 文本,模拟长编程会话。 */
function buildLongConversation(): AnthropicNativeMessage[] {
  const files = [
    "lexer.ts",
    "parser.ts",
    "resolver.ts",
    "binder.ts",
    "lowering.ts",
  ];
  const messages: AnthropicNativeMessage[] = [];
  for (let i = 0; i < 40; i++) {
    const file = files[i % 5]!;
    const lineNo = 100 + ((i * 7) % 800);
    const filler =
      `模块在 src/compiler/${file} 第 ${lineNo} 行附近:caching 层在并发读时漏掉 ` +
      `key 的 canonical 形式,导致 cache miss 退化为完整重算。canonical 化应收敛到 ` +
      `cache key 构造点,且 key 生成须幂等——同一逻辑单元无论何时何线程构造 key 都` +
      `必须得到同一字符串。修复策略:raw key 统一过 canonicalizeKey();回归 412 case。`;
    messages.push(
      text(
        `[turn ${i}] 报告:${file} 出现与 turn ${Math.max(i - 1, 0)} 相关的回归;` +
          filler
      ),
      assistantText(
        `已读 src/compiler/${file} line ${lineNo}:key 构造走 raw string,缺 canonical ` +
          `化。patch:raw key 用 canonicalizeKey() 包一层;test/cache-key.test.ts 覆盖 ` +
          `7 个 canonical 化场景。${filler}`
      )
    );
  }
  return messages;
}

// -- phases ------------------------------------------------------------------

interface PhaseResult {
  readonly outcome: string;
  readonly durationMs: number;
  readonly assertions: ReadonlyArray<{
    readonly name: string;
    readonly pass: boolean;
  }>;
  readonly notes: ReadonlyArray<string>;
}

async function runFunctionalPhase(env: IknowEnv): Promise<
  PhaseResult & {
    readonly summaryLen: number;
    readonly usage: TokenUsage | undefined;
  }
> {
  const { adapter } = createAdapterFromEnv(env);
  const conversation = buildFunctionalConversation();
  const split = splitForCompaction(conversation);
  if (split === undefined) {
    throw new Error("fixture invariant: split must exist (len > keepRecent)");
  }

  const startedAt = performance.now();
  const outcome = await runFullCompact({ adapter, dropped: split.dropped });
  const durationMs = Math.round(performance.now() - startedAt);

  if (outcome.kind !== "summarized") {
    return {
      outcome: outcome.kind,
      durationMs,
      summaryLen: 0,
      usage: undefined,
      assertions: [{ name: "outcome.kind === summarized", pass: false }],
      notes: [`kind=${outcome.kind};aborting structural assertions.`],
    };
  }

  const compacted = buildCompactedMessages({
    summaryText: outcome.text,
    kept: split.kept,
  });
  const firstBlock = compacted[0]?.content[0];
  const shapeOk =
    compacted.length === split.kept.length + 1 &&
    firstBlock !== undefined &&
    firstBlock.type === "text" &&
    firstBlock.text.startsWith(
      "This session is being continued from a previous conversation"
    ) &&
    firstBlock.text.endsWith(outcome.text);
  const seedRe = /lexer|lexer\.ts|#459|ZWJ|zero-width|tokenization/i;

  const assertions = [
    { name: "outcome.kind === summarized", pass: true },
    {
      name: "summary length >= 200 (non-trivial)",
      pass: outcome.text.length >= 200,
    },
    {
      name: "contains 'Primary Request' (9-section)",
      pass: /Primary Request/i.test(outcome.text),
    },
    {
      name: "preserves a seed fact (lexer/#459/ZWJ)",
      pass: seedRe.test(outcome.text),
    },
    {
      name: "no <analysis> tag leaked",
      pass: !outcome.text.includes("<analysis>"),
    },
    { name: "buildCompactedMessages shape ok", pass: shapeOk },
    {
      name: "usage.outputTokens > 0",
      pass: outcome.usage !== undefined && outcome.usage.outputTokens > 0,
    },
  ];
  return {
    outcome: outcome.kind,
    durationMs,
    summaryLen: outcome.text.length,
    usage: outcome.usage,
    assertions,
    notes: [],
  };
}

async function runLongPhase(env: IknowEnv): Promise<
  PhaseResult & {
    readonly droppedCount: number;
    readonly droppedCharCount: number;
    readonly summaryLen: number;
  }
> {
  const { adapter } = createAdapterFromEnv(env);
  const split = splitForCompaction(buildLongConversation());
  if (split === undefined) {
    throw new Error("long fixture invariant: split must exist");
  }
  const droppedCharCount = JSON.stringify(split.dropped).length;
  const startedAt = performance.now();
  const outcome = await runFullCompact({ adapter, dropped: split.dropped });
  const durationMs = Math.round(performance.now() - startedAt);
  // 无默认 client-side 超时(Claude Code 语义):phase B 仅记录真实 latency,
  // 不再比较"占默认超时 X%"。若 adapter 失败(timeout 已被 SDK 默认 HTTP 超时
  // 兜底;本 phase 调用未注入 timeoutMs → 不会触发 timer),如实上报 outcome。
  return {
    outcome: outcome.kind,
    durationMs,
    droppedCount: split.dropped.length,
    droppedCharCount,
    summaryLen: outcome.kind === "summarized" ? outcome.text.length : 0,
    assertions: [
      {
        name: "outcome.kind === summarized (long-context 在 SDK 默认 HTTP 超时内完成)",
        pass: outcome.kind === "summarized",
      },
    ],
    notes: [],
  };
}

async function runAbortPhase(env: IknowEnv): Promise<PhaseResult> {
  const { adapter } = createAdapterFromEnv(env);
  const dropped = buildFunctionalConversation();
  const timeoutMs = 100;
  const wallClockStart = performance.now();
  const outcome = await runFullCompact({ adapter, dropped, timeoutMs });
  const wallClockMs = Math.round(performance.now() - wallClockStart);
  return {
    outcome: outcome.kind,
    durationMs: wallClockMs,
    assertions: [
      {
        name: "outcome.kind === timeout (real SDK aborted)",
        pass: outcome.kind === "timeout",
      },
      {
        name: "wall clock < 1000ms (signal aborted HTTP, not just setTimeout race)",
        pass: wallClockMs < 1000,
      },
    ],
    notes: [],
  };
}

// -- main --------------------------------------------------------------------

async function main(): Promise<void> {
  assertHostLayerGuard();
  const env = loadIknowEnv(process.cwd());
  if (!env.llm.apiKey || env.llm.apiKey.length === 0) {
    console.error(
      "no API key — set settings.llm.apiKey (literal or ${VAR}) in " +
        "~/.iknow/settings.json (llm is a user-layer key, ADR-0084)"
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `assembly: model=${env.llm.model} stream=${env.llm.stream} ` +
      `thinking=${env.llm.thinking} baseUrl=${hostOf(env.llm.baseUrl)}`
  );

  console.log("phase A: functional ...");
  const functional = await runFunctionalPhase(env);
  console.log(
    `  outcome=${functional.outcome} latencyMs=${functional.durationMs} ` +
      `summaryLen=${functional.summaryLen} outputTokens=${functional.usage?.outputTokens ?? "n/a"}`
  );

  console.log("phase B: long-context latency stress ...");
  const long = await runLongPhase(env);
  console.log(
    `  outcome=${long.outcome} latencyMs=${long.durationMs} ` +
      `dropped=${long.droppedCount} chars=${long.droppedCharCount}`
  );
  for (const n of long.notes) console.log(`  note: ${n}`);

  console.log("phase C: real SDK abort path (timeoutMs=100) ...");
  const abort = await runAbortPhase(env);
  console.log(`  outcome=${abort.outcome} wallClockMs=${abort.durationMs}`);

  const allPass = [functional, long, abort].every((p) =>
    p.assertions.every((a) => a.pass)
  );
  const summary = {
    result: allPass ? ("pass" as const) : ("fail" as const),
    timestamp: new Date().toISOString(),
    model: env.llm.model,
    baseUrl: hostOf(env.llm.baseUrl),
    key_source: "settings.llm.apiKey",
    stream: env.llm.stream,
    thinking: env.llm.thinking,
    maxOutputTokens: env.llm.maxOutputTokens,
    timeout_policy: "no-default-client-side-timeout (Claude Code semantics)",
    phases: {
      functional: {
        outcome: functional.outcome,
        durationMs: functional.durationMs,
        summaryLen: (functional as { summaryLen: number }).summaryLen,
        outputTokens:
          (functional as { usage: TokenUsage | undefined }).usage
            ?.outputTokens ?? null,
        assertions: functional.assertions,
      },
      long: {
        outcome: long.outcome,
        durationMs: long.durationMs,
        droppedCount: long.droppedCount,
        droppedCharCount: long.droppedCharCount,
        summaryLen: long.summaryLen,
        assertions: long.assertions,
        notes: long.notes,
      },
      abort: {
        outcome: abort.outcome,
        wallClockMs: abort.durationMs,
        assertions: abort.assertions,
      },
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(JSON_PATH, JSON.stringify(summary, null, 2) + "\n", "utf8");

  const assertionTable = (
    name: string,
    p: { assertions: ReadonlyArray<{ name: string; pass: boolean }> }
  ) =>
    `\n### ${name}\n\n| Assertion | Outcome |\n|-----------|---------|\n` +
    p.assertions
      .map((a) => `| ${a.name} | ${a.pass ? "PASS" : "FAIL"} |`)
      .join("\n") +
    "\n";

  const md =
    `# I467 smoke — real LLM full-compact\n\n` +
    `**Result: ${summary.result.toUpperCase()}**\n\n` +
    `| Field | Value |\n|-------|-------|\n` +
    `| model | ${summary.model} |\n` +
    `| baseUrl host | ${summary.baseUrl} |\n` +
    `| stream | ${summary.stream} |\n` +
    `| thinking | ${summary.thinking} |\n` +
    `| maxOutputTokens | ${summary.maxOutputTokens} |\n` +
    `| timeout policy | ${summary.timeout_policy} |\n\n` +
    `## Phase A — functional\n\n` +
    `| Field | Value |\n|-------|-------|\n` +
    `| outcome | ${summary.phases.functional.outcome} |\n` +
    `| latencyMs | ${summary.phases.functional.durationMs} |\n` +
    `| summaryLen | ${summary.phases.functional.summaryLen} |\n` +
    `| outputTokens | ${summary.phases.functional.outputTokens} |\n` +
    `## Phase B — long-context latency stress\n\n` +
    `| Field | Value |\n|-------|-------|\n` +
    `| outcome | ${summary.phases.long.outcome} |\n` +
    `| latencyMs | ${summary.phases.long.durationMs} |\n` +
    `| dropped count / chars | ${summary.phases.long.droppedCount} / ${summary.phases.long.droppedCharCount} |\n` +
    `| summaryLen | ${summary.phases.long.summaryLen} |\n\n` +
    (summary.phases.long.notes.length > 0
      ? `**Notes**\n\n${summary.phases.long.notes.map((n) => `- ${n}`).join("\n")}\n`
      : "") +
    `## Phase C — real SDK abort path\n\n` +
    `| Field | Value |\n|-------|-------|\n` +
    `| outcome | ${summary.phases.abort.outcome} |\n` +
    `| wallClockMs | ${summary.phases.abort.wallClockMs} |\n` +
    assertionTable("Phase A assertions", summary.phases.functional) +
    assertionTable("Phase B assertions", summary.phases.long) +
    assertionTable("Phase C assertions", summary.phases.abort);
  writeFileSync(MD_PATH, md, "utf8");

  console.log(
    `result=${summary.result} A=${functional.outcome}/${functional.durationMs}ms ` +
      `B=${long.outcome}/${long.durationMs}ms C=${abort.outcome}/${abort.durationMs}ms`
  );
  console.log(`see ${MD_PATH}`);
  if (!allPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
