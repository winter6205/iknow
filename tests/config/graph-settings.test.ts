/**
 * D-α V1 graph mode T2 — `settings.graph` 段（新会话默认；缺省关）。
 *
 * 纪律镜像 `settings.subagent`：drop-not-throw（非法字段丢弃、不抛）、
 * 全段非法/缺席 → 不产出 graph 段。合并层（ADR-0084）：`graph` 属用户层键，
 * 项目文件里的 graph 段被允许名单丢弃，永不覆盖 user 值。
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIknowSettings } from "../../src/config/settings.ts";
import { resolveGraphMode } from "../../src/harness/graph/mode.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-graph-settings-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown>
): Promise<{ home: string; cwd: string }> {
  const home = join(workDir, "home", Math.random().toString(36).slice(2));
  const cwd = join(workDir, "cwd", Math.random().toString(36).slice(2));
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

describe("settings.graph — parse (D-α T2)", () => {
  it("graph.enabled=true → 出 graph 段", async () => {
    const { home, cwd } = await makeSettings({ graph: { enabled: true } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      graph: { enabled: true },
    });
  });

  it("graph.enabled 非 boolean → 丢弃该字段 → 不产出 graph 段", async () => {
    const { home, cwd } = await makeSettings({ graph: { enabled: "yes" } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("graph 非普通对象 → 丢弃该层", async () => {
    const { home, cwd } = await makeSettings({ graph: [1, 2] }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("未知子字段被忽略（只认 enabled）", async () => {
    const { home, cwd } = await makeSettings(
      { graph: { enabled: false, nope: 1 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      graph: { enabled: false },
    });
  });
});

describe("settings.graph — 项目层不参与（ADR-0084 允许名单）", () => {
  it("project 的 graph 段被丢弃且发警告 → user 值胜出（非 project 覆盖）", async () => {
    const { home, cwd } = await makeSettings(
      { graph: { enabled: true } },
      { graph: { enabled: false } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { graph: { enabled: true } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"graph"/);
  });

  it("project 非法 graph 值同样被丢弃 → 不抹掉 user 值", async () => {
    const { home, cwd } = await makeSettings(
      { graph: { enabled: true } },
      { graph: { enabled: 1 } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { graph: { enabled: true } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"graph"/);
  });
});

describe("settings.graph — 初值链落到 holder", () => {
  it("缺席 → resolveGraphMode 默认关", async () => {
    const { home, cwd } = await makeSettings({}, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(resolveGraphMode({ settings: settings.graph }).enabled, false);
  });

  it("settings.graph.enabled=true → 新会话初值开", async () => {
    const { home, cwd } = await makeSettings({ graph: { enabled: true } }, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(resolveGraphMode({ settings: settings.graph }).enabled, true);
  });
});
