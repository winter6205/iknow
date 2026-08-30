/**
 * #837 T2 (plan worktree-isolation-model-provision, 硬要求 8) —
 * 缺 `.iknow/rules` 目录视为空，不得让 worker 退出。
 *
 * 背景（trace 2acfda12-e128-42b5-82e6-0d75864a30fc）：worker 启动装配期扫
 * 用户级 `~/.iknow/rules` 与项目级 `<cwd>/.iknow/rules` 时，目录缺失曾以
 * `[subagent-worker] fatal: ENOENT ... scandir '...rules'` 退出（exit 2，
 * 父代理收到 reason:"crashed"）。合同：目录缺失 = 空集；worker 必须照常
 * 跑完一次 spawn 并交出信封（envelope），不要求操作员先 mkdir。
 *
 * 测试形态：走真实装配缝 createWorkerDeps（不注入 system seam —— 静态
 * 说明书装配是本票被测面），stub-model 驱动 runWorkerOnce 完成一轮 spawn。
 * 仓库惯例不真 spawn worker 二进制（避免依赖真 LLM key，见
 * tests/integration/subagent-chain.test.ts 头注）；真实二进制路径的
 * stderr 验收由 ticket 报告附带的实跑记录覆盖。
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createWorkerDeps,
  runWorkerOnce,
  type CreateWorkerDepsOptions,
} from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import type { IknowEnv } from "../../src/config/env.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import { captureStderrOf } from "../_helpers/capture-stderr.ts";

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

const written: string[] = [];
afterEach(async () => {
  await Promise.all(
    written.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  written.push(dir);
  return dir;
}

/** 真实装配（缺省 system resolver = 静态说明书缝）+ stub-model。 */
async function spawnOnce(opts: {
  readonly userHome: string;
  readonly cwd: string;
}): Promise<void> {
  const workerOpts: CreateWorkerDepsOptions = {
    env: TEST_ENV,
    sandboxRoot: opts.cwd,
    model: createStubModel({
      responses: [assistantResult({ texts: ["done"] })],
    }),
    skillCatalog: createSkillCatalog([]),
    trace: createNoopTraceService(),
    userHome: opts.userHome,
    cwd: opts.cwd,
  };
  const deps = await createWorkerDeps(workerOpts);
  const envelope: WorkerEnvelope = {
    task: "finish the ticket",
    sandboxRoot: opts.cwd,
  };
  const result = await runWorkerOnce({ workerEnvelope: envelope, deps });
  assert.equal(result.status, "ok");
  assert.equal(result.result, "done");
}

// -- stderr 捕获 ---------------------------------------------------------------

// Shared helper (tests/_helpers/capture-stderr.ts); passthrough=true keeps
// this file's original semantics: record AND forward to the real stderr.

// -- 验收 ----------------------------------------------------------------------

describe("#837 T2: missing rules dirs are empty, not fatal", () => {
  it("user + project rules dirs both missing → general-purpose spawn completes with ok envelope, stderr clean", async () => {
    const userHome = await tmpDir("t2-home-missing-");
    const cwd = await tmpDir("t2-cwd-missing-");
    const stderr = await captureStderrOf(() => spawnOnce({ userHome, cwd }), { passthrough: true });
    assert.equal(stderr.includes("[subagent-worker] fatal"), false);
    assert.equal(stderr.includes("scandir"), false);
    assert.equal(stderr.includes("ENOENT"), false);
  });

  it(".iknow exists but rules subdir missing → spawn still completes (trace 2acfda12 shape)", async () => {
    const userHome = await tmpDir("t2-home-bare-");
    const cwd = await tmpDir("t2-cwd-bare-");
    await mkdir(join(userHome, ".iknow"), { recursive: true });
    await mkdir(join(cwd, ".iknow"), { recursive: true });
    const stderr = await captureStderrOf(() => spawnOnce({ userHome, cwd }), { passthrough: true });
    assert.equal(stderr.includes("[subagent-worker] fatal"), false);
    assert.equal(stderr.includes("scandir"), false);
    assert.equal(stderr.includes("ENOENT"), false);
  });

  it("rules dirs present → rule bodies still injected (existing behavior pinned)", async () => {
    const userHome = await tmpDir("t2-home-rules-");
    const cwd = await tmpDir("t2-cwd-rules-");
    await mkdir(join(userHome, ".iknow", "rules"), { recursive: true });
    await mkdir(join(cwd, ".iknow", "rules"), { recursive: true });
    await writeFile(
      join(cwd, ".iknow", "rules", "convention.md"),
      "T2_PROJECT_RULE_MARKER",
      "utf8"
    );
    await writeFile(
      join(userHome, ".iknow", "rules", "global.md"),
      "T2_USER_RULE_MARKER",
      "utf8"
    );

    const deps = await createWorkerDeps({
      env: TEST_ENV,
      sandboxRoot: cwd,
      model: createStubModel({
        responses: [assistantResult({ texts: ["done"] })],
      }),
      skillCatalog: createSkillCatalog([]),
      trace: createNoopTraceService(),
      userHome,
      cwd,
    });
    // 装配不抛 + 项目/用户 rules 正文按既有读法注入静态层。
    const system = await deps.system();
    assert.equal(typeof system, "string");
    assert.ok(system!.includes("T2_PROJECT_RULE_MARKER"));
    assert.ok(system!.includes("T2_USER_RULE_MARKER"));

    const envelope: WorkerEnvelope = {
      task: "finish the ticket",
      sandboxRoot: cwd,
    };
    const result = await runWorkerOnce({ workerEnvelope: envelope, deps });
    assert.equal(result.status, "ok");
  });
});
