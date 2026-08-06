/**
 * #121 T4: assembly.ts tests (assembleSystemPrompt).
 *
 * Spec: specs/121-memory-injection.md (Testing Strategy assembly half — 三层拼接
 * 顺序 / 优先级声明位置精确 / 存在性指针条件出现 / promote 段位置 / 文件截断 /
 * promote 段截断 / 三层全缺 → 仅存在性指针; SC 3/4/5/10). Project Structure
 * assembly.ts (装配顺序固定, append-only 纪律).
 *
 * assembleSystemPrompt is the thin composer over the T2/T3 read-side layer:
 * it reads static-layer files (AGENTS.md + rules) with readFile fallback, emits
 * the locked priority declaration + existence pointer, and appends the promote
 * segment. It never mutates messages and never writes to disk.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSystemPrompt,
  EXISTENCE_POINTER,
  PRIORITY_DECLARATION,
} from "../../../src/harness/memory/index.ts";
import type { AssemblyContext } from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";

// -- tmpdir fixtures --------------------------------------------------------

let cwd: string;
let userHome: string;
let memoryDir: string;
const written: string[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "assembly-cwd-"));
  userHome = await mkdtemp(join(tmpdir(), "assembly-home-"));
  memoryDir = await mkdtemp(join(tmpdir(), "assembly-mem-"));
  written.push(cwd, userHome, memoryDir);
});

afterEach(async () => {
  await Promise.all(
    written.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

// -- helpers ----------------------------------------------------------------

const write = (p: string, content: string) =>
  writeFile(p, content, "utf8").then(() => {
    written.push(p);
  });

const mkdirP = (p: string) =>
  mkdir(p, { recursive: true }).then(() => {
    written.push(p);
  });

const memoryEntry = (
  id: string,
  title: string,
  body: string,
  importance = 1
): MemoryEntryV1 => ({
  id,
  type: "note",
  importance,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title,
  body,
  updated_at: "2026-01-01T00:00:00.000Z",
});

function ctx(overrides?: Partial<AssemblyContext>): AssemblyContext {
  return { cwd, userHome, memoryDir, ...overrides };
}

// -- three-layer assembly order ---------------------------------------------

describe("assembleSystemPrompt", () => {
  it("assembles user → priority → project → existence pointer → promote", async () => {
    await mkdirP(join(userHome, ".iknow", "rules"));
    await write(join(userHome, ".iknow", "AGENTS.md"), "USER AGENTS");
    await write(join(userHome, ".iknow", "rules", "user1.md"), "USER RULE");
    await mkdirP(join(cwd, ".iknow", "rules"));
    await write(join(cwd, "AGENTS.md"), "PROJECT AGENTS");
    await write(join(cwd, ".iknow", "rules", "proj1.md"), "PROJECT RULE");
    // A memory entry file makes the memory library non-empty.
    await write(join(memoryDir, "mem-1.md"), "# mem");
    const promoteEntries = [memoryEntry("mem-1", "Memory one", "body one")];

    const out = await assembleSystemPrompt(ctx({ promoteEntries }));

    const iUser = out.indexOf("USER AGENTS");
    const iPriority = out.indexOf(PRIORITY_DECLARATION);
    const iProject = out.indexOf("PROJECT AGENTS");
    const iPointer = out.indexOf(EXISTENCE_POINTER);
    const iPromote = out.indexOf("### Memory one");
    assert.ok(iUser !== -1, "user layer present");
    assert.ok(iPriority !== -1, "priority declaration present");
    assert.ok(iProject !== -1, "project layer present");
    assert.ok(iPointer !== -1, "existence pointer present");
    assert.ok(iPromote !== -1, "promote segment present");
    assert.ok(iUser < iPriority, "user layer precedes priority declaration");
    assert.ok(
      iPriority < iProject,
      "priority declaration precedes project layer"
    );
    assert.ok(iProject < iPointer, "project layer precedes existence pointer");
    assert.ok(
      iPointer < iPromote,
      "existence pointer precedes promote segment"
    );
  });

  it("emits the priority declaration exactly once, between user and project", async () => {
    await mkdirP(join(userHome, ".iknow", "rules"));
    await write(join(userHome, ".iknow", "AGENTS.md"), "USER BODY");
    await mkdirP(join(cwd, ".iknow", "rules"));
    await write(join(cwd, "AGENTS.md"), "PROJECT BODY");

    const out = await assembleSystemPrompt(ctx());
    const count = out.split(PRIORITY_DECLARATION).length - 1;
    assert.equal(count, 1, "priority declaration must appear exactly once");
    assert.ok(
      out.indexOf(PRIORITY_DECLARATION) > out.indexOf("USER BODY"),
      "priority must come after user layer"
    );
    assert.ok(
      out.indexOf(PRIORITY_DECLARATION) < out.indexOf("PROJECT BODY"),
      "priority must come before project layer"
    );
  });

  it("orders rules by filename asc within each layer", async () => {
    await mkdirP(join(cwd, ".iknow", "rules"));
    await write(join(cwd, ".iknow", "rules", "zzz.md"), "LATE");
    await write(join(cwd, ".iknow", "rules", "aaa.md"), "EARLY");

    const out = await assembleSystemPrompt(ctx());
    assert.ok(out.indexOf("EARLY") !== -1);
    assert.ok(out.indexOf("LATE") !== -1);
    assert.ok(out.indexOf("EARLY") < out.indexOf("LATE"));
  });

  // -- existence pointer -----------------------------------------------------

  it("includes the existence pointer only when the memory library is non-empty", async () => {
    await write(join(memoryDir, "mem-1.md"), "# mem");
    const out = await assembleSystemPrompt(ctx());
    assert.ok(
      out.includes(EXISTENCE_POINTER),
      "non-empty memory library → pointer present"
    );
  });

  it("omits the existence pointer when the memory library is empty", async () => {
    const out = await assembleSystemPrompt(ctx());
    assert.ok(
      !out.includes("memory_recall"),
      "empty memory library → pointer absent"
    );
  });

  // -- file truncation -------------------------------------------------------

  it("truncates a file over 12000 chars with a [truncated N chars] marker", async () => {
    const big = "x".repeat(12100);
    await write(join(cwd, "AGENTS.md"), big);
    const out = await assembleSystemPrompt(ctx());
    assert.ok(
      out.includes("[truncated 100 chars]"),
      "expected truncation marker with dropped char count"
    );
    assert.ok(!out.includes("x".repeat(12050)), "truncated body dropped");
  });

  it("keeps a file at or under the cap untruncated", async () => {
    const small = "y".repeat(12000);
    await write(join(cwd, "AGENTS.md"), small);
    const out = await assembleSystemPrompt(ctx());
    assert.ok(!out.includes("[truncated"), "no truncation marker expected");
    assert.ok(out.includes("y".repeat(12000)));
  });

  // -- promote segment -------------------------------------------------------

  it("fills the promote segment by importance desc and stays ≤ 4000 chars", async () => {
    const lowBody = "low".repeat(300); // ~900 chars
    const highBody = "high".repeat(300);
    const promoteEntries = [
      memoryEntry("low", "Low priority", lowBody, 1),
      memoryEntry("high", "High priority", highBody, 9),
    ];
    const out = await assembleSystemPrompt(ctx({ promoteEntries }));

    const iHigh = out.indexOf("### High priority");
    const iLow = out.indexOf("### Low priority");
    assert.ok(iHigh !== -1 && iLow !== -1, "both promotable entries present");
    assert.ok(iHigh < iLow, "higher importance filled first");

    const promoteHead = out.substring(out.indexOf("### High priority"));
    assert.ok(
      promoteHead.length <= 4000,
      `promote segment must stay ≤ 4000 chars, got ${promoteHead.length}`
    );
  });

  it("omits the promote segment when there are no promotable entries", async () => {
    const out = await assembleSystemPrompt(ctx());
    assert.ok(!out.includes("### "), "no promote segment expected");
  });

  // -- all-layers-absent edge ------------------------------------------------

  it("emits only the existence pointer when all three layers are absent", async () => {
    await write(join(memoryDir, "mem-1.md"), "# mem");
    const out = await assembleSystemPrompt(ctx());
    assert.equal(out, EXISTENCE_POINTER);
  });

  it("emits an empty string when everything is absent", async () => {
    const out = await assembleSystemPrompt(ctx());
    assert.equal(out, "");
  });
});
