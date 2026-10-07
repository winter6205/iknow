/**
 * persist-settings pure module — reverse persistence into settings.json.
 *
 * Coverage:
 *  1. fresh file: missing llm → writes `{llm:{thinking,thinkingEffort}}`.
 *  2. existing file: apiKey / model / fallback / secrets all preserved.
 *  3. thinkingEffort: null → key deleted (auto semantics), no empty string left behind.
 *  4. bad JSON start: merge from empty object then write back (user file content itself not clobbered).
 *  5. atomicity: result parses as complete JSON, no `.tmp` leftovers.
 *  6. permissions: tmp file mode 0600 (asserted before rename).
 *  7. missing parent dir → mkdir -p then successful write.
 *  8. merge defends against invalid patch values (thinking / thinkingEffort out of range → throw).
 *  9. resolveThinkingSettingsPath（ADR-0084 write-back target layer）: thinking / memory are
 *     user-layer keys → target is always `<home>/.iknow/settings.json`, **decoupled from whether
 *     the project file exists**（the old ADR-0019 D1.3 "project exists → project" rule is retired:
 *     project files do not adopt llm / memory, writing there fails silently）. home defaults to homedir().
 * 10. hashSettingsContent: same string same hash, different string different hash.
 * 11. concurrency: two serial awaited persists → final = second patch + preserved fields.
 * 12. error path: target parent is a regular file (ENOTDIR) → reject, error contains the path.
 * 13. defensive branches: non-ENOENT readFile / non-SyntaxError JSON.parse → rethrow
 *    (injected via a real EISDIR fs error and a JSON.parse spy respectively).
 * 14. parallel double write → atomic rename guarantees the final file parses and
 *     thinking ∈ one of the two patches (NOT a merge disaster), preserved fields intact.
 * 15. /model: mergeModelPatch value-domain gating (non-string / empty / no slash / empty segment /
 *     unknown provider → TypeError), touches only `llm.model` with providers etc. intact,
 *     cross-provider round trips, coexists with thinking patches, starts from raw missing llm /
 *     non-object llm, persistModelChanges atomic write + stable bytes sha256, invalid patch never lands.
 *
 * Discipline:
 *  - mkdtempSync + afterAll rmSync (tmp isolation, never touch the real ~/.iknow);
 *  - vitest (framework already used in tests/config; bun test compatible);
 *  - failure-path cases use real fs errors (parent is a file → ENOTDIR; leaf is a directory → EISDIR)
 *    instead of chmod / spy: WSL2 tmpfs does not enforce mode bits for uid 1000, and vitest cannot spy
 *    ESM namespaces; the ENOTDIR case keeps its win32 skip (that platform maps it to ENOENT).
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

/** Per-test isolated tmp root (cleaned in afterAll). */
const tmpBases: string[] = [];

function makeTmpRoot(prefix: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  tmpBases.push(base);
  return base;
}

afterAll(() => {
  for (const base of tmpBases) rmSync(base, { recursive: true, force: true });
});

/** Full settings raw JSON string with apiKey / model / fallback / secrets. */
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

/** Asserts the file exists, parses, leaves no .tmp, and has mode 0600. */
function expectAtomicWrite(target: string): Record<string, unknown> {
  const dir = dirname(target);
  const entries = readdirSync(dir);
  expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  const stat = statSync(target);
  // POSIX mode bits: 0600 (owner rw only); meaningless on Windows.
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
    // llm is a non-plain object (string): old value dropped wholesale, rebuilt from patch fields.
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
    // base object untouched (pure function, no side effects).
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
    // Project file carries a user-layer key llm (outside the allowlist) plus an allowlisted verify.
    writeFileSync(
      projectFile,
      JSON.stringify({
        llm: { model: "project-model" },
        verify: { command: "x" },
      }),
      "utf8"
    );

    // Target = user path (not project), decoupled from whether project exists.
    const target = resolveThinkingSettingsPath({ home });
    expect(target).toBe(join(home, ".iknow", "settings.json"));
    expect(target).not.toBe(projectFile);

    await persistThinkingChanges(target, { thinking: "adaptive" });
    // user file gets thinking; project file's llm is byte-identical (never created / modified).
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
    // An existing project file never changes the target layer (signature narrowed to { home }; project probing retired).
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
    // Only the two thinking keys change; apiKey / model / fallback / maxTurns / secrets stay.
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
    // First call: adaptive + effort=high (preserved fields: model/apiKey/fallback/maxTurns/secrets).
    await persistThinkingChanges(file, {
      thinking: "adaptive",
      thinkingEffort: "high",
    });
    // Second call: thinking=off only, no effort → first effort survives via merge semantics.
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
    // Two persistThinkingChanges racing via Promise.all on the same file. The atomic
    // write (same-dir tmp + rename) guarantees no half-written / torn JSON — the final
    // file is exactly one complete write, never a merge disaster. Asserting:
    //   - JSON.parse succeeds (no torn state);
    //   - thinking ∈ {off, adaptive} (one of the two patches, not a blend);
    //   - preserved fields (model / apiKey / fallback / maxTurns / secrets) still present
    //     (merge started from the full file, not from empty).
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
    // The await already guarantees both writes finished; reading the final file here
    // cannot produce a detached rejection.
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
    // chmod 0555 does not block uid 1000 writes on WSL2 tmpfs (this test once passed the
    // write and failed spuriously). Instead create a deterministic ENOTDIR: the settings
    // parent is a regular file, so the module's mkdir(dirname, {recursive:true}) must fail.
    if (process.platform === "win32") return; // win32 maps ENOTDIR to ENOENT, unreproducible
    const base = makeTmpRoot("iknow-persist-enotdir-");
    const file = join(base, "not-a-dir", "settings.json");
    writeFileSync(join(base, "not-a-dir"), ""); // parent exists but is a file → mkdir must fail
    await expect(
      persistThinkingChanges(file, { thinking: "adaptive" })
    ).rejects.toThrow();
    await expect(
      persistThinkingChanges(file, { thinking: "adaptive" })
    ).rejects.toThrowError(file);
  });

  test("防御分支：readFile 抛非 ENOENT 错误 → 重抛（不静默吞）", async () => {
    // Real EISDIR: the settings leaf path is a directory, so readFile fails with a non-ENOENT
    // error, exercising readSettingsRaw's catch-rethrow branch (no ESM-namespace spy needed).
    const base = makeTmpRoot("iknow-persist-eisdir-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(file, { recursive: true }); // settings.json itself is a directory
    // Assert the error code, not the message: fs EISDIR text differs across runtimes
    // (node adds a comma suffix, bun does not, and neither includes the path) — but
    // code === "EISDIR" is stable everywhere and pins exactly the non-ENOENT rethrow branch.
    await expect(
      persistThinkingChanges(file, { thinking: "off" })
    ).rejects.toMatchObject({ code: "EISDIR" });
  });

  test("防御分支：JSON.parse 抛非 SyntaxError → 重抛（不静默吞）", async () => {
    const base = makeTmpRoot("iknow-persist-rethrow-");
    const file = join(base, "home", ".iknow", "settings.json");
    mkdirSync(join(base, "home", ".iknow"), { recursive: true });
    writeFileSync(file, "{}");
    // Keep the file write outside the mock window — readFile really reads "{}",
    // so only JSON.parse hits the mock (order: fs completes before parse).
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
    // Deliberately invalid input: `autoExtract` is a string, not a boolean.
    // `dream` stays valid so the failing field is unambiguously autoExtract.
    expect(() =>
      mergeMemoryPatch({}, { autoExtract: "yes" as never, dream: false })
    ).toThrow(TypeError);
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

// ADR-0092: filesystem isolation tier (fsMode) — reverse persistence channel.
// Mirrors persistMemoryChanges: raw-merge, atomic write, TypeError on invalid values.
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
    // Atomic write: no .tmp leftovers, mode 0600.
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
    // File untouched (write-back never happened).
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

// ── ADR-0096: subagent concurrency cap patch (cap 3|5|9|15|unlimited) ───────

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

  // Numbers outside the closed set → TypeError (same discipline as fsMode / thinking:
  // the TUI panel can never emit such values; catching here keeps bad data off disk).
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
    // Self-write sentinel: hash of returned bytes matches the file content hash
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
    // File untouched (write-back never happened)
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

// ── ADR-0096: worktree gate patch (ON | OFF) ────────────────────────────────

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
    // Key entirely missing is also rejected (empty patch must not land on disk)
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

/** Raw settings with volcengine-ark / minimax-cn providers (the spec example shape). */
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

/** The raw.llm.providers registry (reused in assertions to avoid hardcoded-copy drift). */
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
    // merged deep-equals "raw with only model swapped" — no other delta.
    expect(merged).toEqual(expected);
    // The providers registry stays whole (not trimmed to only the selected provider).
    expect((merged.llm as Record<string, unknown>).providers).toEqual(
      providersOf(raw)
    );
    // Pure function: raw is not mutated in place.
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
    // Registry absent / not an array / item id non-string → that provider is not a legal target.
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
    // Reverse order (model first, thinking second) likewise leaves both intact.
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
    // Self-write sentinel: bytes is exactly what landed on disk, so content hashes compare (semantics unchanged).
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

    // raw missing the llm section → no registry → TypeError, file untouched.
    const noLlm = join(dir, "settings-nollm.json");
    writeFileSync(noLlm, "{}\n");
    await expect(
      persistModelChanges(noLlm, { model: "minimax-cn/MiniMax-M3" })
    ).rejects.toThrow(TypeError);
    expect(readFileSync(noLlm, "utf8")).toBe("{}\n");

    // llm not a plain object → same rejection.
    const badLlm = join(dir, "settings-badllm.json");
    writeFileSync(badLlm, JSON.stringify({ llm: "nope" }));
    await expect(
      persistModelChanges(badLlm, { model: "minimax-cn/MiniMax-M3" })
    ).rejects.toThrow(TypeError);
    expect(readFileSync(badLlm, "utf8")).toBe(JSON.stringify({ llm: "nope" }));

    // File missing + invalid patch → no file created, no tmp leftovers.
    const missing = join(dir, "settings-missing.json");
    await expect(
      persistModelChanges(missing, { model: "no-slash" })
    ).rejects.toThrow(TypeError);
    const entries = readdirSync(dir);
    expect(entries).not.toContain("settings-missing.json");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });
});
