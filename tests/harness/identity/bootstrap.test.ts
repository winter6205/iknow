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
} from "../../../src/harness/identity/index.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-bootstrap-test-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("bootstrap state machine", () => {
  it("initial seed has bootstrap_seeded=false", async () => {
    const { state } = await initializeIknowWorkspace({ workspace: workDir });
    expect(state.bootstrap_seeded).toBe(false);
    expect(state.schema_version).toBe(1);
  });

  it("bootstrap_seeded false → true is the only migration path", async () => {
    const init = await initializeIknowWorkspace({ workspace: workDir });
    expect(init.state.bootstrap_seeded).toBe(false);
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
