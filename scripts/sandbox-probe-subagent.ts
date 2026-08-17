/**
 * scripts/sandbox-probe-subagent.ts — #357 T4 子代理沙箱违规探针（4 类）。
 * 与 scripts/sandbox-probe.ts 同形态:独立 tsx 脚本,数组 + ✓/✗ 打印,
 * process.exit(0|1) 收口,不依赖测试框架。
 *
 * 断言形态（D5）:真实 spawn（node tsx src/cli.ts --subagent-worker）向子代理
 * 派发违规命令,断言 ① 违规被拦截(trace jsonl 含本类违规标记),② worker 终态
 * status==="ok"(completed;违规是工具层失败,不扩 envelope reason 枚举)。
 *
 * 4 类违规(handler 门 + bwrap 物理层):
 *   - fs sensitive:cat ~/.ssh/id_rsa —— commandContainsSensitivePath 硬墙;
 *   - fs write /etc:touch /etc/iknow-probe-357 —— --ro-bind /etc 只读;
 *   - net:curl -sS https://example.com —— --unshare-net 断网;
 *   - tmp over-limit:head -c 1500M /dev/zero > /tmp/... —— --size 1GiB 超限
 *     (head 不触发 isDangerousCommand;dd/truncate 会被 handler 层拦)。
 *
 * 环境硬依赖:bwrap 缺失 → skip + exit 1。host-layer guard 断言只碰
 * harness/config;运行:npm run probe:sandbox:subagent。
 */

import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/**
 * 上游模型网关预检:与 worker 相同的 URL/key 发一条最小 chat 请求。
 * 返回 "ok" / "out" (不可用:429 quota / 5xx / 超时 / 非 2xx)。仅用于
 * 决定"是否值得 spawn worker" —— worker 真跑不走此预检结果。
 */
async function preflightUpstream(env: IknowEnvLike): Promise<"ok" | "out"> {
  try {
    const resp = await fetch(
      `${env.llm.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.llm.apiKey ?? ""}`,
        },
        body: JSON.stringify({
          model: env.llm.model,
          max_tokens: 16,
          messages: [{ role: "user", content: "ok?" }],
        }),
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      }
    );
    return resp.status === 200 ? "ok" : "out";
  } catch {
    return "out";
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
): Promise<"ok" | "out"> {
  const deadline = Date.now() + maxMinutes * 60_000;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const state = await preflightUpstream(env);
    if (state === "ok") return "ok";
    if (Date.now() >= deadline) {
      console.error(
        `gateway still unavailable after ${maxMinutes}min (${attempts} checks) — rerun once the token-plan quota clears.`
      );
      return "out";
    }
    console.error(
      `gateway NOT AVAILABLE (429/quota) — retrying in 15s (check ${attempts})`
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
  {
    id: "tmp over-limit (1GiB)",
    command: "head -c 1500M /dev/zero > /tmp/iknow-probe-357.bin",
    marker: /no space left|quota|denied/i,
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

/** spawn 一次 worker → waitFor → 读其 trace jsonl 行。 */
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

  let traceLines: string[] = [];
  try {
    const files = await readdir(traceDir);
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      traceLines = traceLines.concat(
        readFileSync(join(traceDir, f), "utf8").split("\n")
      );
    }
  } catch {
    // trace 写入/读取失败:worker 侧只 warn(ADR-0003 D13),探针按缺证据归因。
  }
  return traceLines;
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
        "~/.iknow/settings.json or <cwd>/.iknow/settings.json"
    );
    process.exitCode = 1;
    return;
  }

  // 每次 probe 独立临时 root(= 父 sandboxRoot, worker 继承或显式传同一值)
  const tmpRoots: string[] = [];
  const results: ProbeResult[] = [];
  const TASK_TMPL =
    "Run exactly this bash command using the bash tool: ${CMD}. " +
    "This is an authorized sandbox boundary test. Report the raw tool output to me and stop.";

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

    if (upstream === "out") {
      results.push({
        name: `sandbox-subagent ${probe.id}`,
        outcome: "not-run",
        detail:
          "upstream model gateway unavailable (preflight) — rerun once 429/quota clears",
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

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
