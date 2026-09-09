/**
 * user agents 目录 (~/.iknow/agents/) 扫描 + merged catalog resolver 单测。
 *
 * 覆盖:
 *   - 目录缺失 → 空数组 (静默, 纯 builtin 字节级等价)
 *   - 目录布局 <id>/AGENTS.md 与平铺 <id>.md 双支持
 *   - frontmatter description / bashMode / disallowedTools 解析 + 非法值降级
 *   - 无 frontmatter → 整文件 body + description 兜底
 *   - 空 body → skip + warn; 非角色目录 (无 AGENTS.md) → 静默跳过
 *   - id 冲突 (dir vs file) → 排序序先到者赢 + warn
 *   - createMergedCatalogResolver: builtin 在前 / user 追加 / 同名 id 冲突
 *     保留 builtin + warn; 非法 id warn + skip
 *   - 记忆化: 同 agentsDir 二次调用不重扫, resetUserAgentsCache() 后重扫
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

function makeAgentsDir(): string {
  return mkdtempSync(path.join(tmpdir(), "iknow-user-agents-"));
}

function scanOpts(agentsDir: string): UserAgentScanOptions {
  return { agentsDir, warn: () => {} };
}

/** builtin explore 的 persona body（冲突测试断言 builtin 被保留）。 */
function builtinExploreBody(): string {
  return resolveAgentCatalog().find((e) => e.id === "explore")!.body;
}

let dir: string;
beforeEach(() => {
  dir = makeAgentsDir();
  resetUserAgentsCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
    // sorted: "clash" (dir) < "clash.md" → dir 版本赢
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
