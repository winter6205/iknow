/**
 * 022 T10 smoke: Session API serve path harness e2e.
 *
 * 目的:在真实流量下跑通 Session API serve 路径(
 * startSessionServe → POST /sessions → POST /sessions/:id/messages),
 * 验证 022 主路径 wire 改写(QueryDto → TurnAnswerDto / SessionSummary
 * 去 caller_role / hub 直连 harness / ServeOptions 删 role) 端到端正确,
 * 为 022 plan T10 提供可注入的 serve-path 证据。
 *
 * 边界(与 plan T10 + 主脑裁决 #15 对齐):
 *   - host-layer guard:读自身源码,扫禁词 src/interaction / src/agent-loop
 *     / web/,命中即 throw + exit 1(不污染旧 loop + web)。
 *     与 i9/i10 不同:i11 测的是 session-api serve 路径,合法 import
 *     src/session-api/(测试对象) + src/harness/(被 session-api 依赖的
 *     Foundation) + src/config/。
 *   - 真实跑通 serve 路径:startSessionServe({ dataDir: <tmp> }) → 起
 *     HTTP server → fetch POST /sessions → POST /sessions/:id/messages
 *     (真实模型 chat) → 关闭 server。和断言门逐字对齐(SC4):
 *     ① stopReason === "completed" ② turnCount >= 2 (多 step)
 *     ③ 多 step (trace.turns.length >= 2 或 messages 累积)
 *     ④ finalText 非空 ⑤ cancelled 场景(AbortController abort →
 *     stopReason === "cancelled") ⑥ timeout 场景(极短 timeoutMs →
 *     stopReason === "timeout")
 *   - cancelled / timeout: HTTP 层不暴露 signal,主脑裁决允许通过
 *     SessionHub 直接测试(同属 session-api 路径,只是非 HTTP 入口);
 *     用 never-resolving adapter + AbortController / timeoutMs=1 触发。
 *     严格走 SessionHub + SessionStore + 项目 LoopEngineDeps 工厂,
 *     不引入新的 stub 类型。
 *   - 成功落 docs/handoff/i11-smoke/session-api-harness.{json,md};
 *     失败落 fail 文件 + 打 trace + exit 1。
 *   - 缺 apiKey → stdout 打印 "key missing, smoke skipped" + exit 0
 *     (CI 无 key 不应 fail;与 i9/i10 的 exitCode=1 不同,这是主脑裁决
 *     的 T10 验收点:CI 缺失时 skip 而非 fail)。
 *   - 不 log key/baseURL 完整值;baseURL 只截到 host。
 *
 * 真实失败回流(plan out-of-scope):若模型偶发撞 maxTurns / 9router
 * 不支持 /v1/messages 等,不在此修复,留档 notes + 开后续 ticket。
 *
 * 独立运行:npx tsx scripts/i11-session-api-harness-smoke.ts
 * (不进 npm scripts,不进 vitest)
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIknowEnv } from "../src/config/env.js";
import { startSessionServe } from "../src/session-api/serve.js";
import { SessionHub } from "../src/session-api/hub.js";
import { SessionStore } from "../src/session-api/store/index.js";
import {
  createExecutor,
  createLoopEngine,
  createRegistry,
  type AnthropicContentBlock,
  type AnthropicNativeMessage,
  type AssistantTurnResult,
  type LoopAdapter,
  type LoopEngineDeps,
  type StopReason,
} from "../src/harness/index.js";

const __filename = fileURLToPath(import.meta.url);
const OUT_DIR = join("docs", "handoff", "i11-smoke");
const JSON_PATH = join(OUT_DIR, "session-api-harness.json");
const MD_PATH = join(OUT_DIR, "session-api-harness.md");

/**
 * host-layer guard:smoke 自身不得引用 src/interaction / src/agent-loop /
 * web/。i11 测的是 session-api serve 路径,合法 import src/session-api/
 * (测试对象) + src/harness/(被 session-api 依赖的 Foundation) + src/config/。
 * 作用是代码评审的"门":T10 验收必须真正走 Session API serve 路径,
 * 不能退化成又一份 in-process run() 测试。
 */
function assertHostLayerGuard(): void {
  const self = readFileSync(__filename, "utf8");
  const forbidden = ["src/interaction", "src/agent-loop", "web/"];
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
            `i11 smoke must stay in session-api + harness + config layers only.`
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

interface AssertionCheck {
  readonly name: string;
  readonly pass: boolean;
}

interface ServeSection {
  readonly stopReason: string;
  readonly turnCount: number;
  readonly finalText_excerpt: string;
  readonly sessionTurnCount: number;
  readonly stopReason_valid: boolean;
}

interface MapCancelSection {
  readonly stopReason: string;
  readonly turnCount: number;
  readonly exceptionName: string;
}

interface TimeoutSection {
  readonly stopReason: string;
  readonly turnCount: number;
  readonly exceptionName: string;
}

interface SmokeResult {
  readonly result: "pass" | "fail";
  readonly reason: string;
  readonly timestamp: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly key_env: string;
  readonly maxTurns: number;
  readonly durationMs: number;
  readonly serve: ServeSection;
  readonly cancel: MapCancelSection;
  readonly timeout: TimeoutSection;
  readonly assertions: ReadonlyArray<AssertionCheck>;
  readonly notes: ReadonlyArray<string>;
}

const FINAL_TEXT_EXCERPT_MAX = 200;

/**
 * Never-resolving LoopAdapter:用于 cancelled / timeout 场景。
 * step() 返回一个永不 settle 的 Promise,让 raceModel 的 timer 永远
 * 等待,从而可控地触发 abort signal 或 timeoutMs。
 *
 * 真实路径走的是 harness 的 raceModel(loop-engine.ts:128-179),
 * 此处用 stub 模拟"模型侧永远不响应"是 spec 017 T5 文档里允许的
 * 测试手段(主脑裁决:T10 实施期定,6 条断言必须都有)。
 */
const neverResolvingAdapter: LoopAdapter = {
  step: () => new Promise<AssistantTurnResult>(() => {}),
  encodeUserText: (text: string): AnthropicNativeMessage => ({
    role: "user",
    content: [{ type: "text", text } satisfies AnthropicContentBlock],
  }),
  encodeToolResults: () => [],
};

interface HttpJsonResponse {
  readonly status: number;
  readonly body: unknown;
}

async function fetchJson(
  baseUrl: string,
  path: string,
  init: RequestInit
): Promise<HttpJsonResponse> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  if (!text) {
    return { status: res.status, body: null };
  }
  try {
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, body: text };
  }
}

interface CreateSessionBody {
  readonly session?: {
    readonly conversation_id?: string;
    readonly turn_count?: number;
  };
}

interface PostMessageBody {
  readonly session?: {
    readonly conversation_id?: string;
    readonly turn_count?: number;
  };
  readonly turn?: {
    readonly query?: string;
    readonly answer?: {
      readonly finalText?: string;
      readonly stopReason?: StopReason;
      readonly turnCount?: number;
    };
  };
}

async function runServeSection(baseUrl: string): Promise<{
  stopReason: string;
  turnCount: number;
  finalText: string;
  sessionTurnCount: number;
  stopReasonValid: boolean;
  runError: string | null;
}> {
  const createRes = await fetchJson(baseUrl, "/api/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (createRes.status !== 201) {
    return {
      stopReason: "create_failed",
      turnCount: 0,
      finalText: "",
      sessionTurnCount: 0,
      stopReasonValid: false,
      runError: `create session returned ${createRes.status}`,
    };
  }
  const createBody = createRes.body as CreateSessionBody | null;
  const conversationId = createBody?.session?.conversation_id;
  if (!conversationId) {
    return {
      stopReason: "create_invalid",
      turnCount: 0,
      finalText: "",
      sessionTurnCount: 0,
      stopReasonValid: false,
      runError: "create session response missing conversation_id",
    };
  }

  const msgRes = await fetchJson(
    baseUrl,
    `/api/v1/sessions/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "echo 'hello harness' 然后告诉我当前时间",
      }),
    }
  );
  const msgBody = msgRes.body as PostMessageBody | null;
  const answer = msgBody?.turn?.answer;
  const stopReason = answer?.stopReason ?? "unknown";
  const turnCount = answer?.turnCount ?? 0;
  const finalText = answer?.finalText ?? "";
  const sessionTurnCount = msgBody?.session?.turn_count ?? 0;

  return {
    stopReason,
    turnCount,
    finalText,
    sessionTurnCount,
    stopReasonValid: stopReason === "completed",
    runError:
      msgRes.status !== 200 ? `messages returned ${msgRes.status}` : null,
  };
}

interface HubPostResult {
  readonly stopReason: string;
  readonly turnCount: number;
  readonly exceptionName: string;
}

/**
 * 创建一个带注入 deps 的 SessionHub(SessionStore + 自定义 LoopEngineDeps)。
 * 用于 cancelled / timeout 场景 — HTTP 层不暴露 signal,必须走 Hub 入口。
 */
async function runHubWithDeps(
  deps: LoopEngineDeps,
  text: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<HubPostResult> {
  const dataDir = mkdtempSync(join(tmpdir(), "i11-smoke-hub-"));
  try {
    const store = new SessionStore(dataDir);
    const hub = new SessionHub({
      store,
      deps,
      defaultMode: "llm",
      defaultJsonMode: false,
    });
    const created = await hub.createSession();
    const conversationId = created.session.conversation_id;
    try {
      const result = await hub.postMessage(conversationId, text, {
        signal: opts?.signal,
      });
      return {
        stopReason: result.turn.answer.stopReason,
        turnCount: result.turn.answer.turnCount,
        exceptionName: "none",
      };
    } catch (e) {
      return {
        stopReason: "exception",
        turnCount: 0,
        exceptionName: e instanceof Error ? e.constructor.name : String(e),
      };
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  assertHostLayerGuard();

  const env = loadIknowEnv(process.cwd());
  const apiKey = env.llm.apiKey;
  const keyEnv = env.llm.apiKeyEnv;
  if (!apiKey || apiKey.length === 0) {
    // 主脑裁决:CI 无 key 时 skip 非 fail,exitCode 0 而非 1。
    console.log(
      `key missing, smoke skipped (need env var ${keyEnv} to run real model)`
    );
    // 写入最小 skip 证据,让审查者能看到脚本曾运行。
    const skipResult: SmokeResult = {
      result: "pass",
      reason: "key_missing",
      timestamp: new Date().toISOString(),
      model: env.llm.model,
      baseUrl: hostOf(env.llm.baseUrl),
      key_env: keyEnv,
      maxTurns: 6,
      durationMs: 0,
      serve: {
        stopReason: "skipped",
        turnCount: 0,
        finalText_excerpt: "",
        sessionTurnCount: 0,
        stopReason_valid: false,
      },
      cancel: {
        stopReason: "skipped",
        turnCount: 0,
        exceptionName: "skipped",
      },
      timeout: {
        stopReason: "skipped",
        turnCount: 0,
        exceptionName: "skipped",
      },
      assertions: [],
      notes: [
        "key missing, smoke skipped per plan T10 acceptance (CI without key should not fail).",
        "Run with NINE_ROUTER_KEY (or IKNOW_LLM_API_KEY_ENV) set to exercise real serve path.",
      ],
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      JSON_PATH,
      JSON.stringify(skipResult, null, 2) + "\n",
      "utf8"
    );
    writeFileSync(
      MD_PATH,
      "# I11 smoke - session-api harness\n\n**SKIPPED** (key missing)\n\n",
      "utf8"
    );
    return;
  }

  const start = Date.now();
  const notes: string[] = [];

  // -- 区段 1: serve 路径(真实 HTTP + 真实模型) -------------------------------
  const serveDataDir = mkdtempSync(join(tmpdir(), "i11-smoke-serve-"));
  const { listening } = await startSessionServe({
    dataDir: serveDataDir,
    host: "127.0.0.1",
    port: 0,
    mode: "llm",
  });
  const baseUrl = `http://127.0.0.1:${listening.port}`;

  let serveSection: Awaited<ReturnType<typeof runServeSection>>;
  try {
    serveSection = await runServeSection(baseUrl);
  } finally {
    await listening.close();
    rmSync(serveDataDir, { recursive: true, force: true });
  }
  if (serveSection.runError) {
    notes.push(`serve-path non-200: ${serveSection.runError}`);
  }

  // -- 区段 2: cancelled 场景(Hub + AbortController + never-resolving adapter)-
  const cancelDeps: LoopEngineDeps = {
    adapter: neverResolvingAdapter,
    executor: createExecutor(createRegistry([])),
    registry: createRegistry([]),
    maxTurns: 6,
    timeoutMs: 60_000,
  };
  const cancelAc = new AbortController();
  setTimeout(() => cancelAc.abort(), 50);
  const cancelSection = await runHubWithDeps(cancelDeps, "trigger abort", {
    signal: cancelAc.signal,
  });

  // -- 区段 3: timeout 场景(Hub + timeoutMs=1 + never-resolving adapter) -----
  const timeoutDeps: LoopEngineDeps = {
    adapter: neverResolvingAdapter,
    executor: createExecutor(createRegistry([])),
    registry: createRegistry([]),
    maxTurns: 6,
    timeoutMs: 1,
  };
  const timeoutSection = await runHubWithDeps(timeoutDeps, "trigger timeout");

  const durationMs = Date.now() - start;

  // -- 6 条断言门(spec SC4) ---------------------------------------------------
  const assertions: ReadonlyArray<AssertionCheck> = [
    {
      name: "serve stopReason === completed",
      pass: serveSection.stopReason === "completed",
    },
    {
      name: "serve turnCount >= 2 (multi-step)",
      pass: serveSection.turnCount >= 2,
    },
    {
      name: "serve multi-step (sessionTurnCount accumulation >= 2)",
      pass: serveSection.sessionTurnCount >= 2,
    },
    {
      name: "serve finalText non-empty",
      pass: serveSection.finalText.length > 0,
    },
    {
      name: "cancelled stopReason === cancelled",
      pass: cancelSection.stopReason === "cancelled",
    },
    {
      name: "timeout stopReason === timeout",
      pass: timeoutSection.stopReason === "timeout",
    },
  ];
  const allPass =
    assertions.every((a) => a.pass) && serveSection.runError === null;

  const result: SmokeResult = {
    result: allPass ? "pass" : "fail",
    reason: "ran",
    timestamp: new Date().toISOString(),
    model: env.llm.model,
    baseUrl: hostOf(env.llm.baseUrl),
    key_env: keyEnv,
    maxTurns: 6,
    durationMs,
    serve: {
      stopReason: serveSection.stopReason,
      turnCount: serveSection.turnCount,
      finalText_excerpt: serveSection.finalText.slice(
        0,
        FINAL_TEXT_EXCERPT_MAX
      ),
      sessionTurnCount: serveSection.sessionTurnCount,
      stopReason_valid: serveSection.stopReasonValid,
    },
    cancel: {
      stopReason: cancelSection.stopReason,
      turnCount: cancelSection.turnCount,
      exceptionName: cancelSection.exceptionName,
    },
    timeout: {
      stopReason: timeoutSection.stopReason,
      turnCount: timeoutSection.turnCount,
      exceptionName: timeoutSection.exceptionName,
    },
    assertions,
    notes:
      notes.length > 0
        ? [
            ...notes,
            "Real failure reflow (plan out-of-scope): not fixed here; open followup ticket if needed.",
          ]
        : [
            "6-assertion gate (SC4) over serve path + hub-level cancelled/timeout.",
            "serve path: startSessionServe → POST /sessions → POST /sessions/:id/messages (real model).",
            "cancelled/timeout: SessionHub + injected deps with never-resolving adapter (HTTP layer does not expose signal/signal-typed timeout, so hub-level is the only seam).",
          ],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(JSON_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");

  const checkRows = assertions
    .map((a) => `| ${a.name} | ${a.pass ? "PASS" : "FAIL"} |`)
    .join("\n");
  const md =
    `# I11 smoke - session-api harness\n\n` +
    `**Result: ${result.result.toUpperCase()}**\n\n` +
    `| Field | Value |\n|-------|-------|\n` +
    `| model | ${result.model} |\n` +
    `| baseUrl host | ${result.baseUrl} |\n` +
    `| key_env | ${result.key_env} |\n` +
    `| maxTurns | ${result.maxTurns} |\n` +
    `| durationMs | ${result.durationMs} |\n` +
    `| serve.stopReason | ${result.serve.stopReason} |\n` +
    `| serve.turnCount | ${result.serve.turnCount} |\n` +
    `| serve.sessionTurnCount | ${result.serve.sessionTurnCount} |\n` +
    `| cancel.stopReason | ${result.cancel.stopReason} |\n` +
    `| cancel.exceptionName | ${result.cancel.exceptionName} |\n` +
    `| timeout.stopReason | ${result.timeout.stopReason} |\n` +
    `| timeout.exceptionName | ${result.timeout.exceptionName} |\n\n` +
    `| Assertion | Outcome |\n|-----------|---------|\n` +
    `${checkRows}\n\n` +
    `## Notes\n\n` +
    result.notes.map((n) => `- ${n}`).join("\n") +
    "\n";
  writeFileSync(MD_PATH, md, "utf8");

  // stdout 摘要(操作员可读,不含 key)
  console.log(
    `result=${result.result} key_env=${result.key_env} model=${result.model} ` +
      `serve_stop=${result.serve.stopReason} serve_turns=${result.serve.turnCount} ` +
      `cancel_stop=${result.cancel.stopReason} timeout_stop=${result.timeout.stopReason} ` +
      `durationMs=${result.durationMs}`
  );
  if (result.result !== "pass") {
    console.error(
      `serve: stopReason=${serveSection.stopReason}, runError=${serveSection.runError}`
    );
    console.error(`see ${MD_PATH}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
