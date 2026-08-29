/**
 * ADR-0037 T2: `settings.isolation.worktreeOnMutate` — default-OFF setting
 * surface（plans/worktree-isolation-on-mutate.md T2）。
 *
 * Contract pinned here:
 *  - default OFF: 缺失 / 非 true / 非法值一律视为 OFF（fail-closed），mutate
 *    路径行为与今日完全一致 —— settings 层缺省不产出 isolation 段，
 *    `resolveWorktreeOnMutate` 是唯一 fail-closed 读取点（`=== true`）。
 *  - boolean-only（镜像 memory.autoExtract / graph.enabled 纪律）：非 boolean
 *    → 丢弃该字段（drop-not-throw，不转型），被丢弃字段不参与覆盖。
 *  - persist 往返：persist-settings 的 raw-merge 通道原样保留 isolation 段
 *    （写入 → persist thinking patch → 读回保真）。
 *
 * 只做 settings surface：不读 git、不持会话状态、不接 harness 门禁（T3）。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadIknowSettings,
  resolveWorktreeOnMutate,
} from "../../src/config/settings.ts";
import { persistThinkingChanges } from "../../src/config/persist-settings.ts";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-isolation-settings-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown>
): Promise<{ home: string; cwd: string; projectFile: string }> {
  const seed = Math.random().toString(36).slice(2);
  const home = join(workDir, "home", seed);
  const cwd = join(workDir, "cwd", seed);
  const projectFile = join(cwd, ".iknow", "settings.json");
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  if (Object.keys(user).length > 0) {
    await writeFile(
      join(home, ".iknow", "settings.json"),
      JSON.stringify(user)
    );
  }
  if (Object.keys(project).length > 0) {
    await writeFile(projectFile, JSON.stringify(project));
  }
  return { home, cwd, projectFile };
}

describe("settings.isolation.worktreeOnMutate", () => {
  it("is OFF by default: no isolation section, resolved false, settings object identical to today", async () => {
    const { home, cwd } = await makeSettings({}, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(settings.isolation, undefined);
    assert.equal(resolveWorktreeOnMutate(settings), false);
    // 整个 settings 对象与今日默认一致：空文件 → 空对象，无任何新增键。
    assert.deepEqual(settings, {});
  });

  it("reads an explicit true at runtime", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { isolation: { worktreeOnMutate: true } }
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.isolation, { worktreeOnMutate: true });
    assert.equal(resolveWorktreeOnMutate(settings), true);
  });

  it("preserves an explicit false as a legal value (resolved OFF)", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { isolation: { worktreeOnMutate: false } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      worktreeOnMutate: false,
    });
  });

  for (const illegal of ["true", 1, null, { worktreeOnMutate: true }]) {
    it(`drops the non-boolean value ${JSON.stringify(
      illegal
    )} instead of coercing or throwing`, async () => {
      const { home, cwd } = await makeSettings(
        {},
        { isolation: { worktreeOnMutate: illegal } }
      );
      const settings = loadIknowSettings({ home, cwd });
      assert.equal(settings.isolation, undefined);
      assert.equal(resolveWorktreeOnMutate(settings), false);
    });
  }

  it("lets project override user", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeOnMutate: false } },
      { isolation: { worktreeOnMutate: true } }
    );
    assert.equal(
      resolveWorktreeOnMutate(loadIknowSettings({ home, cwd })),
      true
    );
  });

  it("keeps the user value when project has no isolation section", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeOnMutate: true } },
      { llm: { model: "m" } }
    );
    assert.equal(
      resolveWorktreeOnMutate(loadIknowSettings({ home, cwd })),
      true
    );
  });

  it("drops an illegal project value without clobbering the user layer", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeOnMutate: true } },
      { isolation: { worktreeOnMutate: "yes" } }
    );
    assert.equal(
      resolveWorktreeOnMutate(loadIknowSettings({ home, cwd })),
      true
    );
  });

  it("drops a non-object isolation section", async () => {
    const { home, cwd } = await makeSettings({}, { isolation: "on" });
    assert.equal(loadIknowSettings({ home, cwd }).isolation, undefined);
  });

  it("drops an isolation section carrying only unknown keys (drop-not-throw convention)", async () => {
    const { home, cwd } = await makeSettings({}, { isolation: { nope: 1 } });
    assert.equal(loadIknowSettings({ home, cwd }).isolation, undefined);
  });

  it("freezes the parsed section", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { isolation: { worktreeOnMutate: true } }
    );
    assert.ok(Object.isFrozen(loadIknowSettings({ home, cwd }).isolation));
  });
});

describe("isolation persist round-trip", () => {
  it("survives a persist cycle: isolation survives a thinking patch write-back", async () => {
    const { home, cwd, projectFile } = await makeSettings(
      {},
      {
        isolation: { worktreeOnMutate: true },
        llm: { model: "claude-sonnet" },
      }
    );

    // persist 通道（raw-merge + 原子写）只改 llm.thinking，isolation 原样保留。
    await persistThinkingChanges(projectFile, { thinking: "adaptive" });

    const settings = loadIknowSettings({ home, cwd });
    assert.equal(resolveWorktreeOnMutate(settings), true);
    assert.equal(settings.llm?.thinking, "adaptive");
    assert.equal(settings.llm?.model, "claude-sonnet");
  });

  it("bootstraps isolation into a fresh settings file via persist and reads it back", async () => {
    const { home, cwd, projectFile } = await makeSettings({}, {});

    // 模拟操作员写入开关后，persist 往返（写入 → 读回）保真。
    await persistThinkingChanges(projectFile, { thinking: "off" });
    await writeFile(
      projectFile,
      JSON.stringify(
        {
          isolation: { worktreeOnMutate: true },
          llm: { thinking: "off" },
        },
        null,
        2
      )
    );
    // 再走一次 persist：确认后续写回不吞掉 isolation 段。
    await persistThinkingChanges(projectFile, { thinking: "adaptive" });

    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.isolation, { worktreeOnMutate: true });
    assert.equal(settings.llm?.thinking, "adaptive");
  });
});
