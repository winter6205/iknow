/**
 * #562 T6 — bashMode 通道缝贯通 (worker → registry → bash tool)。
 * 双闸 (validator + fence) 集成断言:
 *   (1) readonly worker bash 越界 → 抛 ReadonlyViolationError;
 *   (2) readonly worker bash 穿越 validator 后 → fence 收 cwdReadonly:true。
 * V1 byte-stable: role 缺省 / 未知 → bashMode 显式 "any"/缺省 → bash 字节与 V1 一致。
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

// vi.mock 提至模块图顶端 — 后续 import 命中 mock (bash.ts 通过
// '../../sandbox/index.js' 引到 createBwrapFence)。
vi.mock("../../src/harness/sandbox/index.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/harness/sandbox/index.ts")
  >("../../src/harness/sandbox/index.ts");
  return {
    ...actual,
    createBwrapFence: vi.fn(),
    requireBwrap: vi.fn(),
  };
});
vi.mock("../../src/harness/sandbox/runner.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/harness/sandbox/runner.ts")
  >("../../src/harness/sandbox/runner.ts");
  return { ...actual, runInSandbox: vi.fn(), requireBwrap: vi.fn() };
});

import * as sandboxIndex from "../../src/harness/sandbox/index.ts";
import { createBashTool } from "../../src/harness/aci/tools/bash.ts";
import { ReadonlyViolationError } from "../../src/harness/aci/tools/bash-readonly.ts";
import { createDefaultAciRegistry } from "../../src/harness/aci/tools/registry.ts";
import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type { IknowEnv } from "../../src/config/env.ts";

// IknowEnv 装配只读 seeder —— 给测试 hermetic 注入。lifecycle 完全 stub 化。
const TEST_ENV = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off" as const,
    thinking: { type: "disabled" as const },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
} as unknown as IknowEnv;

interface FenceOpts {
  readonly cwdReadonly?: boolean;
  [k: string]: unknown;
}
const capturedFenceOpts: FenceOpts[] = [];

function installFenceSpy(): void {
  // fence argv 形态断言。每次 beforeEach 重置实现,确保前测试不留状态。
  vi.mocked(sandboxIndex.createBwrapFence)
    .mockReset()
    .mockImplementation((opts) => {
      capturedFenceOpts.push(opts as unknown as FenceOpts);
      return {
        argv: ["bwrap", "--", "bash", "-c", "echo hi"],
        sealed: true as const,
      };
    });
  vi.mocked(
    (
      sandboxIndex as unknown as {
        runInSandbox: typeof import("../../src/harness/sandbox/runner.ts").runInSandbox;
      }
    ).runInSandbox
  )
    .mockReset()
    .mockResolvedValue({ exitCode: 0, stdout: "OK\n", stderr: "" });
}

// 默认装 fence spy — 让所有 bash handler 调用都走 fake fence + fake runInSandbox,
// 不真起 bwrap,也避免 vi.fn() 默认返回 undefined 触发 TypeError。
beforeEach(() => {
  capturedFenceOpts.length = 0;
  installFenceSpy();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function hermeticOpts(
  extra?: Partial<Parameters<typeof createWorkerDeps>[0]>
): Parameters<typeof createWorkerDeps>[0] {
  return {
    env: TEST_ENV,
    sandboxRoot: "/tmp/sb-bash-mode",
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  };
}

// ─── A. bash.ts: bashMode → validator + fence 双闸 (T4+T5 integration) ──────

describe("bash.ts: bashMode 双闸 (#562 T6)", () => {
  it("bashMode='readonly' + 'env' → 抛 ReadonlyViolationError", async () => {
    const tool = createBashTool("/tmp/sb", { bashMode: "readonly" });
    await assert.rejects(
      () => tool.handler({ command: "env" }),
      (err: unknown) =>
        err instanceof ReadonlyViolationError && /'env'/.test(err.message)
    );
  });

  it("bashMode='readonly' + 'rm file' → 抛 ReadonlyViolationError (deny-by-default)", async () => {
    const tool = createBashTool("/tmp/sb", { bashMode: "readonly" });
    await assert.rejects(
      () => tool.handler({ command: "rm file" }),
      (err: unknown) =>
        err instanceof ReadonlyViolationError && /'rm'/.test(err.message)
    );
  });

  it("bashMode 缺省 + 'env' → 不抛 ROE, fence 不收 cwdReadonly (V1)", async () => {
    const tool = createBashTool("/tmp/sb");
    const out = await tool.handler({ command: "env" });
    assert.deepEqual(out, { code: 0, stdout: "OK\n", stderr: "" });
    assert.equal(capturedFenceOpts[0]!.cwdReadonly, undefined);
  });

  it("bashMode='readonly' + 'ls' → 穿 validator, fence 收 cwdReadonly:true (双闸 1+2)", async () => {
    // ls 在 READONLY_ALLOWED → 通过 validator; fence 收 cwdReadonly:true。
    const tool = createBashTool("/tmp/sb", { bashMode: "readonly" });
    const out = await tool.handler({ command: "ls" });
    assert.deepEqual(out, { code: 0, stdout: "OK\n", stderr: "" });
    assert.equal(capturedFenceOpts[0]!.cwdReadonly, true);
  });

  it("bashMode='any' 显式 + 'ls' → fence 收 cwdReadonly:undef (V1 baseline 等价)", async () => {
    const tool = createBashTool("/tmp/sb", { bashMode: "any" });
    await tool.handler({ command: "ls" });
    assert.equal(capturedFenceOpts[0]!.cwdReadonly, undefined);
  });
});

// ─── B. registry.ts: createDefaultAciRegistry bashMode 透传 (T6) ────────────

describe("registry.ts: createDefaultAciRegistry bashMode 透传 (#562 T6)", () => {
  it("bashMode='readonly' → bash handler 抛 ROE on 'env'", async () => {
    const reg = createDefaultAciRegistry({
      env: TEST_ENV,
      sandboxRoot: "/tmp/sb-bash-mode",
      bashMode: "readonly",
    });
    const bash = reg.inner.get("bash");
    assert.ok(bash, "bash tool 必须出现在 registry");
    await assert.rejects(
      () => bash!.handler({ command: "env" }),
      (err: unknown) => err instanceof ReadonlyViolationError
    );
  });

  it("bashMode 缺省 → bash handler 不抛 ROE (V1 byte-stable)", async () => {
    installFenceSpy();
    const reg = createDefaultAciRegistry({
      env: TEST_ENV,
      sandboxRoot: "/tmp/sb-bash-mode",
    });
    const bash = reg.inner.get("bash");
    assert.ok(bash);
    const out = await bash!.handler({ command: "env" });
    assert.deepEqual(out, { code: 0, stdout: "OK\n", stderr: "" });
    assert.equal(capturedFenceOpts[0]!.cwdReadonly, undefined);
  });
});

// ─── C. worker.ts: createWorkerDeps bashMode derivation from role (T6) ─────

describe("worker.ts: createWorkerDeps bashMode from role (#562 T6)", () => {
  it("role=explore → bash 抛 ROE on 'env' (validator 闸)", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const bash = deps.registry.get("bash");
    assert.ok(bash, "registry 必须含 bash");
    await assert.rejects(
      () => bash!.handler({ command: "env" }),
      (err: unknown) =>
        err instanceof ReadonlyViolationError && /'env'/.test(err.message)
    );
  });

  it("role=explore + 'echo hi' → 穿 validator, fence 收 cwdReadonly:true (双闸 端到端)", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const bash = deps.registry.get("bash");
    assert.ok(bash);
    const out = (await bash!.handler({ command: "echo hi" })) as {
      code: number;
    };
    // (1) readonly validator 已通过 (echo 在 READONLY_ALLOWED);
    // (2) fence 形态断言: cwdReadonly=true 已传导。
    assert.equal(out.code, 0);
    assert.equal(capturedFenceOpts[0]!.cwdReadonly, true);
  });

  // role 缺省 / 未知 / general-purpose / bashMode='any' 显式覆盖 → 全部 V1 baseline:
  // bashMode 派生 "any" 或显式 "any" → bash handler 不启用 readonly validator, fence 不收 cwdReadonly。
  for (const { label, opt } of [
    { label: "role=general-purpose", opt: { role: "general-purpose" } },
    { label: "role 缺省", opt: {} },
    { label: "role=unknown", opt: { role: "not_a_real_agent" } },
    {
      label: "opts.bashMode='any' 覆盖 role",
      opt: { role: "explore", bashMode: "any" as const },
    },
  ]) {
    it(`${label} → bash 不抛 ROE, fence 不收 cwdReadonly (V1 baseline)`, async () => {
      const deps = await createWorkerDeps(hermeticOpts(opt));
      const bash = deps.registry.get("bash");
      assert.ok(bash);
      const out = await bash!.handler({ command: "env" });
      assert.deepEqual(out, { code: 0, stdout: "OK\n", stderr: "" });
      assert.equal(capturedFenceOpts[0]!.cwdReadonly, undefined);
    });
  }

  it("CreateWorkerDepsOptions.bashMode seam 是可选字段 (类型契约)", () => {
    const a: Parameters<typeof createWorkerDeps>[0] = {
      env: TEST_ENV,
      sandboxRoot: "/tmp/sb",
      role: "explore",
    };
    const b: Parameters<typeof createWorkerDeps>[0] = {
      env: TEST_ENV,
      sandboxRoot: "/tmp/sb",
      bashMode: "readonly",
    };
    assert.equal(a.role, "explore");
    assert.equal(b.bashMode, "readonly");
  });
});
