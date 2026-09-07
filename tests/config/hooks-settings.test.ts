/**
 * user-hook-router: `settings.hooks` 段（user lane only）的解析契约
 * （SSOT: specs/user-hook-router.md SC1 —— enabled 缺席或 false 时 user rules
 * 即使写了也不产生 [hook_blocked]，即段缺席 = user lane 关；非法值回退不抛
 * 的纪律继承 src/config/settings.ts / ADR-0015）。
 *
 * Contract pinned here:
 *  - 缺席 = 关（SC1 核心）：无 hooks 段 → settings.hooks === undefined，整对象
 *    与今日默认一致（空文件 → {}）。
 *  - enabled 只认 boolean；rules 只认数组；单条规则 id（非空串）/ event（三值
 *    闭集，大小写敏感）/ reason（非空串）结构性非法 → 丢弃该条不抛；可选
 *    tool / toolPrefix / pattern 非法 → 只丢该字段、规则保留。
 *  - pattern 只做字符串透传：正则可编译性由 hook router 构造期判定（SC6，
 *    坏正则剔除 + onHookError），settings 层不预判。
 *  - 覆盖纪律与 llm/secrets 段一致：per-field project > user；project 非法值
 *    不覆盖 user 合法值。
 *  - 返回结构深 frozen（immutable 纪律）。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowSettings } from "../../src/config/settings.ts";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-hooks-settings-"));
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

/** 合法规则条目基线（可按需覆盖字段）。 */
function validRule(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "no-push-to-main",
    event: "PreToolUse",
    reason: "main 分支禁止直接 push",
    ...overrides,
  };
}

describe("settings.hooks — 缺席 = 关（specs/user-hook-router.md SC1）", () => {
  it("无 hooks 段 → hooks undefined，整对象与今日默认一致（空文件 → {}）", async () => {
    const { home, cwd } = await makeSettings({}, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(settings.hooks, undefined);
    // 整个 settings 对象与今日默认一致：空文件 → 空对象，无任何新增键。
    assert.deepEqual(settings, {});
  });

  it("settings 只有其它段 → hooks 仍 undefined", async () => {
    const { home, cwd } = await makeSettings({ llm: { maxTurns: 5 } }, {});
    const settings = loadIknowSettings({ home, cwd });
    assert.equal(settings.hooks, undefined);
    assert.deepEqual(settings, { llm: { maxTurns: 5 } });
  });

  it("hooks 为空对象（无任何合法字段）→ 不产出 hooks 段", async () => {
    const { home, cwd } = await makeSettings({ hooks: {} }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("hooks 段只带未知键（drop-not-throw）→ 不产出 hooks 段", async () => {
    const { home, cwd } = await makeSettings({ hooks: { nope: 1 } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });
});

describe("settings.hooks — 合法段解析与 frozen 结构", () => {
  it("enabled:true + 合法规则 → 结构保真（含可选 tool/toolPrefix/pattern）", async () => {
    const { home, cwd } = await makeSettings(
      {
        hooks: {
          enabled: true,
          rules: [
            {
              id: "block-rm-rf",
              event: "PreToolUse",
              tool: "bash",
              toolPrefix: "mcp__github",
              pattern: "rm\\s+-rf",
              reason: "禁 rm -rf",
            },
          ],
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      hooks: {
        enabled: true,
        rules: [
          {
            id: "block-rm-rf",
            event: "PreToolUse",
            tool: "bash",
            toolPrefix: "mcp__github",
            pattern: "rm\\s+-rf",
            reason: "禁 rm -rf",
          },
        ],
      },
    });
  });

  it("三值事件闭集（PreToolUse / PreWrite / PreCommit）均合法透传", async () => {
    for (const event of ["PreToolUse", "PreWrite", "PreCommit"]) {
      const { home, cwd } = await makeSettings(
        { hooks: { enabled: true, rules: [validRule({ event })] } },
        {}
      );
      const settings = loadIknowSettings({ home, cwd });
      assert.deepEqual(
        settings.hooks,
        { enabled: true, rules: [validRule({ event })] },
        `event=${event} 应透传`
      );
    }
  });

  it("返回结构深 frozen：段 / rules 数组 / 单条规则均不可改", async () => {
    const { home, cwd } = await makeSettings(
      { hooks: { enabled: true, rules: [validRule()] } },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(settings));
    assert.ok(Object.isFrozen(settings.hooks));
    assert.ok(Object.isFrozen(settings.hooks!.rules));
    assert.ok(Object.isFrozen(settings.hooks!.rules![0]));
    assert.throws(() => {
      (settings.hooks as { enabled: boolean }).enabled = false;
    }, TypeError);
    assert.throws(() => {
      (settings.hooks!.rules as unknown[])[0] = {};
    }, TypeError);
  });
});

describe("settings.hooks — enabled boolean 值域", () => {
  it("enabled:false 合法 → 原样保留（缺席/非法/false 三态由消费方统一按关处理）", async () => {
    const { home, cwd } = await makeSettings(
      { hooks: { enabled: false, rules: [validRule()] } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      enabled: false,
      rules: [validRule()],
    });
  });

  it("enabled:true 合法 → 原样保留", async () => {
    const { home, cwd } = await makeSettings({ hooks: { enabled: true } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      enabled: true,
    });
  });

  it('enabled 非法（"true" / 1 / null）→ 丢弃该字段（drop-not-throw）', async () => {
    for (const bad of ["true", 1, null]) {
      const { home, cwd } = await makeSettings({ hooks: { enabled: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `enabled=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("enabled 非法但 rules 合法 → 丢弃 enabled、保留 rules（字段独立）", async () => {
    const { home, cwd } = await makeSettings(
      { hooks: { enabled: "true", rules: [validRule()] } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      rules: [validRule()],
    });
  });
});

describe("settings.hooks — 非法输入逐项丢弃不抛", () => {
  it("hooks 非普通对象（数组 / 字符串 / 数字）→ 丢弃该层", async () => {
    for (const bad of [[{ enabled: true }], "on", 42]) {
      const { home, cwd } = await makeSettings({ hooks: bad }, {});
      const settings = loadIknowSettings({ home, cwd });
      assert.equal(
        settings.hooks,
        undefined,
        `hooks=${JSON.stringify(bad)} 应丢弃`
      );
      assert.deepEqual(settings, {});
    }
  });

  it("rules 非数组（对象 / 字符串）→ 丢弃该字段；enabled 合法仍保留段", async () => {
    for (const bad of [{ id: "x" }, "rules", 3]) {
      const { home, cwd } = await makeSettings(
        { hooks: { enabled: true, rules: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }).hooks,
        { enabled: true },
        `rules=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("单条规则非法 → 该条丢弃、合法条保留", async () => {
    const cases: Array<[string, unknown]> = [
      ["缺 id", { event: "PreToolUse", reason: "r" }],
      ["空 id", { id: "   ", event: "PreToolUse", reason: "r" }],
      ["缺 reason", { id: "x", event: "PreToolUse" }],
      ["空 reason", { id: "x", event: "PreToolUse", reason: "" }],
      ["非法 event PrePush", { id: "x", event: "PrePush", reason: "r" }],
      [
        "非法 event PostToolUse（大小写敏感闭集，非本 lane 事件）",
        { id: "x", event: "PostToolUse", reason: "r" },
      ],
      ["event 非字符串", { id: "x", event: 3, reason: "r" }],
      ["条目非对象（字符串）", "not-an-object"],
      ["条目非对象（数组）", ["x"]],
    ];
    for (const [label, badEntry] of cases) {
      const { home, cwd } = await makeSettings(
        { hooks: { enabled: true, rules: [validRule(), badEntry] } },
        {}
      );
      const settings = loadIknowSettings({ home, cwd });
      assert.deepEqual(
        settings.hooks,
        { enabled: true, rules: [validRule()] },
        `${label} 的条目应丢弃、合法条保留（input=${JSON.stringify(badEntry)}）`
      );
    }
  });

  it("全部条目非法 → rules 不产出，enabled 合法时段仍保留", async () => {
    const { home, cwd } = await makeSettings(
      {
        hooks: {
          enabled: true,
          rules: [
            { event: "PreToolUse", reason: "no id" },
            { id: "", event: "PreToolUse", reason: "empty id" },
            { id: "x", event: "PrePush", reason: "bad event" },
            "not-an-object",
          ],
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      enabled: true,
    });
  });

  it("全部条目非法且 enabled 也非法 → 不产出 hooks 段", async () => {
    const { home, cwd } = await makeSettings(
      {
        hooks: {
          enabled: "yes",
          rules: [{ event: "PreToolUse", reason: "r" }],
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });
});

describe("settings.hooks — 覆盖纪律（per-field project > user）", () => {
  it("user enabled:true + rules，project enabled:false → project 覆盖 enabled、user rules 保留", async () => {
    const { home, cwd } = await makeSettings(
      { hooks: { enabled: true, rules: [validRule()] } },
      { hooks: { enabled: false } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      enabled: false,
      rules: [validRule()],
    });
  });

  it("project 有 rules → 覆盖 user rules（替换非 merge 残留）", async () => {
    const projectRule = {
      id: "project-rule",
      event: "PreWrite",
      reason: "project 禁写",
    };
    const { home, cwd } = await makeSettings(
      { hooks: { enabled: true, rules: [validRule()] } },
      { hooks: { enabled: true, rules: [projectRule] } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      enabled: true,
      rules: [projectRule],
    });
  });

  it("project 无 hooks 段 → user 段完整保留（逐层合并）", async () => {
    const { home, cwd } = await makeSettings(
      { hooks: { enabled: true, rules: [validRule()] } },
      { llm: { maxTurns: 5 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 5 },
      hooks: { enabled: true, rules: [validRule()] },
    });
  });

  it("project hooks 非法（整层）→ 不覆盖 user 合法段", async () => {
    const { home, cwd } = await makeSettings(
      { hooks: { enabled: true, rules: [validRule()] } },
      { hooks: "garbage" }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      enabled: true,
      rules: [validRule()],
    });
  });
});

describe("settings.hooks — pattern 字段（字符串透传，正则编译性留给 hook router 构造期）", () => {
  it("pattern 非字符串（数字 / 对象）→ 只丢该字段、规则保留", async () => {
    for (const bad of [42, { re: "x" }]) {
      const { home, cwd } = await makeSettings(
        { hooks: { enabled: true, rules: [validRule({ pattern: bad })] } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }).hooks,
        { enabled: true, rules: [validRule()] },
        `pattern=${JSON.stringify(bad)} 应丢弃但规则保留`
      );
    }
  });

  it("空串 pattern → 丢弃该字段、规则保留", async () => {
    const { home, cwd } = await makeSettings(
      { hooks: { enabled: true, rules: [validRule({ pattern: "" })] } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      enabled: true,
      rules: [validRule()],
    });
  });

  it('不可编译串（"["）在 settings 层合法透传（编译性判定是 SC6 构造期职责）', async () => {
    const { home, cwd } = await makeSettings(
      { hooks: { enabled: true, rules: [validRule({ pattern: "[" })] } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      enabled: true,
      rules: [validRule({ pattern: "[" })],
    });
  });
});

describe("settings.hooks — 字段 trim", () => {
  it("id / reason 前后空白被 trim", async () => {
    const { home, cwd } = await makeSettings(
      {
        hooks: {
          enabled: true,
          rules: [validRule({ id: "  block-bash  ", reason: "  禁 bash  " })],
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      enabled: true,
      rules: [validRule({ id: "block-bash", reason: "禁 bash" })],
    });
  });

  it("tool / toolPrefix 前后空白同样 trim（镜像 id/reason 纪律）", async () => {
    const { home, cwd } = await makeSettings(
      {
        hooks: {
          enabled: true,
          rules: [
            validRule({ tool: "  bash  ", toolPrefix: "  mcp__github  " }),
          ],
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).hooks, {
      enabled: true,
      rules: [validRule({ tool: "bash", toolPrefix: "mcp__github" })],
    });
  });
});
