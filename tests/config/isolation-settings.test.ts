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
 *    （写入 → persist thinking patch → 读回保真）。thinking 与 isolation 同属
 *    用户层键（ADR-0084）→ 往返锚点都是 <home>/.iknow/settings.json。
 *  - 层归属（ADR-0084）：isolation 在项目允许名单外 → 项目文件的 isolation
 *    段被丢弃、不覆盖 user 值，启动发一条含键名的警告。
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
    // 整个 settings 对象与今日默认一致：空文件 → 空对象，无任何新增键。
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
  // plans/worktree-exclusive-lock.md T2 / ADR-0070 / SC1: boolean-only；
  // 缺失 / 非 `true` 一律按 OFF（fail-closed，镜像 resolveWorktreeOnMutate 形状）。
  // 仅做 settings surface：不读 git、不持会话状态、不接 session-api 占用判定（T3）。
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
    // ADR-0070 / spec SC1: 与 worktreeOnMutate 正交、同款值域纪律；两字段同
    // 时在场时各自解析、互不影响（isolation 属用户层键（ADR-0084），值只来自
    // user 层；missing / non-true 按 OFF）。matrix 鉴面。
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
    // ADR-0070 已认下 trade-off：每多一个 boolean 设置即多一档组合状态，
    // 测试矩阵相应增加。下表枚举 2×2 = 4 档；OFF×OFF 是默认。
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
    // 未知字段丢弃；已知 boolean 字段保留；段不产空（仍带 worktreeExclusive）。
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
    // ADR-0084：isolation 与 llm 同为用户层键 → 往返锚点是 user 文件。
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

    // 模拟操作员写入开关后，persist 往返（写入 → 读回）保真。
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
    // 再走一次 persist：确认后续写回不吞掉 isolation 段。
    await persistThinkingChanges(userFile, { thinking: "adaptive" });

    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(settings.isolation, { worktreeOnMutate: true });
    assert.equal(settings.llm?.thinking, "adaptive");
  });
});

// ADR-0092 / SC13：filesystem isolation 档（fsMode）— 用户层 boolean-only
// 的可写姿态。默认 global；非法值 / 项目文件 isolation 段 → 丢弃并回落 global。
// 不允许的项目文件 isolation 段被丢弃并告警（与 worktreeOnMutate / worktreeExclusive
// 同款 ADR-0084 纪律）。
describe("settings.isolation.fsMode", () => {
  it("缺省 global：缺席 / 非法值 → 字段不产、resolveFsIsolationMode 回落 global", async () => {
    const { home, cwd } = await makeSettings({}, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(resolveFsIsolationMode(settings), "global");
    // 字段缺席 → isolation 段不产（与 worktreeOnMutate 同款「字段全非法 / 缺席 → undefined」）。
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
    // parseIsolation / mergeIsolation 的合同核心：三字段独立校验、互不影响。
    // 每列一个字段非法，断言另两字段仍在场且值不变 —— 覆盖「漏丢」「错丢」
    // 两种方向的回归。
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
    // 回归钉：per-field 合并若写成 `out.x = undefined`，键会真实存在。用户
    // 配置只给 fsMode 时，另两键必须**不在**（`in` 运算符判否），否则消费方
    // 的 Object.keys / 深比较看到的是「有键的 undefined」，与段缺席语义漂移。
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
    // parseIsolation / mergeIsolation 收尾用 Object.keys 判空，故下列输入
    // 一律不得产出 isolation 段。增字段时这条不变量必须继续成立。
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
