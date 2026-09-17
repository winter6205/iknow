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
 * 15. /model（specs/tui-model-command.md SC5 / SC6）：mergeModelPatch 值域门禁
 *     （非字符串 / 空串 / 无斜杠 / 段空 / 未知 provider → TypeError）、只改
 *     `llm.model` 且 providers 等字段原样、跨 provider 往返、与 thinking patch
 *     共存、raw 缺 llm 段 / llm 非对象起点、persistModelChanges 原子写 +
 *     bytes sha256 稳定、非法 patch 不落盘。
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
  mergeModelPatch,
  mergeSubagentCapPatch,
  mergeThinkingPatch,
  mergeFsModePatch,
  mergeWorktreeOnMutatePatch,
  persistMemoryChanges,
  persistModelChanges,
  persistSubagentCapChanges,
  persistThinkingChanges,
  persistFsModeChanges,
  persistWorktreeOnMutateChanges,
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

// ADR-0092 / SC13：filesystem isolation 档（fsMode）— 反向持久化通道。
// 镜像 persistMemoryChanges 形态：raw-merge、原子写、非法值 TypeError。
describe("mergeFsModePatch（纯函数）", () => {
  test("isolation 缺失 → 创建；其它字段原样保留", () => {
    expect(
      mergeFsModePatch({ llm: { model: "m1" } }, { fsMode: "workspace" })
    ).toEqual({
      llm: { model: "m1" },
      isolation: { fsMode: "workspace" },
    });
  });

  test("已有 isolation 段 → 仅改 fsMode，其余键原样保留", () => {
    expect(
      mergeFsModePatch(
        {
          isolation: { worktreeOnMutate: true, fsMode: "global" },
        },
        { fsMode: "workspace" }
      )
    ).toEqual({
      isolation: { worktreeOnMutate: true, fsMode: "workspace" },
    });
  });

  test("isolation 非普通对象 → 以新对象覆盖，仅保留 patch 字段", () => {
    expect(
      mergeFsModePatch({ isolation: "not-an-object" }, { fsMode: "global" })
    ).toEqual({
      isolation: { fsMode: "global" },
    });
  });

  test("非法 fsMode 值（不在 'global' | 'workspace' 闭集）→ TypeError", () => {
    expect(() =>
      mergeFsModePatch({}, { fsMode: "Workspace" as never })
    ).toThrow(TypeError);
    expect(() =>
      mergeFsModePatch({}, { fsMode: "Workspace" as never })
    ).toThrowError(/fsMode/);
    expect(() => mergeFsModePatch({}, { fsMode: true as never })).toThrow(
      TypeError
    );
    expect(() => mergeFsModePatch({}, {} as never)).toThrow(TypeError);
  });

  test("关闭（global）与打开（workspace）对称", () => {
    expect(mergeFsModePatch({}, { fsMode: "global" })).toEqual({
      isolation: { fsMode: "global" },
    });
    expect(mergeFsModePatch({}, { fsMode: "workspace" })).toEqual({
      isolation: { fsMode: "workspace" },
    });
  });
});

describe("persistFsModeChanges（原子写）", () => {
  test("新文件起步：写入 isolation.fsMode，原子写、保留其它键", async () => {
    const base = makeTmpRoot("iknow-persist-fsmode-new-");
    const file = join(base, "home", ".iknow", "settings.json");
    const res = await persistFsModeChanges(file, { fsMode: "workspace" });
    expect(JSON.parse(res.bytes)).toEqual({
      isolation: { fsMode: "workspace" },
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      isolation: { fsMode: "workspace" },
    });
    // 原子写无 .tmp 残留、mode 0600。
    expectAtomicWrite(file);
  });

  test("已有文件：保留 llm / memory / isolation.worktreeOnMutate 等全部原字段", async () => {
    const base = makeTmpRoot("iknow-persist-fsmode-keep-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          llm: {
            model: "claude-sonnet",
            apiKey: "${ANTHROPIC_API_KEY}",
            thinking: "off",
          },
          memory: { autoExtract: true, dream: false },
          isolation: { worktreeOnMutate: true, fsMode: "global" },
        },
        null,
        2
      )
    );
    const res = await persistFsModeChanges(file, { fsMode: "workspace" });
    expect(JSON.parse(res.bytes)).toEqual({
      llm: {
        model: "claude-sonnet",
        apiKey: "${ANTHROPIC_API_KEY}",
        thinking: "off",
      },
      memory: { autoExtract: true, dream: false },
      isolation: { worktreeOnMutate: true, fsMode: "workspace" },
    });
    expectAtomicWrite(file);
  });

  test("非法 fsMode 值 → TypeError（不静默吞、不写回）", async () => {
    const base = makeTmpRoot("iknow-persist-fsmode-illegal-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(file, JSON.stringify({ isolation: { fsMode: "global" } }));
    await expect(
      persistFsModeChanges(file, { fsMode: "wrong" as never })
    ).rejects.toThrow(TypeError);
    // 文件原样保留（写回未发生）。
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      isolation: { fsMode: "global" },
    });
  });

  test("父目录缺失 → mkdir -p 后成功", async () => {
    const base = makeTmpRoot("iknow-persist-fsmode-mkdir-");
    const file = join(base, "a", "b", ".iknow", "settings.json");
    await persistFsModeChanges(file, { fsMode: "workspace" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      isolation: { fsMode: "workspace" },
    });
    expectAtomicWrite(file);
  });
});

// ── ADR-0096 T2: subagent 并发上限 patch（cap 3|5|9|15|unlimited） ──────────

describe("mergeSubagentCapPatch（纯函数）", () => {
  test("subagent 缺失 → 创建 subagent.maxConcurrentWorkers", () => {
    expect(mergeSubagentCapPatch({}, { maxConcurrentWorkers: 9 })).toEqual({
      subagent: { maxConcurrentWorkers: 9 },
    });
  });

  test("已有 subagent 段 → 仅改 maxConcurrentWorkers，其余键原样保留", () => {
    expect(
      mergeSubagentCapPatch(
        { subagent: { taskTimeoutMs: 30000, maxConcurrentWorkers: 9 } },
        { maxConcurrentWorkers: 15 }
      )
    ).toEqual({
      subagent: { taskTimeoutMs: 30000, maxConcurrentWorkers: 15 },
    });
  });

  test("subagent 非普通对象 → 以新对象覆盖，仅保留 patch 字段", () => {
    expect(
      mergeSubagentCapPatch(
        { subagent: "not-an-object" },
        { maxConcurrentWorkers: 5 }
      )
    ).toEqual({
      subagent: { maxConcurrentWorkers: 5 },
    });
  });

  test('"unlimited" 字面 → 写为字符串字面（与 settings 解析层同形态）', () => {
    expect(
      mergeSubagentCapPatch({}, { maxConcurrentWorkers: "unlimited" })
    ).toEqual({
      subagent: { maxConcurrentWorkers: "unlimited" },
    });
  });

  test("数字字面 3 / 5 / 9 / 15 全部接受", () => {
    for (const v of [3, 5, 9, 15]) {
      expect(mergeSubagentCapPatch({}, { maxConcurrentWorkers: v })).toEqual({
        subagent: { maxConcurrentWorkers: v },
      });
    }
  });

  // 闭集外数字 → TypeError（与 fsMode / thinking 同步；TUI 面板永远不会
  // 传这种值 —— 边界 5 类之一，捕获异常防止污染磁盘）。
  test("闭集外数字（0 / 1 / 2 / 4 / 7 / 99） → TypeError", () => {
    for (const v of [0, 1, 2, 4, 7, 99]) {
      expect(() =>
        mergeSubagentCapPatch({}, { maxConcurrentWorkers: v })
      ).toThrow(TypeError);
      expect(() =>
        mergeSubagentCapPatch({}, { maxConcurrentWorkers: v })
      ).toThrowError(/cap/);
    }
  });

  test("非整数 / 负数 / NaN / Infinity → TypeError", () => {
    for (const v of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        mergeSubagentCapPatch({}, { maxConcurrentWorkers: v })
      ).toThrow(TypeError);
    }
  });

  test('非数字非 "unlimited" 字面（null / true / "3" / 对象）→ TypeError', () => {
    for (const v of [null, true, "3", {}, []]) {
      expect(() =>
        mergeSubagentCapPatch(
          {},
          { maxConcurrentWorkers: v as unknown as number }
        )
      ).toThrow(TypeError);
    }
  });

  test("纯函数：raw 未被就地修改", () => {
    const raw = { subagent: { taskTimeoutMs: 30000 } };
    const before = JSON.stringify(raw);
    mergeSubagentCapPatch(raw, { maxConcurrentWorkers: 9 });
    expect(JSON.stringify(raw)).toBe(before);
  });

  test("其它顶层键（llm / isolation / memory / permissions）原样保留", () => {
    const raw = {
      llm: { model: "claude-sonnet" },
      isolation: { fsMode: "global" },
      memory: { autoExtract: true },
      permissions: { defaultMode: "ask" },
    };
    expect(mergeSubagentCapPatch(raw, { maxConcurrentWorkers: 5 })).toEqual({
      llm: { model: "claude-sonnet" },
      isolation: { fsMode: "global" },
      memory: { autoExtract: true },
      permissions: { defaultMode: "ask" },
      subagent: { maxConcurrentWorkers: 5 },
    });
  });
});

describe("persistSubagentCapChanges（原子写）", () => {
  test("新文件起步：写入 subagent.maxConcurrentWorkers，原子写", async () => {
    const base = makeTmpRoot("iknow-persist-subcap-new-");
    const file = join(base, "home", ".iknow", "settings.json");
    const res = await persistSubagentCapChanges(file, {
      maxConcurrentWorkers: 9,
    });
    expect(JSON.parse(res.bytes)).toEqual({
      subagent: { maxConcurrentWorkers: 9 },
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      subagent: { maxConcurrentWorkers: 9 },
    });
    expectAtomicWrite(file);
    // self-write 哨兵：bytes 哈希与文件内容哈希同源
    expect(hashSettingsContent(res.bytes)).toBe(
      hashSettingsContent(readFileSync(file, "utf8"))
    );
  });

  test('"unlimited" → JSON 字面字符串（与 settings 解析同形态）', async () => {
    const base = makeTmpRoot("iknow-persist-subcap-unlim-");
    const file = join(base, "home", ".iknow", "settings.json");
    const res = await persistSubagentCapChanges(file, {
      maxConcurrentWorkers: "unlimited",
    });
    expect(JSON.parse(res.bytes)).toEqual({
      subagent: { maxConcurrentWorkers: "unlimited" },
    });
  });

  test("已有文件：保留 llm / isolation / memory 等全部原字段", async () => {
    const base = makeTmpRoot("iknow-persist-subcap-keep-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        llm: { model: "claude-sonnet", apiKey: "${ANTHROPIC_API_KEY}" },
        isolation: { worktreeOnMutate: true, fsMode: "global" },
        memory: { autoExtract: true, dream: false },
        subagent: { taskTimeoutMs: 60000 },
      })
    );
    const res = await persistSubagentCapChanges(file, {
      maxConcurrentWorkers: "unlimited",
    });
    expect(JSON.parse(res.bytes)).toEqual({
      llm: { model: "claude-sonnet", apiKey: "${ANTHROPIC_API_KEY}" },
      isolation: { worktreeOnMutate: true, fsMode: "global" },
      memory: { autoExtract: true, dream: false },
      subagent: { taskTimeoutMs: 60000, maxConcurrentWorkers: "unlimited" },
    });
    expectAtomicWrite(file);
  });

  test("非法 cap 值 → TypeError（不静默吞、不写回）", async () => {
    const base = makeTmpRoot("iknow-persist-subcap-illegal-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ subagent: { maxConcurrentWorkers: 9 } })
    );
    await expect(
      persistSubagentCapChanges(file, { maxConcurrentWorkers: 7 as never })
    ).rejects.toThrow(TypeError);
    // 文件原样保留（写回未发生）
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      subagent: { maxConcurrentWorkers: 9 },
    });
  });

  test("文件不存在 → 视为空对象起步（与其它 patch 一致）", async () => {
    const base = makeTmpRoot("iknow-persist-subcap-empty-");
    const file = join(base, "home", ".iknow", "settings.json");
    await persistSubagentCapChanges(file, { maxConcurrentWorkers: 15 });
    expectAtomicWrite(file);
  });
});

// ── ADR-0096 T3: worktree 门禁 patch（ON | OFF） ────────────────────────────

describe("mergeWorktreeOnMutatePatch（纯函数）", () => {
  test("isolation 缺失 → 创建；其它顶层键原样保留", () => {
    expect(
      mergeWorktreeOnMutatePatch(
        { llm: { model: "m1" } },
        { worktreeOnMutate: true }
      )
    ).toEqual({
      llm: { model: "m1" },
      isolation: { worktreeOnMutate: true },
    });
  });

  test("已有 isolation 段 → 仅改 worktreeOnMutate，fsMode / worktreeExclusive 等邻键不丢", () => {
    expect(
      mergeWorktreeOnMutatePatch(
        {
          isolation: {
            fsMode: "workspace",
            worktreeOnMutate: true,
            worktreeExclusive: false,
          },
        },
        { worktreeOnMutate: false }
      )
    ).toEqual({
      isolation: {
        fsMode: "workspace",
        worktreeOnMutate: false,
        worktreeExclusive: false,
      },
    });
  });

  test("isolation 非普通对象 → 以新对象覆盖，仅保留 patch 字段", () => {
    expect(
      mergeWorktreeOnMutatePatch(
        { isolation: "not-an-object" },
        { worktreeOnMutate: true }
      )
    ).toEqual({
      isolation: { worktreeOnMutate: true },
    });
  });

  test("非法 patch 值（非 boolean）→ TypeError，错误信息含字段名", () => {
    for (const bad of ["ON", "OFF", 1, 0, null, undefined, {}, []]) {
      expect(() =>
        mergeWorktreeOnMutatePatch({}, { worktreeOnMutate: bad as never })
      ).toThrow(TypeError);
      expect(() =>
        mergeWorktreeOnMutatePatch({}, { worktreeOnMutate: bad as never })
      ).toThrowError(/worktreeOnMutate/);
    }
    // 字段整体缺失同拒（边界 5 类：空 patch 不落盘）
    expect(() => mergeWorktreeOnMutatePatch({}, {} as never)).toThrow(
      TypeError
    );
  });

  test("ON / OFF 对称：true ⇄ false 往返回到原 raw", () => {
    const raw = { isolation: { fsMode: "global", worktreeOnMutate: true } };
    const off = mergeWorktreeOnMutatePatch(raw, { worktreeOnMutate: false });
    expect(off).toEqual({
      isolation: { fsMode: "global", worktreeOnMutate: false },
    });
    expect(mergeWorktreeOnMutatePatch(off, { worktreeOnMutate: true })).toEqual(
      raw
    );
  });

  test("纯函数：不修改入参 raw（浅拷贝纪律）", () => {
    const raw: Record<string, unknown> = {
      isolation: { fsMode: "global", worktreeOnMutate: true },
    };
    mergeWorktreeOnMutatePatch(raw, { worktreeOnMutate: false });
    expect(raw).toEqual({
      isolation: { fsMode: "global", worktreeOnMutate: true },
    });
  });
});

describe("persistWorktreeOnMutateChanges（原子写）", () => {
  test("新文件起步：写入 isolation.worktreeOnMutate，原子写 + self-write 哈希同源", async () => {
    const base = makeTmpRoot("iknow-persist-wtom-new-");
    const file = join(base, "home", ".iknow", "settings.json");
    const res = await persistWorktreeOnMutateChanges(file, {
      worktreeOnMutate: true,
    });
    expect(JSON.parse(res.bytes)).toEqual({
      isolation: { worktreeOnMutate: true },
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      isolation: { worktreeOnMutate: true },
    });
    expectAtomicWrite(file);
    expect(hashSettingsContent(res.bytes)).toBe(
      hashSettingsContent(readFileSync(file, "utf8"))
    );
  });

  test("已有文件：isolation.fsMode 邻键与 llm / memory / subagent 全部原样保留", async () => {
    const base = makeTmpRoot("iknow-persist-wtom-keep-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          llm: {
            model: "claude-sonnet",
            apiKey: "${ANTHROPIC_API_KEY}",
            thinking: "off",
          },
          isolation: {
            fsMode: "workspace",
            worktreeOnMutate: true,
            worktreeExclusive: false,
          },
          memory: { autoExtract: true, dream: false },
          subagent: { maxConcurrentWorkers: "unlimited" },
        },
        null,
        2
      )
    );
    const res = await persistWorktreeOnMutateChanges(file, {
      worktreeOnMutate: false,
    });
    expect(JSON.parse(res.bytes)).toEqual({
      llm: {
        model: "claude-sonnet",
        apiKey: "${ANTHROPIC_API_KEY}",
        thinking: "off",
      },
      isolation: {
        fsMode: "workspace",
        worktreeOnMutate: false,
        worktreeExclusive: false,
      },
      memory: { autoExtract: true, dream: false },
      subagent: { maxConcurrentWorkers: "unlimited" },
    });
    expectAtomicWrite(file);
  });

  test("ON → OFF → ON round-trip：两次落盘后文件与原始 raw 逐键相等（邻键零漂移）", async () => {
    const base = makeTmpRoot("iknow-persist-wtom-roundtrip-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    const raw = {
      llm: { model: "claude-sonnet" },
      isolation: { fsMode: "global", worktreeOnMutate: true },
    };
    writeFileSync(file, JSON.stringify(raw, null, 2));
    await persistWorktreeOnMutateChanges(file, { worktreeOnMutate: false });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      llm: { model: "claude-sonnet" },
      isolation: { fsMode: "global", worktreeOnMutate: false },
    });
    await persistWorktreeOnMutateChanges(file, { worktreeOnMutate: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(raw);
    expectAtomicWrite(file);
  });

  test("非法值 → TypeError 且文件逐字节不变（不静默吞、不写回、无 tmp 残留）", async () => {
    const base = makeTmpRoot("iknow-persist-wtom-illegal-");
    const dir = join(base, "home", ".iknow");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.json");
    const before = JSON.stringify({ isolation: { worktreeOnMutate: true } });
    writeFileSync(file, before);
    await expect(
      persistWorktreeOnMutateChanges(file, { worktreeOnMutate: "ON" as never })
    ).rejects.toThrow(TypeError);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(dir).some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  test("坏 JSON 起步 → 空对象起步后落盘（不覆盖用户文件原内容之外的东西）", async () => {
    const base = makeTmpRoot("iknow-persist-wtom-badjson-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(file, "{ not json");
    const res = await persistWorktreeOnMutateChanges(file, {
      worktreeOnMutate: true,
    });
    expect(JSON.parse(res.bytes)).toEqual({
      isolation: { worktreeOnMutate: true },
    });
    expectAtomicWrite(file);
  });

  test("文件不存在 → 视为空对象起步（与其它 patch 一致）", async () => {
    const base = makeTmpRoot("iknow-persist-wtom-empty-");
    const file = join(base, "home", ".iknow", "settings.json");
    await persistWorktreeOnMutateChanges(file, { worktreeOnMutate: false });
    expectAtomicWrite(file);
  });

  test("父目录缺失 → mkdir -p 后成功（与其它 patch 一致）", async () => {
    const base = makeTmpRoot("iknow-persist-wtom-mkdir-");
    const file = join(base, "a", "b", ".iknow", "settings.json");
    await persistWorktreeOnMutateChanges(file, { worktreeOnMutate: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      isolation: { worktreeOnMutate: true },
    });
    expectAtomicWrite(file);
  });

  test("并发双写（不同值）：最终 = 某次完整写入的快照，可 parse 且邻键在", async () => {
    const base = makeTmpRoot("iknow-persist-wtom-concurrent-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ isolation: { fsMode: "global" } }, null, 2)
    );
    await Promise.all([
      persistWorktreeOnMutateChanges(file, { worktreeOnMutate: true }),
      persistWorktreeOnMutateChanges(file, { worktreeOnMutate: false }),
    ]);
    const parsed = expectAtomicWrite(file);
    const iso = parsed.isolation as Record<string, unknown>;
    expect([true, false]).toContain(iso.worktreeOnMutate);
    expect(iso.fsMode).toBe("global");
  });
});

/** T4: 含 volcengine-ark / minimax-cn 两 provider 的 raw settings（spec 例模板形状）。 */
function rawWithProviders(): Record<string, unknown> {
  return {
    llm: {
      model: "minimax-cn/MiniMax-M3",
      apiKey: "${ANTHROPIC_AUTH_TOKEN}",
      thinking: "adaptive",
      fallback: ["minimax-cn/MiniMax-M3"],
      compress: { contextWindow: 200_000, thresholdTokens: 150_000 },
      providers: [
        {
          id: "volcengine-ark",
          baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
          apiKeyEnv: "VOLCENGINE_ARK_API_KEY",
          models: [{ id: "deepseek-v3-250324", name: "DeepSeek V3" }],
        },
        {
          id: "minimax-cn",
          baseUrl: "https://api.minimax.chat/v1",
          apiKeyEnv: "MINIMAX_CN_API_KEY",
          headers: { "X-Session": "iknow-dev" },
          models: [{ id: "MiniMax-M3", name: "MiniMax-M3" }],
        },
      ],
    },
    isolation: { worktreeOnMutate: true },
    permissions: { defaultMode: "ask" },
    memory: { autoExtract: true },
    secrets: { enabled: true, patterns: ["token"] },
  };
}

/** raw.llm.providers 注册表（断言复用，避免硬编码副本漂移）。 */
function providersOf(raw: Record<string, unknown>): unknown {
  return (raw.llm as Record<string, unknown>).providers;
}

describe("mergeModelPatch（纯函数：/model 切换，SC5 只改 llm.model）", () => {
  test("有效切换：只改 llm.model；providers / apiKey / thinking / isolation / permissions / memory 原样", () => {
    const raw = rawWithProviders();
    const merged = mergeModelPatch(raw, {
      model: "volcengine-ark/deepseek-v3-250324",
    });
    const expected = rawWithProviders();
    (expected.llm as Record<string, unknown>).model =
      "volcengine-ark/deepseek-v3-250324";
    // 整个 merged 与「raw 仅换 model」深度相等 —— 无任何其它 delta。
    expect(merged).toEqual(expected);
    // providers 注册表整段保留（不裁剪成只剩被选 provider）。
    expect((merged.llm as Record<string, unknown>).providers).toEqual(
      providersOf(raw)
    );
    // 纯函数：raw 未被就地修改。
    expect((raw.llm as Record<string, unknown>).model).toBe(
      "minimax-cn/MiniMax-M3"
    );
  });

  test('trim / 第一个 "/" 语义：外层空白被 trim，model 段允许再含 "/"', () => {
    const raw = {
      llm: {
        model: "old",
        providers: [
          {
            id: "p",
            baseUrl: "https://x",
            apiKeyEnv: "K",
            models: [{ id: "m" }],
          },
        ],
      },
    };
    const merged = mergeModelPatch(raw, { model: "  p/m/n  " });
    expect((merged.llm as Record<string, unknown>).model).toBe("p/m/n");
  });

  test("非法值防御：非字符串 / 空串 / 纯空白 → TypeError，消息含非法值与期望形态", () => {
    const raw = rawWithProviders();
    for (const bad of [undefined, 42, null, "", "   "] as never[]) {
      expect(() => mergeModelPatch(raw, { model: bad })).toThrow(TypeError);
    }
    expect(() => mergeModelPatch(raw, { model: "   " })).toThrowError(
      /illegal model patch value/
    );
    expect(() => mergeModelPatch(raw, { model: "   " })).toThrowError(
      /expected "<provider>\/<model>"/
    );
  });

  test('无斜杠 / provider 段空 / model 段空 → TypeError（含 "/foo" 与 "foo/"）', () => {
    const raw = rawWithProviders();
    for (const bad of [
      "no-slash",
      "/foo",
      "minimax-cn/",
      " / ",
      "minimax-cn",
    ]) {
      expect(() => mergeModelPatch(raw, { model: bad })).toThrow(TypeError);
      expect(() => mergeModelPatch(raw, { model: bad })).toThrowError(
        /illegal model patch value/
      );
    }
  });

  test("未知 provider（SC6）：注册表未命中 → TypeError；providers 缺失 / 非数组 / 项 id 非法同样不登记", () => {
    expect(() =>
      mergeModelPatch(rawWithProviders(), { model: "unknown/foo" })
    ).toThrow(TypeError);
    expect(() =>
      mergeModelPatch(rawWithProviders(), { model: "unknown/foo" })
    ).toThrowError(/unknown provider/);
    // 注册表缺席 / 非数组 / 项 id 非字符串 → 该 provider 不构成合法目标。
    expect(() =>
      mergeModelPatch({ llm: { model: "p/m" } }, { model: "p/m" })
    ).toThrow(TypeError);
    expect(() =>
      mergeModelPatch({ llm: { providers: "nope" } }, { model: "p/m" })
    ).toThrow(TypeError);
    expect(() =>
      mergeModelPatch({ llm: { providers: [{ id: 7 }] } }, { model: "7/m" })
    ).toThrow(TypeError);
  });

  test("raw 缺 llm 段 / llm 非对象 → TypeError（无注册表即未知 provider，不静默写入）", () => {
    expect(() =>
      mergeModelPatch({}, { model: "minimax-cn/MiniMax-M3" })
    ).toThrow(TypeError);
    expect(() =>
      mergeModelPatch(
        { llm: "not-an-object" },
        { model: "minimax-cn/MiniMax-M3" }
      )
    ).toThrow(TypeError);
    expect(() =>
      mergeModelPatch({ llm: null }, { model: "minimax-cn/MiniMax-M3" })
    ).toThrowError(/unknown provider/);
  });

  test("跨 provider 切回原 provider：往返后与原始 raw 深度相等，注册表全程保留", () => {
    const raw = rawWithProviders();
    const toArk = mergeModelPatch(raw, {
      model: "volcengine-ark/deepseek-v3-250324",
    });
    expect((toArk.llm as Record<string, unknown>).model).toBe(
      "volcengine-ark/deepseek-v3-250324"
    );
    const back = mergeModelPatch(toArk, { model: "minimax-cn/MiniMax-M3" });
    expect(back).toEqual(rawWithProviders());
  });

  test("与既有 thinking patch 共存：先 thinking 后 model，两者互不破坏", () => {
    const raw = rawWithProviders();
    const afterThinking = mergeThinkingPatch(raw, {
      thinking: "off",
      thinkingEffort: "max",
    });
    const afterModel = mergeModelPatch(afterThinking, {
      model: "volcengine-ark/deepseek-v3-250324",
    });
    const llm = afterModel.llm as Record<string, unknown>;
    expect(llm.thinking).toBe("off");
    expect(llm.thinkingEffort).toBe("max");
    expect(llm.model).toBe("volcengine-ark/deepseek-v3-250324");
    expect(llm.apiKey).toBe("${ANTHROPIC_AUTH_TOKEN}");
    expect(llm.providers).toEqual(providersOf(raw));
    expect(afterModel.isolation).toEqual({ worktreeOnMutate: true });
    expect(afterModel.permissions).toEqual({ defaultMode: "ask" });
    expect(afterModel.memory).toEqual({ autoExtract: true });
    expect(afterModel.secrets).toEqual({ enabled: true, patterns: ["token"] });
    // 反向顺序（先 model 后 thinking）同样互不破坏。
    const reverse = mergeThinkingPatch(
      mergeModelPatch(raw, { model: "volcengine-ark/deepseek-v3-250324" }),
      { thinking: "off", thinkingEffort: "low" }
    );
    const rllm = reverse.llm as Record<string, unknown>;
    expect(rllm.model).toBe("volcengine-ark/deepseek-v3-250324");
    expect(rllm.thinking).toBe("off");
    expect(rllm.thinkingEffort).toBe("low");
    expect(rllm.providers).toEqual(providersOf(raw));
  });
});

describe("persistModelChanges（原子写 + self-write hash，SC5）", () => {
  test("有效切换落盘：只改 llm.model，返回 path / bytes 且 sha256 与落盘一致", async () => {
    const base = makeTmpRoot("iknow-persist-model-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(dirname(file), { recursive: true });
    const raw = rawWithProviders();
    writeFileSync(file, JSON.stringify(raw, null, 2));
    const res = await persistModelChanges(file, {
      model: "volcengine-ark/deepseek-v3-250324",
    });
    expect(res.path).toBe(file);
    // self-write 哨兵：bytes 即落盘内容，内容哈希可比对（语义未改）。
    expect(hashSettingsContent(res.bytes)).toBe(
      hashSettingsContent(readFileSync(file, "utf8"))
    );
    expect(JSON.parse(res.bytes)).toEqual(
      JSON.parse(readFileSync(file, "utf8"))
    );
    const parsed = expectAtomicWrite(file);
    const llm = parsed.llm as Record<string, unknown>;
    expect(llm.model).toBe("volcengine-ark/deepseek-v3-250324");
    expect(llm.apiKey).toBe("${ANTHROPIC_AUTH_TOKEN}");
    expect(llm.thinking).toBe("adaptive");
    expect(llm.providers).toEqual(providersOf(raw));
    expect(parsed.isolation).toEqual({ worktreeOnMutate: true });
    expect(parsed.permissions).toEqual({ defaultMode: "ask" });
    expect(parsed.memory).toEqual({ autoExtract: true });
  });

  test("连续两次 persist（切走再切回）：最终 = 原始 raw，注册表与保留字段全程在", async () => {
    const base = makeTmpRoot("iknow-persist-model-roundtrip-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(rawWithProviders(), null, 2));
    await persistModelChanges(file, {
      model: "volcengine-ark/deepseek-v3-250324",
    });
    await persistModelChanges(file, { model: "minimax-cn/MiniMax-M3" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(rawWithProviders());
    expectAtomicWrite(file);
  });

  test("非法 patch 不落盘：文件逐字节不变、不创建新文件、无 .tmp 残留（含 {} / llm 非对象起点）", async () => {
    const base = makeTmpRoot("iknow-persist-model-invalid-");
    const dir = join(base, "home", ".iknow");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.json");
    const before = JSON.stringify(rawWithProviders(), null, 2);
    writeFileSync(file, before);
    await expect(
      persistModelChanges(file, { model: "unknown/x" })
    ).rejects.toThrow(TypeError);
    expect(readFileSync(file, "utf8")).toBe(before);

    // raw 缺 llm 段 → 无注册表 → TypeError，文件不被写。
    const noLlm = join(dir, "settings-nollm.json");
    writeFileSync(noLlm, "{}\n");
    await expect(
      persistModelChanges(noLlm, { model: "minimax-cn/MiniMax-M3" })
    ).rejects.toThrow(TypeError);
    expect(readFileSync(noLlm, "utf8")).toBe("{}\n");

    // llm 非普通对象 → 同款拒绝。
    const badLlm = join(dir, "settings-badllm.json");
    writeFileSync(badLlm, JSON.stringify({ llm: "nope" }));
    await expect(
      persistModelChanges(badLlm, { model: "minimax-cn/MiniMax-M3" })
    ).rejects.toThrow(TypeError);
    expect(readFileSync(badLlm, "utf8")).toBe(JSON.stringify({ llm: "nope" }));

    // 文件不存在 + 非法 patch → 不创建文件、无 tmp 残留。
    const missing = join(dir, "settings-missing.json");
    await expect(
      persistModelChanges(missing, { model: "no-slash" })
    ).rejects.toThrow(TypeError);
    const entries = readdirSync(dir);
    expect(entries).not.toContain("settings-missing.json");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});
