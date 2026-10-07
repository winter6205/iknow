/**
 * ADR-0084 / ADR-0090 — build-engine assembly really reads the project
 * `permissions` section.
 *
 * Invariants pinned by this file:
 *  - The declarative `permissions` list in project `settings.json` reaches
 *    tool calls through REAL assembly (build-engine →
 *    createPermissionPolicy → permission-executor): a deny-matched call
 *    returns `[permission_denied]` plus the rule reason, while non-matching
 *    calls of the same tool still pass by category default — rules are
 *    selective, not whole-tool bans.
 *  - The read root is `projectIdentityRoot` (the project identity anchor),
 *    not `cwd`: after rebinding, cwd is a bare task worktree without
 *    `.iknow`, so the project contract exists only at the identity root.
 *  - Two coexisting SSOTs (toml + JSON `permissions`) → typed fail-loud at
 *    assembly time, not a swallowed catch.
 *  - A lazy toml with no `permissions` section on the JSON side → assembly
 *    proceeds normally (ADR-0084 defines only "both present simultaneously"
 *    as unrecoverable ambiguity).
 *
 * Technique: real build-engine assembly + real executor + real read_file
 * handler; project fixtures live in tmp dirs, so nothing outside
 * `:memory:` touches the real ~/.iknow.
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
    // Roots are supplied explicitly to buildHarnessEngine; the env
    // side keeps its "unset" default.
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

/**
 * Project `permissions` section (ADR-0090 declarative form): a deny matching
 * read-tool calls on `secret.txt` at any depth. A single-segment deny path
 * matches at any depth under the workspace root, so `Read(secret.txt)`
 * covers the top-level `<root>/secret.txt` — the equivalent of the old
 * `path_contains` semantics.
 */
const DENY_SECRET_SECTION = {
  deny: ["Read(secret.txt)"],
};

/** Plant `<root>/.iknow/settings.json` (optionally with a permissions section) plus two readable files. */
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

  it("项目 permissions 的 deny 经真实装配拦下命中调用，未命中的同工具调用仍放行", async () => {
    const root = await scratch();
    await plantProject(root, { permissions: DENY_SECRET_SECTION });

    const built = await buildAt(root);
    try {
      const denied = await readFileResult(built, join(root, "secret.txt"));
      expect(denied.kind).toBe("execution_failed");
      expect(denied.message).toMatch(/\[permission_denied\]/);
      // The compile-time-generated reason echoes the declarative rule text verbatim (the settings file stores no id / reason).
      expect(denied.message).toMatch(/Read\(secret\.txt\)/);

      // Selectivity: under the same rule, non-matching paths still take the read-only category default allow.
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
      // A lazy toml is neither a second SSOT nor a source of ghost denies:
      // with no deny rule present, read_file takes the read-only category default allow.
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
