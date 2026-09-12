/**
 * settings-web-backend: `settings.web.searchBackend` — web_search 后端选择的
 * settings 来源（用户要求：全局 settings 可设，不依赖 shell env / .env.local）。
 *
 * Contract pinned here:
 *  - settings 解析：闭集 "bing"|"exa"|"tavily"|"brave"；非法值 drop-not-throw
 *    （镜像 parseIsolation 纪律），被丢弃字段不参与覆盖；非对象段 → undefined。
 *  - 合并（ADR-0084）：`web` 属用户层键 → 项目文件的 web 段被允许名单丢弃、
 *    永不覆盖 user；启动发一条含键名的警告。
 *  - env 回退链：env > settings.web.searchBackend > 默认 "bing"（对齐 #353
 *    maxTurns 先例）；env 未设返回 undefined 而非折叠成显式 "bing"。
 *  - env 非法值仍抛 typed `WebEnvConfigError("invalid_search_backend")`
 *    （schema reject 比 silent fallback 更显眼，#826 T1 纪律不变）。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadIknowSettings,
  type IknowSettings,
} from "../../src/config/settings.ts";
import {
  loadIknowEnv,
  isWebEnvConfigError,
  SEARCH_BACKEND_ENV_KEY,
  SEARCH_BACKEND_VALUES,
} from "../../src/config/env.ts";
import { WEB_SEARCH_BACKEND_VALUES } from "../../src/config/settings.ts";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-web-settings-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// 闭集双份（env.ts SSOT / settings.ts 环避免）的 parity 守卫：漂移在此显红，
// 而非静默 drop / accept（code-review finding：注释"类型系统兜住"只覆盖一半）。
describe("web.searchBackend 闭集 parity", () => {
  it("settings 闭集与 env SSOT 同值域（sort 后 deepEqual）", () => {
    assert.deepEqual(
      [...WEB_SEARCH_BACKEND_VALUES].sort(),
      [...SEARCH_BACKEND_VALUES].sort()
    );
  });
});

// 防 ambient 污染：镜像 env.test.ts 的 ENV_KEYS 清理纪律，未设断言才确定。
const ENV_KEYS = [SEARCH_BACKEND_ENV_KEY] as const;
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
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

/** env.test.ts 同款 fixture：极简 settings（model fail-fast 需 model 来源）。 */
function withModel(s: Record<string, unknown>): Record<string, unknown> {
  return { llm: { model: "test-model" }, ...s };
}

function loadEnvAt(cwd: string, home: string) {
  return loadIknowEnv(cwd, undefined, home);
}

describe("settings.web.searchBackend — settings surface", () => {
  it("absent section: no web key in parsed settings", async () => {
    const { home, cwd } = await makeSettings(withModel({}), {});
    const settings: IknowSettings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web, undefined);
  });

  it("legal value parses through the closed set", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.searchBackend, "exa");
  });

  it("each closed-set member is accepted", async () => {
    for (const backend of SEARCH_BACKEND_VALUES) {
      const { home, cwd } = await makeSettings(
        withModel({ web: { searchBackend: backend } }),
        {}
      );
      const settings = loadIknowSettings({ cwd, home });
      assert.equal(settings.web?.searchBackend, backend, `backend=${backend}`);
    }
  });

  it("drops an illegal value (drop-not-throw)", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "google" } }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web, undefined);
  });

  it("drops a non-string value and a non-object section", async () => {
    for (const bad of [123, true, null, ["exa"], { too: "deep" }]) {
      const { home, cwd } = await makeSettings(
        withModel({ web: { searchBackend: bad } }),
        {}
      );
      assert.equal(loadIknowSettings({ cwd, home }).web, undefined);
    }
    const { home, cwd } = await makeSettings(withModel({ web: "exa" }), {});
    assert.equal(loadIknowSettings({ cwd, home }).web, undefined);
  });

  it("ADR-0084：web 在项目允许名单外 → 项目值被丢弃，user 值胜出（非 project 覆盖）", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      { web: { searchBackend: "tavily" } }
    );
    const warnings: string[] = [];
    const settings = loadIknowSettings({
      cwd,
      home,
      onWarn: (m) => warnings.push(m),
    });
    assert.equal(settings.web?.searchBackend, "exa");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"web"/);
  });

  it("keeps the user value when project has no web section", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.searchBackend, "exa");
  });

  it("drops an illegal project value without clobbering the user layer", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      { web: { searchBackend: "google" } }
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.searchBackend, "exa");
  });

  it("freezes the parsed section", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.throws(() => {
      (settings.web as { searchBackend?: string }).searchBackend = "bing";
    });
  });
});

describe("loadIknowEnv — web.searchBackend 回退链", () => {
  it("default: no env, no settings → bing", async () => {
    const { home, cwd } = await makeSettings(withModel({}), {});
    const env = loadEnvAt(cwd, home);
    assert.equal(env.web.searchBackend, "bing");
  });

  it("settings-only: settings.web.searchBackend=exa, no env → exa", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    const env = loadEnvAt(cwd, home);
    assert.equal(env.web.searchBackend, "exa");
  });

  it("env wins over settings: env=tavily, settings=exa → tavily", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    process.env[SEARCH_BACKEND_ENV_KEY] = "tavily";
    try {
      const env = loadEnvAt(cwd, home);
      assert.equal(env.web.searchBackend, "tavily");
    } finally {
      delete process.env[SEARCH_BACKEND_ENV_KEY];
    }
  });

  it("explicit env bing overrides settings exa (no folding: unset ≠ bing)", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    process.env[SEARCH_BACKEND_ENV_KEY] = "bing";
    try {
      const env = loadEnvAt(cwd, home);
      assert.equal(env.web.searchBackend, "bing");
    } finally {
      delete process.env[SEARCH_BACKEND_ENV_KEY];
    }
  });

  it("illegal env value throws typed invalid_search_backend (even when settings has a legal value)", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      {}
    );
    process.env[SEARCH_BACKEND_ENV_KEY] = "google";
    try {
      assert.throws(() => loadEnvAt(cwd, home), isWebEnvConfigError);
      try {
        loadEnvAt(cwd, home);
        assert.fail("expected loadIknowEnv to throw");
      } catch (err) {
        assert.ok(isWebEnvConfigError(err));
        // typed-error payload 契约：varName / value / expected 必须齐备，
        // 否则渲染侧拿不到 kind 的承重字段（code-quality.md typed-error 纪律）。
        assert.equal(err.varName, SEARCH_BACKEND_ENV_KEY);
        assert.equal(err.value, "google");
        assert.deepEqual(err.expected, [...SEARCH_BACKEND_VALUES]);
      }
    } finally {
      delete process.env[SEARCH_BACKEND_ENV_KEY];
    }
  });

  it("illegal settings value falls through to default bing (drop-not-throw end-to-end)", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "google" } }),
      {}
    );
    const env = loadEnvAt(cwd, home);
    assert.equal(env.web.searchBackend, "bing");
  });
});
