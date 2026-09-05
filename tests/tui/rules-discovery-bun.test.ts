/**
 * tests/tui/rules-discovery-bun.test.ts
 *
 * bun 回归测试（D2 裁决：tests/tui 由 bun:test 驱动）：rules 发现对缺失目录
 * 的容忍契约在 **bun 运行时** 下必须成立。
 *
 * 根因背景：bun 的 `fs.promises.opendir` 是 lazy 的——目录不存在时 opendir
 * 本身不抛（Node 下 eager 抛），ENOENT（syscall "scandir"）在 `for await`
 * 迭代 Dir 时才浮出。discovery.ts 的 safeDir 若只 guard opendir，bun 下
 * `listRulesFiles(<missing>)` 会把 ENOENT 炸进 buildTuiDeps 装配链 →
 * `bun test tests/tui/` 15 个 buildTuiDeps 测试集体失败（master 级
 * pre-existing，2026-09-06 基线确证）。契约本身见
 * tests/harness/memory/discovery.test.ts（vitest/node 侧同名用例）：
 * 缺失 rules 目录 = 空规则集，不抛。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRulesFiles } from "../../src/harness/memory/index.js";

describe("listRulesFiles — 缺失目录容忍（bun lazy opendir 回归）", () => {
  const roots: string[] = [];

  test("user scope：userHome 不存在 → 空数组，不抛", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-rules-bun-"));
    roots.push(root);
    // <root>/home 从不创建 —— 整个 userHome 缺席
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
