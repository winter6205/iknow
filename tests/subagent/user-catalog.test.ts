/**
 * Unit tests for the user agents dir scan and the merged catalog resolver.
 *
 * Covers:
 *   - missing dir -> empty array (silent; byte-equivalent to builtin-only)
 *   - both layouts supported: <id>/AGENTS.md and flat <id>.md
 *   - frontmatter description / bashMode / disallowedTools parsing + invalid-value degradation
 *   - no frontmatter -> whole file as body + description fallback
 *   - empty body -> skip + warn; non-role dir (no AGENTS.md) -> silent skip
 *   - id clash (dir vs file) -> first in sort order wins + warn
 *   - createMergedCatalogResolver: builtins first / user appended / same-id clash
 *     keeps builtin + warn; invalid id warn + skip
 *   - memoization: second call with same agentsDir does not rescan; resetUserAgentsCache() forces rescan
 *   - entry / resolver frozen
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadUserAgentEntries,
  createMergedCatalogResolver,
  resetUserAgentsCache,
  resolveUserAgentsDir,
  type UserAgentScanOptions,
} from "../../src/harness/subagent/user-catalog.ts";
import {
  resolveAgentCatalog,
  AgentCatalogLookupError,
} from "../../src/harness/subagent/catalog.ts";
import { resolveSubagentCapabilities } from "../../src/harness/subagent/capability.ts";

function makeAgentsDir(): string {
  return mkdtempSync(path.join(tmpdir(), "iknow-user-agents-"));
}

/**
 * Isolated scan params: each test uses a temp `home` (no ~/.iknow/plugins
 * ledger, no user agent dir) so createMergedCatalogResolver's default path
 * (ledger first + dir-scan fallback) never reads locally installed plugins.
 * Old tests isolated via `agentsDir` + implicit `homedir()`, enough to skip
 * the user-agent scan, but enumeratePluginAgentDirs is ledger-aware and
 * would read the real `<home>/.iknow/plugins/installed_plugins.json` — it
 * must be isolated too.
 */
let isoHome: string;
function scanOpts(agentsDir: string): UserAgentScanOptions {
  return { agentsDir, home: isoHome, warn: () => {} };
}

/** Builtin explore persona body (clash tests assert the builtin is kept). */
function builtinExploreBody(): string {
  return resolveAgentCatalog().find((e) => e.id === "explore")!.body;
}

let dir: string;
beforeEach(() => {
  dir = makeAgentsDir();
  // Isolate home: a temp dir without a ~/.iknow/plugins subtree, so
  // enumeratePluginAgentDirs cannot see locally installed plugins
  // (needed since the default path became ledger-aware).
  isoHome = mkdtempSync(path.join(tmpdir(), "iknow-user-iso-home-"));
  resetUserAgentsCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(isoHome, { recursive: true, force: true });
  resetUserAgentsCache();
});

describe("loadUserAgentEntries: 扫描", () => {
  it("目录缺失 → 空数组 (静默)", () => {
    const missing = path.join(dir, "not-there");
    assert.deepEqual(loadUserAgentEntries(scanOpts(missing)), []);
  });

  it("目录布局 <id>/AGENTS.md → entry (id = 目录名)", () => {
    mkdirSync(path.join(dir, "reviewer"));
    writeFileSync(
      path.join(dir, "reviewer", "AGENTS.md"),
      "You are a reviewer."
    );
    const entries = loadUserAgentEntries(scanOpts(dir));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.id, "reviewer");
    assert.equal(entries[0]!.body, "You are a reviewer.");
  });

  it("平铺 <id>.md → entry (id = basename)", () => {
    writeFileSync(path.join(dir, "planner.md"), "You are a planner.");
    const entries = loadUserAgentEntries(scanOpts(dir));
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.id, "planner");
  });

  it("frontmatter 全键解析: description / bashMode / disallowedTools", () => {
    mkdirSync(path.join(dir, "auditor"));
    writeFileSync(
      path.join(dir, "auditor", "AGENTS.md"),
      "---\ndescription: Audit only.\nbashMode: readonly\ndisallowedTools: edit_file, write_file\n---\n\nBody here."
    );
    const [entry] = loadUserAgentEntries(scanOpts(dir));
    assert.equal(entry!.description, "Audit only.");
    assert.equal(entry!.bashMode, "readonly");
    assert.deepEqual(entry!.disallowedTools, ["edit_file", "write_file"]);
    assert.equal(entry!.body, "Body here.");
  });

  it("无 frontmatter → 整文件 body + description 兜底", () => {
    writeFileSync(path.join(dir, "plain.md"), "Just a body.");
    const [entry] = loadUserAgentEntries(scanOpts(dir));
    assert.equal(entry!.body, "Just a body.");
    assert.equal(entry!.description, "User-defined subagent role 'plain'.");
    assert.equal(entry!.bashMode, undefined);
    assert.equal(entry!.disallowedTools, undefined);
  });

  it("非法 bashMode → warn + 视为 undefined (不炸装配)", () => {
    const warnings: string[] = [];
    writeFileSync(path.join(dir, "bad.md"), "---\nbashMode: magic\n---\nbody");
    const [entry] = loadUserAgentEntries({
      agentsDir: dir,
      warn: (m) => warnings.push(m),
    });
    assert.equal(entry!.bashMode, undefined);
    assert.equal(warnings.length, 1);
  });

  it("空 body → skip + warn", () => {
    const warnings: string[] = [];
    writeFileSync(path.join(dir, "empty.md"), "---\ndescription: x\n---\n");
    const entries = loadUserAgentEntries({
      agentsDir: dir,
      warn: (m) => warnings.push(m),
    });
    assert.deepEqual(entries, []);
    assert.equal(warnings.length, 1);
  });

  it("目录无 AGENTS.md → 静默跳过 (不是角色目录)", () => {
    mkdirSync(path.join(dir, "not-an-agent"));
    assert.deepEqual(loadUserAgentEntries(scanOpts(dir)), []);
  });

  it("id 冲突 dir vs file → 排序序先到者赢 + warn", () => {
    const warnings: string[] = [];
    mkdirSync(path.join(dir, "clash"));
    writeFileSync(path.join(dir, "clash", "AGENTS.md"), "from dir");
    writeFileSync(path.join(dir, "clash.md"), "from file");
    const entries = loadUserAgentEntries({
      agentsDir: dir,
      warn: (m) => warnings.push(m),
    });
    assert.equal(entries.length, 1);
    // sorted: "clash" (dir) < "clash.md" -> the dir version wins
    assert.equal(entries[0]!.body, "from dir");
    assert.equal(warnings.length, 1);
  });

  it("entry 与 disallowedTools frozen", () => {
    mkdirSync(path.join(dir, "frozen"));
    writeFileSync(
      path.join(dir, "frozen", "AGENTS.md"),
      "---\ndisallowedTools: edit_file\n---\nbody"
    );
    const [entry] = loadUserAgentEntries(scanOpts(dir));
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry!.disallowedTools), true);
  });
});

describe("createMergedCatalogResolver: builtin + user 合并", () => {
  it("无用户角色 → list 等价 builtin (顺序含)", () => {
    const resolver = createMergedCatalogResolver(scanOpts(dir));
    assert.deepEqual(
      resolver.list().map((e) => e.id),
      resolveAgentCatalog().map((e) => e.id)
    );
  });

  it("user 新 id 追加在 builtin 之后", () => {
    writeFileSync(path.join(dir, "extra.md"), "extra body");
    const resolver = createMergedCatalogResolver(scanOpts(dir));
    const ids = resolver.list().map((e) => e.id);
    assert.deepEqual(ids.slice(0, 2), ["explore", "general-purpose"]);
    assert.ok(ids.includes("extra"));
    assert.equal(resolver.get("extra").body, "extra body");
  });

  it("user 同名 id 与 builtin 冲突 → 保留 builtin + warn (不覆盖)", () => {
    const warnings: string[] = [];
    mkdirSync(path.join(dir, "explore"));
    writeFileSync(path.join(dir, "explore", "AGENTS.md"), "custom explore");
    const resolver = createMergedCatalogResolver({
      agentsDir: dir,
      warn: (m) => warnings.push(m),
    });
    assert.equal(resolver.get("explore").body, builtinExploreBody());
    assert.equal(resolver.list().filter((e) => e.id === "explore").length, 1);
    assert.equal(warnings.length, 1);
  });

  it("非法角色 id (空格/点) → warn + skip", () => {
    const warnings: string[] = [];
    writeFileSync(path.join(dir, "My Role.md"), "spaced");
    writeFileSync(path.join(dir, ".hidden.md"), "dotted");
    const entries = loadUserAgentEntries({
      agentsDir: dir,
      warn: (m) => warnings.push(m),
    });
    assert.deepEqual(entries, []);
    assert.equal(warnings.length, 2);
  });

  it("未知 id → AgentCatalogLookupError (typed, fail-fast)", () => {
    const resolver = createMergedCatalogResolver(scanOpts(dir));
    assert.throws(() => resolver.get("nope"), AgentCatalogLookupError);
  });

  it("resolver 与 merged list frozen", () => {
    writeFileSync(path.join(dir, "f.md"), "body");
    const resolver = createMergedCatalogResolver(scanOpts(dir));
    assert.equal(Object.isFrozen(resolver), true);
    assert.equal(Object.isFrozen(resolver.list()), true);
  });

  it("记忆化: 同 agentsDir 不重扫, reset 后重扫", () => {
    writeFileSync(path.join(dir, "one.md"), "one");
    const first = createMergedCatalogResolver(scanOpts(dir));
    assert.ok(first.list().some((e) => e.id === "one"));

    writeFileSync(path.join(dir, "two.md"), "two");
    const cached = createMergedCatalogResolver(scanOpts(dir));
    assert.ok(!cached.list().some((e) => e.id === "two"));

    resetUserAgentsCache();
    const refreshed = createMergedCatalogResolver(scanOpts(dir));
    assert.ok(refreshed.list().some((e) => e.id === "two"));
  });
});

describe("resolveUserAgentsDir", () => {
  it("agentsDir 显式覆盖优先于 home", () => {
    assert.equal(
      resolveUserAgentsDir({ agentsDir: "/x/agents", home: "/home/u" }),
      path.resolve("/x/agents")
    );
    assert.equal(
      resolveUserAgentsDir({ home: "/home/u" }),
      path.join("/home/u", ".iknow", "agents")
    );
  });
});

// ─── plugin agent loading ───────────────────────────────────────────────────

describe("createMergedCatalogResolver × plugin agents", () => {
  it("pluginAgentDirs 注入 → canonical id 进 list, 裸名别名单独命中", () => {
    const pluginDir = path.join(dir, "plugA", "agents");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      path.join(pluginDir, "reviewer.md"),
      "You are PLUGIN REVIEWER."
    );

    const resolver = createMergedCatalogResolver({
      agentsDir: dir,
      pluginAgentDirs: [pluginDir],
      pluginNames: ["plugA"],
      warn: () => {},
    });

    const ids = resolver.list().map((e) => e.id);
    // canonical id is in the list; builtins still come first
    assert.ok(ids.includes("plugA:reviewer"));
    assert.ok(ids.includes("explore"));

    // canonical get
    assert.equal(
      resolver.get("plugA:reviewer").body,
      "You are PLUGIN REVIEWER."
    );
    // bare alias also matches
    assert.equal(resolver.get("reviewer").body, "You are PLUGIN REVIEWER.");
  });

  it("裸名别名与 builtin 冲突 → 丢别名 + warn (canonical 仍在)", () => {
    const pluginDir = path.join(dir, "plugA", "agents");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, "explore.md"), "hostile plugin explore");
    const warnings: string[] = [];
    const resolver = createMergedCatalogResolver({
      agentsDir: dir,
      pluginAgentDirs: [pluginDir],
      pluginNames: ["plugA"],
      warn: (m) => warnings.push(m),
    });

    // canonical `plugA:explore` does not collide with builtin `explore` -> plugin entry kept
    assert.equal(resolver.get("plugA:explore").body, "hostile plugin explore");
    // bare alias `explore` collides with builtin -> builtin wins, plugin bare alias dropped + warn
    const builtinExplore = resolver.get("explore");
    assert.notEqual(builtinExplore.body, "hostile plugin explore");
    assert.ok(warnings.some((w) => /collides with earlier entry/.test(w)));
  });

  it("多插件裸名别名冲突 → 丢后到者别名 + warn (canonical 都留)", () => {
    const aDir = path.join(dir, "plugA", "agents");
    const bDir = path.join(dir, "plugB", "agents");
    mkdirSync(aDir, { recursive: true });
    mkdirSync(bDir, { recursive: true });
    writeFileSync(path.join(aDir, "shared.md"), "from A");
    writeFileSync(path.join(bDir, "shared.md"), "from B");
    const warnings: string[] = [];
    const resolver = createMergedCatalogResolver({
      agentsDir: dir,
      pluginAgentDirs: [aDir, bDir],
      pluginNames: ["plugA", "plugB"],
      warn: (m) => warnings.push(m),
    });

    // canonical ids each hit their own entry
    assert.equal(resolver.get("plugA:shared").body, "from A");
    assert.equal(resolver.get("plugB:shared").body, "from B");
    // bare alias 'shared' -> first arrival (A) wins
    assert.equal(resolver.get("shared").body, "from A");
    // B's alias dropped -> warn
    assert.ok(warnings.some((w) => /collides with earlier entry/.test(w)));
  });

  it("canonical id 与 user 已用同名 id 撞 → 丢整条 plugin entry + warn", () => {
    // user takes the name 'plugA:reviewer'
    writeFileSync(path.join(dir, "plugA:reviewer.md"), "user override");
    const pluginDir = path.join(dir, "plugA", "agents");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, "reviewer.md"), "from plugin");
    const warnings: string[] = [];
    const resolver = createMergedCatalogResolver({
      agentsDir: dir,
      pluginAgentDirs: [pluginDir],
      pluginNames: ["plugA"],
      warn: (m) => warnings.push(m),
    });
    // user entry wins
    assert.equal(resolver.get("plugA:reviewer").body, "user override");
    // warn (plugin collides with the earlier user entry)
    assert.ok(warnings.some((w) => /collides with earlier entry/.test(w)));
  });

  it("ROLE_ID_PATTERN 允许 ':' — 插件 agent 含 ':' 的 canonical id 不被丢", () => {
    const pluginDir = path.join(dir, "plugA", "agents");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, "reviewer.md"), "namespace body");
    const resolver = createMergedCatalogResolver({
      agentsDir: dir,
      pluginAgentDirs: [pluginDir],
      pluginNames: ["plugA"],
      warn: () => {},
    });
    // 'plugA:reviewer' contains ':' -> old ROLE_ID_PATTERN would reject; new one must accept
    assert.equal(resolver.get("plugA:reviewer").body, "namespace body");
  });

  it("resetUserAgentsCache 同时清 user + plugin 缓存", () => {
    const pluginDir = path.join(dir, "plugA", "agents");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, "first.md"), "first");
    const first = createMergedCatalogResolver({
      agentsDir: dir,
      pluginAgentDirs: [pluginDir],
      pluginNames: ["plugA"],
      warn: () => {},
    });
    assert.ok(first.list().some((e) => e.id === "plugA:first"));

    // add a new file without reset -> cache hit, second is invisible
    writeFileSync(path.join(pluginDir, "second.md"), "second");
    const cached = createMergedCatalogResolver({
      agentsDir: dir,
      pluginAgentDirs: [pluginDir],
      pluginNames: ["plugA"],
      warn: () => {},
    });
    assert.ok(!cached.list().some((e) => e.id === "plugA:second"));

    // reset -> reload -> visible
    resetUserAgentsCache();
    const refreshed = createMergedCatalogResolver({
      agentsDir: dir,
      pluginAgentDirs: [pluginDir],
      pluginNames: ["plugA"],
      warn: () => {},
    });
    assert.ok(refreshed.list().some((e) => e.id === "plugA:second"));
  });

  it("ledger-only 默认路径 (review C1): 不传 pluginAgentDirs 也能看见 ledger agent, capability 同源解析", () => {
    // Real end-to-end probe: <root>/installed_plugins.json points to a dir
    // not discoverable by root scan (installed under cache/...); the default
    // path (no pluginAgentDirs) must load agents namespaced by ledger name.
    // The old bug: enumeratePluginAgentDirs fell back to dir scanning and
    // missed ledger-named agents -> resolver.list() omitted them and
    // capability threw catalogError.
    const home = path.join(dir, "home");
    const pluginRoot = path.join(home, ".iknow", "plugins");
    const pluginInstallPath = path.join(dir, "cache", "ledgerplugin");
    mkdirSync(pluginRoot, { recursive: true });
    mkdirSync(path.join(pluginInstallPath, "agents"), { recursive: true });
    writeFileSync(
      path.join(pluginInstallPath, "agents", "reviewer.md"),
      "---\nbashMode: readonly\ndisallowedTools: edit_file\n---\nLedger reviewer body."
    );
    writeFileSync(
      path.join(pluginRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ledgerplugin@official": [
            {
              scope: "user",
              installPath: pluginInstallPath,
              version: "0.1.0",
            },
          ],
        },
      })
    );

    const resolver = createMergedCatalogResolver({
      home,
      agentsDir: dir,
      warn: () => {},
    });

    // canonical id in list (namespace = ledger key prefix)
    const ids = resolver.list().map((e) => e.id);
    assert.ok(
      ids.includes("ledgerplugin:reviewer"),
      `expected ledgerplugin:reviewer in list, got: ${ids.join(", ")}`
    );

    // canonical get matches
    const entry = resolver.get("ledgerplugin:reviewer");
    assert.equal(entry.body, "Ledger reviewer body.");
    assert.equal(entry.bashMode, "readonly");
    assert.deepEqual([...(entry.disallowedTools ?? [])], ["edit_file"]);

    // Key assertion: the capability-resolution side shares the same source —
    // resolving the ledgerplugin:reviewer role through this same resolver
    // yields bashMode/disallowedTools instead of catalogError, reusing the
    // same default path as build-engine / the spawn factory.
    // resolveSubagentCapabilities normally uses createMergedCatalogResolver
    // with no opts; here we pass our resolver as opts.catalog to assert the
    // same resolver exposes bashMode for capability, while the
    // enum-derivation side is that very resolver.list().
    const capabilities = resolveSubagentCapabilities({
      role: "ledgerplugin:reviewer",
      catalog: resolver,
    });
    assert.equal(capabilities.bashMode, "readonly");
    assert.equal(capabilities.catalogRole, "ledgerplugin:reviewer");
    assert.equal(
      capabilities.catalogError,
      undefined,
      "C1 修复：ledger agent 必须在 capability 解析面同源可查"
    );
    assert.deepEqual([...(capabilities.disallowedTools ?? [])], ["edit_file"]);
  });
});
