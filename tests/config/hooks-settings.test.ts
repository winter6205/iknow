/**
 * settings.hooks — Claude command shape (PreToolUse / PostToolUse groups).
 *
 * The old deny-only `{enabled, rules}` is incompatible: pasting it in produces no hooks section.
 * Project-layer hooks never enters the allowlist (an arbitrary command = clone-and-execute).
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowSettings } from "../../src/config/settings.ts";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-hooks-settings-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown>
): Promise<{ home: string; cwd: string }> {
  const seed = Math.random().toString(36).slice(2);
  const home = join(workDir, "home", seed);
  const cwd = join(workDir, "cwd", seed);
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  if (Object.keys(user).length > 0) {
    await writeFile(
      join(home, ".iknow", "settings.json"),
      JSON.stringify(user)
    );
  }
  if (Object.keys(project).length > 0) {
    await writeFile(
      join(cwd, ".iknow", "settings.json"),
      JSON.stringify(project)
    );
  }
  return { home, cwd };
}

function bashGroup(
  command = "echo ok",
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    matcher: "Bash",
    hooks: [{ type: "command", command, timeout: 5 }],
    ...overrides,
  };
}

describe("settings.hooks — 缺席 = 关", () => {
  it("无 hooks 段 → hooks undefined", async () => {
    const { home, cwd } = await makeSettings({}, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(settings.hooks, undefined);
    assert.deepEqual(settings, {});
  });

  it("hooks 为空对象 → 不产出 hooks 段", async () => {
    const { home, cwd } = await makeSettings({ hooks: {} }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("旧 deny-only enabled+rules → 不产出 hooks 段", async () => {
    const { home, cwd } = await makeSettings(
      {
        hooks: {
          enabled: true,
          rules: [{ id: "r1", event: "PreToolUse", reason: "legacy" }],
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });
});

describe("settings.hooks — Claude PreToolUse/PostToolUse", () => {
  it("用户层 Claude 组原样保真（含 matcher / command / timeout）", async () => {
    const { home, cwd } = await makeSettings(
      {
        hooks: {
          PreToolUse: [bashGroup("node ./pre.ts")],
          PostToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [{ type: "command", command: "npx prettier --write" }],
            },
          ],
        },
      },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.hooks, {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "node ./pre.ts", timeout: 5 }],
        },
      ],
      PostToolUse: [
        {
          matcher: "Write|Edit",
          hooks: [{ type: "command", command: "npx prettier --write" }],
        },
      ],
    });
    assert.ok(Object.isFrozen(settings.hooks));
    assert.ok(Object.isFrozen(settings.hooks!.PreToolUse));
    assert.ok(Object.isFrozen(settings.hooks!.PreToolUse![0]));
    assert.ok(Object.isFrozen(settings.hooks!.PreToolUse![0]!.hooks));
  });

  it("matcher 缺席的组仍保留（通配）", async () => {
    const { home, cwd } = await makeSettings(
      {
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo all" }] }],
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      PreToolUse: [{ hooks: [{ type: "command", command: "echo all" }] }],
    });
  });

  it("未知事件名忽略；合法 PreToolUse 仍保留", async () => {
    const { home, cwd } = await makeSettings(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "boot" }] }],
          PreToolUse: [bashGroup()],
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "echo ok", timeout: 5 }],
        },
      ],
    });
  });

  it("非 command type / 缺 command / 非数组事件值 → 丢组不抛", async () => {
    const { home, cwd } = await makeSettings(
      {
        hooks: {
          PreToolUse: "nope",
          PostToolUse: [
            { matcher: "Bash", hooks: [{ type: "prompt", command: "x" }] },
            { matcher: "Bash", hooks: [{ type: "command" }] },
            bashGroup("keep-me"),
            { matcher: 1, hooks: [{ type: "command", command: "x" }] },
          ],
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "keep-me", timeout: 5 }],
        },
      ],
    });
  });

  it("hooks 段非对象 → 丢弃", async () => {
    const { home, cwd } = await makeSettings({ hooks: [] }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });
});

describe("settings.hooks — 仅用户层", () => {
  it("项目层 hooks 不覆盖、不并入用户 command 组", async () => {
    const warnings: string[] = [];
    const { home, cwd } = await makeSettings(
      { hooks: { PreToolUse: [bashGroup("user")] } },
      { hooks: { PreToolUse: [bashGroup("project")] } }
    );
    const settings = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    assert.deepEqual(settings.hooks, {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "user", timeout: 5 }],
        },
      ],
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"hooks"/);
  });

  it("仅项目层 hooks → 不产出（与 plugins 同款供应链）", async () => {
    const warnings: string[] = [];
    const { home, cwd } = await makeSettings(
      {},
      { hooks: { PreToolUse: [bashGroup("project")] } }
    );
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      {}
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"hooks"/);
  });
});
