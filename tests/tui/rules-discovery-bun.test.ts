/**
 * tests/tui/rules-discovery-bun.test.ts
 *
 * bun regression: rules discovery must tolerate missing directories under the
 * **bun runtime** too (tests/tui runs on bun:test).
 *
 * Root cause: bun's `fs.promises.opendir` is lazy — a nonexistent directory
 * does not throw at opendir itself (Node throws eagerly); the ENOENT (syscall
 * "scandir") only surfaces while `for await` iterates the Dir. If safeDir in
 * discovery.ts guarded only opendir, `listRulesFiles(<missing>)` would blow
 * ENOENT into the buildTuiDeps assembly chain → all 15 buildTuiDeps tests in
 * `bun test tests/tui/` fail together (pre-existing on master). The contract
 * itself lives in tests/harness/memory/discovery.test.ts (vitest/node side,
 * same cases): a missing rules dir = empty rule set, no throw.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRulesFiles } from "../../src/harness/memory/index.js";

describe("listRulesFiles — 缺失目录容忍（bun lazy opendir 回归）", () => {
  const roots: string[] = [];

  test("user scope：userHome 不存在 → 空数组，不抛", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rules-bun-"));
    roots.push(root);
    // <root>/home is never created — the whole userHome is absent
    const out = await listRulesFiles(join(root, "home"), "user");
    expect(out).toEqual([]);
  });

  test("project scope：<cwd>/.iknow/rules 缺失 → 空数组，不抛", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rules-bun-"));
    roots.push(root);
    const out = await listRulesFiles(root, "project");
    expect(out).toEqual([]);
  });

  test("对照：目录存在但为空 → 空数组（行为不变）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rules-bun-"));
    roots.push(root);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, ".iknow", "rules"), { recursive: true });
    const out = await listRulesFiles(root, "project");
    expect(out).toEqual([]);
  });
});
