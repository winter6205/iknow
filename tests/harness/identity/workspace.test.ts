/**
 * #196 IKNOW T6:roundtrip (SC 26) + JSON corrupt (SC 31) + schema invalid
 * (SC 32) + user.md missing (SC 33) + eager/idempotent。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  iknowWorkspaceRoot,
  initializeIknowWorkspace,
  readIknowState,
  writeIknowState,
} from "../../../src/harness/identity/index.ts";

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
  it("roundtrip: write + read state", async () => {
    const init = await initializeIknowWorkspace({ workspace: workDir });
    expect(init.state.schema_version).toBe(1);
    expect(init.state.bootstrap_seeded).toBe(false);
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
    expect(re.state.bootstrap_seeded).toBe(false);
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
    expect(final.bootstrap_seeded).toBe(false);
  });
});
