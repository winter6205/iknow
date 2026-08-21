/**
 * #196 IKNOW T6:roundtrip (SC 26) + JSON corrupt (SC 31) + schema invalid
 * (SC 32) + user.md missing (SC 33) + eager/idempotent。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  unlink,
  readdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  iknowWorkspaceRoot,
  initializeIknowWorkspace,
  initIknowWorkspaceSafe,
  readIknowState,
  writeIknowState,
} from "../../../src/harness/identity/index.ts";
import { USER_TEMPLATE } from "../../../src/harness/identity/user-template.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-workspace-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("iknowWorkspaceRoot", () => {
  it("returns ~/.iknow", () => {
    expect(iknowWorkspaceRoot()).toMatch(/\.iknow$/);
  });
});

describe("initializeIknowWorkspace roundtrip", () => {
  it("roundtrip: write + read state (rev 2026-08-11: seed flips bs=true)", async () => {
    const init = await initializeIknowWorkspace({ workspace: workDir });
    expect(init.state.schema_version).toBe(1);
    expect(init.state.bootstrap_seeded).toBe(true);
    const read = await readIknowState(workDir);
    expect(read).toEqual(init.state);
  });

  it("JSON corrupt: returns default state (no throw)", async () => {
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, "state.json"), "{ broken json");
    const state = await readIknowState(workDir);
    expect(state.schema_version).toBe(1);
    expect(state.bootstrap_seeded).toBe(false);
  });

  it("schema invalid: schema_version mismatch returns default state", async () => {
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(workDir, "state.json"),
      JSON.stringify({ schema_version: 99, bootstrap_seeded: true })
    );
    const s = await readIknowState(workDir);
    expect(s.schema_version).toBe(1);
    expect(s.bootstrap_seeded).toBe(false);
  });

  it("user.md missing: workspace init still completes (skip segment)", async () => {
    await initializeIknowWorkspace({ workspace: workDir });
    await unlink(join(workDir, "user.md")).catch(() => {});
    const re = await initializeIknowWorkspace({ workspace: workDir });
    expect(re.state.bootstrap_seeded).toBe(true);
  });

  it("eager + idempotent: re-init does not overwrite", async () => {
    await initializeIknowWorkspace({ workspace: workDir });
    await writeIknowState({ bootstrap_seeded: true }, workDir);
    const re = await initializeIknowWorkspace({ workspace: workDir });
    expect(re.state.bootstrap_seeded).toBe(true);
  });

  it("exception: mkdir failure throws typed IknowIdentityError (write_failed)", async () => {
    // 在 path 中放一个普通文件占位,mkdir recursive 会抛 ENOTDIR → 触发 catch
    await writeFile(join(workDir, "blocker"), "not a dir");
    await expect(
      initializeIknowWorkspace({
        workspace: join(workDir, "blocker", "sub"),
      })
    ).rejects.toMatchObject({ kind: "write_failed" });
  });

  it("concurrent: two parallel init calls converge (last-write-wins)", async () => {
    const fresh = join(workDir, "concurrent");
    const [a, b] = await Promise.all([
      initializeIknowWorkspace({ workspace: fresh }),
      initializeIknowWorkspace({ workspace: fresh }),
    ]);
    // 两个都返回 schema_version=1 的有效 state(谁后写谁的,但都合法)
    expect(a.state.schema_version).toBe(1);
    expect(b.state.schema_version).toBe(1);
    const final = await readIknowState(fresh);
    expect(final.schema_version).toBe(1);
    expect(final.bootstrap_seeded).toBe(true);
  });

  it("self-heal: corrupt JSON is backed up + re-seeded", async () => {
    const ws = join(workDir, "heal-corrupt");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "state.json"), "{ broken json");

    const init = await initializeIknowWorkspace({ workspace: ws });
    expect(init.state.schema_version).toBe(1);
    expect(init.state.bootstrap_seeded).toBe(true);

    // 重新读取应当也是合法 seed
    const reread = await readIknowState(ws);
    expect(reread.schema_version).toBe(1);
    expect(reread.bootstrap_seeded).toBe(true);

    // 备份文件 .corrupt.<hex> 存在
    const entries = await readdir(ws);
    const backups = entries.filter((e) => e.startsWith("state.json.corrupt."));
    expect(backups.length).toBe(1);
  });

  it("self-heal: schema-invalid content is backed up + re-seeded", async () => {
    const ws = join(workDir, "heal-schema");
    await mkdir(ws, { recursive: true });
    await writeFile(
      join(ws, "state.json"),
      JSON.stringify({ schema_version: 99 })
    );

    const init = await initializeIknowWorkspace({ workspace: ws });
    expect(init.state.schema_version).toBe(1);
    expect(init.state.bootstrap_seeded).toBe(true);

    const reread = await readIknowState(ws);
    expect(reread.schema_version).toBe(1);
    expect(reread.bootstrap_seeded).toBe(true);

    const entries = await readdir(ws);
    const backups = entries.filter((e) => e.startsWith("state.json.corrupt."));
    expect(backups.length).toBe(1);
  });

  it("self-heal: valid file with bootstrap_seeded:true is NOT overwritten", async () => {
    const ws = join(workDir, "heal-valid");
    await initializeIknowWorkspace({ workspace: ws });
    await writeIknowState({ bootstrap_seeded: true }, ws);

    const re = await initializeIknowWorkspace({ workspace: ws });
    expect(re.state.bootstrap_seeded).toBe(true);

    // 不应有 .corrupt.* 备份(文件本来就合法)
    const entries = await readdir(ws);
    const backups = entries.filter((e) => e.startsWith("state.json.corrupt."));
    expect(backups.length).toBe(0);
  });
});

// ── #196 rev 2026-08-11 T2: seed BOOTSTRAP.md(对齐 ohmo initialize_workspace) ──
describe("initializeIknowWorkspace seeds BOOTSTRAP.md", () => {
  it("first init: writes BOOTSTRAP.md + flips bootstrap_seeded=true", async () => {
    const ws = join(workDir, "seed-bootstrap");
    const init = await initializeIknowWorkspace({ workspace: ws });
    expect(init.state.bootstrap_seeded).toBe(true);

    const content = await readFile(join(ws, "BOOTSTRAP.md"), "utf8");
    expect(content).toContain("First Contact");
    expect(content).toContain("Goals");
  });

  it("idempotent: second init does NOT overwrite BOOTSTRAP.md", async () => {
    const ws = join(workDir, "seed-bootstrap-idem");
    await initializeIknowWorkspace({ workspace: ws });
    await writeFile(
      join(ws, "BOOTSTRAP.md"),
      "custom user-edited bootstrap",
      "utf8"
    );

    const re = await initializeIknowWorkspace({ workspace: ws });
    expect(re.state.bootstrap_seeded).toBe(true);

    const content = await readFile(join(ws, "BOOTSTRAP.md"), "utf8");
    expect(content).toBe("custom user-edited bootstrap");
  });

  it("bs=true + file deleted: re-init does NOT re-seed (ohmo 隐式完成)", async () => {
    const ws = join(workDir, "seed-bootstrap-seeded");
    await initializeIknowWorkspace({ workspace: ws });
    expect((await readIknowState(ws)).bootstrap_seeded).toBe(true);
    // 模拟 agent 完成引导后 rm BOOTSTRAP.md
    await unlink(join(ws, "BOOTSTRAP.md"));

    const re = await initializeIknowWorkspace({ workspace: ws });
    expect(re.state.bootstrap_seeded).toBe(true);

    // bs=true(已 seed 标记),不重新 seed BOOTSTRAP.md
    // → 文件保持缺失 → 装配层读文件不注入 → 隐式完成
    await expect(readFile(join(ws, "BOOTSTRAP.md"), "utf8")).rejects.toThrow();
  });

  it("self-heal corrupt: seeds BOOTSTRAP.md + flips bs=true", async () => {
    const ws = join(workDir, "seed-bootstrap-heal");
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, "state.json"), "{ broken");

    const init = await initializeIknowWorkspace({ workspace: ws });
    expect(init.state.bootstrap_seeded).toBe(true);

    const content = await readFile(join(ws, "BOOTSTRAP.md"), "utf8");
    expect(content).toContain("First Contact");
  });
});

// ── rev 2026-08-21: seed/read path alignment (issue #584) ──
//
// Persona files live at `<userHome>/.iknow`. `opts.workspace` on
// initializeIknowWorkspace is the fake-home test seam (the `.iknow` dir),
// not workspaceRoot. Assemble reads `ctx.userHome/.iknow` and ignores
// `ctx.workspaceRoot` for user.md / BOOTSTRAP.md.
describe("initializeIknowWorkspace seed/read path alignment (rev 2026-08-21)", () => {
  it("explicit workspace: seed lands on <workspace>/.iknow (path is caller-controlled)", async () => {
    const ws = await mkdtemp(join(tmpdir(), "iknow-explicit-ws-"));
    try {
      const init = await initializeIknowWorkspace({ workspace: ws });
      expect(init.root).toBe(ws);
      // seed artifacts under that root
      await readFile(join(init.root, "user.md"), "utf8");
      const stateRaw = JSON.parse(
        await readFile(join(init.root, "state.json"), "utf8")
      );
      expect(stateRaw.bootstrap_seeded).toBe(true);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("cross-module: seed-path (init) and read-path (assemble userHome) align via shared home", async () => {
    const ws = await mkdtemp(join(tmpdir(), "iknow-cross-align-"));
    try {
      await initIknowWorkspaceSafe({ workspace: ws });

      const assembleReadPath = join(ws, "user.md");
      const assembleRead = await readFile(assembleReadPath, "utf8");
      expect(assembleRead).toBe(USER_TEMPLATE);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

// ── rev 2026-08-21: 默认 fallback 单元测试 ──
//
// vi.mock of node:os works in this test runner (vitest with hoisting), unlike
// the earlier failed attempt that tried vi.spyOn. ESM namespaces are normally
// non-configurable, but vitest's vi.mock is hoisted to the top of the module
// (Babel transform), so the mock factory runs before any module's import of
// node:os resolves. workspace.ts calls `homedir()` lazily inside each function
// body — not at import time — so a hoisted mock lands cleanly.
//
// The fake home lets us assert that the no-arg default fallback resolves to
// `<homedir>/.iknow/` without touching the user's real ~/.iknow. We never pass
// `workspace` to the three functions under test, so the inline literal
// `path.join(homedir(), ".iknow")` is the only resolution path.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: { ...actual, homedir: () => "/tmp/fake-home-iknow-test" },
    homedir: () => "/tmp/fake-home-iknow-test",
  };
});

const FAKE_HOME = "/tmp/fake-home-iknow-test";
const FAKE_ROOT = `${FAKE_HOME}/.iknow`;

describe("default-fallback to <homedir>/.iknow (rev 2026-08-21)", () => {
  beforeAll(async () => {
    // 清掉旧测试残留,确保本次跑是从干净状态开始
    await rm(FAKE_ROOT, { recursive: true, force: true });
    await mkdir(FAKE_HOME, { recursive: true });
  });
  afterAll(async () => {
    await rm(FAKE_ROOT, { recursive: true, force: true });
  });

  it("initializeIknowWorkspace() (no opts) seeds user.md under <homedir>/.iknow/", async () => {
    await rm(FAKE_ROOT, { recursive: true, force: true });

    const init = await initializeIknowWorkspace();

    expect(init.root).toBe(FAKE_ROOT);
    // user.md 应该被 seed 在 <homedir>/.iknow/user.md
    const userContent = await readFile(join(init.root, "user.md"), "utf8");
    expect(userContent).toBe(USER_TEMPLATE);
  });

  it("writeIknowState({ bootstrap_seeded: true }) writes to <homedir>/.iknow/state.json", async () => {
    await rm(FAKE_ROOT, { recursive: true, force: true });
    await mkdir(FAKE_ROOT, { recursive: true });

    const next = await writeIknowState({ bootstrap_seeded: true });

    expect(next.bootstrap_seeded).toBe(true);
    expect(next.schema_version).toBe(1);
    // 文件必须落在 <homedir>/.iknow/state.json
    const stateRaw = JSON.parse(
      await readFile(join(FAKE_ROOT, "state.json"), "utf8")
    );
    expect(stateRaw.bootstrap_seeded).toBe(true);
    expect(stateRaw.schema_version).toBe(1);
  });

  it("initIknowWorkspaceSafe: exception (unwritable parent) warns and does not throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blockerDir = join(workDir, "safe-exc");
    await mkdir(blockerDir, { recursive: true });
    await writeFile(join(blockerDir, "blocker"), "not a dir");
    try {
      await expect(
        initIknowWorkspaceSafe({
          workspace: join(blockerDir, "blocker", "sub"),
        })
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      const msg = warn.mock.calls.map((c) => c.join(" ")).join(" ");
      expect(msg).toContain("workspace init failed");
    } finally {
      warn.mockRestore();
    }
  });

  it("overflow: extra-long workspace path Safe-warns and does not throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        initIknowWorkspaceSafe({
          workspace: join("/tmp", "x".repeat(8000), ".iknow"),
        })
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("readIknowState() (no arg) reads from <homedir>/.iknow/state.json", async () => {
    // 直接在期望路径写一份已知 state,然后 no-arg 读取
    await rm(FAKE_ROOT, { recursive: true, force: true });
    await mkdir(FAKE_ROOT, { recursive: true });
    await writeFile(
      join(FAKE_ROOT, "state.json"),
      JSON.stringify({ schema_version: 1, bootstrap_seeded: true }),
      "utf8"
    );

    const s = await readIknowState();

    expect(s.bootstrap_seeded).toBe(true);
    expect(s.schema_version).toBe(1);
  });
});
