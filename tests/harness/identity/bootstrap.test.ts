/**
 * BOOTSTRAP first-start trigger + state.json write;
 * bootstrap_seeded false→true is the only transition path.
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
 * BOOTSTRAP changed from a conversation script (a stopgap asserting
 * "do not lead the agent to tools") into a file template. New semantics —
 * the agent reads/writes `~/.iknow/` with ACI tools (read_file / write_file /
 * edit_file) and rm's BOOTSTRAP.md itself once guidance is done (file-driven
 * implicit completion). Assertions flipped accordingly: the prompt should
 * *encourage* tool use and no longer mention /profile done.
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
