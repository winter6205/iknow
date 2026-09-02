import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemResolver } from "../../../src/harness/memory/refresh.ts";

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

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("createSystemResolver", () => {
  it("returns the cached system when tracked mtimes are unchanged (zero reassembly)", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.projectIdentityRoot, "AGENTS.md"), "project-v1");
    const resolver = createSystemResolver(ctx);
    expect(await resolver()).toContain("project-v1");
    // Second call: no mtime change → schemaREADME cache hit, no disk reassembly.
    expect(await resolver()).toContain("project-v1");
    expect(spiedAssemble).toHaveBeenCalledTimes(1);
  });

  it("refreshes when a project AGENTS.md mtime changes", async () => {
    const ctx = await makeContext();
    const agents = join(ctx.projectIdentityRoot, "AGENTS.md");
    await writeFile(agents, "project-v1");
    const resolver = createSystemResolver(ctx);
    await resolver();
    await tick();
    await writeFile(agents, "project-v2");
    expect(await resolver()).toContain("project-v2");
  });

  it("keeps system content stable across cache hits", async () => {
    const ctx = await makeContext();
    await writeFile(
      join(ctx.projectIdentityRoot, "AGENTS.md"),
      "stable-project"
    );
    const resolver = createSystemResolver(ctx);
    const first = await resolver();
    expect(await resolver()).toBe(first);
  });

  it("tracks rule files independently", async () => {
    // #841 T6: parent session opener renders the rules index as a manifest
    // (paths only), not bodies. The refresh contract we still own is "a
    // rule's mtime change triggers re-discovery" — assert on the path
    // appearing in the manifest instead of on rule text.
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
    // #841 T6: the parent opener carries rules as a manifest, so the listed
    // paths — not the bodies — are what prove both scopes are tracked.
    expect(first).toContain(projectRule);
    expect(first).toContain(userRule);
    await tick();
    await writeFile(userRule, "user-rule-v2");
    const second = await resolver();
    // 只有 user rule 的 mtime 变了 → 重新装配后两个 scope 的清单条目都必须在。
    expect(second).toContain(projectRule);
    expect(second).toContain(userRule);
    // Only one tracked rule file changed → assembly must still re-run.
    expect(spiedAssemble).toHaveBeenCalledTimes(2);
    await tick();
    // 反向独立：只改 project rule 也必须触发重装配，否则单 scope 的
    // tracker 也能过这条用例。
    await writeFile(projectRule, "project-rule-v2");
    expect(await resolver()).toContain(projectRule);
    expect(spiedAssemble).toHaveBeenCalledTimes(3);
  });

  it("treats a deleted tracked file as absent without throwing", async () => {
    const ctx = await makeContext();
    const agents = join(ctx.projectIdentityRoot, "AGENTS.md");
    await writeFile(agents, "removed-content");
    const resolver = createSystemResolver(ctx);
    await resolver();
    await rm(agents);
    expect(await resolver()).not.toContain("removed-content");
  });

  // -- user static layer root (#732) -----------------------------------------

  it("tracks userHome AGENTS.md even when workspaceRoot is set", async () => {
    const base = await makeContext();
    const workspaceRoot = join(base.projectIdentityRoot, "..", "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const ctx = { ...base, workspaceRoot };
    const userAgents = join(ctx.userHome, ".iknow", "AGENTS.md");
    await mkdir(join(ctx.userHome, ".iknow"), { recursive: true });
    await writeFile(userAgents, "user-agents-v1");

    const resolver = createSystemResolver(ctx);
    expect(await resolver()).toContain("user-agents-v1");
    await tick();
    await writeFile(userAgents, "user-agents-v2");
    expect(await resolver()).toContain("user-agents-v2");
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

  it("does not poison the cache when assembleSystemPrompt throws (next call retries)", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.projectIdentityRoot, "AGENTS.md"), "retry-v1");
    // 第一次装配失败 + 第二次成功
    mockedAssemble
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce("retry-success-content");
    const resolver = createSystemResolver(ctx);
    await expect(resolver()).rejects.toThrow("transient failure");
    // tracked/lastMtime 已被丢弃 → 下次调用重新 discovery + assemble
    expect(await resolver()).toBe("retry-success-content");
  });
});
