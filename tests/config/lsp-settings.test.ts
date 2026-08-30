/**
 * lsp-optimization 二期 B7: `settings.lsp` — LSP 配置段 surface。
 *
 * Contract pinned here:
 *  - default absent: 段缺失 → settings.lsp === undefined（消费方走缺省值：
 *    requestTimeoutMs 20s / diagnosticsWaitMs 2s / idleTimeoutMs 10min）。
 *  - requestTimeoutMs / diagnosticsWaitMs 为正整数（≥1）；idleTimeoutMs
 *    允许 0（关闭 sweep），仍拒绝负数 / 非整数 / 错类型。非法字段丢弃
 *    （drop-not-throw，不转型）。
 *  - disabledServers 为非空字符串数组：空数组 / 含空串或非串元素 → 丢弃。
 *  - merge：project 字段优先，未覆盖的 user 字段保留（mergeIsolation 样板）。
 *  - deepFreeze 覆盖 lsp 段。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowSettings } from "../../src/config/settings.ts";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-lsp-settings-"));
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

describe("settings.lsp (phase2 B7)", () => {
  it("is absent by default (no lsp section → undefined, empty settings object)", async () => {
    const { home, cwd } = await makeSettings({}, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(settings.lsp, undefined);
    assert.deepEqual(settings, {});
  });

  it("parses a fully populated lsp section", async () => {
    const { home, cwd } = await makeSettings(
      {},
      {
        lsp: {
          requestTimeoutMs: 30_000,
          diagnosticsWaitMs: 5_000,
          idleTimeoutMs: 60_000,
          disabledServers: ["yaml-language-server", "json-language-server"],
        },
      }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).lsp, {
      requestTimeoutMs: 30_000,
      diagnosticsWaitMs: 5_000,
      idleTimeoutMs: 60_000,
      disabledServers: ["yaml-language-server", "json-language-server"],
    });
  });

  for (const field of ["requestTimeoutMs", "diagnosticsWaitMs"] as const) {
    for (const illegal of [0, -1, 1.5, "1000", null, true]) {
      it(`drops illegal ${field} = ${JSON.stringify(illegal)} instead of coercing`, async () => {
        const { home, cwd } = await makeSettings(
          {},
          { lsp: { [field]: illegal } }
        );
        assert.equal(loadIknowSettings({ home, cwd }).lsp, undefined);
      });
    }
  }

  for (const illegal of [-1, 1.5, "1000", null, true]) {
    it(`drops illegal idleTimeoutMs = ${JSON.stringify(illegal)} instead of coercing`, async () => {
      const { home, cwd } = await makeSettings(
        {},
        { lsp: { idleTimeoutMs: illegal } }
      );
      assert.equal(loadIknowSettings({ home, cwd }).lsp, undefined);
    });
  }

  it("keeps idleTimeoutMs = 0 (disable idle sweep)", async () => {
    const { home, cwd } = await makeSettings({}, { lsp: { idleTimeoutMs: 0 } });
    assert.deepEqual(loadIknowSettings({ home, cwd }).lsp, {
      idleTimeoutMs: 0,
    });
  });

  for (const illegal of [[], ["ok", ""], ["ok", 42], "pyright", null]) {
    it(`drops illegal disabledServers = ${JSON.stringify(illegal)}`, async () => {
      const { home, cwd } = await makeSettings(
        {},
        { lsp: { disabledServers: illegal } }
      );
      assert.equal(loadIknowSettings({ home, cwd }).lsp, undefined);
    });
  }

  it("keeps valid fields and drops only the illegal ones in the same section", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { lsp: { requestTimeoutMs: 1_000, diagnosticsWaitMs: "soon" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).lsp, {
      requestTimeoutMs: 1_000,
    });
  });

  it("drops a section carrying only unknown keys (drop-not-throw convention)", async () => {
    const { home, cwd } = await makeSettings({}, { lsp: { nope: 1 } });
    assert.equal(loadIknowSettings({ home, cwd }).lsp, undefined);
  });

  it("drops a non-object lsp section", async () => {
    const { home, cwd } = await makeSettings({}, { lsp: "fast" });
    assert.equal(loadIknowSettings({ home, cwd }).lsp, undefined);
  });

  it("lets project override user per-field", async () => {
    const { home, cwd } = await makeSettings(
      { lsp: { requestTimeoutMs: 10_000, idleTimeoutMs: 20_000 } },
      { lsp: { requestTimeoutMs: 99_999 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).lsp, {
      requestTimeoutMs: 99_999,
      idleTimeoutMs: 20_000,
    });
  });

  it("keeps the user value when project has no lsp section", async () => {
    const { home, cwd } = await makeSettings(
      { lsp: { requestTimeoutMs: 10_000 } },
      { llm: { model: "m" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).lsp, {
      requestTimeoutMs: 10_000,
    });
  });

  it("drops an illegal project value without clobbering the user layer", async () => {
    const { home, cwd } = await makeSettings(
      { lsp: { requestTimeoutMs: 10_000 } },
      { lsp: { requestTimeoutMs: 0 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).lsp, {
      requestTimeoutMs: 10_000,
    });
  });

  it("freezes the parsed lsp section", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { lsp: { requestTimeoutMs: 1_000, disabledServers: ["pyright"] } }
    );
    const lsp = loadIknowSettings({ home, cwd }).lsp;
    assert.ok(Object.isFrozen(lsp));
    assert.ok(Object.isFrozen(lsp?.disabledServers));
  });
});
