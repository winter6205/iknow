/**
 * #353: settings 文件机制 —— user/project 双层加载 + 逐层合并 + 非法值回退。
 *
 * 覆盖：
 *  - 文件不存在 → 空对象（不抛错）；
 *  - user 值读取 / project 覆盖 user（同字段替换，非 merge 残留）；
 *  - 逐层合并（project 只覆盖 llm.maxTurns，保留 user 的 llm.compress）；
 *  - 坏 JSON → 空对象（user / project 分别测）；
 *  - 非法值丢弃（maxTurns 0 / -5 / "abc" / 1.5；contextWindow 0 / "bad"；
 *    thresholdTokens 0）；
 *  - 非法字段不覆盖 user 合法值（project 非法 → 保留 user 值）；
 *  - llm 是数组 / 字符串 → 丢弃该层；
 *  - 返回对象深 frozen。
 *
 * 每个用例独立 tmp dir，通过 opts.home / opts.cwd 隔离，不碰真实 ~/.iknow。
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIknowSettings } from "../../src/config/settings.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-settings-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * 写 user / project 各一个 settings 文件，返回隔离的 LoadSettingsOpts。
 * 始终创建 .iknow 目录（空对象用例也保证目录存在，避免 writeFile ENOENT）。
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

  it("project 覆盖 user（同字段替换，非 merge 残留）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 20 } },
      { llm: { maxTurns: 5 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 5 },
    });
  });

  it("逐层合并：project 只覆盖 llm.maxTurns，保留 user 的 llm.compress", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 20, compress: { contextWindow: 200000 } } },
      { llm: { maxTurns: 5 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 5, compress: { contextWindow: 200000 } },
    });
  });

  it("压缩字段逐层合并：project 只覆盖 compress.thresholdTokens，保留 user 的 contextWindow", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { compress: { contextWindow: 200000, thresholdTokens: 150000 } } },
      { llm: { compress: { thresholdTokens: 100000 } } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { compress: { contextWindow: 200000, thresholdTokens: 100000 } },
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

  it("project 非法值不覆盖 user 合法值（保留 user 值）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 20 } },
      { llm: { maxTurns: "bad" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { maxTurns: 20 },
    });
  });

  it("project compress 非法不覆盖 user compress（user 的 compress 完整保留）", async () => {
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

  it("project 写 llm.model=x，user 写 llm.model=y → project 覆盖", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { model: "y" } },
      { llm: { model: "x" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { model: "x" },
    });
  });

  it("project 写非法 model，user 写合法 → user 保留（非法不覆盖）", async () => {
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

  it("user/project 都没 model → 返回对象无 model 字段", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { maxTurns: 5 } },
      { llm: { maxTurns: 3 } }
    );
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s, { llm: { maxTurns: 3 } });
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

  it("project 写 llm.fallback，user 也写 → project 覆盖（替换非 merge 残留）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { fallback: ["user-a", "user-b"] } },
      { llm: { fallback: ["project-a"] } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { fallback: ["project-a"] },
    });
  });

  it("user 写 fallback、project 写其它字段 → user fallback 保留（逐层合并）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { fallback: ["u1"] } },
      { llm: { maxTurns: 5 } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { fallback: ["u1"], maxTurns: 5 },
    });
  });

  it("project fallback 非法不覆盖 user 合法（保留 user 值）", async () => {
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

  // M7: validator 与 env.ts resolver 语义对齐——「整串所有 ${...} 形态都合法」
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

  it("project > user 合并 + apiKey 字段（project 覆盖 user）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "${USER_KEY}" } },
      { llm: { apiKey: "${PROJECT_KEY}" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "${PROJECT_KEY}" },
    });
  });

  it("project apiKey 非法不覆盖 user 合法（保留 user 值）", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "${USER_KEY}" } },
      { llm: { apiKey: "${1BAD}" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "${USER_KEY}" },
    });
  });

  it("user apiKey 字面、project apiKey ${VAR} → project 覆盖", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { apiKey: "sk-literal" } },
      { llm: { apiKey: "${PROJECT_KEY}" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }), {
      llm: { apiKey: "${PROJECT_KEY}" },
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
