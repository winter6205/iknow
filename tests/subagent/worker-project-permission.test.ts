/**
 * ADR-0084 / ADR-0090 — the worker shares the main chain's project permission rules.
 *
 * Invariant: the worker is the subagent face of the same session, so the
 * project `permissions` declarative list must come from the same source as
 * the main chain — otherwise a call denied by the main chain could bypass via
 * the worker (permission parity). Read root = `projectIdentityRoot` (workers
 * have no sessionRoots; the identity root arrives via the IKNOW_PRODUCT_ROOT
 * wire, falling back to cwd when absent).
 *
 * Method: real createWorkerDeps assembly + real executor + real read_file
 * handler; project fixtures live in tmp dirs. When bwrap is on PATH the bash
 * factory calls requireBwrap (present on this machine), but this file only
 * invokes read_file and never triggers fence execution.
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

/**
 * Project `permissions` section (ADR-0090 declarative): denies read tool
 * calls on any `secret.txt` at any depth. A single-segment deny path matches
 * at any depth under the workspace root, so `Read(secret.txt)` covers
 * `<root>/secret.txt` at the top level (equivalent to the old `path_contains` semantics).
 */
const DENY_SECRET_SECTION = {
  deny: ["Read(secret.txt)"],
};

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "iknow-worker-proj-perm-"));
}

/** Lay down `<root>/.iknow/settings.json` + two readable files. */
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
    // The compile-time-generated reason echoes the declarative rule verbatim (no id / reason stored in the file).
    expect(denied.message).toMatch(/Read\(secret\.txt\)/);

    // Selectivity: unmatched paths still get the read-only category default allow.
    const allowed = await readFileResult(deps, join(root, "ok.txt"));
    expect(allowed.kind).toBe("ok");
  });

  it("身份根（改绑档）与 worker cwd 分裂时，规则仍从身份根读（cwd 上的诱饵不生效）", async () => {
    const identityRoot = await scratch();
    const taskRoot = await scratch();
    roots.push(identityRoot, taskRoot);
    await plantProject(identityRoot, { permissions: DENY_SECRET_SECTION });
    // Plant an **allowing** decoy settings on the cwd side (task worktree):
    // reading the wrong root would make the deny vanish, so the test
    // distinguishes "read the identity root" from "read the cwd".
    await plantProject(taskRoot, {
      permissions: { allow: ["Read(secret.txt)"] },
    });

    const deps = await workerAt(identityRoot, taskRoot);
    const result = await readFileResult(deps, join(taskRoot, "secret.txt"));
    expect(result.kind).toBe("execution_failed");
    // The compile-time-generated reason echoes the declarative rule verbatim (no id / reason stored in the file).
    expect(result.message).toMatch(/Read\(secret\.txt\)/);
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
