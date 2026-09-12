/**
 * ADR-0084 / spec Slice B SC5 — worker 与主链共用同一份项目权限规则。
 *
 * 不变式：worker 是同一会话的子代理面，项目 `permissions.rule` 必须与主链
 * 同源 —— 否则被主链 deny 的调用可从 worker 绕行（权限平权）。读根 =
 * `projectIdentityRoot`（worker 无 sessionRoots，身份根经 IKNOW_PRODUCT_ROOT
 * wire 送达 / 缺席回落 cwd）。
 *
 * 手法：真实 createWorkerDeps 装配 + 真实 executor + 真实 read_file handler；
 * 项目 fixture 走 tmp 目录。bwrap 在 PATH 时 bash 工厂会 requireBwrap（本机
 * 有），但本文件只调 read_file，不触发围栏执行。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkerDeps } from "../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
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

/** 项目 `permissions` 段：deny 命中 path 含 `secret.txt` 的 read_file。 */
const DENY_SECRET_SECTION = {
  schema_version: 1,
  rule: [
    {
      id: "deny-secret-read",
      match_tool: "read_file",
      match_input: { path_contains: "secret.txt" },
      decision: "deny",
      reason: "project rule: secret.txt is off-limits",
    },
  ],
};

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "iknow-worker-proj-perm-"));
}

/** 铺 `<root>/.iknow/settings.json` + 两个可读文件。 */
async function plantProject(
  root: string,
  settings: Record<string, unknown>
): Promise<void> {
  await mkdir(join(root, ".iknow"), { recursive: true });
  await writeFile(
    join(root, ".iknow", "settings.json"),
    JSON.stringify(settings),
    "utf8"
  );
  await writeFile(join(root, "secret.txt"), "classified\n", "utf8");
  await writeFile(join(root, "ok.txt"), "public\n", "utf8");
}

async function workerAt(projectIdentityRoot: string, sandboxRoot: string) {
  return createWorkerDeps({
    env: TEST_ENV,
    sandboxRoot,
    projectIdentityRoot,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    trace: createNoopTraceService(),
    system: () => undefined,
    role: "general-purpose",
  });
}

async function readFileResult(
  deps: Awaited<ReturnType<typeof createWorkerDeps>>,
  path: string
): Promise<{ readonly kind: string; readonly message?: string }> {
  const [result] = await deps.executor.executeAll([
    { id: "read-1", name: "read_file", input: { path } },
  ]);
  return result as { readonly kind: string; readonly message?: string };
}

describe("createWorkerDeps — 项目权限源与主链同源（ADR-0084 / SC5）", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  it("worker 遵守身份根上的项目 deny 规则：命中调用被拦，未命中调用仍放行", async () => {
    const root = await scratch();
    roots.push(root);
    await plantProject(root, { permissions: DENY_SECRET_SECTION });

    const deps = await workerAt(root, root);
    const denied = await readFileResult(deps, join(root, "secret.txt"));
    expect(denied.kind).toBe("execution_failed");
    expect(denied.message).toMatch(/\[permission_denied\]/);
    expect(denied.message).toMatch(/project rule: secret\.txt is off-limits/);

    // 选择性：未命中的路径仍走 read-only 类别默认 allow。
    const allowed = await readFileResult(deps, join(root, "ok.txt"));
    expect(allowed.kind).toBe("ok");
  });

  it("身份根（改绑档）与 worker cwd 分裂时，规则仍从身份根读（cwd 上的诱饵不生效）", async () => {
    const identityRoot = await scratch();
    const taskRoot = await scratch();
    roots.push(identityRoot, taskRoot);
    await plantProject(identityRoot, { permissions: DENY_SECRET_SECTION });
    // cwd 侧（task worktree）铺一份**放行**的诱饵 settings：读错根会让 deny
    // 消失，测试因此能区分「读了身份根」与「读了 cwd」。
    await plantProject(taskRoot, {
      permissions: {
        schema_version: 1,
        rule: [
          {
            id: "allow-secret-read",
            match_tool: "read_file",
            match_input: { path_contains: "secret.txt" },
            decision: "allow",
            reason: "decoy: task root allows it",
          },
        ],
      },
    });

    const deps = await workerAt(identityRoot, taskRoot);
    const result = await readFileResult(deps, join(taskRoot, "secret.txt"));
    expect(result.kind).toBe("execution_failed");
    expect(result.message).toMatch(/project rule: secret\.txt is off-limits/);
  });

  it("身份根上 toml 与 JSON permissions 并存 → worker 装配 typed fail-loud", async () => {
    const root = await scratch();
    roots.push(root);
    await plantProject(root, { permissions: DENY_SECRET_SECTION });
    await writeFile(
      join(root, ".iknow", "permissions.toml"),
      "schema_version = 1\n",
      "utf8"
    );

    await expect(workerAt(root, root)).rejects.toMatchObject({
      name: "ProjectSettingsError",
      kind: "toml_and_json_present",
    });
  });

  it("身份根无项目 settings.json → worker 装配照常（内建默认）", async () => {
    const root = await scratch();
    roots.push(root);
    await writeFile(join(root, "ok.txt"), "public\n", "utf8");

    const deps = await workerAt(root, root);
    const result = await readFileResult(deps, join(root, "ok.txt"));
    expect(result.kind).toBe("ok");
  });
});
