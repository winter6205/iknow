/**
 * scripts/t4-spawn-subagent-real-llm-smoke.ts — #365 真实 LLM 接通 e2e 验证。
 *
 * 背景（测试规范更新）:LLM-touching 代码改动必须配套真实模型 e2e（不仅
 * stub-model 脚本化）。#365（TUI 入口 subagent 接线清理）命中该条——改动
 * build-engine / ACI 工具面 25 件 / 三入口接线。本探针用 **buildHarnessEngine
 * ({ surface: "chat" })** 装配（chat 与 tui 走同一份 25 件工具集 =
 * 等价验证），构造 **真实 LLM 调用 + 让模型调 spawn_subagent 工具**，
 * 把 #365 关键验收点落到真实模型证据上。
 *
 * 验收点（真实接通,非 stub）:
 *   T1 hooks 透传真实模型触发 —— buildHarnessEngine({surface:"chat", hooks:
 *     stubHook}) 装配后,真实 LLM 1 turn + 调 bash 工具 → stubHook 被调 ≥1 次,
 *     含 toolUseId / name / kind。
 *   T2 25 件工具面在真实 build-engine 装配下完整 —— deps.registry.list() 长度
 *     === 25,list 含 spawn_subagent + subagent_result + skill + skill_search。
 *   T4 registerShutdown 真实信号触发 —— 装配 chat built(含 shutdown 句柄);
 *     registerShutdown(built);process.emit('SIGINT') → counter +1;dispose() 一次
 *     → counter 保持 +1(幂等守卫已消费);再 dispose() → counter 不变。
 *   T5 subagent manager 真实装配存在 —— built.subagentManager 真存在(自建);
 *     built.shutdown 是函数;调用后真实 codebase-memory MCP server 收到
 *     server.shutdown(由探针输出侧证)。
 *   spawn_subagent 真实模型触发 —— 第二个真实 run 让模型 fork 一个 worker
 *     (task: "Use the bash tool to run `echo subagent-ok` ..."),前景 wait:true
 *     阻塞至 envelope,断言 result 含 subagent-ok。
 *
 * 运行形态（worker 重入）:defaultSubAgentSpawn 用
 * `node <process.argv[1]> --subagent-worker` 形态 spawn。本文件在 tsx 下运行,
 * process.argv[1] 指向本脚本,worker 重入会再次执行本脚本的 main() —— 不是
 * 产品 worker。故本探针**不依赖 defaultSubAgentSpawn**,而是向 manager 注入
 * 等价的生产 spawn 工厂:`node tsx src/cli.ts --subagent-worker`(cli.ts 的
 * `__subagent_worker__` dispatch),env 继承父进程。worker 内部走
 * createWorkerDeps(真实 build + 真实 Anthropic adapter)。
 *
 * #365 真实 e2e 额外产出:worker 的 fs 工具 bwrap fence 需要非空 sandboxRoot,
 * 此前 spawn_subagent 工具不采集、manager 写空串 → worker 内 bash 直接失败
 * (bwrap: Can't find source path)。本探针第一次真实跑即复现,根因修复在
 * src/harness/subagent/manager.ts buildWorkerPayload(缺省回退 process.cwd(),
 * role.ts:34 既有"manager 装配期根据父 cwd 补齐"约定)。
 *
 * 边界 / 纪律:
 *   - 不 stub 替身;不伪造响应;错误真实上报(缺 key / 模型 4xx / 工具错误)。
 *   - 敏感信息:不 log key 值;baseURL 截到 host。
 *   - 每次真实 run 用一个全新临时目录(沙箱根/identity/memory 隔离),跑完
 *     clean,不污染真实工作区。
 *   - T4 registerShutdown 信号路径先于 LLM 装配执行;信号 emit 后进程内存态
 *     干净,不触发真实信号递送(standalone 探针实测不重入,见 #365 T5 测试)。
 *
 * 退出码:全部 pass → 0;任一 fail → 1。
 *
 * 运行:npm run probe:t4-real-llm（= tsx scripts/t4-spawn-subagent-real-llm-smoke.ts）
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadIknowEnv } from "../src/config/env.js";
import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../src/harness/build-engine.js";
import { createNoAskUser } from "../src/harness/permission/ask-user.js";
import { registerShutdown } from "../src/cli/runtime.js";
import type { PostToolUseHook } from "../src/harness/permission/types.js";
import type { LoopEngineDeps } from "../src/harness/index.js";
import { createLoopEngine, run } from "../src/harness/index.js";
import { createSubAgentManager } from "../src/harness/subagent/manager.js";
import { ACI_TOOLSET_NAMES } from "../src/harness/aci/tools/registry.js";

const __filename = fileURLToPath(import.meta.url);
const HERE = dirname(__filename);
const TSX_BIN = join(HERE, "..", "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(HERE, "..", "src", "cli.ts");

/**
 * host-layer guard:i9 同款纪律 —— 本探针只允许碰 harness / config / cli/runtime
 * (T4 registerShutdown 装配验证)。扫描自身源码,禁词命中即 throw。
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
            `t4 smoke must stay in harness layer only.`
        );
      }
    }
  }
}

/** 截断 baseURL 到 host(不带 path),避免日志泄露完整端点。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/\/.*$/, "");
  }
}

/** 结果清单:name + pass + 可选 detail。全部 pass → 探针退出 0。 */
const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];
function record(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
  console.log(
    `${pass ? "[PASS]" : "[FAIL]"} ${name}${detail ? `: ${detail}` : ""}`
  );
}

/** T2 工具面完整性不变式(从 SSOT ACI_TOOLSET_NAMES,Gate 3 append-only 名单
 *  派生):chat 表面装配结果必须是名单子集(条件化缺席合法,名单外多余即装配
 *  漂移),且关键工具在场。不硬编码件数 —— 名单演进不使本探针过时。
 *  提取为顶层 helper:main() 复杂度守在 s5 基线内。 */
function recordToolSurface(names: ReadonlyArray<string>): void {
  const extra = names.filter((n) => !ACI_TOOLSET_NAMES.includes(n));
  record(
    "T2 工具面 ⊆ ACI_TOOLSET_NAMES(buildHarnessEngine chat)",
    extra.length === 0 && names.length > 0,
    `count=${names.length} extra=[${extra.join(",")}]`
  );
  record("T2 含 spawn_subagent", names.includes("spawn_subagent"));
  record("T2 含 subagent_result", names.includes("subagent_result"));
  // disclosure-index-align T2(spec ADR-0046 / SC5)删 skill_search:钉住在场
  // 的 skill 与已删的 skill_search 两侧,防止索引工具复活。
  record(
    "T2 含 skill 且 skill_search 已删(ADR-0046)",
    names.includes("skill") && !names.includes("skill_search")
  );
}

/** 临时目录集合(沙箱根/identity/memory 隔离),跑完 clean。 */
const tmpDirs: string[] = [];
async function cleanupTmp(): Promise<void> {
  await Promise.all(
    tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))
  );
}

/** 真实 spawn 工厂(worker 重入):`node tsx src/cli.ts --subagent-worker`。
 *  env 继承父进程(ADR-0001);worker 内部 createWorkerDeps 真实装配。 */
function productionLikeSpawn(): ReturnType<typeof spawn> {
  return spawn(process.execPath, [TSX_BIN, CLI_ENTRY, "--subagent-worker"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
}

/**
 * 真实 run:固定 maxTurns=6(覆盖 env 缺省无限),防失控循环。
 * 网关 502(upstream minimax-cn connect timeout,实测偶发)→ 原样重试 2 次
 * (同真实模型,不 stub;重试仅限上游瞬时超时)。
 */
async function runReal(
  deps: LoopEngineDeps,
  userText: string,
  label: string
): Promise<{
  stopReason: string;
  turnCount: number;
  finalText: string | null;
  lastUsage: unknown;
}> {
  const runDeps: LoopEngineDeps = { ...deps, maxTurns: 6 };
  const attempts = 3;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const { result } = await run(userText, runDeps);
      return {
        stopReason: result.stopReason,
        turnCount: result.turnCount,
        finalText: result.finalText,
        lastUsage: result.lastUsage,
      };
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // 仅重试上游瞬时 502/连接错误;其余(4xx/协议错误)立即上报。
      if (!/502|connect timeout|fetch failed/i.test(msg)) throw e;
      console.warn(
        `[${label}] attempt ${i + 1}/${attempts} transient gateway error: ${msg.slice(0, 120)}; retrying`
      );
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  assertHostLayerGuard();

  const env = loadIknowEnv(process.cwd());
  if (!env.llm.apiKey) {
    // settings-model-extension：key 来源 = settings.llm.apiKey（字面或 ${VAR}）。
    console.error(
      "no API key — set settings.llm.apiKey (literal or ${VAR}) in " +
        "~/.iknow/settings.json (llm is a user-layer key, ADR-0084)"
    );
    process.exitCode = 1;
    return;
  }
  // L6：key=settings.llm.apiKey 是「来源标记」而非变量名（区别于退役前的
  // IKNOW_LLM_API_KEY_ENV 变量名）。
  console.log(
    `env: model=${env.llm.model} baseUrl=${hostOf(env.llm.baseUrl)} key=settings.llm.apiKey`
  );

  // ── T4 registerShutdown 真实信号触发(先于 LLM,不依赖模型)──────────────
  {
    let sigCount = 0;
    const builtShutdown: BuiltEngine = {
      deps: {} as unknown as LoopEngineDeps,
      engine: createLoopEngine({} as unknown as LoopEngineDeps),
      shutdown: async () => {
        sigCount += 1;
      },
    };
    const h = registerShutdown(builtShutdown);
    process.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    const afterSig = sigCount;
    await h.dispose();
    const afterDispose = sigCount;
    await h.dispose();
    const afterDispose2 = sigCount;
    record(
      "T4 registerShutdown: SIGINT→dispose→dispose 幂等 +1/+0/+0",
      afterSig === 1 && afterDispose === 1 && afterDispose2 === 1,
      `afterSig=${afterSig} afterDispose=${afterDispose} afterDispose2=${afterDispose2}`
    );
    // 清掉挂在进程上的 SIGINT/SIGTERM listener,避免污染后续装配。
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    // registerShutdown 的 re-kill one-shot(runtime.ts onSignal → dispose 完成后
    // setImmediate process.kill(pid, sig))在 removeAllListeners 之后才落地——
    // 真实信号无 listener 时按默认处置直接终止进程,后续真实 LLM 检查全部不跑
    // (exit 143)。一次性吸收位吞掉在途 re-kill,吸收后即摘除,不留常驻 handler。
    const absorbReKill = (): void => {};
    process.once("SIGINT", absorbReKill);
    process.once("SIGTERM", absorbReKill);
    await new Promise((r) => setTimeout(r, 50));
    process.removeListener("SIGINT", absorbReKill);
    process.removeListener("SIGTERM", absorbReKill);
  }

  // ── 装配:真实 build-engine,chat surface(与 TUI 同一份 25 件工具集)────
  const tmpRoot = await mkdtemp(join(tmpdir(), "iknow-t4-real-llm-"));
  tmpDirs.push(tmpRoot);
  const sandboxRoot = join(tmpRoot, "ws");
  await mkdir(sandboxRoot, { recursive: true });
  const fixturePath = join(sandboxRoot, "fixture.txt");
  const marker = "T4-MARK-" + Math.random().toString(36).slice(2, 10);
  await writeFile(fixturePath, marker + "\n", "utf8");

  const hookCalls: Array<{ toolUseId?: string; name: string; kind: string }> =
    [];
  const stubHook: PostToolUseHook = (result) => {
    hookCalls.push({
      toolUseId: result.toolUseId,
      name: result.name,
      kind: result.kind,
    });
  };

  // 注入等价生产 spawn 工厂(见文件头"运行形态")。真实 subagent manager 其余
  // 状态机/spawn/envelope/等待/shutdown 全部保留。
  const manager = createSubAgentManager({
    spawn: productionLikeSpawn as never,
  });
  const built = await buildHarnessEngine({
    env,
    askUser: createNoAskUser(),
    surface: "chat",
    hooks: stubHook,
    subagentManager: manager,
    userHome: join(tmpRoot, "home"),
    cwd: sandboxRoot,
    sandboxRoot,
  });

  // T2 工具面不变式(判据见 recordToolSurface doc)。
  recordToolSurface(built.deps.registry.list().map((d) => d.name));
  record(
    "T5 subagentManager 真实存在",
    typeof built.subagentManager === "object" && built.subagentManager !== null
  );
  record("T5 built.shutdown 真实函数", typeof built.shutdown === "function");

  const deps = built.deps;

  // ── T1 hooks 透传:真实 LLM 1 turn + 调 bash 工具 ─────────────────────
  let t1Stop = "unknown";
  let t1Turns = 0;
  let t1LastUsage: unknown = null;
  let t1FinalText: string | null = null;
  try {
    // T1:模型必须先读文件拿到真实内容,再 bash echo —— 无法靠猜测/先验
    // 知识伪造,必须真实触发工具调用(不可猜测内容保证 hook 真实触发)。
    const r = await runReal(
      deps,
      `Use the read_file tool to read ${JSON.stringify(
        fixturePath
      )}, then use the bash tool to run \`echo <file-contents>\` verbatim. Report the exact bash output to me and stop. Do not use any other tools.`,
      "T1"
    );
    t1Stop = r.stopReason;
    t1Turns = r.turnCount;
    t1LastUsage = r.lastUsage;
    t1FinalText = r.finalText;
  } catch (e) {
    record(
      "T1 real run 未抛错",
      false,
      e instanceof Error ? e.message : String(e)
    );
  }
  record("T1 stopReason completed", t1Stop === "completed", `stop=${t1Stop}`);
  record(
    "T1 hook 被调 ≥1 次",
    hookCalls.length >= 1,
    `calls=${hookCalls.length}`
  );
  record(
    "T1 hook 含 toolUseId/name/kind",
    hookCalls.some(
      (c) =>
        typeof c.toolUseId === "string" &&
        c.toolUseId.length > 0 &&
        typeof c.name === "string" &&
        typeof c.kind === "string"
    ),
    `first=${JSON.stringify(hookCalls[0] ?? null)}`
  );
  record(
    "T1 hook name 是 bash",
    hookCalls.some((c) => c.name === "bash"),
    `names=[${[...new Set(hookCalls.map((c) => c.name))].join(",")}]`
  );

  // ── spawn_subagent 真实模型触发:第二 run,worker 内 bash echo ────────
  let spawnStop = "unknown";
  let spawnTurns = 0;
  let spawnFinalText: string | null = null;
  let spawnLastUsage: unknown = null;
  try {
    const r = await runReal(
      deps,
      'Use the spawn_subagent tool exactly once with task: "Use the bash tool to run the single command `echo subagent-ok`. Report the output to me in one sentence and stop. Do not use any other tools." Wait for it to finish (default). Then report the sub-agent\'s result to me in one sentence and stop.',
      "spawn"
    );
    spawnStop = r.stopReason;
    spawnTurns = r.turnCount;
    spawnFinalText = r.finalText;
    spawnLastUsage = r.lastUsage;
  } catch (e) {
    record(
      "spawn real run 未抛错",
      false,
      e instanceof Error ? e.message : String(e)
    );
  }
  record(
    "spawn stopReason completed",
    spawnStop === "completed",
    `stop=${spawnStop}`
  );
  record(
    "spawn finalText 含 subagent-ok(真实 worker envelope)",
    typeof spawnFinalText === "string" &&
      spawnFinalText.includes("subagent-ok"),
    `final=${JSON.stringify((spawnFinalText ?? "").slice(0, 160))}`
  );

  // ── T5 真实 shutdown(mcp + subagent 两清理)──────────────────────────
  let shutdownError: unknown = null;
  try {
    if (built.shutdown) await built.shutdown();
  } catch (e) {
    shutdownError = e;
  }
  record(
    "T5 built.shutdown() 不抛",
    shutdownError === null,
    shutdownError instanceof Error ? shutdownError.message : ""
  );

  // ── 汇总输出 ─────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  console.log("\n— usage / response 摘要 —");
  console.log(
    `T1 model=${env.llm.model} stop=${t1Stop} turns=${t1Turns} usage=${JSON.stringify(t1LastUsage)}`
  );
  console.log(
    `T1 finalText=${JSON.stringify((t1FinalText ?? "").slice(0, 160))}`
  );
  console.log(
    `spawn model=${env.llm.model} stop=${spawnStop} turns=${spawnTurns} usage=${JSON.stringify(spawnLastUsage)}`
  );
  console.log(
    `spawn finalText=${JSON.stringify((spawnFinalText ?? "").slice(0, 160))}`
  );
  console.log(
    `\n${passed === total ? "all green" : "failures"} (${passed}/${total})`
  );

  await cleanupTmp();
  process.exitCode = passed === total ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
