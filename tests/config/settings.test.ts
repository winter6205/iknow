/**
 * settings file mechanism — user/project two-layer loading + invalid-value fallback.
 *
 * ADR-0084 project allowlist: the project file only contributes the verify / secrets /
 * permissions top-level keys (hooks is user-layer only). Other top-level keys are dropped
 * wholesale with a warning. Two-layer discipline:
 *   - allowlisted keys (verify / secrets / permissions) → project overrides user field by field;
 *   - non-allowlisted keys (llm / isolation / hooks / ...) → project value dropped, user value wins.
 *
 * Coverage:
 *  - file missing → empty object (no throw);
 *  - allowlisted key user read / project field-by-field override of user (e.g. verify.command,
 *    secrets.enabled);
 *  - non-allowlisted key (llm): project value dropped → user value wins;
 *  - bad JSON → empty object (user / project tested separately);
 *  - invalid values dropped (maxTurns 0 / -5 / "abc" / 1.5; contextWindow 0 / "bad";
 *    thresholdTokens 0);
 *  - invalid fields do not override valid user values (project invalid → user value kept);
 *  - llm is an array / string → that layer dropped;
 *  - returned object deeply frozen.
 *
 * Each case uses its own tmp dir via opts.home / opts.cwd, never touching the real ~/.iknow.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIknowSettings } from "../../src/config/settings.ts";
import { resolveVerifyConfig } from "../../src/config/verify-config.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-settings-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Writes one settings file per layer (user / project) and returns isolated LoadSettingsOpts.
 * Always creates the .iknow dirs (even the empty-object case, so writeFile never hits ENOENT).
 */
async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown>
): Promise<{ home: string; cwd: string }> {
  const home = join(workDir, "home", `${Math.random().toString(36).slice(2)}`);
  const cwd = join(workDir, "cwd", `${Math.random().toString(36).slice(2)}`);
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

describe("loadIknowSettings — settings 文件机制 (#353)", () => {
  it("两个文件都不存在 → 返回空对象（不抛错）", async () => {
    const { home, cwd } = await makeSettings({}, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("user 有 settings → 读到 user 值", async () => {
    const { home, cwd } = await makeSettings({ llm: { maxTurns: 20 } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 20 },
    });
  });

  it("project 的 llm 段被允许名单丢弃 → user 值胜出（ADR-0084，非 project 覆盖）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 20 } },
      { llm: { maxTurns: 5 } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { llm: { maxTurns: 20 } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"llm"/);
  });

  it("project llm 段整体丢弃 → user 的 maxTurns + compress 完整保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 20, compress: { contextWindow: 200000 } } },
      { llm: { maxTurns: 5 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 20, compress: { contextWindow: 200000 } },
    });
  });

  it("project compress 段随 llm 丢弃 → user 的 contextWindow + thresholdTokens 均保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { compress: { contextWindow: 200000, thresholdTokens: 150000 } } },
      { llm: { compress: { thresholdTokens: 100000 } } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { compress: { contextWindow: 200000, thresholdTokens: 150000 } },
    });
  });

  it("坏 JSON（user）→ 返回空对象不抛错", async () => {
    const { home, cwd } = await makeSettings({}, {});
    await writeFile(join(home, ".iknow", "settings.json"), "{ broken json");
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("坏 JSON（project）→ 返回空对象不抛错", async () => {
    const { home, cwd } = await makeSettings({}, {});
    await writeFile(join(cwd, ".iknow", "settings.json"), "{ broken json");
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("坏 JSON（project）+ 合法 user → 保留 user 值", async () => {
    const { home, cwd } = await makeSettings({ llm: { maxTurns: 20 } }, {});
    await writeFile(join(cwd, ".iknow", "settings.json"), "{ broken json");
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 20 },
    });
  });

  it('非法值丢弃：maxTurns 0 / -5 / "abc" / 1.5 → 丢弃', async () => {
    for (const bad of [0, -5, "abc", 1.5]) {
      const { home, cwd } = await makeSettings({ llm: { maxTurns: bad } }, {});
      assert.deepEqual(loadIknowSettings({ home, cwd }), {}, `maxTurns=${bad}`);
    }
  });

  it('非法值丢弃：contextWindow 0 / "bad" → 丢弃', async () => {
    for (const bad of [0, "bad"]) {
      const { home, cwd } = await makeSettings(
        { llm: { compress: { contextWindow: bad } } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `contextWindow=${bad}`
      );
    }
  });

  it("非法值丢弃：thresholdTokens 0 → 丢弃", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { compress: { thresholdTokens: 0 } } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it('合法 thinking / thinkingEffort 透传：{ thinking: "adaptive", thinkingEffort: "high" }', async () => {
    const { home, cwd } = await makeSettings(
      { llm: { thinking: "adaptive", thinkingEffort: "high" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { thinking: "adaptive", thinkingEffort: "high" },
    });
  });

  it("thinking 合法值 off / adaptive 均透传", async () => {
    for (const v of ["off", "adaptive"]) {
      const { home, cwd } = await makeSettings({ llm: { thinking: v } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { llm: { thinking: v } },
        `thinking=${v} 应透传`
      );
    }
  });

  it("project thinking / thinkingEffort 丢弃 → user 的两个值都保留（写回落对层的读侧对偶）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { thinking: "adaptive", thinkingEffort: "low" } },
      { llm: { thinking: "off", thinkingEffort: "max" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { thinking: "adaptive", thinkingEffort: "low" },
    });
  });

  it("project 只设置 thinking → 整段丢弃，user 的 thinking + thinkingEffort 原样保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { thinking: "adaptive", thinkingEffort: "high" } },
      { llm: { thinking: "off" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { thinking: "adaptive", thinkingEffort: "high" },
    });
  });

  it('非法 thinking（"ON" 大写 / 1 / "adaptive!"）→ 丢弃', async () => {
    for (const bad of ["ON", 1, "adaptive!"]) {
      const { home, cwd } = await makeSettings({ llm: { thinking: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `thinking=${bad} 应丢弃`
      );
    }
  });

  it('非法 thinkingEffort（"huge" / "Medium" 大写 / 0）→ 丢弃', async () => {
    for (const bad of ["huge", "Medium", 0]) {
      const { home, cwd } = await makeSettings(
        { llm: { thinkingEffort: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `thinkingEffort=${bad} 应丢弃`
      );
    }
  });

  it("thinkingEffort 空串 → 视为缺失（不产出字段，其余字段保留）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { thinking: "adaptive", thinkingEffort: "" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { thinking: "adaptive" },
    });
  });

  it("仅 llm.thinking（无 maxTurns/compress）→ llm 层不被丢弃", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { thinking: "adaptive" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { thinking: "adaptive" },
    });
  });

  it("仅 llm.thinkingEffort（无 maxTurns/compress）→ llm 层不被丢弃", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { thinkingEffort: "max" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { thinkingEffort: "max" },
    });
  });

  it("project llm 段整体丢弃 → user maxTurns 胜出（project 非法值未参与校验）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 20 } },
      { llm: { maxTurns: "bad" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 20 },
    });
  });

  it("project llm.compress 随 llm 段整体丢弃 → user 的 compress 完整保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { compress: { contextWindow: 200000, thresholdTokens: 150000 } } },
      { llm: { compress: { contextWindow: 0, thresholdTokens: "bad" } } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { compress: { contextWindow: 200000, thresholdTokens: 150000 } },
    });
  });

  it("llm 是数组 → 丢弃该层", async () => {
    const { home, cwd } = await makeSettings({ llm: [] }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("llm 是字符串 → 丢弃该层", async () => {
    const { home, cwd } = await makeSettings({ llm: "garbage" }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("顶层是数组 → 空对象", async () => {
    const { home, cwd } = await makeSettings({}, {});
    await writeFile(join(home, ".iknow", "settings.json"), JSON.stringify([]));
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("顶层是字符串 → 空对象", async () => {
    const { home, cwd } = await makeSettings({}, {});
    await writeFile(join(cwd, ".iknow", "settings.json"), JSON.stringify("x"));
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("返回对象深 frozen（含嵌套）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 20, compress: { contextWindow: 200000 } } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.llm));
    assert.ok(Object.isFrozen(s.llm!.compress));
    assert.throws(() => {
      (s.llm as { maxTurns: number }).maxTurns = 99;
    }, TypeError);
    assert.throws(() => {
      (s.llm!.compress as { contextWindow: number }).contextWindow = 1;
    }, TypeError);
  });

  it("空对象也 frozen", async () => {
    const { home, cwd } = await makeSettings({}, {});
    assert.ok(Object.isFrozen(loadIknowSettings({ home, cwd })));
  });

  it("user 写 llm.model → 读到该模型", async () => {
    const { home, cwd } = await makeSettings({ llm: { model: "m3" } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { model: "m3" },
    });
  });

  it("project 写 llm.model=x，user 写 llm.model=y → user 的 y 胜出（SC4 核心不变式）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { model: "y" } },
      { llm: { model: "x" } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { llm: { model: "y" } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"llm"/);
  });

  it("project 写非法 model，user 写合法 → user 保留（llm 段整体丢弃，未进校验器）", async () => {
    for (const bad of [123, "", true]) {
      const { home, cwd } = await makeSettings(
        { llm: { model: "y" } },
        { llm: { model: bad } }
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { llm: { model: "y" } },
        `project model=${JSON.stringify(bad)} 应不覆盖 user`
      );
    }
  });

  it("llm.model 空串 → 丢弃（不产出 model）", async () => {
    const { home, cwd } = await makeSettings({ llm: { model: "" } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("llm.model 非 string（123 / true / null / []）→ 丢弃", async () => {
    for (const bad of [123, true, null, []]) {
      const { home, cwd } = await makeSettings({ llm: { model: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `model=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("llm 是数组 → 整个 llm 丢弃（含 model）", async () => {
    const { home, cwd } = await makeSettings({ llm: [{ model: "x" }] }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("user 写 llm.liteModel → 读到该路由 ID（trim 后透传，ADR-0113）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { model: "m", liteModel: "  test/lite  " } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { model: "m", liteModel: "test/lite" },
    });
  });

  it("llm.liteModel 空串 / 全空白 / 非 string → 丢弃该字段，其余字段保留", async () => {
    for (const bad of ["", "   ", 123, true, null, []]) {
      const { home, cwd } = await makeSettings(
        { llm: { model: "m", liteModel: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { llm: { model: "m" } },
        `liteModel=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("project 写 llm.liteModel → 随 llm 段丢弃，不覆盖 user（ADR-0084/0109）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { model: "y", liteModel: "test/user-lite" } },
      { llm: { liteModel: "test/project-lite" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { model: "y", liteModel: "test/user-lite" },
    });
  });

  it("user/project 都没 liteModel → 返回对象无 liteModel 字段", async () => {
    const { home, cwd } = await makeSettings({ llm: { model: "m" } }, {});
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s, { llm: { model: "m" } });
    assert.equal("liteModel" in s.llm!, false);
  });

  it("user/project 都没 model → 返回对象无 model 字段（maxTurns 取 user）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 5 } },
      { llm: { maxTurns: 3 } }
    );
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s, { llm: { maxTurns: 5 } });
    assert.equal(s.llm?.model, undefined);
  });

  it("返回对象深 frozen 含 model 字段", async () => {
    const { home, cwd } = await makeSettings({ llm: { model: "m3" } }, {});
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.llm));
    assert.throws(() => {
      (s.llm as { model: string }).model = "other";
    }, TypeError);
  });

  it("user 写 llm.fallback → 读到 fallback 数组", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { fallback: ["m1", "m2"] } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { fallback: ["m1", "m2"] },
    });
  });

  it("project fallback 丢弃 → user fallback 胜出（无 merge 残留）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { fallback: ["user-a", "user-b"] } },
      { llm: { fallback: ["project-a"] } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { fallback: ["user-a", "user-b"] },
    });
  });

  it("user 写 fallback、project 写 maxTurns → project 整段丢弃，只剩 user fallback", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { fallback: ["u1"] } },
      { llm: { maxTurns: 5 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { fallback: ["u1"] },
    });
  });

  it("project llm 段整体丢弃 → user fallback 胜出（project 非法值未参与校验）", async () => {
    for (const bad of [123, "", "x", [], ["a", 5], [""], null, [1, 2]]) {
      const { home, cwd } = await makeSettings(
        { llm: { fallback: ["user-keep"] } },
        { llm: { fallback: bad } }
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { llm: { fallback: ["user-keep"] } },
        `project fallback=${JSON.stringify(bad)} 应不覆盖 user`
      );
    }
  });

  it("llm.fallback 缺失 → 不产出 fallback 字段", async () => {
    const { home, cwd } = await makeSettings({ llm: { model: "m3" } }, {});
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s, { llm: { model: "m3" } });
    assert.equal(s.llm?.fallback, undefined);
  });

  it("llm.fallback 空数组 → 丢弃（不产出 fallback 字段）", async () => {
    const { home, cwd } = await makeSettings({ llm: { fallback: [] } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("llm.fallback 非数组（string / 123 / true / {}）→ 丢弃", async () => {
    for (const bad of ["x", 123, true, {}]) {
      const { home, cwd } = await makeSettings({ llm: { fallback: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `fallback=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("llm.fallback 数组含空串 / 非字符串项 → 丢弃整个字段", async () => {
    for (const bad of [["", "m1"], ["m1", 5], [null], ["   "]]) {
      const { home, cwd } = await makeSettings({ llm: { fallback: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `fallback=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("llm.fallback 元素 trim 后保留（两端空白去除）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { fallback: ["  m1  ", "m2"] } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { fallback: ["m1", "m2"] },
    });
  });

  it("返回对象深 frozen 含 fallback 数组（嵌套元素不可改）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { fallback: ["m1", "m2"] } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.llm));
    assert.ok(Object.isFrozen(s.llm!.fallback));
    assert.throws(() => {
      (s.llm!.fallback as string[])[0] = "other";
    }, TypeError);
  });
});

describe("loadIknowSettings — llm.timeoutMs (#358 settings 双字段)", () => {
  it("合法正整数 timeoutMs=60000 → 透传", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { timeoutMs: 60_000 },
    });
  });

  it("合法正整数 timeoutMs=7200000 → 透传（per-call 大值）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 7_200_000 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { timeoutMs: 7_200_000 },
    });
  });

  it('drop-not-throw: timeoutMs 0 / -5 / "abc" / 1.5 → 丢弃', async () => {
    for (const bad of [0, -5, "abc", 1.5]) {
      const { home, cwd } = await makeSettings({ llm: { timeoutMs: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `timeoutMs=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("drop-not-throw: timeoutMs 非数字/null/true/[]/{}/undefined → 丢弃", async () => {
    for (const bad of [null, true, false, [], {}, "  "]) {
      const { home, cwd } = await makeSettings({ llm: { timeoutMs: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `timeoutMs=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("project timeoutMs 丢弃 → user timeoutMs 胜出（同字段亦不覆盖）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 } },
      { llm: { timeoutMs: 30_000 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { timeoutMs: 60_000 },
    });
  });

  it("project llm 段整体丢弃 → user timeoutMs 胜出（project 非法值未参与校验）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 } },
      { llm: { timeoutMs: "bad" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { timeoutMs: 60_000 },
    });
  });

  it("project 只写 timeoutMs → 整段丢弃，user 的 maxTurns + timeoutMs 都保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 20, timeoutMs: 60_000 } },
      { llm: { timeoutMs: 30_000 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 20, timeoutMs: 60_000 },
    });
  });

  it("仅 timeoutMs（无其它 llm 字段）→ llm 层不丢弃", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { timeoutMs: 60_000 },
    });
  });

  it("timeoutMs 缺失 → 不产出 timeoutMs 字段", async () => {
    const { home, cwd } = await makeSettings({ llm: { maxTurns: 5 } }, {});
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s, { llm: { maxTurns: 5 } });
    assert.equal(s.llm?.timeoutMs, undefined);
  });

  it("返回对象深 frozen 含 timeoutMs", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s.llm));
    assert.throws(() => {
      (s.llm as { timeoutMs: number }).timeoutMs = 999;
    }, TypeError);
  });
});

describe("loadIknowSettings — subagent 段 (#358 settings 双字段)", () => {
  it("合法 maxConcurrentWorkers=6 → 透传", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { maxConcurrentWorkers: 6 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      subagent: { maxConcurrentWorkers: 6 },
    });
  });

  it('drop-not-throw: maxConcurrentWorkers 0 / -5 / "abc" / 1.5 → 丢弃', async () => {
    for (const bad of [0, -5, "abc", 1.5]) {
      const { home, cwd } = await makeSettings(
        { subagent: { maxConcurrentWorkers: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `maxConcurrentWorkers=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("project subagent 段丢弃 → user maxConcurrentWorkers 胜出", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { maxConcurrentWorkers: 6 } },
      { subagent: { maxConcurrentWorkers: 3 } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { subagent: { maxConcurrentWorkers: 6 } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"subagent"/);
  });

  it("合法 taskTimeoutMs=7200000 → 透传（per-task 缺省）", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { taskTimeoutMs: 7_200_000 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      subagent: { taskTimeoutMs: 7_200_000 },
    });
  });

  it("合法 taskTimeoutMs=1800000 → 透传（deer-flow 实测值）", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { taskTimeoutMs: 1_800_000 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      subagent: { taskTimeoutMs: 1_800_000 },
    });
  });

  it('drop-not-throw: taskTimeoutMs 0 / -5 / "abc" / 1.5 → 丢弃', async () => {
    for (const bad of [0, -5, "abc", 1.5]) {
      const { home, cwd } = await makeSettings(
        { subagent: { taskTimeoutMs: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `taskTimeoutMs=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("drop-not-throw: taskTimeoutMs 非数字/null/true/[]/{}/undefined → 丢弃", async () => {
    for (const bad of [null, true, false, [], {}]) {
      const { home, cwd } = await makeSettings(
        { subagent: { taskTimeoutMs: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `taskTimeoutMs=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("project taskTimeoutMs 丢弃 → user taskTimeoutMs 胜出", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { taskTimeoutMs: 7_200_000 } },
      { subagent: { taskTimeoutMs: 1_800_000 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      subagent: { taskTimeoutMs: 7_200_000 },
    });
  });

  it("project subagent 段整体丢弃 → user taskTimeoutMs 胜出（project 非法值未参与校验）", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { taskTimeoutMs: 7_200_000 } },
      { subagent: { taskTimeoutMs: "bad" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      subagent: { taskTimeoutMs: 7_200_000 },
    });
  });

  it("subagent 非普通对象（数组 / 字符串 / 数字）→ 丢弃该层", async () => {
    for (const bad of [[{ taskTimeoutMs: 7_200_000 }], "garbage", 42]) {
      const { home, cwd } = await makeSettings({ subagent: bad }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `subagent=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("taskTimeoutMs 缺失 → 不产出 subagent 段", async () => {
    const { home, cwd } = await makeSettings({ llm: { maxTurns: 5 } }, {});
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s, { llm: { maxTurns: 5 } });
    assert.equal(s.subagent, undefined);
  });

  it("taskTimeoutMs 全部非法 → 不产出 subagent 段", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { taskTimeoutMs: 0 } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("subagent 与 llm 并存 → 两段都保留", async () => {
    const { home, cwd } = await makeSettings(
      {
        llm: { maxTurns: 20, timeoutMs: 60_000 },
        subagent: { taskTimeoutMs: 7_200_000 },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 20, timeoutMs: 60_000 },
      subagent: { taskTimeoutMs: 7_200_000 },
    });
  });

  it("user 配 llm.timeoutMs、project 配 subagent.taskTimeoutMs → 只出 user 段（project 段被丢弃）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { timeoutMs: 60_000 } },
      { subagent: { taskTimeoutMs: 7_200_000 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { timeoutMs: 60_000 },
    });
  });

  it("返回对象深 frozen 含 subagent", async () => {
    const { home, cwd } = await makeSettings(
      { subagent: { taskTimeoutMs: 7_200_000 } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.subagent));
    assert.throws(() => {
      (s.subagent as { taskTimeoutMs: number }).taskTimeoutMs = 999;
    }, TypeError);
  });
});

describe("loadIknowSettings — llm.apiKey validator (settings-model-extension)", () => {
  it("字面非空串 → 合法（trim 后保留）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "sk-abc-123" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "sk-abc-123" },
    });
  });

  it("字面前后空白 → trim 后保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "  sk-abc-123  " } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "sk-abc-123" },
    });
  });

  it("${VAR} 占位符 → 合法（保留完整形态，env.ts 负责解析）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "${ANTHROPIC_AUTH_TOKEN}" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "${ANTHROPIC_AUTH_TOKEN}" },
    });
  });

  it("$VAR 裸形态 → 合法（不含 `${`，按字面接受）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "$NINE_ROUTER_KEY" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "$NINE_ROUTER_KEY" },
    });
  });

  it("空串 → 非法丢弃（不产出 apiKey）", async () => {
    const { home, cwd } = await makeSettings({ llm: { apiKey: "" } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("全空白 → 非法丢弃", async () => {
    const { home, cwd } = await makeSettings({ llm: { apiKey: "   " } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("非字符串（数组 / 数字 / null / 对象 / bool）→ 非法丢弃", async () => {
    for (const bad of [["sk-abc"], 123, null, { name: "sk" }, true, false]) {
      const { home, cwd } = await makeSettings({ llm: { apiKey: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `apiKey=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("${} 非法占位符 → 丢弃（含 `${` 但不匹配 `${VAR}` 形态）", async () => {
    const { home, cwd } = await makeSettings({ llm: { apiKey: "${}" } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("${1VAR} 首字符非法 → 丢弃", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "${1VAR}" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("${VAR 未闭合 → 丢弃", async () => {
    const { home, cwd } = await makeSettings({ llm: { apiKey: "${VAR" } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  // Validator semantics aligned with the env.ts resolver — "every ${...} form in the whole string must be legal"
  it("M7 收紧：${A}${1B} 混合合法 + 非法 → 丢弃（残骸检测）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "${A}${1B}" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("M7 收紧：${A}${B} 全合法 → 保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "${A}${B}" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "${A}${B}" },
    });
  });

  it("M7 收紧：${A}literal 合法占位符 + 字面混合 → 保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "${A}literal" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "${A}literal" },
    });
  });

  it("M7 收紧：plain 字面 → 保留", async () => {
    const { home, cwd } = await makeSettings({ llm: { apiKey: "plain" } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "plain" },
    });
  });

  it("apiKey 层选择：project llm 段丢弃 → user ${USER_KEY} 胜出（密钥不落共享仓库）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "${USER_KEY}" } },
      { llm: { apiKey: "${PROJECT_KEY}" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "${USER_KEY}" },
    });
  });

  it("project llm 段整体丢弃 → user apiKey 胜出（project 非法值未参与校验）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "${USER_KEY}" } },
      { llm: { apiKey: "${1BAD}" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "${USER_KEY}" },
    });
  });

  it("user apiKey 字面、project apiKey ${VAR} → user 胜出（project 段整体丢弃）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "sk-literal" } },
      { llm: { apiKey: "${PROJECT_KEY}" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "sk-literal" },
    });
  });

  it("llm 是数组 → 整个 llm 丢弃（含 apiKey）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: [{ apiKey: "sk-abc" }] },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("返回对象深 frozen 含 apiKey（不可改）", async () => {
    const { home, cwd } = await makeSettings({ llm: { apiKey: "sk-abc" } }, {});
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s.llm));
    assert.throws(() => {
      (s.llm as { apiKey: string }).apiKey = "other";
    }, TypeError);
  });
});

describe("loadIknowSettings — verify 段 (#128 自动修正闭环)", () => {
  it("未配置 verify → verify undefined（透明关闭）", async () => {
    const { home, cwd } = await makeSettings({ llm: { maxTurns: 5 } }, {});
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s, { llm: { maxTurns: 5 } });
    assert.equal(s.verify, undefined);
  });

  it("完整合法 verify 段 → 逐字段解析（command/rerunTemplate/countRegex/timeoutSec/onExhausted/maxRounds）", async () => {
    const { home, cwd } = await makeSettings(
      {
        verify: {
          command: "npm test",
          rerunTemplate: "npm test {files}",
          countRegex: "\\d+ failures?",
          timeoutSec: 900,
          onExhausted: "escalate",
          maxRounds: 20,
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      verify: {
        command: "npm test",
        rerunTemplate: "npm test {files}",
        countRegex: "\\d+ failures?",
        timeoutSec: 900,
        onExhausted: "escalate",
        maxRounds: 20,
      },
    });
  });

  it("默认值语义：timeoutSec/maxRounds/onExhausted 未配时 verify 字段里没有它们（消费点兜底）", async () => {
    const { home, cwd } = await makeSettings(
      { verify: { command: "npm test" } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s, { verify: { command: "npm test" } });
    assert.equal(s.verify?.timeoutSec, undefined);
    assert.equal(s.verify?.onExhausted, undefined);
    assert.equal(s.verify?.maxRounds, undefined);
  });

  it("非法值降级：负数 timeoutSec / 空 command / 未知 onExhausted → 该字段被丢弃", async () => {
    for (const badTimeout of [0, -5, 1.5, "abc"]) {
      const { home, cwd } = await makeSettings(
        { verify: { command: "npm test", timeoutSec: badTimeout } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { verify: { command: "npm test" } },
        `timeoutSec=${JSON.stringify(badTimeout)} 应丢弃`
      );
    }
    for (const badCommand of ["", "   ", 123, null, true, []]) {
      const { home, cwd } = await makeSettings(
        { verify: { command: badCommand, timeoutSec: 60 } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { verify: { timeoutSec: 60 } },
        `command=${JSON.stringify(badCommand)} 应丢弃`
      );
    }
    for (const badExhausted of ["stop", "", "ESCALATE", 1, null]) {
      const { home, cwd } = await makeSettings(
        { verify: { command: "npm test", onExhausted: badExhausted } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { verify: { command: "npm test" } },
        `onExhausted=${JSON.stringify(badExhausted)} 应丢弃`
      );
    }
  });

  it("非法值降级：负数/非整数 maxRounds → 丢弃", async () => {
    for (const bad of [0, -1, 2.5, "abc"]) {
      const { home, cwd } = await makeSettings(
        { verify: { command: "npm test", maxRounds: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { verify: { command: "npm test" } },
        `maxRounds=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("verify 全字段非法 → 不产出 verify（丢弃整个字段）", async () => {
    const { home, cwd } = await makeSettings(
      { verify: { command: "", timeoutSec: -1, onExhausted: "nope" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("verify 非普通对象（数组 / 字符串 / 数字）→ 丢弃该层", async () => {
    for (const bad of [[{ command: "npm test" }], "garbage", 42]) {
      const { home, cwd } = await makeSettings({ verify: bad }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `verify=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("verify 字符串字段 trim 后保留（两端空白去除）", async () => {
    const { home, cwd } = await makeSettings(
      {
        verify: {
          command: "  npm test  ",
          rerunTemplate: "  vitest run {files}  ",
          countRegex: "  (\\d+) failed  ",
        },
      },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      verify: {
        command: "npm test",
        rerunTemplate: "vitest run {files}",
        countRegex: "(\\d+) failed",
      },
    });
  });

  it("rerunTemplate / countRegex 空串或非字符串 → 丢弃该字段", async () => {
    for (const bad of ["", "   ", 123, null, []]) {
      const { home, cwd } = await makeSettings(
        {
          verify: { command: "npm test", rerunTemplate: bad, countRegex: bad },
        },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { verify: { command: "npm test" } },
        `rerunTemplate/countRegex=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("project 覆盖 user：verify 段逐字段覆盖", async () => {
    const { home, cwd } = await makeSettings(
      {
        verify: {
          command: "user-test",
          rerunTemplate: "user-template",
          timeoutSec: 300,
          onExhausted: "escalate",
          maxRounds: 5,
        },
      },
      { verify: { command: "project-test", timeoutSec: 120 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      verify: {
        command: "project-test",
        rerunTemplate: "user-template",
        timeoutSec: 120,
        onExhausted: "escalate",
        maxRounds: 5,
      },
    });
  });

  it("project verify 非法值不覆盖 user 合法值（保留 user 值）", async () => {
    for (const bad of [0, -1, "abc"]) {
      const { home, cwd } = await makeSettings(
        { verify: { command: "user-test", timeoutSec: 300 } },
        { verify: { command: "project-test", timeoutSec: bad } }
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { verify: { command: "project-test", timeoutSec: 300 } },
        `project timeoutSec=${JSON.stringify(bad)} 应不覆盖 user`
      );
    }
  });

  it("project 配 verify、user 未配 → 只出 project verify", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { verify: { command: "npm test" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      verify: { command: "npm test" },
    });
  });

  it("verify 与 llm 并存 → 两者都保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 20 }, verify: { command: "npm test" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 20 },
      verify: { command: "npm test" },
    });
  });

  it("classifierModel：非空串合法 → 透传 + trim（#128 verify 分类器，A7 槽位）", async () => {
    const { home, cwd } = await makeSettings(
      { verify: { classifierModel: "  claude-haiku-4-5  " } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      verify: { classifierModel: "claude-haiku-4-5" },
    });
  });

  it("classifierModel：空串/非字符串/数字/数组/null → 丢弃该字段（沿用 command 的 drop-not-throw 纪律）", async () => {
    for (const bad of ["", "   ", 123, true, null, [], { foo: "bar" }]) {
      const { home, cwd } = await makeSettings(
        { verify: { command: "npm test", classifierModel: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { verify: { command: "npm test" } },
        `classifierModel=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("classifierModel 与 command 互不耦合：仅 classifierModel → verify 段保留（command 缺时不透明关闭见 SC7，本字段独立）", async () => {
    const { home, cwd } = await makeSettings(
      { verify: { classifierModel: "claude-haiku-4-5" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      verify: { classifierModel: "claude-haiku-4-5" },
    });
  });

  it("classifierModel：project 覆盖 user（逐字段 project-wins-over-user）", async () => {
    const { home, cwd } = await makeSettings(
      { verify: { classifierModel: "user-model" } },
      { verify: { classifierModel: "project-model" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      verify: { classifierModel: "project-model" },
    });
  });

  it("classifierModel：project 非法值不覆盖 user 合法值（保留 user 值）", async () => {
    for (const bad of ["", 0, null, true]) {
      const { home, cwd } = await makeSettings(
        { verify: { classifierModel: "user-model" } },
        { verify: { classifierModel: bad } }
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        { verify: { classifierModel: "user-model" } },
        `project classifierModel=${JSON.stringify(bad)} 应不覆盖 user`
      );
    }
  });

  it("classifierModel：与其它字段共存的合并结果（project 只覆盖部分字段）", async () => {
    const { home, cwd } = await makeSettings(
      {
        verify: {
          command: "user-test",
          rerunTemplate: "user-template",
          timeoutSec: 300,
          classifierModel: "user-model",
        },
      },
      { verify: { command: "project-test", classifierModel: "project-model" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      verify: {
        command: "project-test",
        rerunTemplate: "user-template",
        timeoutSec: 300,
        classifierModel: "project-model",
      },
    });
  });

  it("classifierModel：verify 段被整体丢弃时（仅 classifierModel 一个字段且非法）不产出 verify", async () => {
    const { home, cwd } = await makeSettings(
      { verify: { classifierModel: "" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("classifierModel：返回对象深 frozen 含 verify.classifierModel（不可改）", async () => {
    const { home, cwd } = await makeSettings(
      { verify: { classifierModel: "claude-haiku-4-5" } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s.verify));
    assert.throws(() => {
      (s.verify as { classifierModel: string }).classifierModel = "other";
    }, TypeError);
  });

  // Assembly-layer fix: when command is missing, resolveVerifyConfig falls back to { command: "" }
  // (the classifier judge takes over, per spec Objective), no longer an undefined transparent close.
  it("resolveVerifyConfig(undefined)（verify 段完全缺失）→ { command: '' }（分类器接管，不再透明关闭）", async () => {
    const { home, cwd } = await makeSettings({}, {});
    const settings = loadIknowSettings({ home, cwd });
    const config = resolveVerifyConfig(settings.verify);
    assert.deepEqual(config, { command: "" });
    assert.notEqual(config, undefined, "verify 段缺失也必须产出 VerifyConfig");
  });

  it("resolveVerifyConfig({ command: 'npm test' }) → command 原样透传（不回归）", async () => {
    const { home, cwd } = await makeSettings(
      { verify: { command: "  npm test  ", timeoutSec: 300 } },
      {}
    );
    const config = resolveVerifyConfig(loadIknowSettings({ home, cwd }).verify);
    assert.deepEqual(config, { command: "npm test", timeoutSec: 300 });
  });

  it("resolveVerifyConfig 全字段透传：verify 段全字段 → 逐字段保留", async () => {
    const { home, cwd } = await makeSettings(
      {
        verify: {
          command: "npm test",
          rerunTemplate: "npm test {files}",
          countRegex: "\\d+ failures?",
          timeoutSec: 900,
          onExhausted: "escalate",
          maxRounds: 20,
          classifierModel: "claude-haiku-4-5",
        },
      },
      {}
    );
    const config = resolveVerifyConfig(loadIknowSettings({ home, cwd }).verify);
    assert.deepEqual(config, {
      command: "npm test",
      rerunTemplate: "npm test {files}",
      countRegex: "\\d+ failures?",
      timeoutSec: 900,
      onExhausted: "escalate",
      maxRounds: 20,
      classifierModel: "claude-haiku-4-5",
    });
  });

  it("resolveVerifyConfig 只透传显式配置字段：command 未配 + 仅 classifierModel → { command: '', classifierModel }（默认值仍由消费点兜底）", async () => {
    const { home, cwd } = await makeSettings(
      { verify: { classifierModel: "claude-haiku-4-5" } },
      {}
    );
    const config = resolveVerifyConfig(loadIknowSettings({ home, cwd }).verify);
    assert.deepEqual(config, {
      command: "",
      classifierModel: "claude-haiku-4-5",
    });
    assert.equal(config.timeoutSec, undefined);
    assert.equal(config.maxRounds, undefined);
    assert.equal(config.onExhausted, undefined);
  });

  it("resolveVerifyConfig 非法值降级：字段级非法 → 丢弃（不产字段），command 空串兜底", async () => {
    // Empty-string command is invalid → settings layer drops command; invalid timeoutSec → dropped.
    const { home, cwd } = await makeSettings(
      { verify: { command: "   ", timeoutSec: -1 } },
      {}
    );
    const settings = loadIknowSettings({ home, cwd });
    assert.deepEqual(
      settings,
      {},
      "settings 层丢弃全部非法字段 → 无 verify 段"
    );
    const config = resolveVerifyConfig(settings.verify);
    assert.deepEqual(config, { command: "" }, "装配层仍以 command='' 兜底");
  });

  it("返回对象深 frozen 含 verify 段（嵌套字段不可改）", async () => {
    const { home, cwd } = await makeSettings(
      {
        verify: {
          command: "npm test",
          rerunTemplate: "npm test {files}",
          timeoutSec: 900,
          onExhausted: "escalate",
          maxRounds: 20,
        },
      },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.verify));
    assert.throws(() => {
      (s.verify as { command: string }).command = "other";
    }, TypeError);
    assert.throws(() => {
      (s.verify as { timeoutSec: number }).timeoutSec = 1;
    }, TypeError);
    assert.throws(() => {
      (s.verify as { onExhausted: string }).onExhausted = "report";
    }, TypeError);
    assert.throws(() => {
      (s.verify as { maxRounds: number }).maxRounds = 1;
    }, TypeError);
  });
});

describe("loadIknowSettings — secrets 段 (#126 hook-system T4)", () => {
  it("user 写 secrets → 读到 enabled + patterns", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { enabled: true, patterns: ["TOKEN"] } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { enabled: true, patterns: ["TOKEN"] },
    });
  });

  it("secrets 缺失 → 不产出 secrets 字段", async () => {
    const { home, cwd } = await makeSettings({ llm: { model: "m3" } }, {});
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s, { llm: { model: "m3" } });
    assert.equal(s.secrets, undefined);
  });

  it("secrets.patterns 空数组 → 丢弃（不产出 patterns）", async () => {
    const { home, cwd } = await makeSettings({ secrets: { patterns: [] } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("secrets.enabled: false → 读到（false 也是合法 boolean）", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { enabled: false } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { enabled: false },
    });
  });

  it("secrets.enabled: true → 读到", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { enabled: true } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { enabled: true },
    });
  });

  it("project 覆盖 user secrets.enabled（同字段替换）", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { enabled: true } },
      { secrets: { enabled: false } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { enabled: false },
    });
  });

  it("project 覆盖 user secrets.patterns（替换非 merge 残留）", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { patterns: ["USER_TOKEN"] } },
      { secrets: { patterns: ["PROJECT_TOKEN"] } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { patterns: ["PROJECT_TOKEN"] },
    });
  });

  it("逐层合并：project 只覆盖 enabled，保留 user 的 patterns", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { enabled: true, patterns: ["USER_TOKEN"] } },
      { secrets: { enabled: false } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { enabled: false, patterns: ["USER_TOKEN"] },
    });
  });

  it('enabled 非 boolean（"yes" / 0 / 1）→ 丢弃（不产出 secrets）', async () => {
    for (const bad of ["yes", 0, 1]) {
      const { home, cwd } = await makeSettings(
        { secrets: { enabled: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `enabled=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("patterns 非数组 / 含非字符串 / 含空串 → 丢弃整个 patterns 字段", async () => {
    for (const bad of ["x", 123, [123], [""], ["   "], [null]]) {
      const { home, cwd } = await makeSettings(
        { secrets: { patterns: bad } },
        {}
      );
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `patterns=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("patterns 非法但 enabled 合法 → 丢弃 patterns、保留 enabled", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { enabled: true, patterns: [123] } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { enabled: true },
    });
  });

  it("project secrets 非法不覆盖 user 合法（保留 user 值）", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { enabled: true, patterns: ["USER_TOKEN"] } },
      { secrets: { enabled: "yes", patterns: [123] } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { enabled: true, patterns: ["USER_TOKEN"] },
    });
  });

  it("secrets.patterns 元素 trim 后保留（两端空白去除）", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { patterns: ["  TOKEN_ONE  ", "TOKEN_TWO"] } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { patterns: ["TOKEN_ONE", "TOKEN_TWO"] },
    });
  });

  it("返回对象深 frozen 含 secrets 段（enabled + patterns 数组不可改）", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { enabled: true, patterns: ["TOKEN"] } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.secrets));
    assert.ok(Object.isFrozen(s.secrets!.patterns));
    assert.throws(() => {
      (s.secrets as { enabled: boolean }).enabled = false;
    }, TypeError);
    assert.throws(() => {
      (s.secrets!.patterns as string[])[0] = "other";
    }, TypeError);
  });
});

describe("loadIknowSettings — secrets.mode 段 (#406 T4)", () => {
  it('secrets.mode: "roundtrip" → 读到（显式 roundtrip 合法）', async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { mode: "roundtrip" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { mode: "roundtrip" },
    });
  });

  it('secrets.mode: "block" → 读到（legacy deny-only 路径）', async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { mode: "block" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { mode: "block" },
    });
  });

  it('secrets.mode: "invalid" → 丢弃（不产出 secrets）', async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { mode: "invalid" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("secrets.mode 非字符串（123 / true / null / [] / {}）→ 丢弃", async () => {
    for (const bad of [123, true, null, [], {}]) {
      const { home, cwd } = await makeSettings({ secrets: { mode: bad } }, {});
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `mode=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("secrets.mode 非法但 enabled 合法 → 丢弃 mode、保留 enabled", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { enabled: true, mode: "bogus" } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { enabled: true },
    });
  });

  it("project mode 覆盖 user mode（同字段替换）", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { mode: "roundtrip" } },
      { secrets: { mode: "block" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { mode: "block" },
    });
  });

  it("project 无 mode、user 有 mode → 保留 user mode（逐层合并）", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { mode: "block", enabled: true } },
      { secrets: { enabled: false } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { enabled: false, mode: "block" },
    });
  });

  it("project mode 非法不覆盖 user 合法（保留 user 值）", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { mode: "roundtrip" } },
      { secrets: { mode: "invalid" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      secrets: { mode: "roundtrip" },
    });
  });

  it("返回对象深 frozen 含 secrets.mode（不可改）", async () => {
    const { home, cwd } = await makeSettings(
      { secrets: { mode: "block" } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.secrets));
    assert.throws(() => {
      (s.secrets as { mode: string }).mode = "roundtrip";
    }, TypeError);
  });
});

describe("loadIknowSettings — 项目 allowlist / permissions（ADR-0084 / SC4 / SC5）", () => {
  it("SC4：项目含 isolation / llm.model → 合并结果等于用户层值 + 每键一条警告", async () => {
    const { home, cwd } = await makeSettings(
      {
        isolation: { worktreeOnMutate: true, worktreeExclusive: true },
        llm: { model: "user-model" },
      },
      {
        isolation: { worktreeOnMutate: false },
        llm: { model: "project-model" },
      }
    );
    const warnings: string[] = [];
    const s = loadIknowSettings({
      home,
      cwd,
      onWarn: (m) => warnings.push(m),
    });
    assert.deepEqual(s, {
      isolation: { worktreeOnMutate: true, worktreeExclusive: true },
      llm: { model: "user-model" },
    });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /"isolation"/);
    assert.match(warnings[1]!, /"llm"/);
  });

  it("用户层无对应值时项目值也不生效（不因 user 缺席而回落到 project）", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { isolation: { worktreeOnMutate: true } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {});
  });

  it("允许名单键（verify / secrets / permissions）仍按 project 覆盖 user 合并", async () => {
    const { home, cwd } = await makeSettings(
      {
        verify: { command: "user-test", timeoutSec: 300 },
        secrets: { enabled: true },
      },
      {
        verify: { command: "project-test" },
        secrets: { enabled: false },
      }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      verify: { command: "project-test", timeoutSec: 300 },
      secrets: { enabled: false },
    });
  });

  it("未知顶层键 → 丢弃 + 警告（前向兼容：不抛错）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { model: "u" } },
      { somethingNew: { a: 1 } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      { llm: { model: "u" } }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"somethingNew"/);
  });

  it("不注入 onWarn → 默认走 console.warn 且不抛错（默认通道可测）", async () => {
    const { home, cwd } = await makeSettings({}, { llm: { model: "p" } });
    const original = console.warn;
    const captured: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      assert.deepEqual(loadIknowSettings({ home, cwd }), {});
    } finally {
      console.warn = original;
    }
    assert.equal(captured.length, 1);
    assert.match(String(captured[0]![0]), /"llm"/);
  });

  it("project permissions 段：defaultMode + allow/ask/deny 字符串数组原样透传（形状透传，语义归 permission 层）", async () => {
    const { home, cwd } = await makeSettings(
      {},
      {
        permissions: {
          defaultMode: "plan",
          allow: ["Bash(echo:*)"],
          ask: ["Bash(git commit:*)"],
          deny: ["Read(**/.pem)"],
        },
      }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      permissions: {
        defaultMode: "plan",
        allow: ["Bash(echo:*)"],
        ask: ["Bash(git commit:*)"],
        deny: ["Read(**/.pem)"],
      },
    });
  });

  it("project permissions 段：缺字段的合法形态也透传", async () => {
    for (const section of [
      { allow: ["Bash"] },
      { deny: ["Read(.env)"] },
      { defaultMode: "default" },
      { allow: [], deny: [] },
    ]) {
      const { home, cwd } = await makeSettings({}, { permissions: section });
      assert.deepEqual(loadIknowSettings({ home, cwd }), {
        permissions: section,
      });
    }
  });

  it("project permissions 非普通对象 / 字段类型错 → 丢弃该段（drop-not-throw）", async () => {
    for (const bad of [
      "x",
      1,
      [],
      { allow: "not-array" },
      { deny: 42 },
      { defaultMode: 7 },
    ]) {
      const { home, cwd } = await makeSettings({}, { permissions: bad });
      assert.deepEqual(
        loadIknowSettings({ home, cwd }),
        {},
        `permissions=${JSON.stringify(bad)} 应丢弃`
      );
    }
  });

  it("用户层 permissions 不接：值不生效 + 警告点名（ADR-0084）", async () => {
    const { home, cwd } = await makeSettings(
      {
        permissions: {
          allow: ["Bash(echo:*)"],
        },
      },
      {}
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }),
      {}
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"permissions"/);
  });

  it("返回对象深 frozen 含 permissions 段与字符串数组", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { permissions: { allow: ["Bash"], deny: ["Read(.env)"] } }
    );
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s.permissions));
    assert.ok(Object.isFrozen(s.permissions!.allow));
    assert.ok(Object.isFrozen(s.permissions!.deny));
  });
});
