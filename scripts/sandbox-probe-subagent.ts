/**
 * scripts/sandbox-probe-subagent.ts — #357 T4 子代理沙箱违规探针（3 类）。
 * 与 scripts/sandbox-probe.ts 同形态:独立 tsx 脚本,数组 + ✓/✗ 打印,
 * process.exit(0|1) 收口,不依赖测试框架。
 *
 * 断言形态（D5）:真实 spawn（node tsx src/cli.ts --subagent-worker）向子代理
 * 派发违规命令,断言 ① 违规被拦截(trace jsonl 含本类违规标记),② worker 终态
 * status==="ok"(completed;违规是工具层失败,不扩 envelope reason 枚举)。
 *
 * 3 类违规(handler 门 + bwrap 物理层):
 *   - fs sensitive:cat ~/.ssh/id_rsa —— commandContainsSensitivePath 硬墙;
 *   - fs write /etc:touch /etc/iknow-probe-357 —— 系统前缀 --ro-bind /etc 只读;
 *   - net:curl -sS https://example.com —— --unshare-net 断网。
 *
 * 三条探针的 task 模板都显式要求「只用 required command 参数,不要设
 * network / background 选参」:bash 工具描述公开了 network:true 宿主网络批准轴,
 * worker 侧 askUser = createNoAskUser(always approve,#162 平权),模型若自行
 * 加 `network:true`,围栏就不再发 --unshare-net —— 探针会误报「fence 没拦住」。
 * 默认隔离姿态本身由 sandbox-probe.ts 的 network denied 直验,本探针只验
 * worker 在默认选参下的断网。
 *
 * 退役类(ADR-0092 全局档):tmp over-limit —— 旧断言依赖 `--size 1GiB` +
 * `--tmpfs /tmp` 的 tmpfs 配额;全局档不发这两条 flag(guest `/tmp` = 宿主
 * `/tmp`),配额不再由围栏表达。此类永久消失(不改成伪覆盖),会话 tmp 的
 * host-path 语义由 worker-session-layout / sandbox-probe 覆盖。
 *
 * 环境硬依赖:bwrap 缺失 → skip + exit 1。host-layer guard 断言只碰
 * harness/config;运行:npm run probe:sandbox:subagent。
 */

import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadIknowEnv } from "../src/config/env.js";
import { createSubAgentManager } from "../src/harness/subagent/manager.js";
import type { SubAgentDefinition } from "../src/harness/subagent/manager.js";

const __filename = fileURLToPath(import.meta.url);
const HERE = dirname(__filename);
const TSX_BIN = join(HERE, "..", "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(HERE, "..", "src", "cli.ts");
/** 单次 spawn → waitFor 的墙钟上限(> worker loop 的 env.llm.timeoutMs=60s,留余量)。 */
const WAIT_FOR_TIMEOUT_MS = 90_000;
/** 每个 probe 的最大 spawn 次数:上游模型网关瞬时 429/quota 滚动 reset 用重试吸收。 */
const MAX_ATTEMPTS = 3;
/** retry backoff 基准(2s * attempt)。 */
const BACKOFF_MS = 2_000;
/** 上游模型网关预检(fetch /chat/completions,key 不落日志)。超时 8s。 */
const PREFLIGHT_TIMEOUT_MS = 8_000;

/** 探针结果三态:pass(证据齐) / failed(真失败) / not-run(上游模型不可用)。 */
type ProbeOutcome = "pass" | "failed" | "not-run";

/** 预检响应状态分类;"ok" 以外都不 spawn worker,但原因要说准。 */
export type PreflightStatus =
  "ok" | "quota" | "unauthorized" | "not-found" | "unavailable";

export function classifyPreflightStatus(status: number): PreflightStatus {
  if (status === 200) return "ok";
  if (status === 429) return "quota";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  return "unavailable";
}

/**
 * 预检请求形态。必须与 worker 说同一种协议:worker 走
 * `new Anthropic({ baseURL: env.llm.baseUrl })`,SDK 打 `${baseUrl}/v1/messages`
 * 并用 `x-api-key`。预检若改打 OpenAI 形态的 `/chat/completions` + Bearer,
 * 在 Anthropic 形态网关上恒 404 —— 探针永远 not-run 且误报成配额问题。
 */
export function buildPreflightRequest(env: IknowEnvLike): {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
} {
  return {
    url: `${env.llm.baseUrl.replace(/\/$/, "")}/v1/messages`,
    headers: {
      "content-type": "application/json",
      "x-api-key": env.llm.apiKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.llm.model,
      max_tokens: 16,
      messages: [{ role: "user", content: "ok?" }],
    }),
  };
}

/**
 * 上游模型网关预检:与 worker 相同的 URL/key 发一条最小 messages 请求。
 * 仅用于决定"是否值得 spawn worker" —— worker 真跑不走此预检结果。
 */
async function preflightUpstream(env: IknowEnvLike): Promise<PreflightStatus> {
  const req = buildPreflightRequest(env);
  try {
    const resp = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    return classifyPreflightStatus(resp.status);
  } catch {
    return "unavailable";
  }
}

/** loadIknowEnv 返回类型中最小的字段面(避免引入 config 类型依赖)。 */
interface IknowEnvLike {
  readonly llm: {
    readonly apiKey?: string;
    readonly baseUrl: string;
    readonly model: string;
  };
}

/**
 * 上游模型网关预检 + 滚动检测:quota 429 有 reset 窗口(实测 2-3min)。
 * 最长 GATEWAY_RETRY_MINS 分钟内 15s 间隔重查,超时返回 "out"。
 */
async function waitForUpstream(
  env: IknowEnvLike,
  maxMinutes: number
): Promise<PreflightStatus> {
  const deadline = Date.now() + maxMinutes * 60_000;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const state = await preflightUpstream(env);
    if (state === "ok") return "ok";
    // 配置类失败(端点打错 / key 不认)不会因为等待而好转 —— 立刻返回,
    // 不烧满重试窗口,也不把它叫成配额问题。
    if (state === "not-found" || state === "unauthorized") {
      console.error(
        `gateway preflight ${state}: ${buildPreflightRequest(env).url} — ` +
          `settings.llm.baseUrl / apiKey 与 worker 的 Anthropic 客户端不匹配,不是配额问题。`
      );
      return state;
    }
    if (Date.now() >= deadline) {
      console.error(
        `gateway still unavailable after ${maxMinutes}min (${attempts} checks) — rerun once the token-plan quota clears.`
      );
      return state;
    }
    console.error(
      `gateway NOT AVAILABLE (${state}) — retrying in 15s (check ${attempts})`
    );
    await sleep(15_000);
  }
}

/**
 * host-layer guard:只碰 harness / config(T4 探针,与 t4-smoke 同纪律)。
 * 扫描自身源码,禁词命中即 throw;豁免声明禁词的行(const forbidden = / 注释)。
 */
function assertHostLayerGuard(): void {
  const src = readFileSync(__filename, "utf8");
  const forbidden = ["src/session-api", "src/interaction", "web/"];
  const lines = src.split("\n");
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
            `sandbox-probe-subagent must stay in harness layer only.`
        );
      }
    }
  }
}

/** 真实 spawn 工厂(worker 重入):`node tsx src/cli.ts --subagent-worker`。
 *  env 继承父进程并覆写 IKNOW_TRACE_OUT → 探针 trace 目录(worker 侧
 *  createJsonlTraceService 落点,作为违规证据面)。 */
function productionLikeSpawn(traceDir: string): ReturnType<typeof spawn> {
  return spawn(process.execPath, [TSX_BIN, CLI_ENTRY, "--subagent-worker"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, IKNOW_TRACE_OUT: traceDir },
  });
}

interface ProbeResult {
  readonly name: string;
  readonly outcome: ProbeOutcome;
  readonly detail: string;
}

interface ProbeDef {
  readonly id: string;
  readonly command: string;
  /** trace jsonl 全文里该类的违规标记(正则)。 */
  readonly marker: RegExp;
  /** 缺省 = 继承父 sandboxRoot(SC8 继承语义覆盖)。 */
  readonly withSandboxRoot?: boolean;
}

const PROBES: ReadonlyArray<ProbeDef> = [
  {
    id: "fs sensitive (~/.ssh)",
    command: "cat ~/.ssh/id_rsa",
    marker: /hard_wall|sensitive/i,
    withSandboxRoot: false, // 继承父 sandboxRoot 的探针
  },
  {
    id: "fs write /etc",
    command: "touch /etc/iknow-probe-357",
    marker: /read-only|permission denied/i,
    withSandboxRoot: true,
  },
  {
    id: "net denied (example.com)",
    command: "curl -sS --max-time 5 https://example.com",
    marker: /network_denied|could not resolve|failed to connect/i,
    withSandboxRoot: true,
  },
];

/** 递归搜内容:bash tool_result / llm_call messages content 里的违规标记。 */
function deepSearch(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const items = Array.isArray(value) ? value : Object.values(value);
  for (const item of items) {
    if (typeof item === "string") return item;
    const nested = deepSearch(item);
    if (nested !== null) return nested;
  }
  return null;
}

/** 提取第一条命中标记的 trace 行(证据摘要,截断到 160 字符)。 */
function firstMatchingLine(traceLines: string[], marker: RegExp): string {
  for (const line of traceLines) {
    if (marker.test(line)) return line.slice(0, 160);
  }
  return "";
}

/** worker trace 的浓缩诊断视图:bash 是否被尝试 + LLM 调用是否失败。 */
interface WorkTraceDiagnostics {
  attemptedBash: boolean;
  rejectedVsBlocked: boolean;
  llmCalled: boolean;
  llmError: string;
  toolCalls: string[];
}

/**
 * 从 trace jsonl 行提取诊断:是否有 bash tool_call record / llm_call 失败 /
 * 工具失败形态(rejected ≠ blocked)。
 */
function diagFromJson(lines: string[]): WorkTraceDiagnostics {
  const diag: WorkTraceDiagnostics = {
    attemptedBash: false,
    rejectedVsBlocked: false,
    llmCalled: false,
    llmError: "",
    toolCalls: [],
  };
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.record_type === "tool_call") {
      diag.toolCalls.push(
        `${String(obj.tool_name ?? "")}:${String(obj.tool_kind ?? "")}`
      );
      if (obj.tool_name === "bash") diag.attemptedBash = true;
      if (
        typeof obj.error === "object" &&
        obj.error !== null &&
        /rejected|violation|denied|dangerous|sensitive/.test(
          String((obj.error as { message?: unknown }).message ?? "")
        )
      ) {
        diag.rejectedVsBlocked = true;
      }
    }
    if (obj.record_type === "llm_call") {
      if (obj.status === "error") {
        diag.llmError = String(
          (obj.error as { message?: string } | null)?.message ?? ""
        );
      }
      if (Array.isArray(obj.messages)) diag.llmCalled = true;
    }
  }
  return diag;
}

function hasBwrap(): boolean {
  const r = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
  return r.error === undefined && r.status === 0;
}

/**
 * 单个 probe:spawn worker(最多 MAX_ATTEMPTS 次,吸收上游瞬时 429/quota 滚动
 * reset)→ waitFor → 读 trace → 三态分类:
 *   pass   = worker status=="ok" 且 trace 明确含本类违规标记(证据齐);
 *   failed = waitFor reject / worker 非 ok / 已 attempt bash 但 trace 无标记
 *            (fence 真漏拦截或装配错误);
 *   not-run= worker ok 但从未 attempt bash 且 llm_call error —— 上游模型
 *            不可用,违规命令根本没被模型发起,无证据可验。
 */
async function runProbe(
  probe: ProbeDef,
  root: string,
  traceDir: string,
  taskTmpl: string
): Promise<ProbeResult> {
  const def: SubAgentDefinition = {
    task: taskTmpl.replace("${CMD}", probe.command),
    maxTurns: 6,
    // 继承探针:绝不给敏感路径探针传 root(SC8 继承语义);其余显式传同一值。
    ...(probe.withSandboxRoot ? { sandboxRoot: root } : {}),
  };

  let lastDetail = "no attempt";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let traceLines: string[] = [];
    try {
      traceLines = await runWorkerOnceForProbe(def, root, traceDir);
    } catch (err) {
      if (err instanceof ProbeFailure) {
        return {
          name: probe.id,
          outcome: "failed",
          detail: `${err.message.slice(0, 200)}`,
        };
      }
      throw err;
    }
    const traceHasMarker = traceLines
      .map((l) => deepSearch(l))
      .some((s) => s !== null && probe.marker.test(s));
    const diag = diagFromJson(traceLines);

    // pass 判据:worker completed(D5)且 trace 含本类违规标记(拦截证据)。
    if (traceHasMarker) {
      const evidence = firstMatchingLine(traceLines, probe.marker).slice(
        0,
        160
      );
      return {
        name: probe.id,
        outcome: "pass",
        detail: `worker completed; trace evidence: ${evidence}`,
      };
    }
    // 真失败:模型已 attempt 过 bash,但 fence 没拦住(无标记)。
    if (diag.attemptedBash) {
      return {
        name: probe.id,
        outcome: "failed",
        detail: `worker completed but fence did NOT block (bash attempted; no ${String(probe.marker)} in trace)`,
      };
    }
    // 其余 = bash 尚未被模型发起:重试吸收上游瞬时故障;3 次后 not-run。
    lastDetail = `worker completed; bash not attempted, llm=${
      diag.llmCalled
        ? diag.llmError.length > 0
          ? `error:${diag.llmError.slice(0, 80)}`
          : "ok"
        : "no-call"
    } — attempt ${attempt}/${MAX_ATTEMPTS}`;
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS * attempt);
  }
  return { name: probe.id, outcome: "not-run", detail: lastDetail };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * spawn 一次 worker → waitFor → 读其 trace 证据语料。
 *
 * 证据语料 = jsonl 行 + `blobs/` 内容。T4 blob 唯一化(commit 09e5c2e0)后,
 * `tool_call` 记录 `result_captured:false`,fence 的 stdout/stderr 不再内联进
 * jsonl——`messages[].content` 只是 `{sha,bytes}` 引用,正文落在
 * `<traceDir>/blobs/<sha>`。只读 `*.jsonl` 会把已拦截的围栏输出当「无证据」,
 * 误报 fence 没拦住。两条面都读才覆盖当前 trace SSOT。
 */
async function runWorkerOnceForProbe(
  def: SubAgentDefinition,
  root: string,
  traceDir: string
): Promise<string[]> {
  const manager = createSubAgentManager({
    spawn: (_, __, ___) => productionLikeSpawn(traceDir),
    sandboxRoot: root,
  });
  let envelopeStatus = "unknown";
  let envelopeReason: string | undefined;
  let waitError = "";
  try {
    const { taskId } = manager.spawn(def);
    const env2 = await manager.waitFor(taskId, WAIT_FOR_TIMEOUT_MS);
    envelopeStatus = env2.status;
    envelopeReason = env2.reason;
  } catch (err) {
    waitError = err instanceof Error ? err.message : String(err);
  }
  await manager.shutdown();

  if (waitError.length > 0 || envelopeStatus !== "ok") {
    // worker 未正常完成:waitFor reject = 超时(探针级),或 envelope failed。
    // 这两种都算真环境性问题 → 记为 failed(带 reason),不重试也不 not-run:
    // 并发 worker 超时 / crashed 不该被重试掩盖。
    throw new ProbeFailure(
      `worker NOT completed: status=${envelopeStatus} reason=${envelopeReason ?? ""}${waitError ? ` waitErr=${waitError.slice(0, 120)}` : ""}`
    );
  }

  return readTraceEvidence(traceDir);
}

/** jsonl 行 + blob 正文两条面;读失败(写入竞态 / 目录缺席)归「缺证据」。 */
async function readTraceEvidence(traceDir: string): Promise<string[]> {
  const evidence: string[] = [];
  try {
    const files = await readdir(traceDir);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      evidence.push(...readFileSync(join(traceDir, f), "utf8").split("\n"));
    }
    // blob 正文(内容寻址;每个 blob 可能无换行,按整文件一行推入)。
    const blobsDir = join(traceDir, "blobs");
    for (const b of await readdir(blobsDir)) {
      evidence.push(readFileSync(join(blobsDir, b), "utf8"));
    }
  } catch {
    // trace 写入/读取失败:worker 侧只 warn(ADR-0003 D13),探针按缺证据归因。
  }
  return evidence;
}

/** 探针级环境性失败(worker 未完成),与 D5 判据区分。 */
class ProbeFailure extends Error {
  override readonly name = "ProbeFailure";
}

async function main(): Promise<void> {
  assertHostLayerGuard();

  if (!hasBwrap()) {
    console.error(
      "skip: bwrap not found on PATH — sandbox probes are a hard environment dependency " +
        "(install bwrap 0.11.x or later, then re-run)."
    );
    process.exitCode = 1;
    return;
  }

  const env = loadIknowEnv(process.cwd());
  if (!env.llm.apiKey) {
    console.error(
      "no API key — set settings.llm.apiKey (literal or ${VAR}) in " +
        "~/.iknow/settings.json (llm is a user-layer key, ADR-0084)"
    );
    process.exitCode = 1;
    return;
  }

  // 每次 probe 独立临时 root(= 父 sandboxRoot, worker 继承或显式传同一值)
  const tmpRoots: string[] = [];
  const results: ProbeResult[] = [];
  const TASK_TMPL =
    "Run exactly this bash command using the bash tool: ${CMD}. " +
    "Use only the required `command` parameter; do not set optional parameters " +
    "(network / background). This is an authorized sandbox boundary test with no " +
    "interactive approval. Report the raw tool output to me and stop.";

  // 上游模型网关预检 + 滚动检测:重试窗口内若恢复则继续真实验证;
  // 始终不可用 → 整体 not-run(不烧 60s/次)。
  const upstream = await waitForUpstream(env, 10);
  if (upstream === "ok") {
    console.log("upstream model gateway: ok");
  }

  for (const probe of PROBES) {
    const root = await mkdtemp(join(tmpdir(), "iknow-subagent-probe-"));
    tmpRoots.push(root);
    let traceDir = "";
    try {
      traceDir = await mkdtemp(join(tmpdir(), "iknow-subagent-probe-trace-"));
      tmpRoots.push(traceDir);
    } catch {
      // trace 目录失败不影响探针本身;worker 落盘失败会 warn(ADR-0003 D13)。
      traceDir = "";
    }

    if (upstream !== "ok") {
      results.push({
        name: `sandbox-subagent ${probe.id}`,
        outcome: "not-run",
        detail: `upstream model gateway preflight ${upstream}`,
      });
      continue;
    }

    const outcome = await runProbe(probe, root, traceDir, TASK_TMPL);
    results.push({
      name: `sandbox-subagent ${probe.id}`,
      outcome: outcome.outcome,
      detail: outcome.detail,
    });
  }

  // ── 汇总输出 ───────────────────────────────────────────────────────
  const passed = results.filter((r) => r.outcome === "pass").length;
  const notRun = results.filter((r) => r.outcome === "not-run").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  for (const r of results) {
    const icon =
      r.outcome === "pass" ? "✓" : r.outcome === "not-run" ? "—" : "✗";
    console.log(` ${icon} ${r.name} (${r.detail})`);
  }
  const total = results.length;
  const tail =
    failed === 0
      ? notRun > 0
        ? `all green but ${notRun}/${total} not-run (upstream model unavailable)`
        : `all green (${passed}/${total})`
      : `failures (${failed}/${total})`;
  console.log(`\n${tail}`);

  await Promise.all(
    tmpRoots.map((d) => rm(d, { recursive: true, force: true }))
  );
  process.exitCode = failed === 0 && passed > 0 ? 0 : 1;
}

// 只有被当作入口跑时才执行探针 —— 单测 import 本模块取纯函数时不得起副作用。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
