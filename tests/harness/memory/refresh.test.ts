/**
 * `createSystemResolver` contract: session-level snapshot (ADR-0042).
 *
 * The resolver assembles once per session — on its first *successful* call —
 * and serves that exact string forever after: no stat, no mtime compare, no
 * reassembly. A resolver's lifetime is a session's, so "next session sees the
 * new content" is asserted by building a second resolver over the same ctx.
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemResolver } from "../../../src/harness/memory/refresh.ts";
import { serializeMemoryEntry } from "../../../src/harness/memory/frontmatter.ts";
import { MEMORY_CATALOG_DISCIPLINE } from "../../../src/harness/memory/catalog.ts";
import { defaultMemoryEntry } from "../../../src/harness/memory/schema.ts";

vi.mock("../../../src/harness/memory/assembly.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harness/memory/assembly.ts")
    >();
  return {
    ...actual,
    assembleSystemPrompt: vi.fn(actual.assembleSystemPrompt),
  };
});
import { assembleSystemPrompt as spiedAssemble } from "../../../src/harness/memory/assembly.ts";

// vi.mock above wraps `assembleSystemPrompt` in `vi.fn(actual...)`; the static
// import below still sees the un-wrapped signature, so cast the spy to a Mock
// for `mockRejectedValueOnce` / `mockResolvedValueOnce` to typecheck.
const mockedAssemble = spiedAssemble as unknown as Mock<typeof spiedAssemble>;

const roots: string[] = [];

// #861: this context has no `cwd` — project AGENTS.md / rules are discovered
// from the required `projectIdentityRoot`, so fixtures must name that member.
async function makeContext() {
  const root = await mkdtemp(join(tmpdir(), "iknow-refresh-"));
  roots.push(root);
  const projectIdentityRoot = join(root, "project");
  const userHome = join(root, "home");
  const memoryDir = join(root, "memory");
  await Promise.all([
    mkdir(projectIdentityRoot),
    mkdir(userHome),
    mkdir(memoryDir),
  ]);
  return { projectIdentityRoot, userHome, memoryDir };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Write one parseable store entry so the catalog segment has a live row. */
async function seedMemoryEntry(
  memoryDir: string,
  slug: string,
  title: string
): Promise<void> {
  await writeFile(
    join(memoryDir, `${slug}.md`),
    serializeMemoryEntry({
      ...defaultMemoryEntry(),
      id: slug,
      title,
      body: `body of ${title}`,
      importance: 3,
      updated_at: "2026-09-04T00:00:00.000Z",
    }),
    "utf8"
  );
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("createSystemResolver", () => {
  it("assembles once per session and serves that snapshot on every later call", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.projectIdentityRoot, "AGENTS.md"), "project-v1");
    const resolver = createSystemResolver(ctx);
    expect(await resolver()).toContain("project-v1");
    // Second call serves the frozen snapshot — no reassembly, no stat.
    expect(await resolver()).toContain("project-v1");
    expect(spiedAssemble).toHaveBeenCalledTimes(1);
  });

  it("freezes the snapshot when a project AGENTS.md changes mid-session", async () => {
    const ctx = await makeContext();
    const agents = join(ctx.projectIdentityRoot, "AGENTS.md");
    await writeFile(agents, "project-v1");
    const resolver = createSystemResolver(ctx);
    const first = await resolver();
    await tick();
    await writeFile(agents, "project-v2");
    // ADR-0042: the session-level snapshot never re-reads the layer.
    expect(await resolver()).toBe(first);
    expect(await resolver()).not.toContain("project-v2");
    expect(spiedAssemble).toHaveBeenCalledTimes(1);
  });

  it("re-reads the layer for the next session (a fresh resolver)", async () => {
    const ctx = await makeContext();
    const agents = join(ctx.projectIdentityRoot, "AGENTS.md");
    await writeFile(agents, "project-v1");
    await createSystemResolver(ctx)();
    await tick();
    await writeFile(agents, "project-v2");
    // A new resolver == a new session: the snapshot is taken afresh.
    const next = await createSystemResolver(ctx)();
    expect(next).toContain("project-v2");
    expect(next).not.toContain("project-v1");
  });

  it("returns the identical string on repeated calls (byte-stable prefix)", async () => {
    const ctx = await makeContext();
    await writeFile(
      join(ctx.projectIdentityRoot, "AGENTS.md"),
      "stable-project"
    );
    const resolver = createSystemResolver(ctx);
    const first = await resolver();
    expect(await resolver()).toBe(first);
  });

  it("snapshots both rule scopes and freezes them against mid-session edits", async () => {
    // #841 T6: the parent opener renders the rules index as a manifest (paths
    // only), never bodies — so the listed paths are what prove both the user
    // and the project scope participated in the snapshot.
    const ctx = await makeContext();
    const projectRules = join(ctx.projectIdentityRoot, ".iknow", "rules");
    const userRules = join(ctx.userHome, ".iknow", "rules");
    await Promise.all([
      mkdir(projectRules, { recursive: true }),
      mkdir(userRules, { recursive: true }),
    ]);
    const projectRule = join(projectRules, "project.md");
    const userRule = join(userRules, "user.md");
    await Promise.all([
      writeFile(projectRule, "project-rule-v1"),
      writeFile(userRule, "user-rule-v1"),
    ]);
    const resolver = createSystemResolver(ctx);
    const first = await resolver();
    expect(first).toContain(projectRule);
    expect(first).toContain(userRule);
    await tick();
    // Both scopes edited mid-session → the snapshot must not move for either.
    await writeFile(userRule, "user-rule-v2");
    await writeFile(projectRule, "project-rule-v2");
    expect(await resolver()).toBe(first);
    expect(spiedAssemble).toHaveBeenCalledTimes(1);
    // A rule file added mid-session is likewise invisible to this session…
    await writeFile(join(projectRules, "added.md"), "added-rule");
    expect(await resolver()).toBe(first);
    expect(spiedAssemble).toHaveBeenCalledTimes(1);
    // …and visible to the next session, proving both scopes are re-discovered.
    const next = await createSystemResolver(ctx)();
    expect(next).toContain(join(projectRules, "added.md"));
    expect(next).toContain(userRule);
  });

  it("keeps a mid-session deletion out of the snapshot and out of the next session", async () => {
    const ctx = await makeContext();
    const agents = join(ctx.projectIdentityRoot, "AGENTS.md");
    await writeFile(agents, "removed-content");
    const resolver = createSystemResolver(ctx);
    const first = await resolver();
    expect(first).toContain("removed-content");
    await rm(agents);
    // Deleting a snapshotted file must neither throw nor move the snapshot.
    expect(await resolver()).toBe(first);
    // The next session re-discovers and simply finds the file absent.
    const next = await createSystemResolver(ctx)();
    expect(next).not.toContain("removed-content");
  });

  // -- ADR-0042 SC6: catalog + promote 段随快照冻结 ---------------------------

  it("freezes the catalog segment against a memory file landing mid-session (SC6)", async () => {
    const base = await makeContext();
    const ctx = { ...base, autoExtract: true };
    const agents = join(ctx.projectIdentityRoot, "AGENTS.md");
    await writeFile(agents, "catalog-proj");
    await seedMemoryEntry(ctx.memoryDir, "aaaaaaaaaaaa", "Snapshotted entry");

    const resolver = createSystemResolver(ctx);
    const first = await resolver();
    expect(first).toContain(MEMORY_CATALOG_DISCIPLINE);
    expect(first).toContain("Snapshotted entry");

    await tick();
    // auto-memory 落盘 mid-session (ADR-0031): catalog must stay byte-identical.
    await seedMemoryEntry(ctx.memoryDir, "bbbbbbbbbbbb", "Late entry");
    // A concurrent static-layer touch is the mechanism that used to drag the
    // fresh catalog into the prefix (ADR-0042 Context / R4); under the
    // snapshot it must not re-open the assembly either.
    await writeFile(agents, "catalog-proj-edited");
    expect(await resolver()).toBe(first);
    expect(await resolver()).not.toContain("Late entry");
    expect(spiedAssemble).toHaveBeenCalledTimes(1);

    // Next session indexes it.
    const next = await createSystemResolver(ctx)();
    expect(next).toContain("Late entry");
    expect(next).toContain("Snapshotted entry");
  });

  // ADR-0044: even after an entry crosses the promote-eligibility threshold
  // mid-session, the snapshot must not include a promote body block. The
  // session-level snapshot already freezes on first assembly; this test pins
  // that the promote exclusion survives the usage.json update path too.
  it("does not add promote bodies to the snapshot when an entry becomes eligible mid-session (ADR-0044)", async () => {
    const base = await makeContext();
    const ctx = { ...base, autoExtract: true };
    await writeFile(
      join(base.projectIdentityRoot, "AGENTS.md"),
      "snapshot-proj"
    );
    await seedMemoryEntry(base.memoryDir, "cccccccccccc", "Pre-existing entry");

    const resolver = createSystemResolver(ctx);
    const first = await resolver();
    expect(first).toBeDefined();
    expect(first).not.toContain("### Pre-existing entry");
    expect(first).not.toContain("body of Pre-existing entry");

    await tick();
    // Mid-session: write usage.json that proves eligibility for the existing
    // entry. ADR-0044: this must not budge the snapshot into rendering a
    // promote body block.
    await writeFile(
      join(base.memoryDir, "usage.json"),
      JSON.stringify({
        entries: {
          cccccccccccccc: { recall_count: 4, sessions: ["s1", "s2"] },
        },
      }),
      "utf8"
    );
    const frozen = await resolver();
    expect(frozen).toBe(first);
    expect(frozen).not.toContain("### Pre-existing entry");
    expect(frozen).not.toContain("body of Pre-existing entry");
    expect(spiedAssemble).toHaveBeenCalledTimes(1);
  });

  // -- user static layer root (#732) -----------------------------------------

  it("snapshots userHome AGENTS.md even when workspaceRoot is set", async () => {
    const base = await makeContext();
    const workspaceRoot = join(base.projectIdentityRoot, "..", "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const ctx = { ...base, workspaceRoot };
    const userAgents = join(ctx.userHome, ".iknow", "AGENTS.md");
    await mkdir(join(ctx.userHome, ".iknow"), { recursive: true });
    await writeFile(userAgents, "user-agents-v1");

    const resolver = createSystemResolver(ctx);
    const first = await resolver();
    expect(first).toContain("user-agents-v1");
    await tick();
    await writeFile(userAgents, "user-agents-v2");
    // Frozen for this session…
    expect(await resolver()).toBe(first);
    // …and re-read by the next one, which proves the user scope (not just the
    // project scope) participates in the per-session snapshot.
    expect(await createSystemResolver(ctx)()).toContain("user-agents-v2");
  });

  it("ignores workspaceRoot/.iknow/AGENTS.md as a user layer", async () => {
    const base = await makeContext();
    const workspaceRoot = join(base.projectIdentityRoot, "..", "workspace");
    await mkdir(join(workspaceRoot, ".iknow"), { recursive: true });
    await writeFile(join(workspaceRoot, ".iknow", "AGENTS.md"), "ws-agents");
    await writeFile(
      join(base.projectIdentityRoot, "AGENTS.md"),
      "project-only"
    );

    const resolved = await createSystemResolver({ ...base, workspaceRoot })();
    expect(resolved).toContain("project-only");
    expect(resolved).not.toContain("ws-agents");
  });

  it("does not throw when the userHome layer is absent", async () => {
    const base = await makeContext();
    const workspaceRoot = join(base.projectIdentityRoot, "..", "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(base.projectIdentityRoot, "AGENTS.md"), "project-v1");

    const resolver = createSystemResolver({ ...base, workspaceRoot });
    await expect(resolver()).resolves.toContain("project-v1");
  });

  // -- review #121: 并发去重 + 装配失败不毒化缓存 -----------------------------

  it("dedupes concurrent first-call assembly (no duplicate discover/assemble)", async () => {
    const ctx = await makeContext();
    await writeFile(
      join(ctx.projectIdentityRoot, "AGENTS.md"),
      "concurrent-v1"
    );
    const resolver = createSystemResolver(ctx);
    // 同一 tick 内派发多个并发调用 —— serve 多会话共享同一 resolver 时会发生。
    const results = await Promise.all([
      resolver(),
      resolver(),
      resolver(),
      resolver(),
    ]);
    // 所有并发调用应返回同一字符串,且底层 assemble 只触发一次（in-flight dedupe）。
    expect(new Set(results).size).toBe(1);
    expect(spiedAssemble).toHaveBeenCalledTimes(1);
  });

  it("does not freeze a failed assembly (next call retries, then freezes)", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.projectIdentityRoot, "AGENTS.md"), "retry-v1");
    // 第一次装配失败 + 第二次成功
    mockedAssemble
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce("retry-success-content");
    const resolver = createSystemResolver(ctx);
    await expect(resolver()).rejects.toThrow("transient failure");
    // 快照只在成功取值后建立 → 失败调用不毒化,下次调用重新 discovery + assemble
    expect(await resolver()).toBe("retry-success-content");
    // 成功那次才是冻结点：此后不再装配。
    expect(await resolver()).toBe("retry-success-content");
    expect(spiedAssemble).toHaveBeenCalledTimes(2);
  });

  // -- live autoExtract 开关（memory-toggle-live）----------------------------
  //
  // ADR-0042 会话级快照的成立前提是「输入构造上不可能在会话内变」。TUI
  // /memory 面板打破了该前提：flags 是宿主持有的可变盒子，提交时翻转。
  // resolver 因此必须读 flags 的**当前值**决定 catalog 装配（flags 在场时
  // 覆盖 ctx.autoExtract），并暴露 invalidate() 让显式用户动作把快照作废，
  // 下一轮重装配。这不是放弃 ADR-0042：无翻转时快照语义逐字节不变。

  it("overrides ctx.autoExtract from live flags on every resolve (flags: false hides the catalog)", async () => {
    const base = await makeContext();
    const ctx = { ...base, autoExtract: true };
    await writeFile(join(base.projectIdentityRoot, "AGENTS.md"), "flags-proj");
    await seedMemoryEntry(base.memoryDir, "dddddddddddd", "Toggled entry");

    const flags = { autoExtract: true, dream: false };
    const resolver = createSystemResolver(ctx, { flags });
    const first = await resolver();
    expect(first).toContain("Toggled entry");

    // Host flips the box (same object identity, as the TUI mutates in place).
    flags.autoExtract = false;
    const afterOff = await resolver();
    expect(afterOff).not.toContain("Toggled entry");
    expect(afterOff).not.toContain(MEMORY_CATALOG_DISCIPLINE);

    // Flip back on: catalog re-enters. ctx.autoExtract stays true throughout —
    // flags alone decide.
    flags.autoExtract = true;
    expect(await resolver()).toContain("Toggled entry");
  });

  it("flags absent → snapshot semantics unchanged (no flags read)", async () => {
    const base = await makeContext();
    const ctx = { ...base, autoExtract: true };
    await writeFile(join(base.projectIdentityRoot, "AGENTS.md"), "noflags");
    await seedMemoryEntry(base.memoryDir, "eeeeeeeeeeee", "Plain entry");
    const resolver = createSystemResolver(ctx);
    const first = await resolver();
    expect(first).toContain("Plain entry");
    expect(await resolver()).toBe(first);
    expect(spiedAssemble).toHaveBeenCalledTimes(1);
  });

  it("invalidate() drops the snapshot so the next resolve reassembles", async () => {
    const base = await makeContext();
    const ctx = { ...base, autoExtract: true };
    await writeFile(join(base.projectIdentityRoot, "AGENTS.md"), "inv-proj");
    await seedMemoryEntry(base.memoryDir, "ffffffffffff", "First entry");

    const resolver = createSystemResolver(ctx);
    const first = await resolver();
    expect(first).toContain("First entry");

    await tick();
    resolver.invalidate();
    await seedMemoryEntry(base.memoryDir, "000000000001", "Second entry");
    const second = await resolver();
    expect(second).not.toBe(first);
    expect(second).toContain("Second entry");
    // After the reassembly the snapshot freezes again.
    expect(await resolver()).toBe(second);
  });

  it("invalidate() before any successful call is a no-op (not a poison)", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.projectIdentityRoot, "AGENTS.md"), "noop-inv");
    mockedAssemble.mockRejectedValueOnce(new Error("early failure"));
    const resolver = createSystemResolver(ctx);
    await expect(resolver()).rejects.toThrow("early failure");
    // 失败态下 invalidate 不改变「失败不毒化」契约。
    expect(() => resolver.invalidate()).not.toThrow();
    mockedAssemble.mockResolvedValueOnce("late-success");
    expect(await resolver()).toBe("late-success");
  });

  it("invalidate() dedupes concurrent reassembly (in-flight dedupe survives)", async () => {
    const base = await makeContext();
    const ctx = { ...base, autoExtract: true };
    await writeFile(join(base.projectIdentityRoot, "AGENTS.md"), "conc-inv");
    const resolver = createSystemResolver(ctx);
    await resolver();
    resolver.invalidate();
    const results = await Promise.all([resolver(), resolver(), resolver()]);
    expect(new Set(results).size).toBe(1);
  });
});
