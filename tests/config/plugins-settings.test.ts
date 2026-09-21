/**
 * settings.plugins section unit tests.
 *
 * Coverage:
 *   - user-layer plugins section parses (roots / disabled arrays)
 *   - non-object / non-array / non-string elements → field dropped
 *   - all fields invalid → section absent (consumers treat it as unconfigured)
 *   - project-layer plugins → discarded by PROJECT_SETTINGS_ALLOWED_KEYS + warning
 *     （ADR-0084: plugins carry hooks = arbitrary command execution → project layer not writable）
 *   - user and project both set plugins → user wins + warn (project discarded)
 *   - settings.plugins.frozen
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowSettings } from "../../src/config/settings.ts";

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "iknow-plugins-settings-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown>
): Promise<{ home: string; cwd: string }> {
  const home = join(workDir, "home", `${Math.random().toString(36).slice(2)}`);
  const cwd = join(workDir, "cwd", `${Math.random().toString(36).slice(2)}`);
  await mkdirSync(join(home, ".iknow"), { recursive: true });
  await mkdirSync(join(cwd, ".iknow"), { recursive: true });
  if (Object.keys(user).length > 0) {
    writeFileSync(join(home, ".iknow", "settings.json"), JSON.stringify(user));
  }
  if (Object.keys(project).length > 0) {
    writeFileSync(
      join(cwd, ".iknow", "settings.json"),
      JSON.stringify(project)
    );
  }
  return { home, cwd };
}

describe("loadIknowSettings — plugins 段 (#global-plugins T1)", () => {
  it("user 层合法 roots 数组 → 解析 + frozen", async () => {
    const { home, cwd } = await makeSettings(
      {
        plugins: {
          roots: ["/opt/iknow-plugins", "/usr/local/share/iknow-plugins"],
        },
      },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s.plugins?.roots, [
      "/opt/iknow-plugins",
      "/usr/local/share/iknow-plugins",
    ]);
    assert.equal(Object.isFrozen(s.plugins), true);
    assert.equal(Object.isFrozen(s.plugins?.roots), true);
  });

  it("user 层合法 disabled 数组 → 解析", async () => {
    const { home, cwd } = await makeSettings(
      { plugins: { disabled: ["plugA", "plugB"] } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s.plugins?.disabled, ["plugA", "plugB"]);
  });

  it("roots + disabled 同时配置 → 两字段都在", async () => {
    const { home, cwd } = await makeSettings(
      {
        plugins: {
          roots: ["/path/a"],
          disabled: ["plugX"],
        },
      },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s.plugins?.roots, ["/path/a"]);
    assert.deepEqual(s.plugins?.disabled, ["plugX"]);
  });

  it("roots 含非字符串元素 → 丢弃该元素（不留空数组）", async () => {
    const { home, cwd } = await makeSettings(
      { plugins: { roots: ["/good", 42, "", "/also-good"] as unknown[] } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    // isNonEmptyString filters out 42 and "" → leaves [/good, /also-good]
    assert.deepEqual(s.plugins?.roots, ["/good", "/also-good"]);
  });

  it("roots 全非法 → 整个 roots 字段缺席 (不抛错)", async () => {
    const { home, cwd } = await makeSettings(
      { plugins: { roots: [42, null, ""] as unknown[] } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.equal(s.plugins?.roots, undefined);
  });

  it("plugins 是非对象（数组 / 字符串）→ 整个段缺席", async () => {
    const home = join(workDir, "home", "h");
    const cwd = join(workDir, "cwd", "c");
    await mkdirSync(join(home, ".iknow"), { recursive: true });
    await mkdirSync(join(cwd, ".iknow"), { recursive: true });
    writeFileSync(
      join(home, ".iknow", "settings.json"),
      JSON.stringify({ plugins: ["not", "object"] })
    );
    assert.equal(loadIknowSettings({ home, cwd }).plugins, undefined);
  });

  it("project 层 plugins → 被 allowlist 丢弃 + 告警", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { plugins: { roots: ["/malicious"] } }
    );
    const warnings: string[] = [];
    const s = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    // project layer discarded → never enters the merged result
    assert.equal(s.plugins, undefined);
    // warning mentions "plugins"
    assert.ok(warnings.some((w) => /"plugins"/.test(w)));
  });

  it("user + project 都配 plugins → user 胜出 + project 告警", async () => {
    const { home, cwd } = await makeSettings(
      { plugins: { roots: ["/user-root"], disabled: ["plugUser"] } },
      { plugins: { roots: ["/project-root"], disabled: ["plugProject"] } }
    );
    const warnings: string[] = [];
    const s = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    // user wins
    assert.deepEqual(s.plugins?.roots, ["/user-root"]);
    assert.deepEqual(s.plugins?.disabled, ["plugUser"]);
    // project discarded → warning
    assert.ok(warnings.some((w) => /"plugins"/.test(w)));
  });

  it("user 缺席 plugins 段 + project 写 plugins → 合并结果无 plugins 段", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { model: "u" } },
      { plugins: { roots: ["/p"] } }
    );
    const warnings: string[] = [];
    const s = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    // user section unset, project discarded → plugins absent entirely
    assert.equal(s.plugins, undefined);
    // user llm still there
    assert.equal(s.llm?.model, "u");
    // warning still fires
    assert.ok(warnings.some((w) => /"plugins"/.test(w)));
  });
});
