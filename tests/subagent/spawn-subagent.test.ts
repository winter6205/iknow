/**
 * spawn_subagent ACI tool unit tests (fake SubAgentManager, no real child process).
 *
 * Coverage:
 *   1. wait:false → handler resolves to {task_id} JSON, manager.spawn called once
 *   2. wait:true (default) → handler resolves to envelope (fake waitFor resolves immediately)
 *   3. background:true → throws ToolExecutionError, message contains "background:true"
 *   4. task missing / task:123 (non-string) / empty task / null input → ToolExecutionError
 *   5. disallowedTools / systemPrompt / model / maxTurns / timeoutMs pass-through to def
 *   6. wait:false → waitFor not called
 *   7. aci metadata (timeoutTier=unbounded — ACI must not preempt manager's per-task clock)
 *   8. subagent_type optional param → def.role pass-through (default = general-purpose)
 *   9. inputSchema.subagent_type enum = catalog ids (derived at runtime)
 *  10. description contains the prose list (catalog entries)
 *
 * Extra fields {task:"x", foo:"bar"} strictness is enforced by the registry's ajv
 * strict validation (createAciRegistry compiles inputSchema with
 * additionalProperties:false); the tool handler receives already-validated input —
 * not re-tested here.
 *
 * Catalog hermeticity: the factory default resolver = merged catalog (builtin +
 * `~/.iknow/agents/` user roles, default path contract). Asserting enum / prose
 * list equals builtin against the real home would drift with whatever user roles
 * the runner has installed; beforeEach points HOME at an empty tmp dir
 * (`os.homedir()` reads `$HOME`), so the default path is always pure builtin.
 * The merged-default proof lives in tests/subagent/user-agents-wiring.test.ts
 * (independent of real home).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import {
  createSpawnSubAgentTool,
  SPAWN_DISPATCH_LESSON,
  SPAWN_DISPATCH_LESSON_CONCURRENCY_PATTERN,
} from "../../src/harness/subagent/spawn-subagent-tool.ts";
import type { SubAgentDefinition } from "../../src/harness/subagent/manager.ts";
import type {
  QueryBufferResult,
  SubAgentManager,
} from "../../src/harness/subagent/manager.ts";
import {
  PER_TASK_TIMEOUT_MS,
  SubAgentAbortError,
  SubAgentCapacityError,
  SubAgentWaitTimeoutError,
  createSubagentCapacityHolder,
} from "../../src/harness/subagent/manager.ts";
import { DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS } from "../../src/config/settings.ts";
import { TIMEOUT_TIER_MS } from "../../src/harness/aci/types.ts";
import { ToolExecutionError } from "../../src/harness/errors.ts";
import {
  resolveAgentCatalog,
  getAgentEntry,
} from "../../src/harness/subagent/catalog.ts";
import { FILE_WRITE_TOOL_NAMES } from "../../src/harness/subagent/catalog.ts";
import { resetUserAgentsCache } from "../../src/harness/subagent/user-catalog.ts";

/**
 * Catalog-hermeticity fixture: HOME points at an empty tmp dir for the whole file.
 *
 * The factory default resolver = merged catalog (builtin + user roles under home);
 * real `~/.iknow/agents/` content would leak into enum / prose-list assertions.
 * An empty HOME keeps the default path pure builtin (dir ENOENT → empty user set,
 * see user-catalog.ts). `resetUserAgentsCache()` must be called after switching
 * HOME: the merged result is memoized per resolved agentsDir, and without clearing
 * the cache we would read the previous HOME's scan.
 */
let savedHome: string | undefined;
let hermeticHome: string;

function emptyHermeticHome(): void {
  savedHome = process.env.HOME;
  hermeticHome = mkdtempSync(join(tmpdir(), "iknow-spawn-tool-home-"));
  process.env.HOME = hermeticHome;
  // user roles from the real home may already be memoized by earlier scans in this process; rescan after HOME switch
  resetUserAgentsCache();
}

beforeEach(() => {
  emptyHermeticHome();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(hermeticHome, { recursive: true, force: true });
  // cache keys are tmp agentsDirs used by this file; clear to avoid polluting other test files in-process
  resetUserAgentsCache();
});

/** ajv instance (same repo config: strict + allErrors + formats) — compiles inputSchema in tests. */
function makeAjv(): Ajv.default {
  const ajv = new Ajv.default({ strict: true, allErrors: true });
  addFormats.default(ajv);
  return ajv;
}

/** fake manager: spawn returns a fixed taskId + records the def argument (spy); other members are stubs. */
function makeFakeManager() {
  const spawn = vi.fn(
    (_def: SubAgentDefinition): { readonly taskId: string } => ({
      taskId: "fixed-task-id-1",
    })
  );
  const waitFor = vi.fn(
    async (): Promise<{ status: "ok"; summary: string; result: string }> => ({
      status: "ok",
      summary: "from-fake",
      result: "fake-result",
    })
  );
  const manager: SubAgentManager = {
    spawn,
    queryBuffer: () => ({ status: "not_found" }) as const,
    waitFor,
    shutdown: () => Promise.resolve(),
    drainCompleted: () => [],
    listActive: () => [],
    abortTask: () => false,
    // interface gained a read-only enumeration surface — fake fills it in for structural compatibility.
    listSubagents: () => [],
    // ADR-0096: the spawn_subagent tool description getter reads capacity.
    // Test fake without holder → falls back to manager.getCapacity(); static 15
    // here shares its source with DEFAULT, keeping description assertions aligned.
    getCapacity: () => DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS,
  };
  return { manager, spawn, waitFor };
}

describe("spawn_subagent — 正常路径", () => {
  it("wait:false → 返回 JSON {task_id},manager.spawn 被调一次,传入 def 含 task", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const out = await tool.handler({ task: "explore the repo", wait: false });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "explore the repo" })
    );
    expect(out).toBe(JSON.stringify({ task_id: "fixed-task-id-1" }));
  });

  // Foreground contract (old sync ≤50ms assertion removed; exclusive with the wait:true default).
  it("wait:true(默认)handler 解析为 envelope (foreground contract)", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    // Foreground arm tool_result = envelope (object returned directly; executor's 20000-char truncation is reused naturally).
    const out = await tool.handler({ task: "wait-me" });
    const parsed = out as { status: string; summary: string; result: string };
    expect(parsed.status).toBe("ok");
    expect(parsed.summary).toBe("from-fake");
    expect(parsed.result).toBe("from-fake");
    expect(parsed.result).not.toBe("fake-result");
  });

  it("wait:false → waitFor 不被调用", async () => {
    const { manager, waitFor } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "async-arm", wait: false });
    expect(waitFor).not.toHaveBeenCalled();
  });
});

describe("spawn_subagent — 非法输入(抛 ToolExecutionError)", () => {
  it("background:true → message 含 'background:true'", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await expect(tool.handler({ task: "t", background: true })).rejects.toThrow(
      ToolExecutionError
    );
    await expect(tool.handler({ task: "t", background: true })).rejects.toThrow(
      /background:true/
    );
  });

  it("task 缺失 → message 含 'missing or invalid'", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await expect(tool.handler({})).rejects.toThrow(ToolExecutionError);
    await expect(tool.handler({})).rejects.toThrow(/missing or invalid/);
  });

  it("task:123（非 string）→ 抛", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await expect(tool.handler({ task: 123 })).rejects.toThrow(
      ToolExecutionError
    );
    await expect(tool.handler({ task: 123 })).rejects.toThrow(
      /missing or invalid/
    );
  });

  it("task 空串 → 抛", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await expect(tool.handler({ task: "" })).rejects.toThrow(
      ToolExecutionError
    );
  });

  it("input 为 null → 按空对象处理,抛 missing task", async () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await expect(tool.handler(null)).rejects.toThrow(ToolExecutionError);
  });
});

describe("spawn_subagent — 可选字段透传到 def", () => {
  it("disallowedTools 数组透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "t",
      disallowedTools: ["edit_file", "write_file"],
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "t",
        disallowedTools: ["edit_file", "write_file"],
      })
    );
  });

  it("systemPrompt 字符串透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "t",
      systemPrompt: "be a verifier",
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", systemPrompt: "be a verifier" })
    );
  });

  it("model 字符串透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", model: "opus", wait: false });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", model: "opus" })
    );
  });

  it("maxTurns 整数透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", maxTurns: 5, wait: false });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", maxTurns: 5 })
    );
  });

  it("timeoutMs 整数透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", timeoutMs: 60000, wait: false });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", timeoutMs: 60000 })
    );
  });

  it("timeoutMs 缺席 → def 省略该字段 (manager 三层链 def ?? taskTimeoutMs ?? 7200s 接管)", async () => {
    // When the model omits timeoutMs, the handler must not stuff a constant into
    // def.timeoutMs — otherwise the chain's middle env.subagent.taskTimeoutMs is
    // always overridden and becomes dead code. Assert def.timeoutMs is undefined
    // (spawn receives a def without the field; manager-side effectiveTaskTimeoutMs
    // decides the SIGTERM / waitFor default).
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", wait: false });
    const calledDef = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(calledDef.timeoutMs).toBeUndefined();
  });

  it("全字段组合透传(含默认缺省)", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "t",
      systemPrompt: "be concise",
      disallowedTools: ["spawn_subagent"],
      model: "opus",
      maxTurns: 7,
      timeoutMs: 90000,
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "t",
        systemPrompt: "be concise",
        disallowedTools: ["spawn_subagent"],
        model: "opus",
        maxTurns: 7,
        timeoutMs: 90000,
      })
    );
  });

  it("#357 T1: sandboxRoot 字符串透传到 def", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "t",
      sandboxRoot: "/tmp/work",
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", sandboxRoot: "/tmp/work" })
    );
  });

  it("T5 SC8: ctx.toolUseId → def.toolUseId (Anthropic tool_use_id 透传, manager 抄到 .meta.json)", async () => {
    // ADR-0071: executor puts call.id into ctx.toolUseId; the spawn_subagent
    // handler consumes it into def.toolUseId, and manager.writeMetaOnce copies it
    // into the toolUseId field of `<subagentsDir>/agent-<taskId>.meta.json`
    // for reverse lookup of the parent loop's tool call.
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler(
      { task: "t", wait: false },
      { toolUseId: "toolu_wire_abc" }
    );
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "t", toolUseId: "toolu_wire_abc" })
    );
  });

  it("T5 SC8: ctx 不带 toolUseId (ask / worker / 直调 handler) → def 整字段省略 (Postel)", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", wait: false });
    const calledDef = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(calledDef.toolUseId).toBeUndefined();
  });
});

describe("spawn_subagent — AciToolDef 元数据", () => {
  it("name = spawn_subagent,aci read-only/long/cancel/concurrencySafe", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    expect(tool.name).toBe("spawn_subagent");
    expect(tool.aci.category).toBe("read-only");
    // Foreground-arm lifetime belongs to the manager's per-task clock; ACI
    // unbounded=0 avoids long(30min) early abort (long < PER_TASK_TIMEOUT_MS would cut real tasks).
    expect(tool.aci.timeoutTier).toBe("unbounded");
    expect(TIMEOUT_TIER_MS[tool.aci.timeoutTier]).toBe(0);
    expect(TIMEOUT_TIER_MS.long).toBeLessThan(PER_TASK_TIMEOUT_MS);
    expect(tool.aci.interruptBehavior).toBe("cancel");
    expect(tool.aci.isConcurrencySafe).toBe(true);
    expect(tool.aci.lazy).toBe(false);
  });

  it("inputSchema 冻结:required=['task'],additionalProperties:false", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type: string }>;
    };
    expect(schema.required).toEqual(["task"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(schema.properties.timeoutMs).toBeDefined();
    expect(schema.properties.timeoutMs.type).toBe("integer");
    const timeoutDesc = (
      tool.inputSchema as {
        properties: Record<string, { description?: string }>;
      }
    ).properties.timeoutMs.description;
    expect(timeoutDesc).not.toMatch(/5\s*min/i);
    expect(timeoutDesc).toMatch(/2\s*h/i);
  });

  it("wait schema describes terminal wake as the async completion path", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    const waitDescription = schema.properties.wait?.description ?? "";

    expect(waitDescription).toMatch(/terminal completion/i);
    expect(waitDescription).toMatch(/silent run/i);
    expect(waitDescription).toMatch(/explicit status query/i);
    expect(waitDescription).not.toMatch(/poll with subagent_result/i);
  });

  it("#357 T1: inputSchema 含 sandboxRoot 字段(string,可选)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as {
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
    expect(schema.properties.sandboxRoot).toBeDefined();
    expect(schema.properties.sandboxRoot.type).toBe("string");
    // not in required (optional)
    expect(schema.required).not.toContain("sandboxRoot");
  });
});

describe("spawn_subagent — #357 T1: SubAgentSandboxRootError → ToolExecutionError", () => {
  it("manager.spawn 抛 SubAgentSandboxRootError → handler 转 ToolExecutionError", async () => {
    const { SubAgentSandboxRootError } =
      await import("../../src/harness/errors.ts");
    const { manager, spawn } = makeFakeManager();
    // make spawn throw the typed error every time (mockImplementationOnce would only
    // cover the first call; use mockImplementation so both handler calls are covered).
    spawn.mockImplementation(() => {
      throw new SubAgentSandboxRootError({
        parentSandboxRoot: "/parent",
        requested: "/outside",
      });
    });
    const tool = createSpawnSubAgentTool({ manager });
    await expect(
      tool.handler({ task: "t", sandboxRoot: "/outside", wait: false })
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler({ task: "t", sandboxRoot: "/outside", wait: false })
    ).rejects.toThrow(/sandboxRoot/i);
  });
});

/**
 * spawn_subagent.description = the tool-usage SSOT.
 * Topics: when to dispatch, blocking vs parallel, wait:false, short handoff and
 * capacity. Nesting policy is intentionally absent (prohibition is enforced by
 * code, not advertised in the description).
 */
describe("spawn_subagent description — 工具用法 SSOT (T1 #557)", () => {
  const fixtureManager = (): SubAgentManager => makeFakeManager().manager;
  let description: string;
  beforeEach(() => {
    // beforeEach (not beforeAll): the HOME-hermeticity fixture takes effect in
    // beforeEach; beforeAll would run earlier and read user-role prose from the real home.
    description = createSpawnSubAgentTool({
      manager: fixtureManager(),
    }).description;
  });

  it("写入 5 主题：何时用 / 默认阻塞 / 独立并行 / wait:false 轮询 / 短交差与容量", () => {
    // 1. when to use: multi-step exploration / independent verification / parallelizable work → dispatch sub-agent
    expect(description).toMatch(/multi-step exploration/);
    expect(description).toMatch(/independent verification/);
    expect(description).toMatch(/parallelizable work/);
    // 2. blocking by default: wait:true → blocks until sub-agent finishes; default wall clock = 2h (PER_TASK), overridable via timeoutMs. Never mention 5 min (would induce the model to pass 300000).
    expect(description).toMatch(/wait[:\s]*true/i);
    expect(description).toMatch(/blocks? until/i);
    expect(description).toMatch(/parent-visible short handoff/i);
    expect(description).not.toMatch(/5\s*min/i);
    expect(description).toMatch(/2\s*h(?:ours?)?/i);
    expect(description).toMatch(/timeoutMs/i);
    // 3. parallel: multiple spawn_subagent calls in one turn only for independent, self-contained tasks
    expect(description).toMatch(/multiple.*spawn_subagent/s);
    expect(description).toMatch(/one (?:single )?turn/i);
    expect(description).toMatch(/parallel/i);
    expect(description).toMatch(/independent/i);
    expect(description).toMatch(/self-contained/i);
    // 4. wait:false → returns {task_id} immediately, poll with subagent_result
    expect(description).toMatch(/wait[:\s]*false/i);
    expect(description).toMatch(/task_id/i);
    expect(description).toMatch(/subagent_result/i);
    // 5. parent-visible short handoff and capacity: summary / paths / status / stop_reason; over limit is not queued
    expect(description).toMatch(/summary/i);
    expect(description).toMatch(/paths?/i);
    expect(description).toMatch(/status/i);
    expect(description).toMatch(/stop[_ ]reason/i);
    expect(description).toMatch(
      new RegExp(String(DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS))
    );
    expect(description).toMatch(/at capacity/i);
    expect(description).toMatch(/reduce concurrency/i);
    expect(description).toMatch(/not queued|rather than queued/i);
    expect(description).toMatch(/general-purpose/);
    // T2 / spec Layer 2 item 5 (SC2): the omit arm must say outright that
    // omitting routes to general-purpose (the writable default) and that
    // `explore` is the read-only type you must ask for explicitly. A model
    // that reads only the tool description must not infer "no type = minimal
    // capability" — that inverts the contract.
    expect(description).toMatch(/omit/i);
    expect(description).toMatch(/general-purpose/);
    expect(description).toMatch(/explore/i);
    expect(description).toMatch(/read-only|readonly/i);
    expect(description).not.toMatch(/sole ground truth|ground truth/i);
    expect(description).not.toMatch(/full result envelope/i);
    // Invariant: the description must not advertise "forking the conversation" or
    // "per-worker worktree" as spawn capabilities — the tool has no fork mode, no
    // worktree param, no per-worker tree selection (schema assertions below).
    // `create-worktree` is another tool's name (the dispatch lesson requires
    // building the tree before mutating files) and is the only allowed mention:
    // word forms are banned at word boundaries, so any other fork/worktree usage
    // counts as false advertising.
    expect(description).not.toMatch(
      /(?<!create-)\b(?:fork(?:s|ed|ing)?|worktrees?)\b/i
    );
    // No fork-style routing parameter exists in the schema either.
    const lessonTool = createSpawnSubAgentTool({
      manager: fixtureManager(),
    });
    expect(
      Object.keys(
        (lessonTool.inputSchema as { properties: Record<string, unknown> })
          .properties
      )
    ).not.toContain("fork");
  });

  it("wait:false → chat/tui/serve rely on terminal wake, not polling, while wait:true wording stays blocking", () => {
    const waitFalseStart = description.indexOf("Pass `wait:false`");
    const capacityStart = description.indexOf("At most", waitFalseStart);
    const waitFalseGuidance = description.slice(waitFalseStart, capacityStart);

    expect(waitFalseGuidance).toMatch(/mailbox/i);
    expect(waitFalseGuidance).toMatch(/subscribe/i);
    expect(waitFalseGuidance).toMatch(/silent run/i);
    expect(waitFalseGuidance).toMatch(/chat\/tui\/serve/i);
    expect(waitFalseGuidance).toMatch(/primary completion path/i);
    expect(waitFalseGuidance).not.toMatch(/poll later/i);
    expect(description).toContain(
      "Default `wait:true` — the call blocks until the sub-agent finishes"
    );
  });

  it("携带 dispatch lesson：explore 先行 / 并发纪律 / 隔离先 create-worktree / 查 skill catalog", () => {
    // Spec Layer 1 item 1 + SC4: the lesson lives on THIS description — the
    // surface the model reads at the moment it decides whether to dispatch —
    // and carries the four operator disciplines. The SSOT is the module
    // constant: the description must embed it verbatim (a re-typed copy can
    // drift), and the concurrency clause is judged on its semantics below.
    const lessonStart = description.indexOf(SPAWN_DISPATCH_LESSON);
    expect(lessonStart).toBeGreaterThan(-1);
    const lesson = description.slice(lessonStart);

    // 1. explore first — read-only reconnaissance before any edit
    expect(lesson).toMatch(/explore/i);
    expect(lesson).toMatch(/before/i);
    // 2. operator concurrency discipline: an explicit ceiling stated together
    //    with concurrent/workers semantics (the enforced cap above is a
    //    separate sentence and is untouched by the lesson)
    expect(lesson).toMatch(SPAWN_DISPATCH_LESSON_CONCURRENCY_PATTERN);
    // 3. isolation: create the tree before dispatching mutating work
    expect(lesson).toContain("create-worktree");
    // 4. skills come from the catalog rather than improvised procedure
    expect(lesson).toMatch(/skill catalog/i);
  });

  it("不写入嵌套政策(nested / one level / caps at 等措辞)", () => {
    // nesting prohibition is enforced by code; the description must not pose as a semantic-level SSOT for it
    expect(description).not.toMatch(/nested/i);
    expect(description).not.toMatch(/one level/i);
    expect(description).not.toMatch(/caps at/i);
  });

  // ADR-0096 ── description reflects the current cap dynamically (holder.get() read live).
  // The existing "5 topics" description SSOT is unchanged — only the N segment moved
  // from a static literal to a getter; the per-topic assertions + dispatch lesson +
  // omit → general-purpose path still hit (those fixed segments do not depend on N).
  // Only the N segment's dynamism is asserted here.
  it('description 段含当前 holder N：holder.set(7) → description 含 "At most 7"', () => {
    const fixtureManager = (): SubAgentManager => makeFakeManager().manager;
    const holder = createSubagentCapacityHolder(7);
    const desc = createSpawnSubAgentTool({
      manager: fixtureManager(),
      capacityHolder: holder,
    }).description;
    expect(desc).toMatch(/At most 7 workers run simultaneously/);
    // all existing 5-topic assertions still hit (5 min banned + 2 hours default + etc.)
    // — locking the "N dynamic vs other segments static" boundary.
    expect(desc).toMatch(/multi-step exploration/);
    expect(desc).toMatch(/summary/i);
    expect(desc).not.toMatch(/5\s*min/i);
    expect(desc).toMatch(/2\s*h/i);
  });

  it('description 段含当前 holder N：holder.set("unlimited") → description 含 unlimited 文案', () => {
    const fixtureManager = (): SubAgentManager => makeFakeManager().manager;
    const holder = createSubagentCapacityHolder("unlimited");
    const desc = createSpawnSubAgentTool({
      manager: fixtureManager(),
      capacityHolder: holder,
    }).description;
    // unlimited form → no "At most N"; the unlimited wording appears
    expect(desc).toMatch(/Concurrency cap is unlimited/);
    expect(desc).toMatch(/OS \/ memory budget/);
    expect(desc).not.toMatch(/At most \d+ workers/);
    // 5 topics unchanged + dispatch lesson still present
    expect(desc).toMatch(/multi-step exploration/);
    expect(desc.indexOf(SPAWN_DISPATCH_LESSON)).toBeGreaterThan(-1);
  });

  it("description holder.set 后即时反映（不冻结旧值）", () => {
    const fixtureManager = (): SubAgentManager => makeFakeManager().manager;
    const holder = createSubagentCapacityHolder(3);
    const tool = createSpawnSubAgentTool({
      manager: fixtureManager(),
      capacityHolder: holder,
    });
    const beforeFlip = tool.description;
    expect(beforeFlip).toMatch(/At most 3 workers/);
    holder.set(11);
    const afterFlip = tool.description;
    expect(afterFlip).toMatch(/At most 11 workers/);
    // Object.freeze still holds (accessor is locked, cannot be wholesale replaced)
    expect(Object.isFrozen(tool)).toBe(true);
  });

  it("holder 缺席 → 退化到 manager.getCapacity()（既有装配路径）", () => {
    // Assembly-time direct-manager construction (manager.test.ts makeHarness shape):
    // factory without holder → readCapacity() takes the manager.getCapacity() branch.
    const { manager } = makeFakeManager();
    const desc = createSpawnSubAgentTool({ manager }).description;
    // fake manager.getCapacity() = DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS
    expect(desc).toMatch(
      new RegExp(`At most ${DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS} workers`)
    );
  });
});

/**
 * subagent_type param + ajv enum (derived from catalog ids) +
 * handler mapping → def.role.
 *
 * Defensive contract:
 *   - subagent_type omitted → def.role = general-purpose (equivalent to explicit general-purpose)
 *   - subagent_type known → def.role passed through explicitly → manager.buildWorkerPayload →
 *     envelope.role → worker injects the catalog body persona section
 *   - ajv enum = catalog id list (derived at runtime via resolveAgentCatalog)
 *   - unknown subagent_type → ajv fail-fast (rejected before the handler entry point)
 *   - description prose-list section: intro + one `name: description` line per entry
 */
describe("spawn_subagent — #556 T3 subagent_type 参数 + ajv enum", () => {
  it("inputSchema.subagent_type 字段存在 (string + enum = catalog ids 派生)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as {
      properties: Record<
        string,
        { type: string; enum?: ReadonlyArray<string>; description?: string }
      >;
      required: string[];
    };
    const subagentType = schema.properties.subagent_type;
    expect(subagentType).toBeDefined();
    expect(subagentType.type).toBe("string");
    // enum derived from catalog ids (no hardcoded literal at runtime)
    const expected = resolveAgentCatalog().map((e) => e.id);
    expect(subagentType.enum).toBeDefined();
    expect([...subagentType.enum!]).toEqual(expected);
    // T2 / spec Layer 2 item 5: the per-field description repeats the omit
    // contract where the model actually reads it (schema), not only in the
    // long prose above.
    expect(subagentType.description).toMatch(/omit/i);
    expect(subagentType.description).toMatch(/general-purpose/);
    expect(subagentType.description).toMatch(/explore/i);
    expect(subagentType.description).toMatch(/read-only|readonly/i);
  });

  it("subagent_type 不进 required (可选参数)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as { required: string[] };
    expect(schema.required).not.toContain("subagent_type");
    // required stays exactly ["task"] (V1 baseline preserved)
    expect(schema.required).toEqual(["task"]);
  });

  it("ajv 编译: subagent_type='explore' 通过 strict 校验", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const validate = makeAjv().compile(tool.inputSchema);
    expect(validate({ task: "x", subagent_type: "explore" })).toBe(true);
    expect(validate({ task: "x", subagent_type: "general-purpose" })).toBe(
      true
    );
  });

  it("ajv 编译: subagent_type 未知值被 enum 拒绝 (fail-fast, ajv 入口拦截)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const validate = makeAjv().compile(tool.inputSchema);
    expect(validate({ task: "x", subagent_type: "not_a_real_agent" })).toBe(
      false
    );
    // ajv enum error: instancePath=/subagent_type, keyword="enum",
    // params.allowedValues = catalog ids (ajv rejection reason: not in enum).
    const errs = validate.errors ?? [];
    const enumErr = errs.find(
      (e) =>
        e.instancePath === "/subagent_type" &&
        (e as { keyword?: string }).keyword === "enum"
    );
    expect(enumErr).toBeDefined();
    // params.allowedValues contains catalog ids (derived from SSOT; under empty home = builtin)
    const allowed = (enumErr as { params?: { allowedValues?: unknown } })
      ?.params?.allowedValues;
    expect(allowed).toEqual(resolveAgentCatalog().map((e) => e.id));
  });

  it("ajv 编译: subagent_type 非 string 类型被拒", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const validate = makeAjv().compile(tool.inputSchema);
    expect(validate({ task: "x", subagent_type: 123 })).toBe(false);
    expect(validate({ task: "x", subagent_type: ["explore"] })).toBe(false);
  });

  it("ajv 编译: 缺 subagent_type 仍合法 (optional)", () => {
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const validate = makeAjv().compile(tool.inputSchema);
    expect(validate({ task: "x" })).toBe(true);
  });
});

describe("spawn_subagent — #556 T3 handler: subagent_type → def.role", () => {
  it("subagent_type='explore' → def.role = 'explore' (透传 spawn)", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "explore the repo",
      subagent_type: "explore",
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: "explore the repo", role: "explore" })
    );
  });

  it("subagent_type='general-purpose' → def.role = 'general-purpose'", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "do anything",
      subagent_type: "general-purpose",
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "general-purpose" })
    );
  });

  it("subagent_type 缺省 → def.role = general-purpose", async () => {
    // The default role when subagent_type is omitted must equal explicit
    // general-purpose, so the worker gets persona injection and the full tool surface.
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "no-role", wait: false });
    const calledDef = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(calledDef.role).toBe("general-purpose");
  });

  it("subagent_type 显式传 'general-purpose' 等价于不传", async () => {
    // both invocations must take the general-purpose persona and full tool surface
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({ task: "t", wait: false });
    await tool.handler({
      task: "t",
      subagent_type: "general-purpose",
      wait: false,
    });
    const def1 = spawn.mock.calls[0][0] as SubAgentDefinition;
    const def2 = spawn.mock.calls[1][0] as SubAgentDefinition;
    expect(def1.role).toBe("general-purpose");
    expect(def2.role).toBe("general-purpose");
    expect(def1.disallowedTools).toBeUndefined();
    expect(def2.disallowedTools).toBeUndefined();
  });

  it("subagent_type + 其他字段组合 → 全部透传", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "t",
      subagent_type: "explore",
      systemPrompt: "be focused",
      disallowedTools: ["spawn_subagent"],
      model: "opus",
      maxTurns: 4,
      timeoutMs: 60000,
      sandboxRoot: "/tmp/work",
      wait: false,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "t",
        role: "explore",
        systemPrompt: "be focused",
        // parent disallowedTools are unioned (Set-deduped) with the catalog entry's
        // deny list. explore's catalog default is FILE_WRITE_TOOL_NAMES
        // (edit_file / write_file + 5 symbol-mutate tools); merged with the parent's
        // [spawn_subagent] the length = 1 + FILE_WRITE_TOOL_NAMES.length.
        disallowedTools: expect.arrayContaining([
          "spawn_subagent",
          ...FILE_WRITE_TOOL_NAMES,
        ]),
        model: "opus",
        maxTurns: 4,
        timeoutMs: 60000,
        sandboxRoot: "/tmp/work",
      })
    );
  });
});

describe("spawn_subagent — capacity reject reaches the model as a typed tool error", () => {
  it("manager throwing SubAgentCapacityError → ToolExecutionError carrying active/max", async () => {
    // Spec Layer 3 item 7 / SC3: the model-visible failure must name the
    // active/max pair so the next attempt can lower concurrency instead of
    // retrying blindly. The mapping lives here (manager → tool boundary).
    const { manager, spawn } = makeFakeManager();
    spawn.mockImplementation(() => {
      throw new SubAgentCapacityError(3, 3);
    });
    const tool = createSpawnSubAgentTool({ manager });

    const error: unknown = await tool
      .handler({ task: "t", wait: false })
      .then(() => undefined)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect((error as Error).message).toMatch(/3\/3/);
  });
});

describe("spawn_subagent — #556 T3 spec-review 收口: catalog disallowedTools merge in wire", () => {
  // A past review High finding: catalog entry.disallowedTools did not flow into
  // the wire, so explore's [edit_file, write_file] deny never reached the worker
  // tool surface. Fix: the handler captures the catalog entry when resolving the
  // role, writes union(parent disallowedTools, catalog entry.disallowedTools)
  // into def.disallowedTools (registry.ts Gate 3 deny-list removes those names
  // from toolsetNames).
  //
  // The catalog deny's extension surface = FILE_WRITE_TOOL_NAMES
  // (edit_file / write_file + 5 symbol-mutate tools). Assertions reference that
  // SSOT directly instead of hardcoding lengths, so extending the SSOT cannot go stale here.

  it("subagent_type='explore' 无 parent disallowedTools → def.disallowedTools = catalog 默认 FILE_WRITE_TOOL_NAMES", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "explore-only",
      subagent_type: "explore",
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.role).toBe("explore");
    expect(def.disallowedTools).toBeDefined();
    expect([...def.disallowedTools!]).toEqual(
      expect.arrayContaining([...FILE_WRITE_TOOL_NAMES])
    );
    expect(def.disallowedTools).toHaveLength(FILE_WRITE_TOOL_NAMES.length);
  });

  it("subagent_type='explore' + parent disallowedTools → union (parent ADD, 不 subtract catalog)", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "explore-with-parent",
      subagent_type: "explore",
      disallowedTools: ["some_extra_tool"],
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.role).toBe("explore");
    expect([...def.disallowedTools!]).toEqual(
      expect.arrayContaining([...FILE_WRITE_TOOL_NAMES, "some_extra_tool"])
    );
    expect(def.disallowedTools).toHaveLength(FILE_WRITE_TOOL_NAMES.length + 1);
  });

  it("subagent_type='explore' + parent 重复 deny 同名 → Set 去重", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "dedupe-check",
      subagent_type: "explore",
      disallowedTools: ["edit_file", "another_tool"], // edit_file already in catalog
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    // edit_file shares the catalog name → counted once; another_tool adds 1.
    expect(def.disallowedTools).toHaveLength(FILE_WRITE_TOOL_NAMES.length + 1);
    expect([...def.disallowedTools!]).toEqual(
      expect.arrayContaining([...FILE_WRITE_TOOL_NAMES, "another_tool"])
    );
  });

  it("subagent_type='general-purpose' 无 catalog denied → def.disallowedTools 缺省 (V1 byte-stable)", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "general",
      subagent_type: "general-purpose",
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.role).toBe("general-purpose");
    expect(def.disallowedTools).toBeUndefined();
  });

  it("subagent_type 不传 + parent disallowedTools → def.disallowedTools = parent", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "v1-baseline",
      disallowedTools: ["some_tool"],
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.role).toBe("general-purpose");
    expect(def.disallowedTools).toEqual(["some_tool"]);
  });

  it("subagent_type 不传 + 无 parent disallowedTools → general-purpose 完整工具面", async () => {
    const { manager, spawn } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    await tool.handler({
      task: "v1-blank",
      wait: false,
    });
    const def = spawn.mock.calls[0][0] as SubAgentDefinition;
    expect(def.role).toBe("general-purpose");
    expect(def.disallowedTools).toBeUndefined();
  });
});

describe("spawn_subagent — #556 T3 deps.catalog (additive, default = builtin)", () => {
  it("未传 catalog → factory 内部 fallback, ajv enum = builtin ids 派生 (空 home 密闭)", () => {
    // dist assembly (registry.ts) does not pass catalog; the factory uses its default.
    // default = merged catalog (builtin + home user roles), so the proposition
    // certified here is "enum derives from builtin catalog ids under the default
    // resolver" — under empty-HOME isolation merged degrades to pure builtin, and
    // the assertion matches the resolveAgentCatalog() derived value.
    // Merged semantics (user additions / builtin kept on name collision) are
    // certified separately in tests/subagent/user-agents-wiring.test.ts + user-catalog.test.ts.
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({ manager });
    const schema = tool.inputSchema as {
      properties: Record<string, { enum?: ReadonlyArray<string> }>;
    };
    expect([...schema.properties.subagent_type.enum!]).toEqual(
      resolveAgentCatalog().map((e) => e.id)
    );
    expect([...schema.properties.subagent_type.enum!]).toEqual([
      "explore",
      "general-purpose",
    ]);
  });

  it("deps.catalog 显式传 fake resolver → ajv enum + prose list 都由 fake 派生", () => {
    // test seam: inject a fake resolver (both list + get faces) to prove the factory
    // really consumes deps.catalog rather than its internal default (factory closure →
    // both list + get consumption faces take effect together).
    const FAKE_ENTRY = {
      id: "fake_agent",
      description: "fake agent for testing",
      body: "fake body",
    };
    const fakeCatalog = {
      list: () => [FAKE_ENTRY] as const,
      get: (id: string) => {
        if (id === "fake_agent") return FAKE_ENTRY;
        throw new Error("unknown " + id);
      },
    };
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({
      manager,
      catalog: fakeCatalog,
    });
    // enum derives from the fake list
    const schema = tool.inputSchema as {
      properties: Record<string, { enum?: ReadonlyArray<string> }>;
    };
    expect([...schema.properties.subagent_type.enum!]).toEqual(["fake_agent"]);
    // prose list contains the fake_agent line
    expect(tool.description).toMatch(
      /-\s*fake_agent\s*:\s*fake agent for testing/
    );
    // builtin 'explore' absent from enum / prose (fake fully replaces it)
    expect([...schema.properties.subagent_type.enum!]).not.toContain("explore");
    expect(tool.description).not.toMatch(/-\s*explore\s*:/);
  });

  it("deps.catalog 接受 resolver 双面形态 (list + get)", () => {
    // Type contract: deps.catalog is an AgentCatalogResolver (two faces: list() returns
    // ReadonlyArray<AgentCatalogEntry>, get(id) returns AgentCatalogEntry).
    // The factory accepts that shape; it need not be frozen like builtinCatalogResolver.
    const fakeCatalog = {
      list: () => resolveAgentCatalog(),
      get: (id: string) => getAgentEntry(id),
    };
    const { manager } = makeFakeManager();
    const tool = createSpawnSubAgentTool({
      manager,
      catalog: fakeCatalog,
    });
    expect(tool.name).toBe("spawn_subagent");
  });
});

describe("spawn_subagent description — #556 T3 prose list 段 (catalog entries)", () => {
  const fixtureManager = (): SubAgentManager => makeFakeManager().manager;
  let description: string;
  beforeEach(() => {
    // same as the previous describe: must run after the HOME-hermeticity fixture takes
    // effect to snapshot the default resolver, else real-home user roles leak into the prose list.
    description = createSpawnSubAgentTool({
      manager: fixtureManager(),
    }).description;
  });

  it("含 'Available subagent types' intro 段", () => {
    expect(description).toMatch(/Available subagent types/i);
  });

  it("每个 catalog entry 一行 `name: description`", () => {
    const catalog = resolveAgentCatalog();
    for (const entry of catalog) {
      const re = new RegExp(
        `-\\s*${entry.id}\\s*:\\s*${entry.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
      );
      expect(description).toMatch(re);
    }
  });

  it("prose list 在原描述之后追加 (不动现有 SSOT 段)", () => {
    // the original description's "Delegate a self-contained task" must still appear
    // before the prose-list section.
    const introIdx = description.indexOf("Delegate a self-contained task");
    const proseIdx = description.indexOf("Available subagent types");
    expect(introIdx).toBeGreaterThanOrEqual(0);
    expect(proseIdx).toBeGreaterThan(introIdx);
  });
});

describe("spawn_subagent — WaitTimeoutError queryBuffer 分流", () => {
  function managerRejectingWait(opts: {
    readonly buffer: QueryBufferResult;
    readonly err: Error;
  }): SubAgentManager {
    const { manager } = makeFakeManager();
    return {
      ...manager,
      queryBuffer: () => opts.buffer,
      waitFor: async () => {
        throw opts.err;
      },
    };
  }

  it("negative: WaitTimeout + not_found → ToolExecutionError（不谎报 timeout envelope）", async () => {
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: { status: "not_found" },
        err: new SubAgentWaitTimeoutError(),
      }),
    });
    await expect(tool.handler({ task: "t", wait: true })).rejects.toThrow(
      ToolExecutionError
    );
    await expect(tool.handler({ task: "t", wait: true })).rejects.toThrow(
      /not found|gone|unknown/i
    );
  });

  it("exception: WaitTimeout + running → ToolExecutionError，不再合成 ok 数据（SC13）", async () => {
    // wall-clock expiry + worker not terminal = no readable handoff; the
    // parent-visible tool result kind must not be ok. message carries taskId + the
    // timeout fact and must not collide with loop-engine's whole-turn stop-reason
    // literals ("cancelled" / "timeout").
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: { status: "running" },
        err: new SubAgentWaitTimeoutError(),
      }),
    });
    let caught: unknown;
    try {
      await tool.handler({ task: "t", wait: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).toContain("fixed-task-id-1");
    expect(message).toContain("wall-clock timeout");
    expect(message).not.toBe("cancelled");
    expect(message).not.toBe("timeout");
  });

  it("exception: 终态信封 reason=timeout（per-task timer 路径）→ 同样非 ok（SC13）", async () => {
    // Second timeout path: manager per-task timer already wrote a failed envelope and
    // waitFor resolved normally — kind must not be ok either (previously only the
    // running branch was watched).
    const tool = createSpawnSubAgentTool({
      manager: {
        ...makeFakeManager().manager,
        waitFor: async () => ({
          status: "failed" as const,
          reason: "timeout" as const,
          summary: "timeout after 600000ms",
          result: "",
        }),
      },
    });
    let caught: unknown;
    try {
      await tool.handler({ task: "t", wait: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    expect((caught as ToolExecutionError).message).toContain(
      "wall-clock timeout"
    );
  });

  it("boundary: 终态信封 reason=crashed → 仍作 ok 数据（SC13 不越界）", async () => {
    const tool = createSpawnSubAgentTool({
      manager: {
        ...makeFakeManager().manager,
        waitFor: async () => ({
          status: "failed" as const,
          reason: "crashed" as const,
          summary: "worker exited with code 3",
          result: "",
        }),
      },
    });
    const out = (await tool.handler({ task: "t", wait: true })) as {
      status: string;
      reason?: string;
    };
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("crashed");
  });

  it("exception: WaitTimeout + failed buffer → 原 reason/summary，不合成", async () => {
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: {
          status: "failed",
          reason: "protocolError",
          summary: "child protocol",
        },
        err: new SubAgentWaitTimeoutError(),
      }),
    });
    const out = (await tool.handler({ task: "t", wait: true })) as {
      status: string;
      reason?: string;
      summary?: string;
    };
    expect(out.status).toBe("failed");
    expect(out.reason).toBe("protocolError");
    expect(out.summary).toBe("child protocol");
  });

  it("concurrent: signal.aborted 优先于 WaitTimeoutError → cancelled", async () => {
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: { status: "running" },
        err: new SubAgentWaitTimeoutError(),
      }),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.handler({ task: "t", wait: true }, { signal: controller.signal })
    ).rejects.toThrow(ToolExecutionError);
    await expect(
      tool.handler({ task: "t", wait: true }, { signal: controller.signal })
    ).rejects.toThrow(/cancel/i);
  });

  it("abort typed error 仍走 cancelled，不经 queryBuffer 合成 timeout", async () => {
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: { status: "running" },
        err: new SubAgentAbortError("fixed-task-id-1"),
      }),
    });
    await expect(tool.handler({ task: "t", wait: true })).rejects.toThrow(
      /cancelled/
    );
  });

  it("SC14: 调用方 signal 未 abort 的 SubAgentAbortError → 操作员强杀归因（不是 caller abort / 不是墙钟）", async () => {
    // Operator kill (TUI Ctrl+X → manager.abortTask) does not abort ctx.signal, so
    // executor does not normalize to strict "cancelled"; the model-visible attribution
    // relies entirely on this text.
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: { status: "running" },
        err: new SubAgentAbortError("task-killed-1"),
      }),
    });
    let caught: unknown;
    try {
      await tool.handler({ task: "t", wait: true }, { signal: undefined });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).toContain("cancelled");
    expect(message).toContain("operator killed");
    expect(message).toContain("task-killed-1");
    expect(message).not.toContain("caller aborted");
    expect(message).not.toContain("wall-clock timeout");
    // must not collide with loop-engine's whole-turn stop-reason literals (loop-engine.ts:1605-1618).
    expect(message).not.toBe("cancelled");
    expect(message).not.toBe("timeout");
  });

  it("SC14: 调用方 signal 已 abort 的 SubAgentAbortError → 保留 caller abort 文本（不误标操作员）", async () => {
    const tool = createSpawnSubAgentTool({
      manager: managerRejectingWait({
        buffer: { status: "running" },
        err: new SubAgentAbortError("task-caller-1"),
      }),
    });
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      await tool.handler(
        { task: "t", wait: true },
        { signal: controller.signal }
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolExecutionError);
    const message = (caught as ToolExecutionError).message;
    expect(message).toContain("caller aborted");
    expect(message).not.toContain("operator killed");
  });
});
