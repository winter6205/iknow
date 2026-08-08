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
  IKNOW_BOOTSTRAP_PROMPT,
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

/**
 * BOOTSTRAP prompt must not direct the agent to use file/bash tools against
 * `~/.iknow/` (the workspace root-isolates read_file/glob; bash hard-wall
 * rejects compound commands; write_file also stays inside workspace root).
 * Without this guarantee, first-launch turns cascade [失败] tool rows and
 * never produce an answer. The completion hook `/profile` (cli + tui) flips
 * bootstrap_seeded so bootstrap terminates when the user has filled user.md.
 *
 * Allowable: the prompt may *name* read_file / glob / compound commands in
 * a "do not use these" warning. The assertion below forbids *instructional*
 * phrasing — "use read_file", "run cat", "execute X on user.md".
 */
describe("IKNOW_BOOTSTRAP_PROMPT: pure-conversation guide", () => {
  it("does NOT instruct 'use read_file' / 'read it with' against ~/.iknow", () => {
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(/use\s+read_file/i);
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(
      /read\s+(it\s+)?with\s+read_file/i
    );
  });

  it("does NOT instruct 'use glob' against ~/.iknow", () => {
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(/use\s+glob/i);
  });

  it("does NOT instruct agent to use bash cat / sed / printf against ~/.iknow", () => {
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(/\bcat\s+~?\/?home/);
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(/\bcat\s+~?\/?\.iknow/);
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(/run\s+cat/i);
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(/use\s+sed/i);
  });

  it("does NOT instruct agent to write to ~/.iknow/user.md via shell", () => {
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(/>>?\s*~\/?\.iknow/);
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(/use\s+tee/i);
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(/use\s+printf/i);
  });

  it("points the user at the /profile completion hook so bootstrap terminates", () => {
    expect(IKNOW_BOOTSTRAP_PROMPT).toMatch(/\/profile\s+done/);
  });

  it("warns (not instructs) the agent that file/bash tools are out-of-sandbox", () => {
    // W5 → W6: 文案已改为与真实执行对齐 — read_file 默认允许读 ~/.iknow/(用户画像);
    // write_file / edit_file / glob 仍然 cwd-scoping 拒绝 ~/.iknow/;
    // compound shell commands 可直达;host 拥有该目录,agent 不诱导用工具。
    // 断言承诺:write-file 子集拒绝、read_file 显式可读、host 拥有目录、用户在外侧编辑。
    expect(IKNOW_BOOTSTRAP_PROMPT).toMatch(/project-root sandbox/i);
    expect(IKNOW_BOOTSTRAP_PROMPT).toMatch(/read_file\s+can\s+read/i);
    expect(IKNOW_BOOTSTRAP_PROMPT).toMatch(
      /write_file\s*\/\s*edit_file\s*\/\s*glob/i
    );
    expect(IKNOW_BOOTSTRAP_PROMPT).toMatch(/host owns this directory/i);
    expect(IKNOW_BOOTSTRAP_PROMPT).toMatch(/in your own editor/i);
    // 不允许回归到旧的"compound shell commands will reject"错误声明。
    expect(IKNOW_BOOTSTRAP_PROMPT).not.toMatch(/compound.*will reject/i);
  });
});
