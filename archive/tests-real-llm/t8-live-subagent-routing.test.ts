/**
 * #556 T8 — Live 收口:subagent_type 路由真实 LLM 接通 + trace 双断言 (含 bashMode 验证)。
 *
 * Plan T8 acceptance (plans/556-562-builtin-catalog-bash-readonly.md §T8):
 *   - 两条 live 任务:explore / general-purpose (subagent_type → role)。
 *   - Track 1 (with-trace):createJsonlTraceService 注入,落盘 JSONL,grep ≥3
 *     subagent_* events + spawn_subagent tool_call 含 subagent_type,bashMode
 *     派生验证 (explore=readonly;general-purpose=any)。
 *   - Track 2 (NoopTraceService baseline):createNoopTraceService 注入,行为
 *     deepEqual + 无 JSONL 副作用 (Noop = no IO,trace 不改变语义)。
 *   - fakeSpawn 拦截 manager.spawn,捕获 envelope + def.role 真值,worker
 *     子进程不发 (T3 fakeSpawn precedent)。
 *   - skip-guard:HAS_KEY 缺失 → describe.skip + Not run。
 * TUI smoke 非 logic gate (handoff doc 留一句)。
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import type { ChildProcess } from "node:child_process";

import { loadIknowEnv } from "../../src/config/env.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import { getAgentEntry } from "../../src/harness/subagent/catalog.ts";
import type {
  SubAgentDefinition,
  SubAgentSpawn,
} from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type { TraceService } from "../../src/harness/trace/types.ts";

// ── env + HAS_KEY 守卫 ──────────────────────────────────────────────────
const env = loadIknowEnv(process.cwd());
const HAS_KEY =
  typeof env.llm.apiKey === "string" &&
  env.llm.apiKey.length > 0 &&
  env.llm.apiKey !== "your-api-key" &&
  !env.llm.apiKey.startsWith("YOUR_");
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

const asserts: Array<{ name: string; pass: boolean; detail?: string }> = [];
const rec = (name: string, pass: boolean, detail?: string): void => {
  asserts.push({ name, pass, detail });
  if (!pass) console.error(`[FAIL] ${name}: ${detail ?? ""}`);
};

// ── throwaway workspace fixture:两个独立 doc 模块 ────────────────────────
let scratchRoot: string | undefined;
beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "iknow-t8-routing-"));
  for (const [name, dir] of [
    ["alpha", join(scratchRoot, "module-a")],
    ["beta", join(scratchRoot, "module-b")],
  ] as const) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ${name}\nT8 fixture.\n`, "utf8");
    writeFileSync(
      join(dir, "src", `${name}.ts`),
      `export const ${name} = "${name}";\n`,
      "utf8"
    );
  }
});

interface Cap {
  defs: SubAgentDefinition[];
  payloads: WorkerEnvelope[];
}

function makeFakeSpawn(cap: Cap): SubAgentSpawn {
  return (def, _taskId, payload): ChildProcess => {
    cap.defs.push(def);
    cap.payloads.push(payload);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const cp = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      pid: 12345,
      kill: () => true,
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
    // TASK() 让 worker "report the word 'subagent-ok' verbatim" —— fake worker
    // 扮演一个照做了的 worker,result 必须真带该 token,否则父代理的 final 文本
    // 里永远不会出现它,`final 含 subagent-ok` 断言无法被满足。
    const fakeEnv: SubAgentEnvelope = {
      status: "ok",
      summary: `T8-fake:${payload.task.slice(0, 40)}`,
      result: `subagent-ok (T8-fake role=${payload.role ?? "<none>"})`,
    };
    stdin.on("end", () => {
      stdout.write(JSON.stringify(fakeEnv) + "\n");
      cp.emit("exit", 0, null);
    });
    // 真 worker 用 `for await (const chunk of stdin)` 读到 EOF 才开跑。
    // PassThrough 的 "end" 只在读侧被消费完后才触发 —— 光挂 listener 不切
    // flowing 模式,manager 的 `stdin.write(...) + stdin.end()` 之后 "end"
    // 永不触发,envelope 永不回写,manager 一直等到 per-task timeout。
    stdin.resume();
    return cp;
  };
}

async function buildEngine(cap: Cap, trace: TraceService) {
  const eng = await buildHarnessEngine({
    env,
    askUser: createNoAskUser(),
    surface: "chat",
    // trace 必须进 manager:subagent_spawn / state_change / stop 三事件由
    // manager 发,build-engine 的自动接线在调用方自带 manager 时不介入。
    subagentManager: createSubAgentManager({ spawn: makeFakeSpawn(cap), trace }),
    userHome: join(scratchRoot!, `home-${cap.defs.length}`),
    cwd: scratchRoot!,
    sandboxRoot: scratchRoot!,
  });
  return { ...eng, deps: { ...eng.deps, trace } };
}

async function runTask(prompt: string, deps: LoopEngineDeps) {
  try {
    const { result } = await run(prompt, deps);
    return { stop: result.stopReason, final: result.finalText };
  } catch (e) {
    rec(
      "[llm] real run 未抛错",
      false,
      e instanceof Error ? e.message : String(e)
    );
    return { stop: "unknown", final: null };
  }
}

const TASK = (subType: string) =>
  `Use the spawn_subagent tool exactly once with subagent_type: "${subType}" and task: "report the word 'subagent-ok' verbatim and stop. Do not use any other tools." Wait for the sub-agent to finish (default). Then report the sub-agent's response to me in one sentence and stop. Do not use spawn_subagent again, do not use any other tools yourself.`;

const dump = <T extends { task?: string; role?: string }>(
  arr: ReadonlyArray<T>
) =>
  JSON.stringify(
    arr.map((x) => ({ role: x.role, task: x.task?.slice(0, 40) }))
  );

const runOrSkip = HAS_KEY ? describe : describe.skip;

runOrSkip("#556 T8 live subagent routing + trace double-assert", () => {
  let traceDir: string | undefined;
  let exploreCap: Cap, generalCap: Cap, noopCap: Cap;
  let exploreDeps: LoopEngineDeps,
    generalDeps: LoopEngineDeps,
    noopDeps: LoopEngineDeps;
  const cleanup: Array<() => Promise<void>> = [];
  let exploreEngine: Awaited<ReturnType<typeof buildHarnessEngine>>;
  let generalEngine: Awaited<ReturnType<typeof buildHarnessEngine>>;
  let noopEngine: Awaited<ReturnType<typeof buildHarnessEngine>>;

  beforeAll(async () => {
    traceDir = mkdtempSync(join(tmpdir(), "iknow-t8-trace-"));
    exploreCap = { defs: [], payloads: [] };
    generalCap = { defs: [], payloads: [] };
    noopCap = { defs: [], payloads: [] };
    ({ deps: exploreDeps, ...exploreEngine } = await buildEngine(
      exploreCap,
      createJsonlTraceService({ filePath: traceDir, conversationId: "explore" })
    ));
    cleanup.push(async () => {
      if (exploreEngine.shutdown) await exploreEngine.shutdown();
    });
    ({ deps: generalDeps, ...generalEngine } = await buildEngine(
      generalCap,
      createJsonlTraceService({ filePath: traceDir, conversationId: "general" })
    ));
    cleanup.push(async () => {
      if (generalEngine.shutdown) await generalEngine.shutdown();
    });
    ({ deps: noopDeps, ...noopEngine } = await buildEngine(
      noopCap,
      createNoopTraceService()
    ));
    cleanup.push(async () => {
      if (noopEngine.shutdown) await noopEngine.shutdown();
    });
  });

  afterAll(async () => {
    await Promise.all(cleanup.splice(0).map((f) => f()));
    if (traceDir) rmSync(traceDir, { recursive: true, force: true });
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
    if (asserts.length > 0) {
      const passed = asserts.filter((a) => a.pass).length;
      console.log(
        `\nt8-live-subagent-routing: ${passed}/${asserts.length} asserts`
      );
      for (const a of asserts)
        console.log(
          `  ${a.pass ? "[PASS]" : "[FAIL]"} ${a.name}${a.detail ? `: ${a.detail}` : ""}`
        );
    }
  });

  it("[env] loadIknowEnv 走 settings 单承载", () => {
    rec(
      "[env] apiKey+model 真值",
      !!env.llm.apiKey && !!env.llm.model,
      `apiKey.len=${env.llm.apiKey?.length ?? "u"}; model=${env.llm.model}`
    );
    expect(asserts.filter((a) => !a.pass)).toEqual([]);
  });

  it("[llm] explore 路由 — subagent_type=explore 真模型触发", async () => {
    const { stop, final } = await runTask(TASK("explore"), {
      ...exploreDeps,
      maxTurns: 3,
    });
    rec(
      "[llm][explore] stopReason completed + final 含 subagent-ok",
      stop === "completed" &&
        typeof final === "string" &&
        final.includes("subagent-ok"),
      `stop=${stop}; final=${JSON.stringify((final ?? "").slice(0, 120))}`
    );
    rec(
      "[llm][explore] capturedPayloads[0].role === 'explore'",
      exploreCap.payloads[0]?.role === "explore",
      `payloads=${dump(exploreCap.payloads)}`
    );
    rec(
      "[llm][explore] capturedDefs[0].role === 'explore'",
      exploreCap.defs[0]?.role === "explore",
      `defs=${dump(exploreCap.defs)}`
    );
    const e = getAgentEntry("explore");
    rec(
      "[llm][explore] catalog: body + deny(edit_file,write_file) + bashMode=readonly",
      e.body.length > 0 &&
        e.body.includes("explore") &&
        e.disallowedTools!.includes("edit_file") &&
        e.disallowedTools!.includes("write_file") &&
        e.bashMode === "readonly",
      `body.len=${e.body.length}; deny=${[...e.disallowedTools!].join(",")}; bashMode=${e.bashMode}`
    );
  }, 360_000);

  it("[llm] general-purpose 路由 — subagent_type=general-purpose 真模型触发", async () => {
    const { stop, final } = await runTask(TASK("general-purpose"), {
      ...generalDeps,
      maxTurns: 3,
    });
    rec(
      "[llm][general] stopReason completed + final 含 subagent-ok",
      stop === "completed" &&
        typeof final === "string" &&
        final.includes("subagent-ok"),
      `stop=${stop}; final=${JSON.stringify((final ?? "").slice(0, 120))}`
    );
    rec(
      "[llm][general] capturedPayloads[0].role === 'general-purpose'",
      generalCap.payloads[0]?.role === "general-purpose",
      `payloads=${dump(generalCap.payloads)}`
    );
    rec(
      "[llm][general] capturedDefs[0].role === 'general-purpose'",
      generalCap.defs[0]?.role === "general-purpose",
      `defs=${dump(generalCap.defs)}`
    );
    const g = getAgentEntry("general-purpose");
    rec(
      "[llm][general] catalog: body 非空 + bashMode/disallowedTools 缺省 (V1 baseline)",
      g.body.length > 0 &&
        g.bashMode === undefined &&
        g.disallowedTools === undefined,
      `body.len=${g.body.length}; bashMode=${g.bashMode ?? "<u>"}; deny=${g.disallowedTools ?? "<u>"}`
    );
  }, 360_000);

  it("[trace][T1] JSONL 落盘 subagent_* ≥3 + spawn/stop 同 id 配对 + 双档 tool_call", async () => {
    const read = (conv: string): Array<Record<string, unknown>> =>
      readFileSync(join(traceDir!, `${conv}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    // conversationId 分档 = 路由分档:explore 任务与 general-purpose 任务各自
    // 独立落盘,两档不得互相串味。
    const byConv = { explore: read("explore"), general: read("general") };
    const recs = [...byConv.explore, ...byConv.general];
    const typeOf = (r: Record<string, unknown>): string =>
      typeof r.record_type === "string" ? r.record_type : "";
    const sub = recs.filter((r) => typeOf(r).startsWith("subagent_"));
    const idsOf = (t: string): string[] =>
      recs.filter((r) => typeOf(r) === t).map((r) => String(r.subagent_id));
    const spawnIds = idsOf("subagent_spawn");
    const stopIds = idsOf("subagent_stop");
    rec(
      "[trace][T1] grep -c subagent_ >= 3 + spawn/stop 同 id 配对",
      sub.length >= 3 &&
        spawnIds.length >= 2 &&
        stopIds.length === spawnIds.length &&
        stopIds.every((id) => spawnIds.includes(id)),
      `count=${sub.length}; spawn=${spawnIds.length}; stop=${stopIds.length}; paired=${stopIds.every((id) => spawnIds.includes(id))}; types=${sub.map(typeOf).join(",")}`
    );
    // 为什么不断言 `arguments.subagent_type`:loop-engine 的 recordToolCall 走
    // `argumentsCaptured: false` 且不落 `arguments`(生产 trace 不把任意工具入参
    // 写盘)。JSONL 里该字段恒缺席,断言它等于断言一个不存在的契约。
    // trace 侧改断"两档各自恰好一次 spawn_subagent 调用且成功";
    // subagent_type → role 的真值由上面两条 it 的 wire 侧
    // capturedDefs[0].role / capturedPayloads[0].role 承担。
    // 观测面缺口(trace 无 role 字段)已记入 handoff,归 Phase 1 观测性地板。
    const spawnCallsIn = (rs: Array<Record<string, unknown>>) =>
      rs.filter(
        (r) => typeOf(r) === "tool_call" && r.tool_name === "spawn_subagent"
      );
    const eCalls = spawnCallsIn(byConv.explore);
    const gCalls = spawnCallsIn(byConv.general);
    rec(
      "[trace][T1] explore / general 两档各恰好一次成功 spawn_subagent tool_call",
      eCalls.length === 1 &&
        gCalls.length === 1 &&
        eCalls[0]!.status === "ok" &&
        gCalls[0]!.status === "ok",
      `explore=${eCalls.length}(${String(eCalls[0]?.status)}); general=${gCalls.length}(${String(gCalls[0]?.status)})`
    );
  }, 60_000);

  it("[trace][T2] NoopTraceService baseline — 无 JSONL + 行为 deepEqual", async () => {
    const { stop } = await runTask(TASK("explore"), {
      ...noopDeps,
      maxTurns: 3,
    });
    rec(
      "[trace][T2] stopReason completed + Noop 不写新 JSONL",
      stop === "completed" && !existsSync(join(traceDir!, "noop.jsonl")),
      `stop=${stop}; noop-exists=${existsSync(join(traceDir!, "noop.jsonl"))}`
    );
    rec(
      "[trace][T2] deepEqual:capturedPayloads[0].role === 'explore'",
      noopCap.payloads[0]?.role === "explore",
      `noop-role=${noopCap.payloads[0]?.role}`
    );
    rec(
      "[trace][T2] deepEqual:capturedDefs[0].role === 'explore'",
      noopCap.defs[0]?.role === "explore",
      `noop-def-role=${noopCap.defs[0]?.role}`
    );
    expect(asserts.filter((a) => !a.pass)).toEqual([]);
  }, 360_000);
});
