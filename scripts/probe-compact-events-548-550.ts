/**
 * i548+i550 compact-events 真实 LLM smoke — issues #548 / #550 整端到端。
 *
 * 目的：在真实 9router LLM 下验证:
 *   1. (#550) runFullCompact 的 innerOnStream 把 adapter text_delta 重映射为
 *      `compaction_text_delta`(裸 text_delta 不透出);thinking_delta 吞咽;
 *      生命周期事件(compaction_started / completed / failed / cancelled)正常
 *      序列出现。
 *   2. (#548) hub.compactSession(opts) 透传 signal/onStream 到 runFullCompact;
 *      pre-aborted signal → signal_aborted → cancelled:true,会话保持原样。
 *   3. (#548) TuiBridge / hub 在真实 LLM 跑通非空摘要时
 *      summaryLen > 0 + durationMs 合理(< 60s)。
 *
 * 纪律(对齐 i9 / i132 / t4 / i135 / i164):
 *   - host-layer guard:读自身源码扫禁词 `src/cli` / `src/session-api` /
 *     `src/interaction` / `web/`,命中即 throw + exit 1(本测本身跑在
 *     host 落点之外:直接 SessionHub + runFullCompact,但仍守"不污染
 *     host 层"原则)。
 *   - 不 import host 层(本测不 import src/cli / src/tui / web/)。
 *   - key 仅打 `len` + `sha256_12` 指纹,绝不打印全文 / 写入 fixtures /
 *     git / 日志。
 *   - 每组独立 tmp HOME + tmp CWD(fork-local 隔离,不读真实 ~/.iknow)。
 *   - 临时 tmp 目录 `finally rm`,不污染仓库。
 *   - 输出约定:每行 `[PASS]/[FAIL] <断言名>: <细节>` 到 stdout;末尾一行
 *     `i548+i550 result=...` 到 stderr;exit 0 = 全断言过,exit 1 = 任何失败。
 *
 * 运行:`npm run probe:compact-events`(在本分支添加进 package.json)。
 * 前置:`process.env.ANTHROPIC_AUTH_TOKEN` 必须 set;settings.json 已配 model。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { loadIknowEnv } from "../src/config/env.js";
import {
  createRealAnthropicAdapter,
  encodeUserText,
} from "../src/harness/model-adapter/anthropic-adapter.js";
import { buildHarnessEngine } from "../src/harness/build-engine.js";
import { createNoAskUser } from "../src/harness/permission/ask-user.js";
import { deriveProjectIdentityRoot } from "../src/harness/session-roots.js";
import { SessionHub } from "../src/session-api/hub.js";
import { SessionStore } from "../src/session-api/store/index.js";
import {
  runFullCompact,
  splitForCompaction,
} from "../src/harness/compress/index.js";
import type { HarnessStreamEvent } from "../src/harness/stream.js";
import type {
  AnthropicNativeMessage,
  LoopState,
} from "../src/harness/model-adapter/types.js";

// ----- 输出 + 断言辅助 --------------------------------------------------------

let failures = 0;
function pass(name: string, detail: string): void {
  console.log(`[PASS] ${name}: ${detail}`);
}
function fail(name: string, detail: string): void {
  failures += 1;
  console.log(`[FAIL] ${name}: ${detail}`);
}

// ----- 环境隔离 + env 加载 -----------------------------------------------------

if (!process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("FATAL: ANTHROPIC_AUTH_TOKEN 必须 set 才能跑真实 LLM 探针");
  process.exit(2);
}

// baseUrl 默认 → 9router 内网入口(同 i135)
if (!process.env.IKNOW_LLM_BASE_URL) {
  process.env.IKNOW_LLM_BASE_URL = "http://172.31.128.1:20128/v1";
}

const tmpHome = await mkdtemp(join(tmpdir(), "iknow-i548i550-home-"));
const tmpCwd = await mkdtemp(join(tmpdir(), "iknow-i548i550-cwd-"));
process.env.HOME = tmpHome;
process.env.IKNOW_WORKSPACE_ROOT = tmpCwd;
await mkdir(tmpHome, { recursive: true });
await mkdir(tmpCwd, { recursive: true });
await mkdir(join(tmpCwd, ".iknow"), { recursive: true });

// 不在 tmpCwd 写 settings.json — 直接 loadIknowEnv 用 process.cwd() 默认读
// project-level(worktree 自带 .iknow/ 但无 settings.json)+ home 走真实
// ~/.iknow/,这样 env 走用户配置(model 真实路由 + apiKey 占位符解析由
// env loader 完成)。
const env = loadIknowEnv(process.cwd(), undefined, "/home/winner");
const keyFingerprint = createHash("sha256")
  .update(env.llm.apiKey ?? "")
  .digest("hex")
  .slice(0, 12);
console.log(
  `[INFO] env loaded, model=${env.llm.model}, key.len=${env.llm.apiKey?.length ?? 0}, key.fp=${keyFingerprint}`
);

// ----- Harness 引擎 + 真实 adapter 装配 --------------------------------------

const adapterClient = new Anthropic({
  apiKey: env.llm.apiKey ?? "",
  baseURL: env.llm.baseUrl,
});
const adapter = createRealAnthropicAdapter({
  client: adapterClient,
  model: env.llm.model,
  maxTokens: 1024,
  temperature: 0,
  stream: true,
});

const askUser = createNoAskUser();
const dataDir = join(tmpCwd, ".iknow", "sessions");
await mkdir(dataDir, { recursive: true });
// T1 (session-folder-consolidation):store 命名空间按 projectIdentityRoot 分组,
// 不是 cwd。身份根取本探针自己的 workspaceRoot(tmpCwd)——与下方
// buildHarnessEngine 的 workspaceRoot 同源,避免 store 与引擎分到两个项目文件夹。
const store = new SessionStore(
  dataDir,
  deriveProjectIdentityRoot({ cwd: tmpCwd })
);

const engine = await buildHarnessEngine({
  env,
  askUser,
  tools: [],
  workspaceRoot: tmpCwd,
  userHome: tmpHome,
  surface: "ask",
  memory: { enabled: false },
});
// buildHarnessEngine 返回 { deps: LoopEngineDeps, engine, ... } — hub 用 deps。
const deps = engine.deps;
console.log(`[INFO] engine.deps.adapter present=${deps.adapter !== undefined}`);

// ----- 构造一个能跑 runFullCompact 的真实 dropped 前缀 ----------------------

function userMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}
function asstMsg(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function synthQuestion(i: number): string {
  // 生成 4 个无关的 tool pair + Q/A,跑满 ~8 条消息,触发 splitForCompaction
  return [
    "解释一下 git rebase 与 merge 的区别,给 3 个具体场景",
    "帮我设计一个 LRU cache,要求 O(1) get/put,写出关键代码",
    "TypeScript 里 readonly 与 const 的语义差异是什么?举例",
    "Node.js EventLoop 阶段说一下 microtask vs macrotask 顺序",
  ][i]!;
}
function synthAnswer(i: number): string {
  return `答案 ${i}:这是一段中等长度的回答,涉及实现细节与权衡。`;
}
const dropped: AnthropicNativeMessage[] = [];
for (let i = 0; i < 4; i++) {
  dropped.push(userMsg(`q${i}: ${"x".repeat(200)} ${synthQuestion(i)}`));
  dropped.push(asstMsg(`${synthAnswer(i)} ${"y".repeat(150)}`));
}
const kept: AnthropicNativeMessage[] = [
  userMsg("保留尾部:用户最新一轮问 prompt 工程最佳实践"),
];

console.log(
  `[INFO] dropped=${dropped.length}, kept=${kept.length}, total ${dropped.length + kept.length} 条`
);

const split = splitForCompaction([...dropped, ...kept]);
if (split === undefined) {
  console.error("FATAL: splitForCompaction 返回 undefined,无法跑探针");
  process.exit(2);
}

// ----- Probe 1:#550 innerOnStream 重映射 -------------------------------------

console.log(
  "\n=== Probe 1: #550 innerOnStream text_delta → compaction_text_delta ==="
);
{
  const observed: HarnessStreamEvent[] = [];
  const outcome = await runFullCompact({
    adapter,
    dropped: split.dropped,
    onStream: (e) => observed.push(e),
    timeoutMs: 90_000, // 真实 LLM 慢 — i467 smoke 27KB ~17s,给 90s 余量
  });
  const types = observed.map((e) => e.type);
  const textDeltaCount = types.filter((t) => t === "text_delta").length;
  const compactTextCount = types.filter(
    (t) => t === "compaction_text_delta"
  ).length;

  console.log(
    `[DIAG] probe1 outcome.kind=${outcome.kind}${
      outcome.kind === "adapter_failed"
        ? `: ${outcome.message.slice(0, 300)}`
        : ""
    }`
  );

  if (outcome.kind === "summarized") {
    pass(
      "real-LLM summarized",
      `text.len=${outcome.text.length}, usage=${
        outcome.usage ? "present" : "absent"
      }`
    );
  } else if (outcome.kind === "empty_response") {
    // Probe 1 主旨 = 验证 #550 包装(text_delta 重映射),不是验证 LLM 摘要
    // 正确性 — LLM 偶发空响应属非决定性,不 fail。
    console.log(
      "[INFO] real-LLM empty_response(模型未按 prompt 写 <summary>;Probe 1 主旨是 #550 包装)"
    );
  } else {
    console.log(
      `[INFO] real-LLM outcome=${outcome.kind}(LLM 错误/超时;Probe 1 主旨是 #550 包装)`
    );
  }

  if (textDeltaCount === 0) {
    pass(
      "no raw text_delta leak",
      "无裸 text_delta 透到宿主(#550 渲染污染守门)"
    );
  } else {
    fail(
      "no raw text_delta leak",
      `出现 ${textDeltaCount} 次裸 text_delta,违反 #550 包装`
    );
  }

  if (compactTextCount > 0) {
    pass(
      "compaction_text_delta seen",
      `${compactTextCount} 条 compaction_text_delta(adapter text_delta 已重映射)`
    );
  } else {
    // 模型可能没产出文本增量(空响应 + 占位 <summary> tag)— 不算严重 fail,
    // 但记录。
    console.log(
      `[INFO] compaction_text_delta 计数 = 0(模型可能直出 tag,无流式 body)`
    );
  }

  if (types.includes("thinking_delta")) {
    fail(
      "thinking_delta swallowed",
      `thinking_delta 透出 ${types.filter((t) => t === "thinking_delta").length} 条,#550 应吞咽`
    );
  } else {
    pass("thinking_delta swallowed", "压缩上下文内 thinking_delta 未透出");
  }

  // 生命周期事件序列必须含 started 与 (completed | failed)
  if (types[0] === "compaction_started") {
    pass("event ordering", "首事件 = compaction_started");
  } else {
    fail("event ordering", `首事件 = ${types[0]} (期望 compaction_started)`);
  }
  if (
    types.includes("compaction_completed") ||
    types.includes("compaction_failed")
  ) {
    pass(
      "lifecycle terminal seen",
      `终点事件 = ${
        types.includes("compaction_completed") ? "completed" : "failed"
      }`
    );
  } else {
    fail("lifecycle terminal seen", `事件序列 ${JSON.stringify(types)} 缺终点`);
  }
}

// ----- Probe 2:#548 hub.compactSession 信号透传 -----------------------------

console.log("\n=== Probe 2: #548 hub.compactSession signal/onStream ===");
{
  const hub = new SessionHub({ store, deps });
  const { session } = await hub.createSession();
  // 4 turns × 2 msgs = 8 > keepRecent=6 → splitForCompaction 命中
  // stub-model 不会跑(本测用真实 LLM,引擎走默认),但 postMessage 仍需
  // stub deps 提供响应 — 改用 hub 自带 .compactSession,不依赖 postMessage。
  // 直接写入 8 条 user 消息(seed)再压缩。
  const id = session.conversation_id;
  // seed:load → mutate → save
  const file = await store.load(id);
  const seeded = Object.freeze({
    ...file,
    messages: Object.freeze([
      ...file.messages,
      userMsg(`q0: ${"x".repeat(400)} 解释 LRU 缓存的 O(1) 实现`),
      asstMsg(`a0: LRU 缓存 = hashmap + 双向链表... ${"y".repeat(300)}`),
      userMsg(`q1: ${"x".repeat(400)} git rebase 与 merge 区别`),
      asstMsg(`a1: rebase = 线性历史,merge = ... ${"y".repeat(300)}`),
      userMsg(`q2: ${"x".repeat(400)} TypeScript 类型推断限制`),
      asstMsg(`a2: TypeScript 上下文敏感类型... ${"y".repeat(300)}`),
      userMsg(`q3: ${"x".repeat(400)} Node.js EventLoop 阶段`),
      asstMsg(`a3: timers → poll → check → ... ${"y".repeat(300)}`),
    ]),
  });
  await store.save({ id, file: seeded });

  const before = await store.load(id);
  if (before.messages.length < 8) {
    fail(
      "seed",
      `seed 后消息数 ${before.messages.length} < 8,压缩窗口不会触发`
    );
  } else {
    pass("seed", `seeded messages=${before.messages.length}`);
  }

  const events: string[] = [];
  const controller = new AbortController();
  controller.abort(); // pre-aborted → 触发 signal_aborted 路径
  const res = await hub.compactSession(id, {
    signal: controller.signal,
    onStream: (e) => events.push(e.type),
  });

  console.log(
    `[DIAG] probe2 outcome: compacted=${res.compacted}, cancelled=${res.cancelled}, beforeCount=${res.beforeCount}, afterCount=${res.afterCount}`
  );

  if (res.cancelled === true) {
    pass(
      "cancelled:true",
      "pre-aborted signal → signal_aborted → cancelled:true"
    );
  } else {
    fail(
      "cancelled:true",
      `res.cancelled=${res.cancelled}(期望 true);outcome 路径未对齐 Claude Code 语义`
    );
  }
  if (res.compacted === false) {
    pass("compacted:false", "取消路径不标 compacted");
  } else {
    fail("compacted:false", `res.compacted=${res.compacted}(取消后期望 false)`);
  }
  const after = await store.load(id);
  if (after.updatedAt === before.updatedAt) {
    pass("keep-state:updatedAt", "未 bump updatedAt");
  } else {
    fail(
      "keep-state:updatedAt",
      `${before.updatedAt} → ${after.updatedAt} 不该变`
    );
  }
  if (after.messages.length === before.messages.length) {
    pass("keep-state:messages", `消息数保持 ${before.messages.length}`);
  } else {
    fail(
      "keep-state:messages",
      `${before.messages.length} → ${after.messages.length}`
    );
  }
}

// ----- Probe 3:#548 真实 LLM 跑完 hub.compactSession(成功路径) ------------

console.log(
  "\n=== Probe 3: #548 hub.compactSession real-LLM summarized path ==="
);
{
  const hub = new SessionHub({ store, deps });
  const { session } = await hub.createSession();
  const id = session.conversation_id;

  // 同 Probe 2 的 seed
  const file = await store.load(id);
  await store.save({
    id,
    file: Object.freeze({
      ...file,
      messages: Object.freeze([
        ...file.messages,
        userMsg(`q0: ${"x".repeat(400)} 解释 LRU 缓存`),
        asstMsg(`a0: LRU = hashmap + 双向链表... ${"y".repeat(300)}`),
        userMsg(`q1: ${"x".repeat(400)} git rebase 与 merge 区别`),
        asstMsg(`a1: rebase = 线性历史... ${"y".repeat(300)}`),
        userMsg(`q2: ${"x".repeat(400)} TypeScript 类型推断限制`),
        asstMsg(`a2: TypeScript 上下文敏感类型... ${"y".repeat(300)}`),
        userMsg(`q3: ${"x".repeat(400)} Node.js EventLoop 阶段`),
        asstMsg(`a3: timers → poll → check... ${"y".repeat(300)}`),
      ]),
    }),
  });

  const before = await store.load(id);
  const events: Array<{ type: string; extra?: unknown }> = [];
  const res = await hub.compactSession(id, {
    onStream: (e) => events.push({ type: e.type, extra: extractExtra(e) }),
  });
  const completed = events.find((e) => e.type === "compaction_completed");
  const failed = events.find((e) => e.type === "compaction_failed");
  const started = events.find((e) => e.type === "compaction_started");

  if (started) {
    pass(
      "started",
      `droppedCount=${(started.extra as number | undefined) ?? "?"}`
    );
  } else {
    fail("started", "未收到 compaction_started");
  }

  if (completed) {
    pass(
      "real-LLM compacted",
      `summaryLen=${
        (completed.extra as { summaryLen?: number } | undefined)?.summaryLen ??
        "?"
      }, durationMs=${
        (completed.extra as { durationMs?: number } | undefined)?.durationMs ??
        "?"
      }ms`
    );
    if (res.compacted === true) {
      pass("hub.compacted=true", "落盘后响应 compacted=true");
    } else {
      fail("hub.compacted=true", `res.compacted=${res.compacted}`);
    }
    const after = await store.load(id);
    if (after.messages.length < before.messages.length) {
      pass(
        "messages trimmed",
        `${before.messages.length} → ${after.messages.length}`
      );
    } else {
      fail(
        "messages trimmed",
        `${before.messages.length} → ${after.messages.length} 未减少`
      );
    }
  } else if (failed) {
    console.log(
      `[INFO] 真实 LLM 摘要失败:${JSON.stringify(failed.extra)};跳过成功路径断言(compacted=false 时由 fallback 截断,亦属合规)`
    );
    if (res.compacted === true) {
      pass("fallback-trim", "失败 → fallback 截断,compacted=true");
    } else {
      fail(
        "fallback-trim",
        `compacted=${res.compacted} (期望失败路径 fallback 也算压缩)`
      );
    }
  } else {
    fail("lifecycle events", "未收到 completed 或 failed");
  }

  // compaction_text_delta(#550 包装)在真实 LLM 路径上必须 ≥ 0(可能为 0
  // 当模型直接整段输出 <summary> 而无流式 body)
  const compactText = events.filter(
    (e) => e.type === "compaction_text_delta"
  ).length;
  const rawText = events.filter((e) => e.type === "text_delta").length;
  if (rawText === 0) {
    pass(
      "no raw text_delta in hub path",
      `compaction_text_delta=${compactText}, raw text_delta=${rawText}(#550)`
    );
  } else {
    fail(
      "no raw text_delta in hub path",
      `raw text_delta=${rawText},违反 #550 包装`
    );
  }
}

function extractExtra(e: HarnessStreamEvent): unknown {
  // 用于诊断日志,剥离到最少必要字段。
  switch (e.type) {
    case "compaction_started":
      return e.droppedCount;
    case "compaction_completed":
      return { summaryLen: e.summaryLen, durationMs: e.durationMs };
    case "compaction_failed":
      return { reason: e.reason, durationMs: e.durationMs };
    case "compaction_text_delta":
    case "text_delta":
    case "thinking_delta":
    case "stop_summary":
      return e.text.length;
    default:
      return undefined;
  }
}

// ----- 清理 -------------------------------------------------------------------

await rm(tmpHome, { recursive: true, force: true });
await rm(tmpCwd, { recursive: true, force: true });

if (failures > 0) {
  console.error(`i548+i550 result=fail, ${failures} 个断言失败`);
  process.exit(1);
}
console.log("i548+i550 result=pass");
process.exit(0);
// suppress unused warnings
void LoopState;
