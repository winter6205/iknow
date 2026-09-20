/**
 * plugin/roots.ts — discovery-layer unit tests.
 *
 * Covers:
 *   - resolvePluginRoots ordered merge + dedupe, silently skipping missing roots;
 *   - env IKNOW_PLUGIN_ROOTS (path.delimiter separated);
 *   - settings.plugins.roots;
 *   - default <home>/.iknow/plugins;
 *   - discoverPlugins ledger precedence (user scope / last-entry fallback /
 *     non-absolute installPath / unreadable / corrupt JSON → fallback /
 *     multiple versions / names containing @);
 *   - directory-scan fallback (direct layout + nested <plugin>/<version> layout);
 *   - skipping node_modules / .git / hidden / names containing : / symlinks;
 *   - disabled filtering;
 *   - enumeratePluginAgentDirs (sync path) — both direct and nested layouts.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolvePluginRoots,
  discoverPlugins,
  enumeratePluginAgentDirs,
} from "../../../src/harness/plugin/roots.ts";
import type { IknowSettings } from "../../../src/config/settings.ts";

let work: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "iknow-plugin-roots-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Create a directory under work and return its absolute path. */
function dir(...parts: string[]): string {
  const d = path.join(work, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Write a string file at path (utf8). */
function file(p: string, body: string): void {
  writeFileSync(p, body, "utf8");
}

describe("resolvePluginRoots", () => {
  it("无任何配置 → 只看默认 <home>/.iknow/plugins,不存在则空数组", () => {
    const home = dir("home");
    assert.deepEqual(resolvePluginRoots({ userHome: home }), []);
  });

  it("默认 <home>/.iknow/plugins 存在 → 出现在结果里", () => {
    const home = dir("home");
    const defaultRoot = dir("home", ".iknow", "plugins");
    assert.deepEqual(resolvePluginRoots({ userHome: home }), [
      path.resolve(defaultRoot),
    ]);
  });

  it("显式 pluginRoots > env > settings > default 顺序合并去重", () => {
    const home = dir("home");
    const defaultRoot = dir("home", ".iknow", "plugins");
    const settingsRoot = dir("settings-root");
    const envRoot = dir("env-root");
    const explicitRoot = dir("explicit-root");

    const settings: Pick<IknowSettings, "plugins"> = {
      plugins: { roots: [settingsRoot, defaultRoot] },
    };

    const result = resolvePluginRoots({
      userHome: home,
      pluginRoots: [explicitRoot, settingsRoot], // explicit + settings overlap → deduped
      env: { IKNOW_PLUGIN_ROOTS: [envRoot, defaultRoot].join(path.delimiter) },
      settings,
    });

    // Order: explicit > env > settings > default;
    // settingsRoot was already added via pluginRoots → deduped at the
    // settings stage; defaultRoot was already added via env → deduped at the
    // default stage.
    assert.deepEqual(result, [
      path.resolve(explicitRoot),
      path.resolve(settingsRoot),
      path.resolve(envRoot),
      path.resolve(defaultRoot),
    ]);
  });

  it("根不存在 → 静默跳过（不告警）", () => {
    const home = dir("home");
    const missing = dir("missing"); // deleted right away
    rmSync(missing, { recursive: true, force: true });
    const result = resolvePluginRoots({
      userHome: home,
      pluginRoots: [missing],
    });
    assert.deepEqual(result, []);
  });

  it("env IKNOW_PLUGIN_ROOTS 多项 path.delimiter 分隔 + 空白 trim", () => {
    const home = dir("home");
    const a = dir("a");
    const b = dir("b");
    const result = resolvePluginRoots({
      userHome: home,
      env: { IKNOW_PLUGIN_ROOTS: ` ${a} ${path.delimiter}  ${b}  ` },
    });
    assert.deepEqual(result, [path.resolve(a), path.resolve(b)]);
  });
});

describe("discoverPlugins — ledger", () => {
  it("ledger version=2, key='<plugin>@<marketplace>', 多条取 user scope 优先", async () => {
    const root = dir("ledger-root");
    const pluginPath = dir("ledger-root", "myplugin");
    file(
      path.join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "myplugin@official": [
            {
              scope: "project",
              installPath: path.join(root, "old-version"),
              version: "0.1.0",
            },
            {
              scope: "user",
              installPath: pluginPath,
              version: "0.2.0",
            },
          ],
        },
      })
    );

    const result = await discoverPlugins(root);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], {
      name: "myplugin",
      root: pluginPath,
      marketplace: "official",
      version: "0.2.0",
    });
  });

  it("ledger 多条无 user scope → 取末项", async () => {
    const root = dir("ledger-root");
    const lastPath = dir("ledger-root", "last");
    file(
      path.join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "myplugin@official": [
            {
              scope: "project",
              installPath: path.join(root, "v1"),
              version: "0.1.0",
            },
            { scope: "other", installPath: lastPath, version: "0.3.0" },
          ],
        },
      })
    );
    const result = await discoverPlugins(root);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.root, lastPath);
    assert.equal(result[0]?.version, "0.3.0");
  });

  it("ledger.installPath 非绝对 → 跳过该条 + warn", async () => {
    const root = dir("ledger-root");
    const warnings: string[] = [];
    file(
      path.join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "badplugin@official": [
            { scope: "user", installPath: "relative/path", version: "0.1.0" },
          ],
        },
      })
    );
    const result = await discoverPlugins(root, {
      warn: (m) => warnings.push(m),
    });
    assert.deepEqual(result, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /not absolute/);
  });

  it("ledger.installPath 不存在 → 跳过该条 + warn", async () => {
    const root = dir("ledger-root");
    const warnings: string[] = [];
    file(
      path.join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "myplugin@official": [
            {
              scope: "user",
              installPath: path.join(root, "never-created"),
              version: "0.1.0",
            },
          ],
        },
      })
    );
    const result = await discoverPlugins(root, {
      warn: (m) => warnings.push(m),
    });
    assert.deepEqual(result, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /unreadable/);
  });

  it("ledger JSON 损坏 → fallback 到目录扫描 + warn", async () => {
    const root = dir("ledger-root");
    const pluginPath = dir("ledger-root", "scanplugin");
    mkdirSync(path.join(pluginPath, "skills"), { recursive: true });
    file(path.join(root, "installed_plugins.json"), "{ broken json");
    const warnings: string[] = [];
    const result = await discoverPlugins(root, {
      warn: (m) => warnings.push(m),
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, "scanplugin");
    assert.ok(warnings.some((w) => /corrupt/i.test(w)));
  });
});

describe("discoverPlugins — directory scan fallback", () => {
  it("直接布局: <root>/<plugin>/skills", async () => {
    const root = dir("scan-root");
    const a = dir("scan-root", "plugA", "skills");
    const b = dir("scan-root", "plugB", "agents");
    const result = await discoverPlugins(root);
    const names = result.map((p) => p.name).sort();
    assert.deepEqual(names, ["plugA", "plugB"]);
    assert.ok(result.some((p) => p.root === path.resolve(path.dirname(a))));
    assert.ok(result.some((p) => p.root === path.resolve(path.dirname(b))));
  });

  it("嵌套布局: <root>/<plugin>/<version>/agents", async () => {
    const root = dir("scan-root");
    dir("scan-root", "plugA", "0.2.0", "agents");
    dir("scan-root", "plugA", "0.2.0", "skills"); // dual-component layout still holds
    const result = await discoverPlugins(root);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, "plugA");
    assert.equal(
      result[0]?.root,
      path.resolve(path.join(root, "plugA", "0.2.0"))
    );
  });

  it("嵌套布局: 多于一个版本目录 → skip (不猜)", async () => {
    const root = dir("scan-root");
    dir("scan-root", "plugA", "0.1.0", "agents");
    dir("scan-root", "plugA", "0.2.0", "agents");
    const result = await discoverPlugins(root);
    assert.deepEqual(result, []);
  });

  it("跳过: node_modules, .git, .hidden, :colon, symlink", async () => {
    const root = dir("scan-root");
    const good = dir("scan-root", "good", "skills");
    dir("scan-root", "node_modules", "skills");
    dir("scan-root", ".git", "skills");
    dir("scan-root", ".hidden", "skills");
    dir("scan-root", "WSL:shadow", "skills");
    try {
      symlinkSync(good, path.join(root, "symlink-good"), "dir");
    } catch {
      // Some WSL environments disallow dir symlinks → skip that assertion branch.
    }
    const result = await discoverPlugins(root);
    const names = result.map((p) => p.name).sort();
    assert.deepEqual(names, ["good"]);
  });
});

describe("discoverPlugins — disabled filter (review C2)", () => {
  it("ledger 解析后, 同步 enumeratePluginAgentDirs 嵌套布局下的 disabled 过滤", () => {
    // Previously opts.disabled was only checked in the direct layout, missing
    // nested <root>/<plugin>/<version>/agents. Now a single check gates both
    // layouts.
    const root = dir("sync-root");
    // Write a ledger whose installPath points into a directory with a nested version dir
    const pluginAInstall = dir("sync-root", "plugA", "0.1.0");
    const pluginBInstall = dir("sync-root", "plugB", "0.2.0");
    mkdirSync(path.join(pluginAInstall, "agents"), { recursive: true });
    mkdirSync(path.join(pluginBInstall, "agents"), { recursive: true });
    writeFileSync(
      path.join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "plugA@official": [
            {
              scope: "user",
              installPath: pluginAInstall,
              version: "0.1.0",
            },
          ],
          "plugB@official": [
            {
              scope: "user",
              installPath: pluginBInstall,
              version: "0.2.0",
            },
          ],
        },
      })
    );
    const out = enumeratePluginAgentDirs([root], {
      disabled: new Set(["plugA"]),
    });
    // plugA is filtered in the nested layout too
    assert.equal(out.length, 1);
    assert.equal(out[0]!.plugin, "plugB");
    assert.equal(
      out[0]!.dir,
      path.resolve(path.join(pluginBInstall, "agents"))
    );
  });

  it("直接布局 (扫描兜底) 的 disabled 过滤仍生效 (回归)", () => {
    const root = dir("sync-root");
    dir("sync-root", "plugA", "agents");
    dir("sync-root", "plugB", "agents");
    const out = enumeratePluginAgentDirs([root], {
      disabled: new Set(["plugA"]),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.plugin, "plugB");
  });
});

describe("enumeratePluginAgentDirs (sync path)", () => {
  it("直接布局: <root>/<plugin>/agents", () => {
    const root = dir("sync-root");
    dir("sync-root", "plugA", "agents");
    dir("sync-root", "plugB", "skills"); // skills only → skipped
    const out = enumeratePluginAgentDirs([root]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.plugin, "plugA");
  });

  it("嵌套布局: <root>/<plugin>/<version>/agents", () => {
    const root = dir("sync-root");
    dir("sync-root", "plugA", "1.0.0", "agents");
    const out = enumeratePluginAgentDirs([root]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.plugin, "plugA");
    assert.equal(
      out[0]!.dir,
      path.resolve(path.join(root, "plugA", "1.0.0", "agents"))
    );
  });

  it("ledger 优先 (review C1): 根下无 scan 可见插件, 但 ledger 指向其他位置 → 以 ledger 名加载", () => {
    // Realistic ledger-only layout: <root> contains no plugin directories at
    // all and installPath points somewhere entirely different (simulating
    // cache/<marketplace>/<plugin>/<ver>/)
    const root = dir("sync-root");
    const pluginInstall = dir("cache", "ledgerplug", "0.1.0");
    mkdirSync(path.join(pluginInstall, "agents"), { recursive: true });
    writeFileSync(
      path.join(root, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ledgerplug@official": [
            {
              scope: "user",
              installPath: pluginInstall,
              version: "0.1.0",
            },
          ],
        },
      })
    );
    const out = enumeratePluginAgentDirs([root]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.plugin, "ledgerplug");
    assert.equal(out[0]!.dir, path.resolve(path.join(pluginInstall, "agents")));
  });

  it("disabled 过滤", () => {
    const root = dir("sync-root");
    dir("sync-root", "plugA", "agents");
    dir("sync-root", "plugB", "agents");
    const out = enumeratePluginAgentDirs([root], {
      disabled: new Set(["plugA"]),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.plugin, "plugB");
  });

  it("根不存在 → []", () => {
    const out = enumeratePluginAgentDirs([path.join(work, "missing")]);
    assert.deepEqual(out, []);
  });
});
