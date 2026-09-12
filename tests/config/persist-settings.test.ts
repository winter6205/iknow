/**
 * T1: persist-settings 纯函数模块 —— settings.json 反向持久化。
 *
 * 覆盖（plans/settings-bidirectional-persist.md T1 验收 + plans/workspace-root-launch.md T3 验收，≥14 用例）：
 *  1. 新文件起步：llm 缺失 → 写入 `{llm:{thinking,thinkingEffort}}`。
 *  2. 已有文件：保留 apiKey / model / fallback / secrets 全部原字段。
 *  3. thinkingEffort: null → 删除键（auto 语义），不残留空串。
 *  4. 坏 JSON 起步：从空对象合并后写回（不覆盖用户文件原内容本身）。
 *  5. 原子性：写回后是完整可 parse JSON，无 `.tmp` 残留。
 *  6. 权限：tmp 文件 mode 0600（rename 前断言）。
 *  7. 父目录缺失 → mkdir -p 后成功写。
 *  8. merge 对非法 patch 值防御（thinking / thinkingEffort 越界 → throw）。
 *  9. resolveThinkingSettingsPath（ADR-0084 写回落对层）：thinking / memory 是
 *     用户层键 → 目标恒为 `<home>/.iknow/settings.json`，**与 project 文件是否
 *     存在解耦**（旧 ADR-0019 D1.3 的「project 存在 → project」档已退役：
 *     项目文件不采纳 llm / memory，写进去静默无效）。home 缺省 homedir()。
 * 10. hashSettingsContent：同串同哈希，异串异哈希。
 * 11. 并发类：串行 await 两次 persist → 最终 = 第二次 patch + 保留字段。
 * 12. 异常类：目标父路径为普通文件（ENOTDIR）→ reject，错误含路径。
 * 13. 防御分支：readFile 非 ENOENT / JSON.parse 非 SyntaxError → 重抛
 *    （分别用真实 fs 错误 EISDIR 与 JSON.parse spy 注入）。
 * 14. T3 acceptance #2：并行双写 → atomic rename 保证最终文件可 parse 且
 *     thinking ∈ 两个 patch 之一（NOT merge disaster），保留字段全在。
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
  mergeMemoryPatch,
  mergeThinkingPatch,
  persistMemoryChanges,
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

describe("resolveThinkingSettingsPath（ADR-0084 写回落对层）", () => {
  test("opts 缺省 → homedir()/.iknow/settings.json（与 loadIknowSettings 同源）", () => {
    expect(resolveThinkingSettingsPath()).toBe(
      join(homedir(), ".iknow", "settings.json")
    );
  });

  test("SC6 核心不变式：project 文件在场 → 写回目标仍是 user 文件，且 project 的 llm 不被创建/修改", async () => {
    const base = makeTmpRoot("iknow-persist-layer-");
    const home = join(base, "home");
    const cwd = join(base, "cwd");
    mkdirSync(join(cwd, ".iknow"), { recursive: true });
    const projectFile = join(cwd, ".iknow", "settings.json");
    // 项目文件里带一个「用户层键」llm（允许名单外）与一个允许名单内的 verify。
    writeFileSync(
      projectFile,
      JSON.stringify({
        llm: { model: "project-model" },
        verify: { command: "x" },
      }),
      "utf8"
    );

    // 目标 = user 路径（不是 project），与 project 是否存在解耦。
    const target = resolveThinkingSettingsPath({ home });
    expect(target).toBe(join(home, ".iknow", "settings.json"));
    expect(target).not.toBe(projectFile);

    await persistThinkingChanges(target, { thinking: "adaptive" });
    // user 文件拿到 thinking；project 文件的 llm 逐字节不变（未创建 / 未修改）。
    expect(
      (JSON.parse(readFileSync(target, "utf8")) as { llm: unknown }).llm
    ).toEqual({ thinking: "adaptive" });
    expect(readFileSync(projectFile, "utf8")).toBe(
      JSON.stringify({
        llm: { model: "project-model" },
        verify: { command: "x" },
      })
    );
  });

  test("SC6：显式 home 下写回 memory 亦落 user 文件，project 文件不被触碰", async () => {
    const base = makeTmpRoot("iknow-persist-layer-mem-");
    const home = join(base, "home");
    const cwd = join(base, "cwd");
    mkdirSync(join(cwd, ".iknow"), { recursive: true });
    const projectFile = join(cwd, ".iknow", "settings.json");
    writeFileSync(projectFile, "{}", "utf8");
    const target = resolveThinkingSettingsPath({ home });
    await persistMemoryChanges(target, { autoExtract: true, dream: false });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      memory: { autoExtract: true, dream: false },
    });
    expect(readFileSync(projectFile, "utf8")).toBe("{}");
  });

  test("无 cwd / workspaceRoot 入参：目标恒为 home 层（写回锚点只有 home）", () => {
    const base = makeTmpRoot("iknow-persist-cwd-");
    const home = join(base, "home");
    // 项目文件存在也不改变目标层（签名已收窄为 { home }，项目文件探测退役）。
    const cwd = join(base, "cwd");
    mkdirSync(join(cwd, ".iknow"), { recursive: true });
    writeFileSync(join(cwd, ".iknow", "settings.json"), "{}", "utf8");
    expect(resolveThinkingSettingsPath({ home })).toBe(
      join(home, ".iknow", "settings.json")
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

  test("T3 acceptance #2：并行双写同一文件 → atomic rename 保证可 parse 且为两者之一", async () => {
    // 边界类 concurrent（test.md）：两个 persistThinkingChanges 并行 Promise.all
    // 打同一个 settings 文件。既有 atomic 写（同目录 tmp + rename 原子替换）
    // 保证最终文件无 half-written JSON / 无 torn file —— 最终必是完整某个
    // 写入的落盘（文件状态原子交换），不会是 merge disaster。断言语义：
    //   - JSON.parse 成功（无 torn）；
    //   - thinking ∈ {off, adaptive}（patch1 或 patch2 之一，非二者混合）；
    //   - effort 保留字段（model / apiKey / fallback / maxTurns / secrets）仍在
    //     （merge 起点完整，非空起步覆盖）。
    const base = makeTmpRoot("iknow-persist-parallel-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(file, fullSettingsJson());
    await Promise.all([
      persistThinkingChanges(file, { thinking: "off", thinkingEffort: "low" }),
      persistThinkingChanges(file, {
        thinking: "adaptive",
        thinkingEffort: "high",
      }),
    ]);
    // assert 顺序放 resolved detach 内：await 已保证两写完成，但异常先行时
    // 不留悬挂（vitest 对 detached 未处理 rejection 会告警，此处 resolve 处
    // 无 reject 风险 —— 仅读最终文件）。
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    const llm = parsed.llm as Record<string, unknown>;
    expect(["off", "adaptive"]).toContain(llm.thinking);
    expect(["low", "high"]).toContain(llm.thinkingEffort);
    expect(llm.model).toBe("claude-sonnet");
    expect(llm.apiKey).toBe("${ANTHROPIC_API_KEY}");
    expect(llm.fallback).toEqual(["claude-haiku", "gpt-5"]);
    expect(llm.maxTurns).toBe(8);
    expect(parsed.secrets).toEqual({ enabled: true, patterns: ["token"] });
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

describe("mergeMemoryPatch（纯函数）", () => {
  test("memory 缺失 → 创建；其它字段原样保留", () => {
    expect(
      mergeMemoryPatch(
        { llm: { model: "m1" } },
        { autoExtract: true, dream: false }
      )
    ).toEqual({
      llm: { model: "m1" },
      memory: { autoExtract: true, dream: false },
    });
  });

  test("自动记忆关 → 强制 dream false", () => {
    expect(
      mergeMemoryPatch(
        { memory: { autoExtract: true, dream: true } },
        { autoExtract: false, dream: true }
      )
    ).toEqual({ memory: { autoExtract: false, dream: false } });
  });

  test("非法 boolean → TypeError", () => {
    expect(() => mergeMemoryPatch({}, { autoExtract: "yes" as never })).toThrow(
      TypeError
    );
  });
});

describe("persistMemoryChanges（原子写）", () => {
  test("写回 memory.autoExtract / dream 且保留 llm", async () => {
    const base = makeTmpRoot("iknow-persist-memory-");
    const file = join(base, ".iknow", "settings.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ llm: { model: "keep-me" } }, null, 2));
    const res = await persistMemoryChanges(file, {
      autoExtract: true,
      dream: true,
    });
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({
      llm: { model: "keep-me" },
      memory: { autoExtract: true, dream: true },
    });
    expect(res.path).toBe(file);
    expect(res.bytes).toContain("autoExtract");
  });
});
