/**
 * SubAgentManager unit tests (fake spawn factory, no real child processes).
 *
 * Covers 10 fixtures:
 *   1. spawn → valid envelope on stdout → completed
 *   2. spawn → exit code=1 → crashed
 *   3. spawn → invalid JSON on stdout → protocolError
 *   4. spawn → stdout result over 20000 chars → truncated envelope
 *   5. spawn → 'error' ENOENT → crashed
 *   6. shutdown: two running children get SIGTERM; fakes that never exit → SIGKILL fallback
 *   7. queryBuffer four states (not_found / running / completed / failed)
 *   8. waitFor timeout: fake never emits → reject reason=timeout
 *   9. drainCompleted lists completed only (running / failed absent)
 *  10. SubAgentDefinition local definition typecheck
 *
 * fake ChildProcess follows the precedent in tests/harness/lsp/client.test.ts:
 * EventEmitter + PassThrough stdin/stdout/stderr + kill spy.
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { describe, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  createSubAgentManager,
  coerceSubagentCapacityValue,
  createSubagentCapacityHolder,
  MAX_CONCURRENT_WORKERS,
  SubAgentAbortError,
  SubAgentCapacityError,
  SubAgentWaitTimeoutError,
} from "../../src/harness/subagent/manager.ts";
import type {
  QueryBufferResult,
  SubAgentDefinition,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentEnvelope,
  WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";

// ── fake ChildProcess factory ─────────────────────────────────────────────────

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

/** Capture wrapper: records each spawned child + inputs so tests can emit.
 *  `opts.taskTimeoutMs` passes through to createSubAgentManager (middle layer of the three-tier default chain). */
function makeHarness(
  opts: {
    readonly taskTimeoutMs?: number;
    readonly maxConcurrentWorkers?: number;
  } = {}
) {
  const spawned: FakeChild[] = [];
  const spawnCalls: {
    def: SubAgentDefinition;
    taskId: string;
    payload: WorkerEnvelope;
  }[] = [];
  const manager = createSubAgentManager({
    spawn: (def, taskId, payload) => {
      const child = makeFakeChild();
      spawned.push(child);
      spawnCalls.push({ def, taskId, payload });
      return child as unknown as ChildProcess;
    },
    ...(opts.taskTimeoutMs !== undefined
      ? { taskTimeoutMs: opts.taskTimeoutMs }
      : {}),
    ...(opts.maxConcurrentWorkers !== undefined
      ? { maxConcurrentWorkers: opts.maxConcurrentWorkers }
      : {}),
  });
  return { manager, spawned, spawnCalls };
}

describe("SubAgentManager concurrency capacity", () => {
  it("default capacity is 15 and the 16th spawn fails immediately", () => {
    assert.equal(MAX_CONCURRENT_WORKERS, 15);
    const { manager } = makeHarness();

    for (let i = 0; i < MAX_CONCURRENT_WORKERS; i++) {
      assert.doesNotThrow(() => manager.spawn({ task: `default-${i}` }));
    }
    assert.throws(
      () => manager.spawn({ task: "default-overflow" }),
      (error: unknown) => {
        assert.ok(error instanceof SubAgentCapacityError);
        assert.equal(error.active, 15);
        assert.match(error.message, /15\/15/);
        return true;
      }
    );
  });

  it("uses an injected smaller capacity without queueing", () => {
    const { manager } = makeHarness({ maxConcurrentWorkers: 2 });

    manager.spawn({ task: "first" });
    manager.spawn({ task: "second" });
    assert.throws(
      () => manager.spawn({ task: "overflow" }),
      (error: unknown) => {
        assert.ok(error instanceof SubAgentCapacityError);
        assert.equal(error.active, 2);
        assert.match(error.message, /2\/2/);
        return true;
      }
    );
  });

  // Spec Layer 3 item 7 + SC3: the rejection is observable as the exact
  // active/max pair, and the surplus request starts NOTHING — no child is
  // spawned for the rejected call (no queue, no silent backlog).
  it("rejecting at capacity spawns no extra child", () => {
    const { manager, spawned } = makeHarness({ maxConcurrentWorkers: 2 });

    manager.spawn({ task: "first" });
    manager.spawn({ task: "second" });
    const before = spawned.length;

    assert.throws(
      () => manager.spawn({ task: "third" }),
      SubAgentCapacityError
    );
    assert.equal(spawned.length, before);
  });

  it("same-turn batch up to max all start, and the (max+1)-th is the only failure", () => {
    // Spec Layer 3 item 8 + input-contract row "same-turn multi-spawn ≤ max":
    // dispatching a whole batch in one turn is the supported shape — every
    // call up to the cap is admitted, and the boundary is exactly one over.
    const cap = 4;
    const { manager, spawned } = makeHarness({ maxConcurrentWorkers: cap });

    for (let i = 0; i < cap; i++) {
      assert.doesNotThrow(() => manager.spawn({ task: `batch-${i}` }));
    }
    assert.equal(spawned.length, cap);

    assert.throws(
      () => manager.spawn({ task: "batch-over" }),
      (error: unknown) => {
        assert.ok(error instanceof SubAgentCapacityError);
        assert.equal(error.active, cap);
        assert.equal(error.maxConcurrentWorkers, cap);
        assert.match(error.message, new RegExp(`${cap}/${cap}`));
        return true;
      }
    );
    assert.equal(spawned.length, cap);
  });

  it("falls back to the default for an illegal injected capacity", () => {
    const { manager } = makeHarness({ maxConcurrentWorkers: 0 });
    for (let i = 0; i < MAX_CONCURRENT_WORKERS; i++) {
      assert.doesNotThrow(() => manager.spawn({ task: `fallback-${i}` }));
    }
    assert.throws(() => manager.spawn({ task: "fallback-overflow" }));
  });

  // ADR-0096 ── capacity holder (runtime flip) + unlimited semantics.
  it("subagentCapacityHolder 缺席 → 回退到 opts.maxConcurrentWorkers（既有行为）", () => {
    const holder = createSubagentCapacityHolder(2);
    const manager = createSubAgentManager({
      spawn: () => makeFakeChild() as unknown as ChildProcess,
      maxConcurrentWorkers: 2,
      subagentCapacityHolder: holder,
    });
    assert.equal(manager.getCapacity(), 2);
  });
});

describe("SubagentCapacityHolder（ADR-0096 T2）", () => {
  // holder is a pure factory (reads no globals) — the contract is pinned by unit tests.
  it("初始值正整数 → get() 返同值", () => {
    const h = createSubagentCapacityHolder(7);
    assert.equal(h.get(), 7);
  });
  it("初始值缺省 → 默认 15", () => {
    const h = createSubagentCapacityHolder();
    assert.equal(h.get(), MAX_CONCURRENT_WORKERS);
  });
  it('初始值 "unlimited" → get() 返 "unlimited"', () => {
    const h = createSubagentCapacityHolder("unlimited");
    assert.equal(h.get(), "unlimited");
  });
  it("set(正整数) → get() 返新值", () => {
    const h = createSubagentCapacityHolder(3);
    h.set(9);
    assert.equal(h.get(), 9);
  });
  it('set("unlimited") → get() 返 "unlimited"', () => {
    const h = createSubagentCapacityHolder(3);
    h.set("unlimited");
    assert.equal(h.get(), "unlimited");
  });
  it("set(0 / 非法) → get() 维持当前值（fail-closed）", () => {
    const h = createSubagentCapacityHolder(5);
    h.set(0);
    assert.equal(h.get(), 5);
    h.set(-1);
    assert.equal(h.get(), 5);
    h.set(1.5); // non-integer
    assert.equal(h.get(), 5);
    h.set("garbage" as unknown as number);
    assert.equal(h.get(), 5);
  });
  it("holder 冻结（外部无法 set 引用替换）", () => {
    const h = createSubagentCapacityHolder(3);
    assert.equal(Object.isFrozen(h), true);
  });
});

describe("coerceSubagentCapacityValue（ADR-0096 T2）", () => {
  it('"unlimited" → "unlimited"', () => {
    assert.equal(coerceSubagentCapacityValue("unlimited"), "unlimited");
  });
  it("正整数 → 同值", () => {
    assert.equal(coerceSubagentCapacityValue(1), 1);
    assert.equal(coerceSubagentCapacityValue(99), 99);
  });
  it("0 / 负数 / 非整数 / NaN / null / undefined / 字面 → 默认 15", () => {
    assert.equal(coerceSubagentCapacityValue(0), MAX_CONCURRENT_WORKERS);
    assert.equal(coerceSubagentCapacityValue(-1), MAX_CONCURRENT_WORKERS);
    assert.equal(coerceSubagentCapacityValue(1.5), MAX_CONCURRENT_WORKERS);
    assert.equal(coerceSubagentCapacityValue(NaN), MAX_CONCURRENT_WORKERS);
    assert.equal(coerceSubagentCapacityValue(Infinity), MAX_CONCURRENT_WORKERS);
    assert.equal(coerceSubagentCapacityValue(null), MAX_CONCURRENT_WORKERS);
    assert.equal(
      coerceSubagentCapacityValue(undefined),
      MAX_CONCURRENT_WORKERS
    );
    assert.equal(coerceSubagentCapacityValue("3"), MAX_CONCURRENT_WORKERS);
    assert.equal(coerceSubagentCapacityValue({}), MAX_CONCURRENT_WORKERS);
  });
});

describe("SubAgentManager concurrency capacity — ADR-0096 T2（holder + unlimited）", () => {
  it("holder 缺席 → opts.maxConcurrentWorkers 作初值（fallback chain）", () => {
    const manager = createSubAgentManager({
      spawn: () => makeFakeChild() as unknown as ChildProcess,
      maxConcurrentWorkers: 4,
    });
    assert.equal(manager.getCapacity(), 4);
  });

  it("holder 缺席 → opts.maxConcurrentWorkers 也缺席 → 默认 15", () => {
    const manager = createSubAgentManager({
      spawn: () => makeFakeChild() as unknown as ChildProcess,
    });
    assert.equal(manager.getCapacity(), MAX_CONCURRENT_WORKERS);
  });

  it("holder 在场时 → manager.getCapacity() 反映 holder 当前值（opts 失效）", () => {
    const holder = createSubagentCapacityHolder(7);
    const manager = createSubAgentManager({
      spawn: () => makeFakeChild() as unknown as ChildProcess,
      // a present holder overrides opts.maxConcurrentWorkers (ADR-0096 ruling):
      // with a holder, the gate reads holder.get() live each time; opts is only
      // the initial value when no holder is given.
      maxConcurrentWorkers: 999,
      subagentCapacityHolder: holder,
    });
    assert.equal(manager.getCapacity(), 7);
    holder.set(11);
    assert.equal(manager.getCapacity(), 11);
  });

  it("运行时 holder.set(N) → 下一次 spawn 闸值即时反映", () => {
    const holder = createSubagentCapacityHolder(2);
    const manager = createSubAgentManager({
      spawn: () => makeFakeChild() as unknown as ChildProcess,
      subagentCapacityHolder: holder,
    });

    // gate = 2: the 3rd of three spawns throws SubAgentCapacityError
    manager.spawn({ task: "t1" });
    manager.spawn({ task: "t2" });
    assert.throws(() => manager.spawn({ task: "t3" }), SubAgentCapacityError);

    // runtime raise to 5 → three more spawns pass (the existing 2 still hold slots; the 5th fills the gate, the 6th overflows)
    holder.set(5);
    manager.spawn({ task: "t4" }); // active=3
    manager.spawn({ task: "t5" }); // active=4
    manager.spawn({ task: "t6" }); // active=5, gate=5 → boundary hit (active < cap passes, == cap rejects)
    assert.throws(
      () => manager.spawn({ task: "t7" }),
      (error: unknown) => {
        assert.ok(error instanceof SubAgentCapacityError);
        // active = 5 running/starting; max = 5 (read live from holder, matches check-time)
        assert.equal(error.active, 5);
        assert.equal(error.maxConcurrentWorkers, 5);
        assert.match(error.message, /5\/5/);
        return true;
      }
    );
  });

  it('holder.set("unlimited") → 远超 15 个 spawn 全过（OS / 内存是事实顶）', () => {
    const holder = createSubagentCapacityHolder("unlimited");
    const manager = createSubAgentManager({
      spawn: () => makeFakeChild() as unknown as ChildProcess,
      subagentCapacityHolder: holder,
    });

    // far above the default 15 — no throw under the unlimited gate.
    for (let i = 0; i < 20; i++) {
      assert.doesNotThrow(() => manager.spawn({ task: `u-${i}` }));
    }
    assert.equal(manager.getCapacity(), "unlimited");
  });

  it('holder initial "unlimited" → 装配即不抛（与 set 后语义一致）', () => {
    const manager = createSubAgentManager({
      spawn: () => makeFakeChild() as unknown as ChildProcess,
      subagentCapacityHolder: createSubagentCapacityHolder("unlimited"),
    });
    assert.equal(manager.getCapacity(), "unlimited");
    for (let i = 0; i < 20; i++) {
      assert.doesNotThrow(() => manager.spawn({ task: `u-${i}` }));
    }
  });

  it("SubAgentCapacityError.maxConcurrentWorkers = 闸 check-time 数值（holder 翻转亦同）", () => {
    const holder = createSubagentCapacityHolder(3);
    const manager = createSubAgentManager({
      spawn: () => makeFakeChild() as unknown as ChildProcess,
      subagentCapacityHolder: holder,
    });
    manager.spawn({ task: "a" });
    manager.spawn({ task: "b" });
    manager.spawn({ task: "c" });
    assert.throws(
      () => manager.spawn({ task: "d" }),
      (error: unknown) => {
        assert.ok(error instanceof SubAgentCapacityError);
        assert.equal(error.maxConcurrentWorkers, 3);
        assert.match(error.message, /3\/3/);
        return true;
      }
    );

    // holder flip → the gate value is the maxConcurrentWorkers of the next thrown error
    holder.set(9);
    for (let i = 0; i < 6; i++) manager.spawn({ task: `flip-${i}` });
    assert.throws(
      () => manager.spawn({ task: "flip-over" }),
      (error: unknown) => {
        assert.ok(error instanceof SubAgentCapacityError);
        assert.equal(error.maxConcurrentWorkers, 9);
        assert.match(error.message, /9\/9/);
        return true;
      }
    );
  });

  it("opts.maxConcurrentWorkers 非法（0 / -1） + holder 在场 → 闸值 = holder 初值", () => {
    // With a holder present, an illegal opts.maxConcurrentWorkers never falls
    // back to the default — its only role is the initial value when no holder
    // is given (ADR-0096 ruling: opts is inert once a holder exists; no cross-validation).
    const holder = createSubagentCapacityHolder(4);
    const manager = createSubAgentManager({
      spawn: () => makeFakeChild() as unknown as ChildProcess,
      maxConcurrentWorkers: 0,
      subagentCapacityHolder: holder,
    });
    assert.equal(manager.getCapacity(), 4);
    for (let i = 0; i < 4; i++) {
      assert.doesNotThrow(() => manager.spawn({ task: `t-${i}` }));
    }
    assert.throws(() => manager.spawn({ task: "over" }), SubAgentCapacityError);
  });
});

function okEnvelope(result = "ok result"): SubAgentEnvelope {
  return { status: "ok", summary: "done", result };
}

function emitEnvelope(child: FakeChild, env: SubAgentEnvelope): void {
  child.stdout.write(JSON.stringify(env) + "\n");
  child.emit("exit", 0, null);
}

async function emitCrashAndWait(
  manager: SubAgentManager,
  child: FakeChild,
  taskId: string,
  code: number | null,
  signal: NodeJS.Signals | null
): Promise<SubAgentEnvelope> {
  child.stderr.end();
  child.emit("exit", code, signal);
  return manager.waitFor(taskId, 1000);
}

// ── fixture 1:completed ───────────────────────────────────────────────────────

describe("SubAgentManager spawn → completed", () => {
  it("valid envelope on stdout → completed, queryBuffer returns envelope", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({
      systemPrompt: "be concise",
    });
    assert.ok(taskId.length > 0);

    emitEnvelope(spawned[0]!, okEnvelope("hello"));

    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "ok");
    assert.equal((q as SubAgentEnvelope).result, "hello");
  });

  it("writes a newline-JSON WorkerEnvelope payload to stdin then ends it", () => {
    const { manager, spawnCalls } = makeHarness();
    const def: SubAgentDefinition = {
      systemPrompt: "p",
      disallowedTools: ["edit_file"],
      maxTurns: 5,
      timeoutMs: 30000,
    };
    manager.spawn(def);
    assert.equal(spawnCalls.length, 1);
    const { payload, taskId } = spawnCalls[0]!;
    // taskId is manager's internal randomUUID — the single source of truth
    assert.ok(taskId.length > 0);
    assert.equal(payload.task, "");
    // when def omits sandboxRoot, the manager fills in the parent sandboxRoot.
    // makeHarness passes no sandboxRoot opt → fallback = realpathSync(process.cwd()).
    // The default inherits the parent root rather than a literal process.cwd() (locked behavior change).
    assert.equal(payload.sandboxRoot, realpathSync(process.cwd()));
    assert.equal(payload.systemPrompt, "p");
    assert.deepEqual(payload.disallowedTools, ["edit_file"]);
    // ADR-0122: the per-spawn model field is deleted — the manager writes no
    // `model` key into the worker payload.
    assert.ok(!("model" in payload), "payload must not carry model");
    assert.equal(payload.maxTurns, 5);
    assert.equal(payload.timeoutMs, 30000);
  });

  it("worker 侧读 stdin 到 EOF 拿到整条 payload 行 (真 worker 的 for-await 契约)", async () => {
    const { manager, spawned, spawnCalls } = makeHarness();
    manager.spawn({ systemPrompt: "p" });
    const chunks: string[] = [];
    // mirrors the real worker's consumption shape: for-await to EOF. If the
    // manager never end()s stdin, EOF never arrives here and the worker never
    // starts (the hang seen in the live e2e).
    for await (const chunk of spawned[0]!.stdin) chunks.push(String(chunk));
    const raw = chunks.join("");
    assert.equal(raw.endsWith("\n"), true, "payload 必须以换行收尾");
    assert.deepEqual(JSON.parse(raw.trim()), spawnCalls[0]!.payload);
  });

  it("waitFor resolves envelope on completed", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    // mark completed synchronously first (emit dispatches on data/exit, so waitFor converges on its first check)
    emitEnvelope(spawned[0]!, okEnvelope("w"));
    const env = await manager.waitFor(taskId, 1000);
    assert.equal(env.status, "ok");
    assert.equal(env.result, "w");
  });

  it("multiple stdout envelopes → last one wins", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stdout.write(JSON.stringify(okEnvelope("first")) + "\n");
    spawned[0]!.stdout.write(JSON.stringify(okEnvelope("second")) + "\n");
    spawned[0]!.emit("exit", 0, null);
    const q = manager.queryBuffer(taskId);
    assert.equal((q as SubAgentEnvelope).result, "second");
  });
});

// ── fixture 2 / 5:failed(crashed) ─────────────────────────────────────────────

describe("SubAgentManager spawn → crashed", () => {
  it("exit code=1 → failed reason=crashed with summary", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    const q = await emitCrashAndWait(manager, spawned[0]!, taskId, 1, null);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.match(q.summary, /worker exit code=1 signal=null/);
    }
  });

  it("stderr before exit → crashed summary includes the bounded stderr tail", async () => {
    const { SUMMARY_LIMIT } =
      await import("../../src/harness/subagent/envelope.ts");
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    // 2500-char body sits inside a 4096 window but outside SUMMARY_LIMIT=2000,
    // so DROPME surviving would mean the drain still uses a second magic cap.
    const stderr = "DROPME\n" + "x".repeat(2_500) + "\nKEEPME\n";

    spawned[0]!.stderr.write(stderr);
    assert.equal(spawned[0]!.stderr.readableLength, 0);
    spawned[0]!.stderr.end();
    spawned[0]!.emit("exit", 2, null);

    const q = await manager.waitFor(taskId, 1000);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.match(q.summary, /worker exit code=2 signal=null/);
      assert.match(q.summary, /KEEPME/);
      assert.doesNotMatch(q.summary, /DROPME/);
      assert.ok(q.summary.length <= SUMMARY_LIMIT + 80);
    }
  });

  it("empty stderr → crashed summary remains unchanged", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    const q = await emitCrashAndWait(manager, spawned[0]!, taskId, 1, null);

    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.summary, "worker exit code=1 signal=null");
    }
  });

  it("killed by signal → failed reason=crashed", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    const q = await emitCrashAndWait(
      manager,
      spawned[0]!,
      taskId,
      null,
      "SIGTERM"
    );
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.match(q.summary, /signal=SIGTERM/);
    }
  });

  it("spawn factory throw → failed reason=crashed", () => {
    const manager = createSubAgentManager({
      spawn: () => {
        throw new Error("ENOENT: no iknow bin");
      },
    });
    const { taskId } = manager.spawn({});
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.match(q.summary, /spawn failed: ENOENT/);
    }
  });

  it("child 'error' ENOENT → failed reason=crashed summary=err.message", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stderr.end();
    spawned[0]!.emit(
      "error",
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })
    );
    const q = await manager.waitFor(taskId, 1000);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "crashed");
      assert.equal(q.summary, "spawn ENOENT");
    }
  });
});

// ── ADR-0111: modelTransient attribution (upstream transient failure ≠ process-level crash) ──

describe("SubAgentManager spawn → modelTransient (ADR-0111 attribution)", () => {
  it("failed envelope reason=modelTransient + exit 0 → failed modelTransient + 续跑引导文案", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    emitEnvelope(spawned[0]!, {
      status: "failed",
      reason: "modelTransient",
      summary: "",
      result: "",
    });
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      // attribution comes from the envelope, never impersonates crashed (crashed is reserved for non-zero/signal exits with no consumed envelope).
      assert.equal(q.reason, "modelTransient");
      // an empty summary is projected by failedSummary into parent-visible continuation guidance (ADR-0102 Decision 1).
      assert.match(q.summary, /modelTransient/);
      assert.match(q.summary, /subagent_continue/);
    }
  });

  it("failed envelope reason=modelTransient + exit 1 (run 阶段逃逸, ADR-0111 不变式 (b)) → 保持 modelTransient 不被 crashed 覆盖", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stdout.write(
      JSON.stringify({
        status: "failed",
        reason: "modelTransient",
        summary: "",
        result: "",
      }) + "\n"
    );
    spawned[0]!.stderr.end();
    spawned[0]!.emit("exit", 1, null);
    const q = await manager.waitFor(taskId, 1000);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "modelTransient");
    }
  });
});

// ── fixture 3:protocolError ───────────────────────────────────────────────────

describe("SubAgentManager clean exit without envelope", () => {
  it("exit code=0 without envelope → failed protocolError and releases the slot", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});

    spawned[0]!.emit("exit", 0, null);

    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "protocolError");
      assert.match(q.summary, /without envelope/);
    }
    assert.deepEqual(manager.listActive(), []);
  });

  it("four clean exits without envelopes release capacity for a fifth spawn", () => {
    const { manager, spawned } = makeHarness();
    for (let i = 0; i < 4; i++) manager.spawn({});

    for (const child of spawned) child.emit("exit", 0, null);

    assert.doesNotThrow(() => manager.spawn({}));
  });
});

describe("SubAgentManager spawn → protocolError", () => {
  it("invalid JSON on stdout → failed reason=protocolError", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stdout.write("{not json\n");
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") {
      assert.equal(q.reason, "protocolError");
      assert.match(q.summary, /subagent envelope protocol error/);
    }
  });

  it("schema-invalid envelope (missing required) → failed reason=protocolError", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stdout.write(
      JSON.stringify({ status: "ok", summary: "s" }) + "\n"
    ); // missing result
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") assert.equal(q.reason, "protocolError");
  });
});

// ── fixture 4:truncation ──────────────────────────────────────────────────────

describe("SubAgentManager envelope truncation (SC10)", () => {
  it("result > 20000 chars → short folded envelope in buffer", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    emitEnvelope(spawned[0]!, {
      status: "ok",
      summary: "completed with a long report " + "x".repeat(25000),
      result: "x".repeat(25000),
      fileRefs: ["src/changed.ts"],
      stop_reason: "completed",
    });
    const q = manager.queryBuffer(taskId) as SubAgentEnvelope;
    assert.equal(q.status, "ok");
    assert.equal(q.truncated, true);
    assert.equal(q.totalLength, 25000);
    assert.ok(q.summary.length < 25000);
    assert.ok(q.result.length < 20000);
    assert.notEqual(q.result, "x".repeat(25000));
    assert.match(q.result, /src\/changed\.ts/);
    assert.match(q.result, /report folded/);
    assert.equal(q.stop_reason, "completed");
  });
});

// ── fixture 7: queryBuffer four states ─────────────────────────────────────────

describe("SubAgentManager queryBuffer 四态 (SC5)", () => {
  it("unknown taskId → not_found", () => {
    const { manager } = makeHarness();
    assert.deepEqual(manager.queryBuffer("nope"), { status: "not_found" });
  });

  it("spawned but no stdout/exit → running", () => {
    const { manager } = makeHarness();
    const { taskId } = manager.spawn({});
    assert.deepEqual(manager.queryBuffer(taskId), { status: "running" });
  });

  it("completed → full envelope", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    emitEnvelope(spawned[0]!, okEnvelope("r"));
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "ok");
    assert.equal((q as SubAgentEnvelope).result, "r");
  });

  it("failed → {status:failed, reason, summary}", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    spawned[0]!.stderr.end();
    spawned[0]!.emit("exit", 2, null);
    await manager.waitFor(taskId, 1000);
    const q = manager.queryBuffer(taskId);
    assert.equal(q.status, "failed");
    if (q.status === "failed") assert.equal(q.reason, "crashed");
  });
});

// ── fixture 6b: per-task timeout ───────────────────────────────────────────────

describe("SubAgentManager per-task timeout (def.timeoutMs)", () => {
  it("timeoutMs 到期且 child 未完成 → failed reason=timeout + SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      // initially running
      assert.deepEqual(manager.queryBuffer(taskId), { status: "running" });

      // after 50ms the timer fires → failed reason=timeout + SIGTERM
      await vi.advanceTimersByTimeAsync(50);
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 50ms/);
      }
      // child received SIGTERM (first strike)
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("child 以 SIGTERM 退出不覆盖 timeout envelope(保持 reason=timeout)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      // already marked failed by timeout; the child's later signal exit must not overwrite it with crashed
      spawned[0]!.emit("exit", null, "SIGTERM");
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 50ms/);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout 前 child 正常完成 → 不标 timeout,timer 被 exit handler 清理", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      emitEnvelope(spawned[0]!, okEnvelope("fast done"));
      assert.equal(
        (manager.queryBuffer(taskId) as SubAgentEnvelope).status,
        "ok"
      );
      // past the timeout window: already completed, the timer callback was cleared by the exit handler / must not overwrite
      await vi.advanceTimersByTimeAsync(100);
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "ok");
      assert.equal((q as SubAgentEnvelope).result, "fast done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdown 清掉 timeoutTimer,timeout 不再触发 SIGTERM(只 shutdown 自己的 SIGTERM)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({ timeoutMs: 50 });
      // shutdown immediately (timeoutTimer not yet due)
      const done = manager.shutdown();
      // past the 50ms timeout window + the 5s shutdown fallback
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      // if timeoutTimer were not cleared, another SIGTERM would fire at 50ms.
      // The shutdown fallback sends SIGKILL (the fake never exits) — not counted as SIGTERM.
      const sigtermCount = spawned[0]!.kill.mock.calls.filter(
        (c) => c[0] === "SIGTERM"
      ).length;
      assert.equal(sigtermCount, 1);
      assert.deepEqual(manager.queryBuffer(taskId), { status: "not_found" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── per-task three-tier default chain: def.timeoutMs ?? opts.taskTimeoutMs ?? constant ──

describe("SubAgentManager per-task 缺省链 (T2: def ?? taskTimeoutMs ?? 7200s)", () => {
  it("层 1: def.timeoutMs=111 优先 → 111ms 触发 SIGTERM (不 shell 到下方层)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness({ taskTimeoutMs: 222 });
      const { taskId } = manager.spawn({ timeoutMs: 111 });
      await vi.advanceTimersByTimeAsync(111);
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 111ms/);
      }
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("层 2: 无 def.timeoutMs + opts.taskTimeoutMs=222 → 222ms 触发 SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness({ taskTimeoutMs: 222 });
      const { taskId } = manager.spawn({});
      await vi.advanceTimersByTimeAsync(222);
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 222ms/);
      }
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("层 3: 前两层皆缺席 → 默认 7_200_000ms (固定常量, 不 shell 到任何 env)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({});
      assert.deepEqual(manager.queryBuffer(taskId), { status: "running" });
      await vi.advanceTimersByTimeAsync(7_200_000);
      const q = manager.queryBuffer(taskId);
      assert.equal(q.status, "failed");
      if (q.status === "failed") {
        assert.equal(q.reason, "timeout");
        assert.match(q.summary, /timeout after 7200000ms/);
      }
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitFor timeout rejects while the child remains live", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = makeHarness({ taskTimeoutMs: 1000 });
      const { taskId } = manager.spawn({});
      const pending = manager.waitFor(taskId, 50);
      const rejected = assert.rejects(pending, SubAgentWaitTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── fixture 8:waitFor timeout ─────────────────────────────────────────────────

describe("SubAgentManager waitFor timeout", () => {
  it("rejects with reason=timeout when no terminal event within timeoutMs", async () => {
    const { manager } = makeHarness();
    const { taskId } = manager.spawn({});
    await assert.rejects(manager.waitFor(taskId, 100), (err: unknown) => {
      assert.ok(err instanceof SubAgentWaitTimeoutError);
      assert.equal(err.status, "failed");
      assert.equal(err.reason, "timeout");
      return true;
    });
  });

  it("rejects for unknown taskId", async () => {
    const { manager } = makeHarness();
    await assert.rejects(
      manager.waitFor("nope", 100),
      SubAgentWaitTimeoutError
    );
  });
});

// ── fixture 6:shutdown ────────────────────────────────────────────────────────

describe("SubAgentManager shutdown (SC12)", () => {
  it("running children receive SIGTERM; those not exiting get SIGKILL fallback", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId: a } = manager.spawn({});
      const { taskId: b } = manager.spawn({});
      assert.ok(a && b);

      const done = manager.shutdown();
      // both children receive SIGTERM (first strike)
      for (const child of spawned) {
        assert.deepEqual(child.kill.mock.calls.at(-1), ["SIGTERM"]);
      }
      // fakes never emit exit → SIGKILL fallback (second strike)
      await vi.advanceTimersByTimeAsync(5000);
      await done;

      for (const child of spawned) {
        const signals = child.kill.mock.calls.map((c) => c[0]);
        assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      }
      // buffer cleared after shutdown → not_found
      assert.deepEqual(manager.queryBuffer(a), { status: "not_found" });
      assert.deepEqual(manager.queryBuffer(b), { status: "not_found" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("children that exit on SIGTERM → no SIGKILL fallback", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({});
      const done = manager.shutdown();
      // child exits synchronously after SIGTERM (emit exit)
      spawned[0]!.emit("exit", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM"]);
      assert.deepEqual(manager.queryBuffer(taskId), { status: "not_found" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pending waitFor is rejected by shutdown (SC16 no hang)", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = makeHarness();
      const { taskId } = manager.spawn({});
      const pending = manager.waitFor(taskId, 60000);
      // attach the rejection handler up front so shutdown's active reject does not surface as unhandledRejection
      const rejected = assert.rejects(pending, SubAgentWaitTimeoutError);
      const done = manager.shutdown();
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── fixture 9:drainCompleted ──────────────────────────────────────────────────

describe("SubAgentManager drainCompleted (T7 host-drain 最小枚举)", () => {
  it("lists only completed tasks; running and failed absent", () => {
    const { manager, spawned } = makeHarness();
    const doneTask = manager.spawn({}).taskId;
    emitEnvelope(spawned[0]!, okEnvelope("done"));
    const runningTask = manager.spawn({}).taskId;
    const failedTask = manager.spawn({}).taskId;
    spawned[2]!.emit("exit", 1, null);

    const drained = manager.drainCompleted();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]!.taskId, doneTask);
    assert.equal(drained[0]!.envelope.status, "ok");
    // no state mutation (host drain is a read): re-enumeration yields the same result
    const drained2 = manager.drainCompleted();
    assert.equal(drained2.length, 1);
    assert.equal(drained2[0]!.taskId, doneTask);
    // running / failed absent
    assert.ok(!drained.some((d) => d.taskId === runningTask));
    assert.ok(!drained.some((d) => d.taskId === failedTask));
  });

  it("excludeFromHostDrain=true completed 任务不进 drainCompleted", () => {
    const { manager, spawned, spawnCalls } = makeHarness();
    const hidden = manager.spawn({ excludeFromHostDrain: true }).taskId;
    emitEnvelope(spawned[0]!, okEnvelope("judge abort json"));
    const visible = manager.spawn({}).taskId;
    emitEnvelope(spawned[1]!, okEnvelope("user subagent"));

    assert.equal(
      "excludeFromHostDrain" in spawnCalls[0]!.payload,
      false,
      "excludeFromHostDrain is parent-only; must not land on WorkerEnvelope"
    );

    const drained = manager.drainCompleted();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]!.taskId, visible);
    assert.ok(!drained.some((d) => d.taskId === hidden));
  });

  it("excludeFromHostDrain 与 role 并存：payload 只拷 role", () => {
    const { manager, spawned, spawnCalls } = makeHarness();
    manager.spawn({ role: "explore", excludeFromHostDrain: true });
    emitEnvelope(spawned[0]!, okEnvelope("hidden explore"));
    assert.equal(spawnCalls[0]!.payload.role, "explore");
    assert.equal("excludeFromHostDrain" in spawnCalls[0]!.payload, false);
    assert.equal(manager.drainCompleted().length, 0);
  });
});

// ── fixture 11: abortTask ──────────────────────────────────────────────────────

describe("SubAgentManager abortTask (#361 T5)", () => {
  it("running task → SIGTERM 一次(arm SIGKILL 兜底复用同一 armKillFallback 路径)", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    // initially running
    assert.deepEqual(manager.queryBuffer(taskId), { status: "running" });

    const ok = manager.abortTask(taskId);
    assert.equal(ok, true);
    // first strike: SIGTERM
    const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
    assert.deepEqual(signals, ["SIGTERM"]);
  });

  it("arm SIGKILL 兜底:fake child 不退出 → 5s 后 SIGKILL 强杀", async () => {
    vi.useFakeTimers();
    try {
      const { manager, spawned } = makeHarness();
      const { taskId } = manager.spawn({});
      manager.abortTask(taskId);
      // after 5s killFallback sends the SIGKILL safety net
      await vi.advanceTimersByTimeAsync(5000);
      const signals = spawned[0]!.kill.mock.calls.map((c) => c[0]);
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      // keep later spawns from leaving a stray timer
      spawned[0]!.stderr.end();
      spawned[0]!.emit("exit", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(500);
      await manager.shutdown();
    } finally {
      vi.useRealTimers();
    }
  }, 10000);

  it("running task → abortCtrl 已 abort(传播到 in-flight)", () => {
    const { manager } = makeHarness();
    const { taskId } = manager.spawn({});
    manager.abortTask(taskId);
    // no direct assertion surface: ensure no throw and the state stays running (buffer unchanged, awaiting the exit handler).
    assert.deepEqual(manager.queryBuffer(taskId), { status: "running" });
  });

  it("未知 taskId → no-op 返回 false", () => {
    const { manager } = makeHarness();
    assert.equal(manager.abortTask("nope"), false);
  });

  // ── an operator kill must settle this task's in-flight waitFor ──────────────
  it("SC14: in-flight waitFor → abortTask 以 SubAgentAbortError 拒绝(非 WaitTimeout)", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    const pending = manager.waitFor(taskId, 60000);
    const rejected = assert.rejects(pending, (err: unknown) => {
      assert.ok(
        err instanceof SubAgentAbortError,
        `expected SubAgentAbortError, got ${String((err as Error)?.name)}`
      );
      assert.equal(err.taskId, taskId);
      assert.ok(!(err instanceof SubAgentWaitTimeoutError));
      return true;
    });
    assert.equal(manager.abortTask(taskId), true);
    await rejected;
    // SIGTERM comes only after the rejection (order contract: settle the parent-side wait first, then kill the worker).
    assert.deepEqual(
      spawned[0]!.kill.mock.calls.map((c) => c[0]),
      ["SIGTERM"]
    );
  });

  it("SC14: abortTask 只拒绝本任务;另一任务的 waitFor 不受影响", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId: victim } = manager.spawn({});
    const { taskId: bystander } = manager.spawn({});
    let bystanderSettled = false;
    const bystanderWait = manager.waitFor(bystander, 60000).finally(() => {
      bystanderSettled = true;
    });
    bystanderWait.catch(() => {});
    const victimWait = assert.rejects(
      manager.waitFor(victim, 60000),
      SubAgentAbortError
    );
    assert.equal(manager.abortTask(victim), true);
    await victimWait;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(bystanderSettled, false, "bystander wait must stay pending");
    // the bystander task stays live: resolves normally once its terminal envelope arrives.
    emitEnvelope(spawned[1]!, okEnvelope("bystander done"));
    assert.equal((await bystanderWait).summary, "done");
    assert.equal(bystanderSettled, true);
  });

  it("SC14: 已 settle 的 waitFor 不再被 abortTask 二次 settle(cleanup 摘除)", async () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    const first = manager.waitFor(taskId, 1000);
    emitEnvelope(spawned[0]!, okEnvelope("early"));
    assert.equal((await first).summary, "done");
    // task already completed → abortTask is a no-op (existing contract), no throw / no second reject.
    assert.equal(manager.abortTask(taskId), false);
  });

  it("SC13 不回归: 真墙钟到期仍是 SubAgentWaitTimeoutError(不是 abort 归因)", async () => {
    const { manager } = makeHarness();
    const { taskId } = manager.spawn({});
    const pending = manager.waitFor(taskId, 50);
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof SubAgentWaitTimeoutError);
      assert.ok(!(err instanceof SubAgentAbortError));
      return true;
    });
  });

  it("已终态(completed)task → no-op 返回 false,不再 SIGTERM", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({});
    emitEnvelope(spawned[0]!, okEnvelope("done"));
    assert.equal(manager.abortTask(taskId), false);
    assert.equal(spawned[0]!.kill.mock.calls.length, 0);
  });
});

// ── fixture 10: SubAgentDefinition local definition typecheck ─────────────────

describe("SubAgentDefinition local definition typecheck", () => {
  it("accepts all optional camelCase fields", () => {
    const def: SubAgentDefinition = {
      systemPrompt: "p",
      disallowedTools: ["spawn_subagent", "edit_file"],
      maxTurns: 5,
      timeoutMs: 30000,
    };
    assert.equal(def.maxTurns, 5);
    assert.equal(def.systemPrompt, "p");
  });

  it("accepts an empty definition (all fields optional)", () => {
    const def: SubAgentDefinition = {};
    assert.equal(def.systemPrompt, undefined);
  });

  it("manager surface exposes the seven-member API", () => {
    const { manager } = makeHarness();
    const api: SubAgentManager = manager;
    assert.equal(typeof api.spawn, "function");
    assert.equal(typeof api.queryBuffer, "function");
    assert.equal(typeof api.waitFor, "function");
    assert.equal(typeof api.shutdown, "function");
    assert.equal(typeof api.drainCompleted, "function");
    assert.equal(typeof api.listActive, "function");
    // read-only enumeration surface (consumed by Session API endpoints; running/completed/failed unified).
    assert.equal(typeof api.listSubagents, "function");
  });
});

// ── listSubagents (read-only enumeration surface, consumed by Session API endpoints) ────

describe("SubAgentManager listSubagents (#358 T7)", () => {
  it("空管理面 → 返回空数组", () => {
    const { manager } = makeHarness();
    const items = manager.listSubagents();
    assert.equal(items.length, 0);
  });

  it("completed 任务 → taskId/state/startedAt/taskPreview/endedAt/summary 齐全", () => {
    const { manager, spawned } = makeHarness();
    const { taskId } = manager.spawn({
      task: "第一个任务提示词".repeat(40),
    });
    emitEnvelope(spawned[0]!, okEnvelope("r"));
    const items = manager.listSubagents();
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.taskId, taskId);
    assert.equal(item.state, "completed");
    assert.equal(typeof item.startedAt, "string");
    // permission row: taskPreview is truncated to ≤120, never the full task text.
    assert.ok(item.taskPreview.length <= 120);
    assert.equal(item.taskPreview, "第一个任务提示词".repeat(40).slice(0, 120));
    // Postel: completed always carries endedAt + summary.
    assert.equal(typeof item.endedAt, "string");
    assert.equal(item.summary, "done");
    assert.equal(item.reason, undefined);
  });

  it("failed 任务 → state=failed + reason + summary (Postel: endedAt 必在)", async () => {
    const { manager, spawned } = makeHarness();
    const taskId = manager.spawn({ task: "explore the repo" }).taskId;
    await emitCrashAndWait(manager, spawned[0]!, taskId, 1, null);
    const items = manager.listSubagents();
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.state, "failed");
    assert.equal(item.reason, "crashed");
    assert.match(item.summary!, /worker exit code=1 signal=null/);
    assert.equal(typeof item.endedAt, "string");
  });

  it("running 任务 → Postel: endedAt/summary/reason 全缺席 (仅必备四字段)", () => {
    const { manager } = makeHarness();
    manager.spawn({ task: "long running" });
    const items = manager.listSubagents();
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.state, "running");
    assert.equal(item.endedAt, undefined);
    assert.equal(item.summary, undefined);
    assert.equal(item.reason, undefined);
    assert.equal(item.role, undefined);
  });

  it("spawn 带 role → listSubagents 投影 role（TUI 行首名称）", () => {
    const { manager } = makeHarness();
    manager.spawn({ task: "look around", role: "explore" });
    const items = manager.listSubagents();
    assert.equal(items[0]!.role, "explore");
  });

  it("spawn 带 toolUseId → listSubagents 投影 toolUseId（spawn 卡 join 键）", () => {
    const { manager } = makeHarness();
    manager.spawn({ task: "look around", toolUseId: "toolu_x" });
    const items = manager.listSubagents();
    assert.equal(items.length, 1);
    assert.equal(items[0]!.toolUseId, "toolu_x");
  });

  it("toolUseId 缺席或空串 → 字段整个省略（Postel：缺席即不在场，不是 undefined 值）", () => {
    const { manager } = makeHarness();
    manager.spawn({ task: "no id" });
    manager.spawn({ task: "empty id", toolUseId: "" });
    const items = manager.listSubagents();
    assert.equal(items.length, 2);
    // ask / direct-handler / test-injected spawns carry no toolUseId: the key is absent, not an undefined value.
    assert.equal("toolUseId" in items[0]!, false);
    assert.equal("toolUseId" in items[1]!, false);
  });

  it("conversationId 过滤后 toolUseId 随各自任务透出（不串台）", () => {
    const { manager } = makeHarness();
    const sessionATask = manager.spawn({
      task: "session A",
      conversationId: "session-a",
      toolUseId: "toolu_a",
    }).taskId;
    const sessionBTask = manager.spawn({
      task: "session B",
      conversationId: "session-b",
      toolUseId: "toolu_b",
    }).taskId;

    const a = manager.listSubagents("session-a");
    assert.deepEqual(
      a.map(({ taskId }) => taskId),
      [sessionATask]
    );
    assert.equal(a[0]!.toolUseId, "toolu_a");

    const b = manager.listSubagents("session-b");
    assert.deepEqual(
      b.map(({ taskId }) => taskId),
      [sessionBTask]
    );
    assert.equal(b[0]!.toolUseId, "toolu_b");
  });

  it("task 缺席 → taskPreview 为空串 (回退不落全文)", () => {
    const { manager } = makeHarness();
    manager.spawn({});
    const items = manager.listSubagents();
    assert.equal(items[0]!.taskPreview, "");
  });

  it("completed + failed + running 混合 → 返回全部三项 (每项 snapshot 只读)", async () => {
    const { manager, spawned, spawnCalls } = makeHarness();
    manager.spawn({ task: "completed-task" }); // 0
    const failedTask = manager.spawn({ task: "failed-task" }).taskId; // 1
    manager.spawn({ task: "running-task" }); // 2
    emitEnvelope(spawned[0]!, okEnvelope("done"));
    await emitCrashAndWait(manager, spawned[1]!, failedTask, 1, null);
    assert.equal(spawnCalls.length, 3);
    const items = manager.listSubagents();
    assert.equal(items.length, 3);
    const byState = Object.fromEntries(items.map((i) => [i.state, i]));
    assert.equal(byState["completed"]!.taskPreview, "completed-task");
    assert.equal(byState["failed"]!.taskPreview, "failed-task");
    assert.equal(byState["running"]!.taskPreview, "running-task");
  });

  it("按父 conversationId 过滤列表与终态订阅", () => {
    const { manager, spawned } = makeHarness();
    const notices: string[] = [];
    manager.subscribe((notice) => {
      notices.push(notice.taskId);
    }, "session-a");
    const sessionATask = manager.spawn({
      task: "session A",
      conversationId: "session-a",
    }).taskId;
    const sessionBTask = manager.spawn({
      task: "session B",
      conversationId: "session-b",
    }).taskId;

    emitEnvelope(spawned[0]!, okEnvelope("A result"));
    emitEnvelope(spawned[1]!, okEnvelope("B result"));

    assert.deepEqual(
      manager.listSubagents("session-a").map(({ taskId }) => taskId),
      [sessionATask]
    );
    assert.deepEqual(
      manager.listSubagents("session-b").map(({ taskId }) => taskId),
      [sessionBTask]
    );
    assert.deepEqual(notices, [sessionATask]);
  });
});
