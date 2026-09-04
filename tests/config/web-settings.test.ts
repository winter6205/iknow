/**
 * settings-web-backend: `settings.web.searchBackend` — web_search 后端选择的
 * settings 来源（用户要求：全局 settings 可设，不依赖 shell env / .env.local）。
 *
 * Contract pinned here:
 *  - settings 解析：闭集 "bing"|"exa"|"tavily"|"brave"；非法值 drop-not-throw
 *    （镜像 parseIsolation 纪律），被丢弃字段不参与覆盖；非对象段 → undefined。
 *  - 合并：project 优先，未覆盖的 user 字段保留（镜像 mergeIsolation）。
 *  - env 回退链：env > settings.web.searchBackend > 默认 "bing"（对齐 #353
 *    maxTurns 先例）；env 未设返回 undefined 而非折叠成显式 "bing"。
 *  - env 非法值仍抛 typed `WebEnvConfigError("invalid_search_backend")`
 *    （schema reject 比 silent fallback 更显眼，#826 T1 纪律不变）。
 */
import { afterAll, beforeAll, describe, it } from "vitest";
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
  SEARCH_BACKEND_ENV_KEY,
  SEARCH_BACKEND_VALUES,
} from "../../src/config/env.ts";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-web-settings-"));
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

  it("project overrides user", async () => {
    const { home, cwd } = await makeSettings(
      withModel({ web: { searchBackend: "exa" } }),
      { web: { searchBackend: "tavily" } }
    );
    const settings = loadIknowSettings({ cwd, home });
    assert.equal(settings.web?.searchBackend, "tavily");
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
      assert.throws(
        () => loadEnvAt(cwd, home),
        (err: unknown) =>
          (err as { kind?: string })?.kind === "invalid_search_backend"
      );
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
