/**
 * plugin/catalog.ts — data-plane unit tests.
 *
 * Verifies createPluginCatalog splits PluginInstallation[] into three
 * surfaces, each populated only when the subdirectory/file actually exists.
 * The result is frozen.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPluginCatalog } from "../../../src/harness/plugin/catalog.ts";
import type { PluginInstallation } from "../../../src/harness/plugin/roots.ts";

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "iknow-plugin-catalog-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("createPluginCatalog", () => {
  it("空安装列表 → 三面均空数组", () => {
    const c = createPluginCatalog([]);
    assert.deepEqual(c.skillDirs, []);
    assert.deepEqual(c.agentDirs, []);
    assert.deepEqual(c.hooksFiles, []);
    assert.equal(Object.isFrozen(c), true);
    assert.equal(Object.isFrozen(c.skillDirs), true);
    assert.equal(Object.isFrozen(c.agentDirs), true);
    assert.equal(Object.isFrozen(c.hooksFiles), true);
  });

  it("每个插件按子目录存在与否拆分到三面", () => {
    const aSkills = path.join(work, "plugA", "skills");
    const aAgents = path.join(work, "plugA", "agents");
    const aHooks = path.join(work, "plugA", "hooks");
    mkdirSync(aSkills, { recursive: true });
    mkdirSync(aAgents, { recursive: true });
    mkdirSync(aHooks, { recursive: true });
    writeFileSync(path.join(aHooks, "hooks.json"), "{}");

    // plugB has skills/agents only, no hooks
    mkdirSync(path.join(work, "plugB", "skills"), { recursive: true });
    mkdirSync(path.join(work, "plugB", "agents"), { recursive: true });

    // plugC has skills only (the typical skill-only plugin shape)
    mkdirSync(path.join(work, "plugC", "skills"), { recursive: true });

    const installations: PluginInstallation[] = [
      { name: "plugA", root: path.join(work, "plugA") },
      { name: "plugB", root: path.join(work, "plugB") },
      { name: "plugC", root: path.join(work, "plugC") },
    ];
    const c = createPluginCatalog(installations);
    assert.deepEqual(c.skillDirs, [
      aSkills,
      path.join(work, "plugB", "skills"),
      path.join(work, "plugC", "skills"),
    ]);
    assert.deepEqual(c.agentDirs, [
      aAgents,
      path.join(work, "plugB", "agents"),
    ]);
    assert.deepEqual(c.hooksFiles, [path.join(aHooks, "hooks.json")]);
  });

  it("installations 顺序保留（三面都按 installations 入参顺序）", () => {
    mkdirSync(path.join(work, "z", "skills"), { recursive: true });
    mkdirSync(path.join(work, "a", "skills"), { recursive: true });
    const installations: PluginInstallation[] = [
      { name: "z", root: path.join(work, "z") },
      { name: "a", root: path.join(work, "a") },
    ];
    const c = createPluginCatalog(installations);
    assert.deepEqual(c.skillDirs, [
      path.join(work, "z", "skills"),
      path.join(work, "a", "skills"),
    ]);
  });
});
