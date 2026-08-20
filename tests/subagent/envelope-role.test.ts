/**
 * #556 T2 — envelope `role` additive 通道 + worker persona/addendum 消费
 * + systemPrompt 幽灵通道修复 (T2 acceptance)。
 *
 * 防御契约 (ACR blocker 1 收口):
 *   - role 缺省 → V1 baseline (byte-stable)
 *   - role 未知 → V1 fallback (defense-in-depth, worker catch 后发 log)
 *   - role 在场 → 注入 persona (catalog body), addendum (envelope.systemPrompt) 在 persona 之后
 */
import assert from "node:assert/strict";
import { describe, it, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import {
  WORKER_SCHEMA,
  parseWorkerEnvelope,
  type WorkerEnvelope,
} from "../../src/harness/subagent/envelope.ts";
import { createSubAgentManager } from "../../src/harness/subagent/manager.ts";
import type {
  SubAgentDefinition,
  SubAgentSpawn,
} from "../../src/harness/subagent/manager.ts";
import {
  createWorkerDeps,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { getAgentEntry } from "../../src/harness/subagent/catalog.ts";
import type { IknowEnv } from "../../src/config/env.ts";

let parentSandboxRoot: string;
beforeAll(() => {
  parentSandboxRoot = mkdtempSync(path.join(tmpdir(), "iknow-envelope-role-"));
});
afterAll(() => {
  rmSync(parentSandboxRoot, { recursive: true, force: true });
});

const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: { type: "disabled" },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
};

/** hermetic createWorkerDeps 装配 — stub-model + 空 skill + noop trace + 占位 system。 */
function hermeticOpts(
  extra?: Partial<CreateWorkerDepsOptions>
): CreateWorkerDepsOptions {
  return {
    env: TEST_ENV,
    sandboxRoot: "/tmp/sb",
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  };
}

// ─── A. envelope.role schema 通道 ─────────────────────────────────────────────

describe("envelope.role: schema + parse 通道 (T2 #556)", () => {
  it("WORKER_SCHEMA 包含 role (additive, type=string) + additionalProperties: false 保持", () => {
    const props = (WORKER_SCHEMA as { properties: Record<string, unknown> })
      .properties;
    const role = props.role as { type: string };
    assert.ok(role, "role 字段在 schema");
    assert.equal(role.type, "string");
    assert.equal(
      (WORKER_SCHEMA as { additionalProperties: boolean }).additionalProperties,
      false
    );
  });

  it("parseWorkerEnvelope 接受 role: 'explore' / 缺省 → undefined / 非字符串 → 抛", () => {
    const present = parseWorkerEnvelope(
      JSON.stringify({ task: "x", sandboxRoot: "/tmp/sb", role: "explore" })
    );
    assert.equal(present.role, "explore");
    const absent = parseWorkerEnvelope(
      JSON.stringify({ task: "x", sandboxRoot: "/tmp/sb" })
    );
    assert.equal(absent.role, undefined);
    assert.throws(() =>
      parseWorkerEnvelope(
        JSON.stringify({ task: "x", sandboxRoot: "/tmp/sb", role: 123 })
      )
    );
  });

  it("role + systemPrompt 可同时存在", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({
        task: "x",
        sandboxRoot: "/tmp/sb",
        systemPrompt: "MY ADDENDUM",
        role: "explore",
      })
    );
    assert.equal(env.role, "explore");
    assert.equal(env.systemPrompt, "MY ADDENDUM");
  });

  it("parseWorkerEnvelope 接受独立 finalText / evidenceContext，不并入 task", () => {
    const env = parseWorkerEnvelope(
      JSON.stringify({
        task: "goal.text identity",
        sandboxRoot: "/tmp/sb",
        role: "judge",
        finalText: "TRUNCATED_HOST_DIALOGUE",
        evidenceContext: { checkerVerdict: "EVIDENCE_INSUFFICIENT" },
      })
    );
    assert.equal(env.task, "goal.text identity");
    assert.equal(env.finalText, "TRUNCATED_HOST_DIALOGUE");
    assert.deepEqual(env.evidenceContext, {
      checkerVerdict: "EVIDENCE_INSUFFICIENT",
    });
    assert.equal(env.role, "judge");
  });
});

// ─── B. SubAgentDefinition.role → buildWorkerPayload 透传 ─────────────────────

describe("SubAgentDefinition.role → buildWorkerPayload → envelope.role (T2 #556)", () => {
  function makeFakeChild(): ChildProcess {
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    }) as unknown as ChildProcess;
  }

  function makeManagerCapturingPayload() {
    const captured: WorkerEnvelope[] = [];
    const manager = createSubAgentManager({
      spawn: ((
        _def: SubAgentDefinition,
        _taskId: string,
        payload: WorkerEnvelope
      ) => {
        captured.push(payload);
        return makeFakeChild();
      }) as SubAgentSpawn,
      sandboxRoot: parentSandboxRoot,
    });
    return { manager, captured };
  }

  it("def.role 显式 → envelope.role 复制 (spread-guard 不破现有字段)", () => {
    const { manager, captured } = makeManagerCapturingPayload();
    manager.spawn({
      task: "hello",
      role: "explore",
      systemPrompt: "be concise",
    });
    assert.equal(captured[0]!.role, "explore");
    assert.equal(captured[0]!.task, "hello");
    assert.equal(captured[0]!.systemPrompt, "be concise");
  });

  it("def.role 缺省 → envelope.role 缺席 (V1 baseline)", () => {
    const { manager, captured } = makeManagerCapturingPayload();
    manager.spawn({ task: "hello" });
    assert.equal(captured[0]!.role, undefined);
  });

  it("def.role = unknown_id → payload.role 仍透传 (worker 侧 fallback 兜底)", () => {
    // buildWorkerPayload 单点 = spread-guard 复制, 不查 catalog (worker 侧)。
    const { manager, captured } = makeManagerCapturingPayload();
    manager.spawn({ task: "hello", role: "unknown_id" });
    assert.equal(captured[0]!.role, "unknown_id");
  });

  it("def.finalText / evidenceContext 透传到 payload，task 保持 identity", () => {
    const { manager, captured } = makeManagerCapturingPayload();
    const evidenceContext = { checkerVerdict: "EVIDENCE_INSUFFICIENT" };
    manager.spawn({
      task: "goal.text identity",
      role: "judge",
      finalText: "TRUNCATED_HOST_DIALOGUE",
      evidenceContext,
    });
    const payload = captured[0]!;
    assert.equal(payload.task, "goal.text identity");
    assert.ok(!payload.task.includes("checkerVerdict"));
    assert.equal(payload.finalText, "TRUNCATED_HOST_DIALOGUE");
    assert.deepEqual(payload.evidenceContext, evidenceContext);
    assert.equal(payload.role, "judge");
  });
});

// ─── C. worker persona 注入 (role missing / unknown / known) ─────────────────

describe("createWorkerDeps persona 注入 (worker.ts envelope.role → catalog body)", () => {
  it("role=explore → deps.system() 包含 catalog body", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const out = (await deps.system?.()) ?? "";
    assert.ok(out.includes(getAgentEntry("explore").body));
  });

  it("role=general-purpose → deps.system() 包含 general-purpose body", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ role: "general-purpose" })
    );
    const out = (await deps.system?.()) ?? "";
    assert.ok(out.includes(getAgentEntry("general-purpose").body));
  });

  it("role 缺省 → deps.system() 不注入 persona (V1 baseline, byte-stable)", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    const out = (await deps.system?.()) ?? "";
    assert.ok(!out.includes(getAgentEntry("explore").body));
    assert.ok(!out.includes(getAgentEntry("general-purpose").body));
  });

  it("role=unknown → deps.system() 不注入 persona (V1 fallback, 不静默吞掉)", async () => {
    // T2 防御契约: spawn 侧 ajv 已挡一轮, 此为 defense-in-depth — worker 装配
    // 期 catch AgentCatalogLookupError 后走 V1 baseline。
    const deps = await createWorkerDeps(
      hermeticOpts({ role: "not_a_real_agent" })
    );
    const out = (await deps.system?.()) ?? "";
    assert.ok(!out.includes(getAgentEntry("explore").body));
    assert.ok(!out.includes(getAgentEntry("general-purpose").body));
  });
});

// ─── D. addendum 消费 (envelope.systemPrompt 幽灵通道修复) ────────────────────

describe("createWorkerDeps addendum 消费 (envelope.systemPrompt 现在被消费)", () => {
  it("addendum 单独存在 → 注入 system", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ addendum: "MY ADDENDUM" })
    );
    const out = (await deps.system?.()) ?? "";
    assert.ok(out.includes("MY ADDENDUM"));
  });

  it("addendum 缺省 → system 不注入 addendum (V1 baseline)", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    const out = (await deps.system?.()) ?? "";
    assert.ok(!out.includes("MY ADDENDUM"));
  });

  it("role + addendum → persona 在前, addendum 在后 (LOCKED 5 段不破)", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ role: "explore", addendum: "MY ADDENDUM" })
    );
    const out = (await deps.system?.()) ?? "";
    const personaIdx = out.indexOf(getAgentEntry("explore").body);
    const addendumIdx = out.indexOf("MY ADDENDUM");
    assert.ok(personaIdx >= 0);
    assert.ok(addendumIdx > personaIdx, "addendum 在 persona 之后");
  });

  it("role + addendum → base (LOCKED 5 段) 在 persona 之前 (顺序不变)", async () => {
    const baseText = "BASE_SYSTEM_TEXT";
    const deps = await createWorkerDeps(
      hermeticOpts({
        role: "explore",
        addendum: "MY ADDENDUM",
        system: async () => baseText,
      })
    );
    const out = (await deps.system?.()) ?? "";
    const baseIdx = out.indexOf(baseText);
    const personaIdx = out.indexOf(getAgentEntry("explore").body);
    const addendumIdx = out.indexOf("MY ADDENDUM");
    assert.ok(baseIdx >= 0);
    assert.ok(personaIdx > baseIdx, "persona 在 base 之后");
    assert.ok(addendumIdx > personaIdx, "addendum 在 persona 之后");
  });

  it("base=undefined + role + addendum → 输出只是 persona + addendum", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        role: "explore",
        addendum: "MY ADDENDUM",
        system: () => undefined,
      })
    );
    const out = (await deps.system?.()) ?? "";
    assert.ok(out.includes(getAgentEntry("explore").body));
    assert.ok(out.includes("MY ADDENDUM"));
  });

  it("base=undefined + 无 role/addendum → 输出 = undefined (V1 baseline)", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    assert.equal(await deps.system?.(), undefined);
  });

  it("role=judge + addendum → system 是判官 prompt, 不含 iknow soul base", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        role: "judge",
        addendum: "You are a strict task-completion judge.",
        system: async () => "# iknow Soul\nYou are iknow.",
      })
    );
    const out = (await deps.system?.()) ?? "";
    assert.ok(out.includes("strict task-completion judge"));
    assert.ok(
      !out.includes("# iknow Soul"),
      "judge must not default to full iknow assistant voice"
    );
    assert.ok(!out.includes("You are iknow."));
  });
});

// ─── E. 装配层 seam: opts.role / opts.addendum 在 CreateWorkerDepsOptions ─────

describe("CreateWorkerDepsOptions seam: role / addendum 字段 (类型契约)", () => {
  it("opts.role / opts.addendum 是可选 seam (undefined 出席合法)", () => {
    const a: CreateWorkerDepsOptions = {
      env: TEST_ENV,
      sandboxRoot: "/tmp/sb",
      role: "explore",
    };
    const b: CreateWorkerDepsOptions = {
      env: TEST_ENV,
      sandboxRoot: "/tmp/sb",
      addendum: "be concise",
    };
    assert.equal(a.role, "explore");
    assert.equal(b.addendum, "be concise");
  });
});
