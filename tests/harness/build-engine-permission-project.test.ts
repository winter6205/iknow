/**
 * ADR-0084 / Slice B SC5 — build-engine 装配真实读项目 `permissions` 段。
 *
 * 不变式（本文件钉住的东西）：
 *  - 项目 `settings.json` 的 `permissions.rule` 经**真实装配**（build-engine →
 *    createPermissionPolicy → permission-executor）落到工具调用上：命中 deny
 *    的调用以 `[permission_denied]` + 规则 reason 返回，未命中的同工具调用
 *    仍按类别默认放行 —— 规则是选择性的，不是整工具封禁。
 *  - 读根是 `projectIdentityRoot`（项目身份锚），不是 `cwd`：改绑后 cwd 是
 *    没有 `.iknow` 的裸 task worktree，项目契约只在身份根上。
 *  - 两份 SSOT 并存（toml + JSON `permissions`）→ 装配期 typed fail-loud，
 *    不是被吞的 catch。
 *  - 只有惰性 toml、JSON 侧无 `permissions` 段 → 装配照常（ADR-0084 只把
 *    「两份同时存在」定为不可恢复歧义）。
 *
 * 手法：真实 build-engine 装配 + 真实 executor + 真实 read_file handler；
 * 项目 fixture 走 tmp 目录，`:memory:` 之外的根不污染真实 ~/.iknow。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { ProjectSettingsError } from "../../src/harness/permission/project-settings.ts";
import type { IknowEnv } from "../../src/config/env.ts";

/** Deterministic env: never read process.env / .env files (env.ts SSOT). */
function makeEnv(apiKey: string): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
}

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

/** 铺 `<root>/.iknow/settings.json`（可选带 permissions 段）+ 两个可读文件。 */
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

async function buildAt(root: string): Promise<BuiltEngine> {
  return buildHarnessEngine({
    env: makeEnv("sk-test-proj-perm"),
    askUser: createNoAskUser(),
    surface: "chat",
    cwd: root,
    userHome: join(root, "home"),
  });
}

async function readFileResult(
  built: BuiltEngine,
  path: string
): Promise<{ readonly kind: string; readonly message?: string }> {
  const [result] = await built.deps.executor.executeAll([
    { id: "read-1", name: "read_file", input: { path } },
  ]);
  return result as { readonly kind: string; readonly message?: string };
}

describe("buildHarnessEngine — 项目权限源装配（ADR-0084 / SC5）", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))
    );
  });

  async function scratch(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "iknow-proj-perm-"));
    roots.push(root);
    return root;
  }

  it("项目 permissions.rule 的 deny 经真实装配拦下命中调用，未命中的同工具调用仍放行", async () => {
    const root = await scratch();
    await plantProject(root, { permissions: DENY_SECRET_SECTION });

    const built = await buildAt(root);
    try {
      const denied = await readFileResult(built, join(root, "secret.txt"));
      expect(denied.kind).toBe("execution_failed");
      expect(denied.message).toMatch(/\[permission_denied\]/);
      expect(denied.message).toMatch(/project rule: secret\.txt is off-limits/);

      // 选择性：同一条规则下未命中的路径仍走 read-only 类别默认 allow。
      const allowed = await readFileResult(built, join(root, "ok.txt"));
      expect(allowed.kind).toBe("ok");
    } finally {
      await built.shutdown?.();
    }
  });

  it("toml 与 JSON permissions 段并存 → 装配期 typed fail-loud（ProjectSettingsError）", async () => {
    const root = await scratch();
    await plantProject(root, { permissions: DENY_SECRET_SECTION });
    await writeFile(
      join(root, ".iknow", "permissions.toml"),
      "schema_version = 1\n",
      "utf8"
    );

    await expect(buildAt(root)).rejects.toBeInstanceOf(ProjectSettingsError);
    await expect(buildAt(root)).rejects.toMatchObject({
      name: "ProjectSettingsError",
      kind: "toml_and_json_present",
    });
  });

  it("只有惰性 toml、JSON 侧无 permissions 段 → 装配照常且工具调用不受影响", async () => {
    const root = await scratch();
    await plantProject(root, { verify: { command: "npm test" } });
    await writeFile(
      join(root, ".iknow", "permissions.toml"),
      "schema_version = 1\n",
      "utf8"
    );

    const built = await buildAt(root);
    try {
      // 惰性 toml 既不是第二份 SSOT 也不产生幽灵 deny：deny 规则不在场，
      // read_file 走 read-only 类别默认 allow。
      const result = await readFileResult(built, join(root, "secret.txt"));
      expect(result.kind).toBe("ok");
    } finally {
      await built.shutdown?.();
    }
  });

  it("项目 settings.json 缺席 → 装配照常（项目层无规则）", async () => {
    const root = await scratch();
    await mkdir(join(root, ".iknow"), { recursive: true });
    await writeFile(join(root, "ok.txt"), "public\n", "utf8");

    const built = await buildAt(root);
    try {
      const result = await readFileResult(built, join(root, "ok.txt"));
      expect(result.kind).toBe("ok");
    } finally {
      await built.shutdown?.();
    }
  });
});
