/**
 * tests/config/settings-llm-providers.test.ts
 *
 * ADR-0093 / #1010: `settings.llm.providers` schema + drop-not-throw 校验。
 *
 * provider 形态：
 *  - `id`（非空串，trim）
 *  - `baseUrl`（非空串，trim）
 *  - `apiKeyEnv`（非空串，trim）—— V1 仅 anthropic 格式，env 变量名
 *  - `headers?`（普通对象，键值均为字符串；非字符串值 drop 整键）
 *  - `models[]`（非空数组；每项 id 非空 + 可选 name/contextWindow/maxTokens）
 *
 * 用户层键：项目文件写 `llm.providers` 整段丢弃并告警。
 *
 * 跑法：`npx vitest run tests/config/settings-llm-providers.test.ts`。
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIknowSettings } from "../../src/config/settings.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-llm-providers-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

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

describe("loadIknowSettings — llm.providers 段 (ADR-0093 / #1010)", () => {
  it("合法 providers 数组 → 整段透传,id/baseUrl/apiKeyEnv/models 各字段保序", async () => {
    const { home, cwd } = await makeSettings(
      {
        llm: {
          providers: [
            {
              id: "minimax-cn",
              baseUrl: "https://api.minimax.chat/v1",
              apiKeyEnv: "MINIMAX_CN_API_KEY",
              models: [
                {
                  id: "MiniMax-M3",
                  name: "MiniMax-M3",
                  contextWindow: 1000000,
                  maxTokens: 128000,
                },
              ],
            },
            {
              id: "volcengine-ark",
              baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
              apiKeyEnv: "VOLCENGINE_ARK_API_KEY",
              headers: { "X-Session": "iknow-dev" },
              models: [{ id: "deepseek-v3" }, { id: "doubao-pro" }],
            },
          ],
        },
      },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.equal(s.llm?.providers?.length, 2);
    assert.equal(s.llm?.providers?.[0]?.id, "minimax-cn");
    assert.equal(s.llm?.providers?.[0]?.baseUrl, "https://api.minimax.chat/v1");
    assert.equal(s.llm?.providers?.[0]?.apiKeyEnv, "MINIMAX_CN_API_KEY");
    assert.equal(s.llm?.providers?.[0]?.models[0]?.id, "MiniMax-M3");
    assert.equal(s.llm?.providers?.[0]?.models[0]?.contextWindow, 1000000);
    assert.equal(s.llm?.providers?.[0]?.models[0]?.maxTokens, 128000);
    assert.equal(s.llm?.providers?.[1]?.headers?.["X-Session"], "iknow-dev");
  });

  it("整段 llm.providers 非数组 → 丢弃 providers,其它 llm 字段保留", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { model: "minimax-cn/MiniMax-M3", providers: "not-array" } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.deepEqual(s, { llm: { model: "minimax-cn/MiniMax-M3" } });
  });

  it("providers 数组含坏条(id 空串 / baseUrl 非字符串 / apiKeyEnv 缺失 / models 非数组)→ 整条 drop", async () => {
    const { home, cwd } = await makeSettings(
      {
        llm: {
          providers: [
            { id: "", baseUrl: "https://x", apiKeyEnv: "K", models: [] }, // id 空串
            { id: "ok-a", baseUrl: 123, apiKeyEnv: "K", models: [] }, // baseUrl 非字符串
            { id: "ok-b", baseUrl: "https://x", models: [] }, // apiKeyEnv 缺失
            {
              id: "ok-c",
              baseUrl: "https://x",
              apiKeyEnv: "K",
              models: "no",
            }, // models 非数组
            {
              id: "ok-good",
              baseUrl: "https://x",
              apiKeyEnv: "K",
              models: [{ id: "m1" }],
            },
          ],
        },
      },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.equal(s.llm?.providers?.length, 1);
    assert.equal(s.llm?.providers?.[0]?.id, "ok-good");
  });

  it("provider.models 项字段非法(id 空串 → drop model;contextWindow 0 → 仅字段 drop,model 保留)", async () => {
    const { home, cwd } = await makeSettings(
      {
        llm: {
          providers: [
            {
              id: "p",
              baseUrl: "https://x",
              apiKeyEnv: "K",
              models: [
                { id: "" }, // id 空串 → 整 model drop
                { id: "ok", contextWindow: 0 }, // 0 不合法(>0 才是合法正数)→ 仅 contextWindow 字段 drop,model 保留
                { id: "ok2", name: "OK2" },
              ],
            },
          ],
        },
      },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    const provider = s.llm?.providers?.[0];
    assert.equal(provider?.models.length, 2);
    // 第二个 model(contextWindow 0)被保留但 contextWindow 字段缺席
    assert.equal(provider?.models[0]?.id, "ok");
    assert.equal(provider?.models[0]?.contextWindow, undefined);
    assert.equal(provider?.models[1]?.id, "ok2");
    assert.equal(provider?.models[1]?.name, "OK2");
  });

  it("providers 空数组 → 丢弃 providers 字段(空集无意义)", async () => {
    const { home, cwd } = await makeSettings(
      { llm: { providers: [], model: "minimax-cn/MiniMax-M3" } },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.equal(s.llm?.providers, undefined);
    assert.equal(s.llm?.model, "minimax-cn/MiniMax-M3");
  });

  it("project 写 providers → 整段丢弃(用户层键),user 值胜出", async () => {
    const { home, cwd } = await makeSettings(
      {
        llm: {
          providers: [
            {
              id: "user-p",
              baseUrl: "https://user",
              apiKeyEnv: "K",
              models: [{ id: "m1" }],
            },
          ],
        },
      },
      {
        llm: {
          providers: [
            {
              id: "project-p",
              baseUrl: "https://project",
              apiKeyEnv: "K",
              models: [{ id: "m1" }],
            },
          ],
        },
      }
    );
    const s = loadIknowSettings({ home, cwd });
    assert.equal(s.llm?.providers?.length, 1);
    assert.equal(s.llm?.providers?.[0]?.id, "user-p");
  });

  it("providers 字段缺失 → 不产出 providers 段", async () => {
    const { home, cwd } = await makeSettings({ llm: { model: "x" } }, {});
    assert.equal(loadIknowSettings({ home, cwd }).llm?.providers, undefined);
  });

  it("id / baseUrl / apiKeyEnv 仅 trim;headers 非字符串值 drop 整键", async () => {
    const { home, cwd } = await makeSettings(
      {
        llm: {
          providers: [
            {
              id: "  minimax-cn  ",
              baseUrl: "  https://api.minimax.chat/v1  ",
              apiKeyEnv: "  MINIMAX_CN_API_KEY  ",
              headers: { "X-Session": "iknow", "X-Bad": 42 },
              models: [{ id: "  M3  ", name: "  MiniMax-M3  " }],
            },
          ],
        },
      },
      {}
    );
    const p = loadIknowSettings({ home, cwd }).llm?.providers?.[0];
    assert.equal(p?.id, "minimax-cn");
    assert.equal(p?.baseUrl, "https://api.minimax.chat/v1");
    assert.equal(p?.apiKeyEnv, "MINIMAX_CN_API_KEY");
    assert.equal(p?.headers?.["X-Session"], "iknow");
    assert.equal(p?.headers?.["X-Bad"], undefined);
    assert.equal(p?.models[0]?.id, "M3");
    assert.equal(p?.models[0]?.name, "MiniMax-M3");
  });

  it("返回对象深 frozen 含 providers 数组", async () => {
    const { home, cwd } = await makeSettings(
      {
        llm: {
          providers: [
            {
              id: "p",
              baseUrl: "https://x",
              apiKeyEnv: "K",
              models: [{ id: "m" }],
            },
          ],
        },
      },
      {}
    );
    const s = loadIknowSettings({ home, cwd });
    assert.ok(Object.isFrozen(s.llm?.providers));
    assert.ok(Object.isFrozen(s.llm?.providers?.[0]));
    assert.ok(Object.isFrozen(s.llm?.providers?.[0]?.models));
  });
});
