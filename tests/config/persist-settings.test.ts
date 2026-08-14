/**
 * T1: persist-settings 纯函数模块 —— settings.json 反向持久化。
 *
 * 覆盖（plans/settings-bidirectional-persist.md T1 验收，≥10 用例）：
 *  1. 新文件起步：llm 缺失 → 写入 `{llm:{thinking,thinkingEffort}}`。
 *  2. 已有文件：保留 apiKey / model / fallback / secrets 全部原字段。
 *  3. thinkingEffort: null → 删除键（auto 语义），不残留空串。
 *  4. 坏 JSON 起步：从空对象合并后写回（不覆盖用户文件原内容本身）。
 *  5. 原子性：写回后是完整可 parse JSON，无 `.tmp` 残留。
 *  6. 权限：tmp 文件 mode 0600（rename 前断言）。
 *  7. 父目录缺失 → mkdir -p 后成功写。
 *  8. merge 对非法 patch 值防御（thinking / thinkingEffort 越界 → throw）。
 *  9. resolveThinkingSettingsPath：project 存在 → project；不存在 → user。
 * 10. hashSettingsContent：同串同哈希，异串异哈希。
 * 11. 并发类：串行 await 两次 persist → 最终 = 第二次 patch + 保留字段。
 * 12. 异常类：目标父路径为普通文件（ENOTDIR）→ reject，错误含路径。
 * 13. 防御分支：readFile 非 ENOENT / JSON.parse 非 SyntaxError → 重抛
 *    （分别用真实 fs 错误 EISDIR 与 JSON.parse spy 注入）。
 *
 * 纪律：
 *  - mkdtempSync + afterAll rmSync（tmp 隔离，绝不碰真实 ~/.iknow）；
 *  - vitest（tests/config 既有框架；bun test 亦可跑，兼容）；
 *  - 失败路径用例用真实 fs 错误（父路径为文件 → ENOTDIR；叶子为目录 → EISDIR）
 *    替代 chmod / spy：WSL2 tmpfs 不按 mode 位拦 uid 1000 写，vitest 也不允许
 *    spy ESM namespace；ENOTDIR 用例保留 win32 跳过（该平台映射为 ENOENT）。
 */
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hashSettingsContent,
  mergeThinkingPatch,
  persistThinkingChanges,
  resolveThinkingSettingsPath,
} from "../../src/config/persist-settings.ts";

/** 每个测试的隔离 tmp 根目录（afterAll 统一清理）。 */
const tmpBases: string[] = [];

function makeTmpRoot(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  tmpBases.push(base);
  return base;
}

afterAll(() => {
  for (const base of tmpBases) rmSync(base, { recursive: true, force: true });
});

/** 含 apiKey / model / fallback / secrets 的完整 settings raw JSON 字符串。 */
function fullSettingsJson(): string {
  return JSON.stringify(
    {
      llm: {
        model: "claude-sonnet",
        apiKey: "${ANTHROPIC_API_KEY}",
        fallback: ["claude-haiku", "gpt-5"],
        maxTurns: 8,
        thinking: "off",
      },
      secrets: { enabled: true, patterns: ["token"] },
    },
    null,
    2
  );
}

/** 断言目标文件存在、可 parse、无 .tmp 残留、mode 0600。 */
function expectAtomicWrite(target: string): Record<string, unknown> {
  const dir = dirname(target);
  const entries = readdirSync(dir);
  expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  const stat = statSync(target);
  // POSIX mode 位：0600（owner rw only）；Windows 无意义。
  if (process.platform !== "win32") {
    expect(stat.mode & 0o777).toBe(0o600);
  }
  return JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
}

describe("mergeThinkingPatch（纯函数）", () => {
  test("llm 缺失 → 创建；非法 llm 值 → 以新对象覆盖，只保留 patch 字段", () => {
    expect(
      mergeThinkingPatch({}, { thinking: "adaptive", thinkingEffort: "high" })
    ).toEqual({ llm: { thinking: "adaptive", thinkingEffort: "high" } });
    // llm 非普通对象（字符串）：原值整体丢弃，重新由 patch 字段起步。
    expect(
      mergeThinkingPatch({ llm: "not-an-object" }, { thinking: "off" })
    ).toEqual({
      llm: { thinking: "off" },
    });
  });

  test("其它字段一律原样保留，只改 thinking 两键", () => {
    const raw = JSON.parse(fullSettingsJson()) as Record<string, unknown>;
    const merged = mergeThinkingPatch(raw, { thinking: "adaptive" });
    expect(merged).toEqual({
      llm: {
        model: "claude-sonnet",
        apiKey: "${ANTHROPIC_API_KEY}",
        fallback: ["claude-haiku", "gpt-5"],
        maxTurns: 8,
        thinking: "adaptive",
      },
      secrets: { enabled: true, patterns: ["token"] },
    });
    // 原对象不被修改（纯函数无副作用）。
    expect((raw.llm as Record<string, unknown>).thinking).toBe("off");
  });

  test("thinkingEffort: null → 删除键（auto 语义），不残留空串", () => {
    const merged = mergeThinkingPatch(
      { llm: { thinking: "adaptive", thinkingEffort: "high", model: "m1" } },
      { thinkingEffort: null }
    );
    expect(merged.llm).toEqual({ thinking: "adaptive", model: "m1" });
    expect(merged.llm).not.toHaveProperty("thinkingEffort");
  });

  test("非法 patch 值防御：thinking 越界 / thinkingEffort 越界 → TypeError", () => {
    expect(() =>
      mergeThinkingPatch({}, { thinking: "always" as never })
    ).toThrow(TypeError);
    expect(() =>
      mergeThinkingPatch({}, { thinking: "always" as never })
    ).toThrowError(/expected "off" \| "adaptive"/);
    expect(() =>
      mergeThinkingPatch({}, { thinkingEffort: "ultra" as never })
    ).toThrow(TypeError);
    expect(() =>
      mergeThinkingPatch({}, { thinkingEffort: "ultra" as never })
    ).toThrowError(/thinkingEffort/);
  });
});

describe("hashSettingsContent", () => {
  test("同串同哈希，异串异哈希；空串也有稳定哈希", () => {
    const a = hashSettingsContent("abc");
    expect(a).toBe(hashSettingsContent("abc"));
    expect(a).not.toBe(hashSettingsContent("abd"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSettingsContent("")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("resolveThinkingSettingsPath", () => {
  test("opts 缺省 → 回退 process.cwd() / os.homedir() 再按存在性选择", () => {
    // 假 cwd 用 tmpdir() 派生（bun WSL 下 /tmp 路径会被改写，rmSync 会
    // EFAULT）；fakeRoot 挂进 tmpBases 由 afterAll 统一清理。
    // cwd 用 process.chdir 真实切换（不 spy process / os.homedir —— vitest 禁止
    // spy ESM namespace 导出，bun 又无法 vi.mock node 内建，二者都不可靠）；
    // home 不覆盖：user 分支断言即真实 os.homedir()，两运行时都确定。
    const fakeRoot = mkdtempSync(join(tmpdir(), "iknow-persist-defaults-"));
    tmpBases.push(fakeRoot);
    const fakeCwd = join(fakeRoot, "cwd");
    mkdirSync(fakeCwd, { recursive: true });
    const prevCwd = process.cwd();
    process.chdir(fakeCwd);
    try {
      // project 不存在 → user 路径（无 opts，回退真实 home）。
      expect(resolveThinkingSettingsPath()).toBe(
        join(homedir(), ".iknow", "settings.json")
      );
      // project 存在 → project 路径（无 opts）。
      mkdirSync(join(fakeCwd, ".iknow"), { recursive: true });
      writeFileSync(join(fakeCwd, ".iknow", "settings.json"), "{}");
      expect(resolveThinkingSettingsPath()).toBe(
        join(fakeCwd, ".iknow", "settings.json")
      );
    } finally {
      process.chdir(prevCwd); // 恢复，避免污染同进程后续测试
    }
  });

  test("project 文件存在 → project 路径；不存在 → user 路径", () => {
    const base = makeTmpRoot("iknow-persist-path-");
    const cwd = join(base, "cwd");
    const home = join(base, "home");
    mkdirSync(join(home, ".iknow"), { recursive: true });
    mkdirSync(join(cwd, ".iknow"), { recursive: true });
    const userPath = join(home, ".iknow", "settings.json");

    expect(resolveThinkingSettingsPath({ cwd, home })).toBe(userPath);
    writeFileSync(join(cwd, ".iknow", "settings.json"), "{}");
    expect(resolveThinkingSettingsPath({ cwd, home })).toBe(
      join(cwd, ".iknow", "settings.json")
    );
  });
});

describe("persistThinkingChanges（原子写）", () => {
  test("新文件起步：llm 缺失 → 写入 {llm:{thinking,thinkingEffort}}", async () => {
    const base = makeTmpRoot("iknow-persist-new-");
    const file = join(base, "home", ".iknow", "settings.json");
    const res = await persistThinkingChanges(file, {
      thinking: "adaptive",
      thinkingEffort: "high",
    });
    expect(res.path).toBe(file);
    expect(JSON.parse(res.bytes)).toEqual({
      llm: { thinking: "adaptive", thinkingEffort: "high" },
    });
    expect(hashSettingsContent(res.bytes)).toBe(
      hashSettingsContent(readFileSync(file, "utf8"))
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      llm: { thinking: "adaptive", thinkingEffort: "high" },
    });
    expectAtomicWrite(file);
  });

  test("已有文件：保留 apiKey / model / fallback / secrets 全部原字段", async () => {
    const base = makeTmpRoot("iknow-persist-keep-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(file, fullSettingsJson());
    const res = await persistThinkingChanges(file, { thinking: "adaptive" });
    // 只应改 thinking 两键，apiKey / model / fallback / maxTurns / secrets 原样。
    expect(JSON.parse(res.bytes)).toEqual({
      llm: {
        model: "claude-sonnet",
        apiKey: "${ANTHROPIC_API_KEY}",
        fallback: ["claude-haiku", "gpt-5"],
        maxTurns: 8,
        thinking: "adaptive",
      },
      secrets: { enabled: true, patterns: ["token"] },
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(
      JSON.parse(res.bytes) as object
    );
    expectAtomicWrite(file);
  });

  test("thinkingEffort: null → 删除键，不残留空串", async () => {
    const base = makeTmpRoot("iknow-persist-null-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ llm: { thinking: "adaptive", thinkingEffort: "high" } })
    );
    await persistThinkingChanges(file, { thinkingEffort: null });
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    expect((parsed.llm as Record<string, unknown>).thinking).toBe("adaptive");
    expect(parsed.llm).not.toHaveProperty("thinkingEffort");
    expect(parsed.llm).not.toHaveProperty("thinkingEffort", "");
    expectAtomicWrite(file);
  });

  test("坏 JSON 起步：从空对象合并后写回", async () => {
    const base = makeTmpRoot("iknow-persist-bad-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(file, "{ not-json");
    await persistThinkingChanges(file, {
      thinking: "adaptive",
      thinkingEffort: "max",
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      llm: { thinking: "adaptive", thinkingEffort: "max" },
    });
    expectAtomicWrite(file);
  });

  test("顶层非普通对象（数组）→ 按空对象起步", async () => {
    const base = makeTmpRoot("iknow-persist-array-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(file, "[1,2,3]");
    await persistThinkingChanges(file, { thinking: "off" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      llm: { thinking: "off" },
    });
    expectAtomicWrite(file);
  });

  test("父目录缺失（tmp HOME 无 .iknow）→ mkdir -p 后成功写，无 .tmp 残留", async () => {
    const base = makeTmpRoot("iknow-persist-mkdir-");
    const file = join(base, "a", "b", ".iknow", "settings.json");
    await persistThinkingChanges(file, {
      thinking: "adaptive",
      thinkingEffort: "low",
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      llm: { thinking: "adaptive", thinkingEffort: "low" },
    });
    expectAtomicWrite(file);
  });

  test("并发类：串行两次 persist → 最终 = 第二次 patch + 保留字段全在", async () => {
    const base = makeTmpRoot("iknow-persist-conc-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(file, fullSettingsJson());
    // 第一次：adaptive + effort=high（保留字段：model/apiKey/fallback/maxTurns/secrets）。
    await persistThinkingChanges(file, {
      thinking: "adaptive",
      thinkingEffort: "high",
    });
    // 第二次：只改 thinking=off，不传 effort → 第一次的 effort 按 merge 语义保留。
    await persistThinkingChanges(file, { thinking: "off" });
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({
      llm: {
        model: "claude-sonnet",
        apiKey: "${ANTHROPIC_API_KEY}",
        fallback: ["claude-haiku", "gpt-5"],
        maxTurns: 8,
        thinking: "off",
        thinkingEffort: "high",
      },
      secrets: { enabled: true, patterns: ["token"] },
    });
    expectAtomicWrite(file);
  });

  test("异常类：目标父路径是普通文件（ENOTDIR）→ reject 且错误含路径", async () => {
    // chmod 0555 在 WSL2 tmpfs 下不拦 uid 1000 写（测试曾解析成功而误挂），
    // 改为制造确定性的 ENOTDIR：把 settings 的父层建造成普通文件，
    // 模块的 mkdir(dirname, {recursive:true}) 必失败且错误带路径。
    if (process.platform === "win32") return; // win32 将 ENOTDIR 映射为 ENOENT，无法复现
    const base = makeTmpRoot("iknow-persist-enotdir-");
    const file = join(base, "not-a-dir", "settings.json");
    writeFileSync(join(base, "not-a-dir"), ""); // 父层存在但为文件，mkdir 必失败
    await expect(
      persistThinkingChanges(file, { thinking: "adaptive" })
    ).rejects.toThrow();
    await expect(
      persistThinkingChanges(file, { thinking: "adaptive" })
    ).rejects.toThrowError(file);
  });

  test("防御分支：readFile 抛非 ENOENT 错误 → 重抛（不静默吞）", async () => {
    // 真实 EISDIR：settings 叶子路径是目录，readFile 必失败且非 ENOENT，
    // 走 readSettingsRaw 的 catch-rethrow 分支（避免 spy ESM namespace）。
    const base = makeTmpRoot("iknow-persist-eisdir-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(file, { recursive: true }); // settings.json 本身是目录
    // 断言错误码而非路径：fs 的 EISDIR 消息是 "EISDIR: illegal operation on
    // a directory, read"（node 侧含逗号后缀，bun 侧无，且不带路径），跨运行时
    // 不一致 —— 但 code === "EISDIR" 两运行时都稳定，且正好锁定非 ENOENT 重抛分支。
    await expect(
      persistThinkingChanges(file, { thinking: "off" })
    ).rejects.toMatchObject({ code: "EISDIR" });
  });

  test("防御分支：JSON.parse 抛非 SyntaxError → 重抛（不静默吞）", async () => {
    const base = makeTmpRoot("iknow-persist-rethrow-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(file, "{}");
    // 注意：不把写文件放进 mock 窗口 —— readFile 在文件系统上真实读到 "{}"，
    // JSON.parse 才命中 mock（顺序依赖 fs 先于 JSON.parse 完成）。
    const spy = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw new TypeError("boom from spy");
    });
    try {
      await expect(
        persistThinkingChanges(file, { thinking: "off" })
      ).rejects.toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });
});
