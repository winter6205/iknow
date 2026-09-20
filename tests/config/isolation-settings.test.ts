/**
 * ADR-0037: `settings.isolation.worktreeOnMutate` — default-OFF setting surface.
 *
 * Contract pinned here:
 *  - default OFF: missing / non-true / illegal values all count as OFF
 *    (fail-closed); the mutate path behaves exactly as before — the settings
 *    layer produces no isolation section by default, and `resolveWorktreeOnMutate`
 *    is the sole fail-closed read point (`=== true`).
 *  - boolean-only (mirroring memory.autoExtract / graph.enabled discipline):
 *    non-boolean → field dropped (drop-not-throw, no coercion); dropped fields never override.
 *  - persist round-trip: persist-settings' raw-merge channel preserves the
 *    isolation section verbatim (write → persist thinking patch → read back intact).
 *    thinking and isolation are both user-layer keys (ADR-0084) → the round-trip
 *    anchor is <home>/.iknow/settings.json for both.
 *  - layer ownership (ADR-0084): isolation is off the project allowlist → the
 *    project file's isolation section is dropped, never overriding user values,
 *    with one startup warning naming the key.
 *
 * Settings surface only: no git reads, no session state, no harness gate wiring.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadIknowSettings,
  resolveWorktreeOnMutate,
  resolveWorktreeExclusive,
  resolveFsIsolationMode,
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
): Promise<{
  home: string;
  cwd: string;
  userFile: string;
  projectFile: string;
}> {
  const seed = Math.random().toString(36).slice(2);
  const home = join(workDir, "home", seed);
  const cwd = join(workDir, "cwd", seed);
  const userFile = join(home, ".iknow", "settings.json");
  const projectFile = join(cwd, ".iknow", "settings.json");
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  if (Object.keys(user).length > 0) {
    await writeFile(userFile, JSON.stringify(user));
  }
  if (Object.keys(project).length > 0) {
    await writeFile(projectFile, JSON.stringify(project));
  }
  return { home, cwd, userFile, projectFile };
}

describe("settings.isolation.worktreeOnMutate", () => {
  it("is OFF by default: no isolation section, resolved false, settings object identical to today", async () => {
    const { home, cwd } = await makeSettings({}, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(settings.isolation, undefined);
    assert.equal(resolveWorktreeOnMutate(settings), false);
    // The whole settings object matches today's default: empty file → empty object, no new keys.
    assert.deepEqual(settings, {});
  });

  it("reads an explicit true at runtime", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeOnMutate: true } },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.isolation, { worktreeOnMutate: true });
    assert.equal(resolveWorktreeOnMutate(settings), true);
  });

  it("preserves an explicit false as a legal value (resolved OFF)", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeOnMutate: false } },
      {}
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
        { isolation: { worktreeOnMutate: illegal } },
        {}
      );
      const settings = loadIknowSettings({ home, cwd });
      assert.equal(settings.isolation, undefined);
      assert.equal(resolveWorktreeOnMutate(settings), false);
    });
  }

  it("ADR-0084：project 的 isolation 被丢弃并告警 → user 值胜出（不再被 project 覆盖）", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeOnMutate: false } },
      { isolation: { worktreeOnMutate: true } }
    );
    const warnings: string[] = [];
    assert.equal(
      resolveWorktreeOnMutate(
        loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
      ),
      false
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
  });

  it("keeps the user value when the project has no isolation section", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeOnMutate: true } },
      {}
    );
    assert.equal(
      resolveWorktreeOnMutate(loadIknowSettings({ home, cwd })),
      true
    );
  });

  it("project 的非法 isolation 值随段丢弃 → 不抹掉 user 值且发警告", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeOnMutate: true } },
      { isolation: { worktreeOnMutate: "yes" } }
    );
    const warnings: string[] = [];
    assert.equal(
      resolveWorktreeOnMutate(
        loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
      ),
      true
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
  });

  it("drops a non-object isolation section", async () => {
    const { home, cwd } = await makeSettings({ isolation: "on" }, {});
    assert.equal(loadIknowSettings({ home, cwd }).isolation, undefined);
  });

  it("drops an isolation section carrying only unknown keys (drop-not-throw convention)", async () => {
    const { home, cwd } = await makeSettings({ isolation: { nope: 1 } }, {});
    assert.equal(loadIknowSettings({ home, cwd }).isolation, undefined);
  });

  it("freezes the parsed section", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeOnMutate: true } },
      {}
    );
    assert.ok(Object.isFrozen(loadIknowSettings({ home, cwd }).isolation));
  });
});

describe("settings.isolation.worktreeExclusive", () => {
  // ADR-0070: boolean-only; missing / non-`true` counts as OFF (fail-closed,
  // mirroring the resolveWorktreeOnMutate shape). Settings surface only: no git
  // reads, no session state, no session-api occupancy check.
  it("is OFF by default: absent field, resolved false, no isolation shape drift", async () => {
    const { home, cwd } = await makeSettings({}, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(settings.isolation, undefined);
    assert.equal(resolveWorktreeExclusive(settings), false);
  });

  it("reads an explicit true at runtime and resolves ON", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeExclusive: true } },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.isolation, { worktreeExclusive: true });
    assert.equal(resolveWorktreeExclusive(settings), true);
  });

  it("preserves an explicit false as a legal value (resolved OFF, isolation segment survives)", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeExclusive: false } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      worktreeExclusive: false,
    });
  });

  for (const illegal of ["true", 1, null, { worktreeExclusive: true }]) {
    it(`drops the non-boolean value ${JSON.stringify(
      illegal
    )} instead of coercing or throwing`, async () => {
      const { home, cwd } = await makeSettings(
        { isolation: { worktreeExclusive: illegal } },
        {}
      );
      const settings = loadIknowSettings({ home, cwd });
      assert.equal(settings.isolation, undefined);
      assert.equal(resolveWorktreeExclusive(settings), false);
    });
  }

  it("ADR-0084：project 的 isolation 被丢弃并告警 → user 值胜出（不再被 project 覆盖）", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeExclusive: false } },
      { isolation: { worktreeExclusive: true } }
    );
    const warnings: string[] = [];
    assert.equal(
      resolveWorktreeExclusive(
        loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
      ),
      false
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
  });

  it("keeps the user value when the project has no isolation section", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeExclusive: true } },
      {}
    );
    assert.equal(
      resolveWorktreeExclusive(loadIknowSettings({ home, cwd })),
      true
    );
  });

  it("project 的非法 isolation 值随段丢弃 → 不抹掉 user 值且发警告", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeExclusive: true } },
      { isolation: { worktreeExclusive: "yes" } }
    );
    const warnings: string[] = [];
    assert.equal(
      resolveWorktreeExclusive(
        loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
      ),
      true
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
  });

  it("coexists with worktreeOnMutate: both fields preserved per-segment", async () => {
    // ADR-0070: orthogonal to worktreeOnMutate with the same value-domain
    // discipline; when both fields are present they parse independently without
    // interference (isolation is a user-layer key per ADR-0084, values come only
    // from the user layer; missing / non-true counts as OFF).
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          worktreeOnMutate: true,
          worktreeExclusive: true,
        },
      },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(resolveWorktreeOnMutate(settings), true);
    assert.equal(resolveWorktreeExclusive(settings), true);
    assert.deepEqual(settings.isolation, {
      worktreeOnMutate: true,
      worktreeExclusive: true,
    });
  });

  it("matrix — worktreeOnMutate × worktreeExclusive 四档组合状态解析独立", async () => {
    // ADR-0070 accepted the trade-off: each extra boolean setting adds one more
    // combined state and the test matrix grows accordingly. The loop below
    // enumerates 2×2 = 4 states; OFF×OFF is the default.
    for (const [wom, exc] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      const { home, cwd } = await makeSettings(
        { isolation: { worktreeOnMutate: wom, worktreeExclusive: exc } },
        {}
      );
      const settings = loadIknowSettings({ home, cwd });
      assert.equal(resolveWorktreeOnMutate(settings), wom, `wom=${wom}`);
      assert.equal(resolveWorktreeExclusive(settings), exc, `exc=${exc}`);
    }
  });

  it("drops an unknown sibling field without clobbering worktreeExclusive", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeExclusive: true, futureFlag: "yes" } },
      {}
    );
    // Unknown fields dropped; known boolean fields kept; no empty section produced (worktreeExclusive remains).
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      worktreeExclusive: true,
    });
  });

  it("freezes the parsed section", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { worktreeExclusive: true } },
      {}
    );
    assert.ok(Object.isFrozen(loadIknowSettings({ home, cwd }).isolation));
  });

  it("survives a persist cycle without losing worktreeExclusive", async () => {
    // ADR-0084: isolation and llm are both user-layer keys → the round-trip anchor is the user file.
    const { home, cwd, userFile } = await makeSettings(
      {
        isolation: { worktreeExclusive: true },
        llm: { model: "claude-sonnet" },
      },
      {}
    );
    await persistThinkingChanges(userFile, { thinking: "adaptive" });
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(resolveWorktreeExclusive(settings), true);
    assert.equal(settings.llm?.thinking, "adaptive");
  });
});

describe("isolation persist round-trip", () => {
  it("bootstraps isolation into a fresh settings file via persist and reads it back", async () => {
    const { home, cwd, userFile } = await makeSettings({}, {});

    // Simulate the operator writing the switch, then verify the persist round-trip (write → read back) stays intact.
    await persistThinkingChanges(userFile, { thinking: "off" });
    await writeFile(
      userFile,
      JSON.stringify(
        {
          isolation: { worktreeOnMutate: true },
          llm: { thinking: "off" },
        },
        null,
        2
      )
    );
    // Run persist once more: a later write-back must not swallow the isolation section.
    await persistThinkingChanges(userFile, { thinking: "adaptive" });

    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.isolation, { worktreeOnMutate: true });
    assert.equal(settings.llm?.thinking, "adaptive");
  });
});

// ADR-0092: filesystem isolation mode (fsMode) — the user-layer writable posture.
// Default global; illegal values / project-file isolation sections → dropped and
// fall back to global. Disallowed project-file isolation sections are dropped with
// a warning (same ADR-0084 discipline as worktreeOnMutate / worktreeExclusive).
describe("settings.isolation.fsMode", () => {
  it("缺省 global：缺席 / 非法值 → 字段不产、resolveFsIsolationMode 回落 global", async () => {
    const { home, cwd } = await makeSettings({}, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(resolveFsIsolationMode(settings), "global");
    // Field absent → no isolation section (same "all fields illegal / absent → undefined" shape as worktreeOnMutate).
    assert.equal(settings.isolation, undefined);
  });

  it("显式 workspace → 字段透传、resolveFsIsolationMode 解析为 workspace", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { fsMode: "workspace" } },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.isolation, { fsMode: "workspace" });
    assert.equal(resolveFsIsolationMode(settings), "workspace");
  });

  it("显式 global → 字段透传（fail-closed 兜底与显式值同效）", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { fsMode: "global" } },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.isolation, { fsMode: "global" });
    assert.equal(resolveFsIsolationMode(settings), "global");
  });

  for (const illegal of [
    "Global",
    "WORKSPACE",
    true,
    1,
    null,
    ["global"],
    { value: "global" },
  ]) {
    it(`非法 fsMode 值 ${JSON.stringify(illegal)} → 丢弃字段，回落 global`, async () => {
      const { home, cwd } = await makeSettings(
        { isolation: { fsMode: illegal } },
        {}
      );
      const settings = loadIknowSettings({ home, cwd });
      assert.equal(settings.isolation, undefined);
      assert.equal(resolveFsIsolationMode(settings), "global");
    });
  }

  it("ADR-0084：project 文件的 fsMode 被丢弃并告警 → user 值胜出", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { fsMode: "global" } },
      { isolation: { fsMode: "workspace" } }
    );
    const warnings: string[] = [];
    assert.equal(
      resolveFsIsolationMode(
        loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
      ),
      "global"
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
  });

  it("project 文件无 isolation 段 → user fsMode 原样保留", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { fsMode: "workspace" } },
      {}
    );
    assert.equal(
      resolveFsIsolationMode(loadIknowSettings({ home, cwd })),
      "workspace"
    );
  });

  it("项目文件 fsMode 非法 → 随段丢弃，不抹掉 user 的 fsMode", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { fsMode: "workspace" } },
      { isolation: { fsMode: "wrong" } }
    );
    const warnings: string[] = [];
    assert.equal(
      resolveFsIsolationMode(
        loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) })
      ),
      "workspace"
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"isolation"/);
  });

  it("fsMode 与 worktreeOnMutate / worktreeExclusive 共存于 isolation 段", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          worktreeOnMutate: true,
          worktreeExclusive: false,
          fsMode: "workspace",
        },
      },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(resolveWorktreeOnMutate(settings), true);
    assert.equal(resolveWorktreeExclusive(settings), false);
    assert.equal(resolveFsIsolationMode(settings), "workspace");
    assert.deepEqual(settings.isolation, {
      worktreeOnMutate: true,
      worktreeExclusive: false,
      fsMode: "workspace",
    });
  });

  it("未知 sibling 字段丢弃，已知字段保留（与 worktreeExclusive 同纪律）", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { fsMode: "workspace", futureFlag: 1 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      fsMode: "workspace",
    });
  });

  it("顶层 fsMode（非 isolation.fsMode）→ 完全不识别", async () => {
    const { home, cwd } = await makeSettings({ fsMode: "workspace" }, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(settings.isolation, undefined);
    assert.equal(resolveFsIsolationMode(settings), "global");
  });

  it("freeze：isolation.fsMode 解析后冻结", async () => {
    const { home, cwd } = await makeSettings(
      { isolation: { fsMode: "workspace" } },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(settings.isolation));
    assert.ok(Object.isFrozen(settings.isolation!.fsMode));
  });

  it("resolveFsIsolationMode：null / undefined 输入 → global", () => {
    assert.equal(resolveFsIsolationMode(undefined), "global");
    assert.equal(resolveFsIsolationMode(null), "global");
    assert.equal(resolveFsIsolationMode({}), "global");
    assert.equal(
      resolveFsIsolationMode({ isolation: { fsMode: "workspace" } }),
      "workspace"
    );
  });

  it("persist 往返：fsMode 与 worktreeOnMutate 同时保留", async () => {
    const { home, cwd, userFile } = await makeSettings(
      {
        isolation: { worktreeOnMutate: true, fsMode: "workspace" },
        llm: { model: "claude-sonnet" },
      },
      {}
    );
    await persistThinkingChanges(userFile, { thinking: "adaptive" });
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(resolveWorktreeOnMutate(settings), true);
    assert.equal(resolveFsIsolationMode(settings), "workspace");
    assert.equal(settings.llm?.thinking, "adaptive");
  });

  it("per-field 独立：任一字段非法不牵连其它字段（三字段各自留 / 丢）", async () => {
    // Core of the parseIsolation / mergeIsolation contract: the three fields
    // validate independently. With one field illegal per case, the other two must
    // remain present and unchanged — covering regressions in both the
    // "failed-to-drop" and "wrongly-dropped" directions.
    const { home, cwd } = await makeSettings(
      {
        isolation: {
          worktreeOnMutate: true,
          worktreeExclusive: false,
          fsMode: "workspace",
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).isolation, {
      worktreeOnMutate: true,
      worktreeExclusive: false,
      fsMode: "workspace",
    });

    const illegalFsMode = await makeSettings(
      { isolation: { worktreeOnMutate: true, fsMode: "GLOBAL" } },
      {}
    );
    assert.deepEqual(loadIknowSettings(illegalFsMode).isolation, {
      worktreeOnMutate: true,
    });

    const illegalBoolean = await makeSettings(
      { isolation: { worktreeOnMutate: "yes", fsMode: "global" } },
      {}
    );
    assert.deepEqual(loadIknowSettings(illegalBoolean).isolation, {
      fsMode: "global",
    });
  });

  it("isolation 段的键集合不含 undefined 值键（`in` 为假，不只是值为 undefined）", async () => {
    // Regression pin: if per-field merge wrote `out.x = undefined`, the key would
    // really exist. When user config supplies only fsMode, the other two keys must
    // be **absent** (falsy `in` operator), otherwise consumers' Object.keys / deep
    // compare see a "present key with undefined value", drifting from section-absent semantics.
    const { home, cwd } = await makeSettings(
      { isolation: { fsMode: "global" } },
      {}
    );
    const isolation = loadIknowSettings({ home, cwd }).isolation;
    assert.ok(isolation);
    assert.equal("worktreeOnMutate" in isolation, false);
    assert.equal("worktreeExclusive" in isolation, false);
    assert.deepEqual(Object.keys(isolation), ["fsMode"]);
  });

  it("字段增删不影响「全空 → 段缺席」判断（结构不变量，不随字段数漂移）", async () => {
    // parseIsolation / mergeIsolation finish with an Object.keys emptiness check,
    // so none of the inputs below may produce an isolation section. This invariant
    // must keep holding as fields are added.
    for (const isolation of [
      {},
      { unknownOnly: 1 },
      { worktreeOnMutate: "yes", worktreeExclusive: "no", fsMode: "WRONG" },
      { worktreeOnMutate: null, worktreeExclusive: 1, fsMode: ["global"] },
    ]) {
      const { home, cwd } = await makeSettings({ isolation }, {});
      assert.equal(
        loadIknowSettings({ home, cwd }).isolation,
        undefined,
        `isolation=${JSON.stringify(isolation)}`
      );
    }
  });
});
