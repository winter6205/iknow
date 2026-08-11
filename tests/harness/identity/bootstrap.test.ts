/**
 * #196 IKNOW T6:BOOTSTRAP 首启触发 + state.json 写入 (SC 24/27);
 * bootstrap_seeded false→true 唯一迁移路径。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeIknowWorkspace,
  readIknowState,
  writeIknowState,
  BOOTSTRAP_TEMPLATE,
} from "../../../src/harness/identity/index.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-bootstrap-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("bootstrap state machine", () => {
  it("initial seed: bootstrap_seeded flips true + schema_version=1", async () => {
    const { state } = await initializeIknowWorkspace({ workspace: workDir });
    expect(state.bootstrap_seeded).toBe(true);
    expect(state.schema_version).toBe(1);
  });

  it("bootstrap_seeded true→true (seed 即翻旗;写 state 保持 true)", async () => {
    const init = await initializeIknowWorkspace({ workspace: workDir });
    expect(init.state.bootstrap_seeded).toBe(true);
    const after = await writeIknowState({ bootstrap_seeded: true }, workDir);
    expect(after.bootstrap_seeded).toBe(true);
    const p = join(workDir, "state.json");
    const content = JSON.parse(await readFile(p, "utf8"));
    expect(content.bootstrap_seeded).toBe(true);
    expect(content.schema_version).toBe(1);
  });

  it("second init does not overwrite user-modified state.json", async () => {
    await initializeIknowWorkspace({ workspace: workDir });
    await writeIknowState({ bootstrap_seeded: true }, workDir);
    const re = await initializeIknowWorkspace({ workspace: workDir });
    expect(re.state.bootstrap_seeded).toBe(true);
  });

  it("eager + idempotent: second init returns existing state", async () => {
    await initializeIknowWorkspace({ workspace: workDir });
    const first = await initializeIknowWorkspace({ workspace: workDir });
    const second = await initializeIknowWorkspace({ workspace: workDir });
    expect(first.state.bootstrap_seeded).toBe(second.state.bootstrap_seeded);
  });
});

/**
 * rev 2026-08-11:BOOTSTRAP 从对话脚本(14cd709 应急设计,断言"不要诱导工具")
 * 改为文件模板。新语义 — agent 用 ACI 工具(read_file / write_file / edit_file)
 * 读写 `~/.iknow/`,引导完成后自己 rm BOOTSTRAP.md(文件驱动隐式完成)。
 * 断言同步翻转:prompt 应 *诱导* 用工具、不再提 /profile done。
 */
describe("BOOTSTRAP_TEMPLATE: file-driven tool guide", () => {
  it("instructs agent to update ~/.iknow/user.md with tools", () => {
    expect(BOOTSTRAP_TEMPLATE).toMatch(/update\s+.*user\.md/i);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/\.iknow/i);
  });

  it("does NOT reference /profile done (host hook removed)", () => {
    expect(BOOTSTRAP_TEMPLATE).not.toMatch(/\/profile\s+done/);
  });

  it("tells the agent to delete the bootstrap file when done", () => {
    expect(BOOTSTRAP_TEMPLATE).toMatch(/delete this file/i);
  });
});
