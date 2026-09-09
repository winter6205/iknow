/**
 * git 作业（specs/git-work.md）：worker 不注入纪律段；
 * explore 只读 bash 拒 commit/push；worker 无名 create-task-worktree。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleIdentityContext,
  type AssemblyContext,
} from "../../src/harness/identity/assemble.ts";
import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { ReadonlyViolationError } from "../../src/harness/aci/tools/bash-readonly.ts";
import type { IknowEnv } from "../../src/config/env.ts";

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

const WORKTREE_TOOLS = [
  "create-task-worktree",
  "enter-task-worktree",
  "exit-task-worktree",
] as const;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-git-work-t3-"));
  await mkdir(join(workDir, ".iknow"), { recursive: true });
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function parentCtx(): AssemblyContext {
  return {
    cwd: workDir,
    projectIdentityRoot: workDir,
    userHome: workDir,
    bootstrapActive: false,
    memoryEnabled: false,
    gitWorkDiscipline: true,
  };
}

function hermeticOpts(
  extra?: Partial<Parameters<typeof createWorkerDeps>[0]>
): Parameters<typeof createWorkerDeps>[0] {
  return {
    env: TEST_ENV,
    sandboxRoot: workDir,
    cwd: workDir,
    userHome: workDir,
    projectIdentityRoot: workDir,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    trace: createNoopTraceService(),
    ...extra,
  };
}

describe("git work — worker does not inject the parent discipline", () => {
  it("parent system contains the segment while a parallel worker system does not", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    const [parent, worker] = await Promise.all([
      assembleIdentityContext(parentCtx()),
      deps.system?.() ?? Promise.resolve(undefined),
    ]);
    expect(parent).toContain("## Git work");
    expect(worker ?? "").not.toContain("## Git work");
  });

  it("explore bash git commit is typed-rejected", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ system: () => undefined, role: "explore" })
    );
    const bash = deps.registry.get("bash");
    expect(bash).toBeDefined();
    await expect(
      bash!.handler({ command: "git commit -m msg" })
    ).rejects.toBeInstanceOf(ReadonlyViolationError);
  });

  it("explore bash git push is typed-rejected", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ system: () => undefined, role: "explore" })
    );
    const bash = deps.registry.get("bash");
    expect(bash).toBeDefined();
    await expect(bash!.handler({ command: "git push" })).rejects.toBeInstanceOf(
      ReadonlyViolationError
    );
  });

  it("worker registry has no create-task-worktree (inner + promptTools)", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({ system: () => undefined })
    );
    const inner = deps.registry.list().map((t) => t.name);
    const prompt = deps.promptTools().map((t) => t.name);
    for (const name of WORKTREE_TOOLS) {
      expect(inner).not.toContain(name);
      expect(prompt).not.toContain(name);
    }
  });
});
