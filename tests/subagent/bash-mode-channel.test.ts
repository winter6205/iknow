/**
 * bashMode wiring through the whole seam (worker → registry → bash tool).
 * Dual-gate integration assertions (validator + fence):
 *   (1) readonly worker running an out-of-bounds bash command → ReadonlyViolationError;
 *   (2) readonly worker bash passing the validator → fence receives cwdReadonly:true.
 * V1 byte-stable: role absent / unknown → bashMode explicit "any"/absent → bash bytes identical to V1.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

// Closed-world adaptation: the real createFsPolicy inside the bash handler
// validates taskRoot on disk → sandboxRoot fixtures must exist. This file mocks
// createBwrapFence / runInSandbox (no real bwrap), so we only create the dirs,
// without touching the assertion surface.
for (const dir of ["/tmp/sb", "/tmp/sb-bash-mode"]) {
  mkdirSync(dir, { recursive: true });
}

// vi.mock hoisted to module-graph top — later imports hit the mock
// (bash.ts reaches createBwrapFence via '../../sandbox/index.js').
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

// Hermetic IknowEnv seeder — injects a fully stubbed lifecycle into tests.
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
  // Assert on fence argv shape. Reset the implementation each beforeEach so no
  // state leaks from previous tests.
  vi.mocked(sandboxIndex.createBwrapFence)
    .mockReset()
    .mockImplementation((opts) => {
      capturedFenceOpts.push(opts as unknown as FenceOpts);
      return {
        argv: ["bwrap", "--", "bash", "-c", "echo hi"],
        sealed: true as const,
        exactFileMaskPaths: [],
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

// Install fence spy by default — every bash handler call goes through the fake
// fence + fake runInSandbox, so no real bwrap and no TypeError from vi.fn()
// returning undefined.
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
    system: async () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  };
}

// ─── A. bash.ts: bashMode → validator + fence dual gate ─────────────────────

describe("bash.ts: bashMode 双闸 (#562 T6)", () => {
  it("bashMode='readonly' + 'env' → 抛 ReadonlyViolationError", async () => {
    const tool = createBashTool("/tmp/sb", { bashMode: "readonly" });
    await assert.rejects(
      async () => tool.handler({ command: "env" }),
      (err: unknown) =>
        err instanceof ReadonlyViolationError && /'env'/.test(err.message)
    );
  });

  it("bashMode='readonly' + 'rm file' → 抛 ReadonlyViolationError (deny-by-default)", async () => {
    const tool = createBashTool("/tmp/sb", { bashMode: "readonly" });
    await assert.rejects(
      async () => tool.handler({ command: "rm file" }),
      (err: unknown) =>
        err instanceof ReadonlyViolationError && /'rm'/.test(err.message)
    );
  });

  it("bashMode 缺省 + 'env' → 不抛 ROE, fence 不收 cwdReadonly (V1)", async () => {
    const tool = createBashTool("/tmp/sb");
    const out = (await tool.handler({ command: "env" })) as {
      output: string;
      meta: { stdout: string; stderr: string };
    };
    // The handler returns an envelope `{ output, meta }` (via fake fence +
    // runInSandbox; top level keeps envelope shape); the JSON-encoded
    // code/stdout/stderr inside `output` still honor the original contract
    // (model's view unchanged).
    const parsed = JSON.parse(out.output) as {
      code: number;
      stdout: string;
      stderr: string;
    };
    assert.deepEqual(parsed, { code: 0, stdout: "OK\n", stderr: "" });
    assert.deepEqual(out.meta, { stdout: "OK\n", stderr: "" });
    assert.equal(capturedFenceOpts[0]!.cwdReadonly, undefined);
  });

  it("bashMode='readonly' + 'ls' → 穿 validator, fence 收 cwdReadonly:true (双闸 1+2)", async () => {
    // ls is in READONLY_ALLOWED → passes the validator; fence receives cwdReadonly:true.
    const tool = createBashTool("/tmp/sb", { bashMode: "readonly" });
    const out = (await tool.handler({ command: "ls" })) as {
      output: string;
      meta: { stdout: string; stderr: string };
    };
    const parsed = JSON.parse(out.output) as {
      code: number;
      stdout: string;
      stderr: string;
    };
    assert.deepEqual(parsed, { code: 0, stdout: "OK\n", stderr: "" });
    assert.deepEqual(out.meta, { stdout: "OK\n", stderr: "" });
    assert.equal(capturedFenceOpts[0]!.cwdReadonly, true);
  });

  it("bashMode='any' 显式 + 'ls' → fence 收 cwdReadonly:undef (V1 baseline 等价)", async () => {
    const tool = createBashTool("/tmp/sb", { bashMode: "any" });
    await tool.handler({ command: "ls" });
    assert.equal(capturedFenceOpts[0]!.cwdReadonly, undefined);
  });
});

// ─── B. registry.ts: createDefaultAciRegistry bashMode pass-through ──────────

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
      async () => bash!.handler({ command: "env" }),
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
    const out = (await bash!.handler({ command: "env" })) as {
      output: string;
      meta: { stdout: string; stderr: string };
    };
    const parsed = JSON.parse(out.output) as {
      code: number;
      stdout: string;
      stderr: string;
    };
    assert.deepEqual(parsed, { code: 0, stdout: "OK\n", stderr: "" });
    assert.deepEqual(out.meta, { stdout: "OK\n", stderr: "" });
    assert.equal(capturedFenceOpts[0]!.cwdReadonly, undefined);
  });
});

// ─── C. worker.ts: createWorkerDeps bashMode derivation from role ────────────

describe("worker.ts: createWorkerDeps bashMode from role (#562 T6)", () => {
  it("role=explore → bash 抛 ROE on 'env' (validator 闸)", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const bash = deps.registry.get("bash");
    assert.ok(bash, "registry 必须含 bash");
    await assert.rejects(
      async () => bash!.handler({ command: "env" }),
      (err: unknown) =>
        err instanceof ReadonlyViolationError && /'env'/.test(err.message)
    );
  });

  it("role=explore + 'echo hi' → 穿 validator, fence 收 cwdReadonly:true (双闸 端到端)", async () => {
    const deps = await createWorkerDeps(hermeticOpts({ role: "explore" }));
    const bash = deps.registry.get("bash");
    assert.ok(bash);
    // The handler returns an envelope; code/stdout/stderr are JSON-encoded in `output`.
    const envelope = (await bash!.handler({ command: "echo hi" })) as {
      output: string;
    };
    const out = JSON.parse(envelope.output) as { code: number };
    // (1) readonly validator passed (echo is in READONLY_ALLOWED);
    // (2) fence shape assertion: cwdReadonly=true propagated.
    assert.equal(out.code, 0);
    assert.equal(capturedFenceOpts[0]!.cwdReadonly, true);
  });

  // role absent / unknown / general-purpose / explicit bashMode='any' override → all V1 baseline:
  // bashMode derives "any" or is explicitly "any" → bash handler disables the readonly
  // validator, fence receives no cwdReadonly.
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
      const out = (await bash!.handler({ command: "env" })) as {
        output: string;
        meta: { stdout: string; stderr: string };
      };
      // The handler returns an envelope; code/stdout/stderr are JSON-encoded in
      // `output`, byte-stable with V1 after parsing.
      const parsed = JSON.parse(out.output) as {
        code: number;
        stdout: string;
        stderr: string;
      };
      assert.deepEqual(parsed, { code: 0, stdout: "OK\n", stderr: "" });
      assert.deepEqual(out.meta, { stdout: "OK\n", stderr: "" });
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
