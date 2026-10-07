/**
 * Tests for discovery.ts (findProjectAgents / findUserAgents / listRulesFiles).
 *
 * Coverage (discovery half): cwd present / cwd missing / user home missing /
 * rules glob ordering / mtime metadata / symlink rejection / non-UTF-8 skip + stderr warning.
 *
 * discovery is the read-side metadata scanner: NEVER reads content (content
 * loading is assembly.ts's job). It only resolves existence + mtime +
 * size so the per-turn refresh hook can compare cached mtimes.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findProjectAgents,
  findUserAgents,
  listRulesFiles,
} from "../../../src/harness/memory/index.ts";

// -- tmpdir fixtures --------------------------------------------------------

let cwd: string;
let userHome: string;
const written: string[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "discovery-cwd-"));
  userHome = await mkdtemp(join(tmpdir(), "discovery-home-"));
  written.push(cwd, userHome);
});

afterEach(async () => {
  await Promise.all(
    written.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  );
});

// -- helpers ----------------------------------------------------------------

const writeFileUtf8 = (p: string, content: string) =>
  writeFile(p, content, "utf8").then(() => {
    written.push(p);
  });

// -- findProjectAgents ------------------------------------------------------

describe("findProjectAgents", () => {
  it("returns null when <cwd>/AGENTS.md does not exist", async () => {
    const out = await findProjectAgents(cwd);
    assert.equal(out, null);
  });

  it("returns the project AGENTS.md entry when present", async () => {
    const p = join(cwd, "AGENTS.md");
    await writeFileUtf8(p, "project content");
    const out = await findProjectAgents(cwd);
    assert.ok(out !== null, "expected non-null entry");
    assert.equal(out!.path, p);
    assert.equal(typeof out!.mtimeMs, "number");
    assert.equal(typeof out!.size, "number");
    assert.ok(out!.size > 0);
  });

  it("returns null when cwd does not exist (ENOENT path)", async () => {
    const out = await findProjectAgents(join(cwd, "no-such-dir"));
    assert.equal(out, null);
  });
});

// -- findUserAgents ---------------------------------------------------------

describe("findUserAgents", () => {
  it("returns null when ~/.iknow/AGENTS.md does not exist", async () => {
    const out = await findUserAgents(userHome);
    assert.equal(out, null);
  });

  it("returns the user AGENTS.md entry when present", async () => {
    const dir = join(userHome, ".iknow");
    await mkdir(dir, { recursive: true });
    const p = join(dir, "AGENTS.md");
    await writeFileUtf8(p, "user content");
    const out = await findUserAgents(userHome);
    assert.ok(out !== null, "expected non-null entry");
    assert.equal(out!.path, p);
    assert.ok(out!.mtimeMs > 0);
    assert.ok(out!.size > 0);
  });

  it("returns null when userHome does not exist (ENOENT path)", async () => {
    const out = await findUserAgents(join(cwd, "no-such-home"));
    assert.equal(out, null);
  });
});

// -- listRulesFiles ---------------------------------------------------------

describe("listRulesFiles", () => {
  it("returns an empty array when the rules directory is missing", async () => {
    const out = await listRulesFiles(cwd, "project");
    assert.deepEqual(out, []);
  });

  it("returns project rules sorted by filename (asc)", async () => {
    const dir = join(cwd, ".iknow", "rules");
    await mkdir(dir, { recursive: true });
    // Write in non-sorted order to prove sort is by filename asc.
    await writeFileUtf8(join(dir, "zeta.md"), "z");
    await writeFileUtf8(join(dir, "alpha.md"), "a");
    await writeFileUtf8(join(dir, "mu.md"), "m");
    const out = await listRulesFiles(cwd, "project");
    assert.deepEqual(
      out.map((e) => e.path.split("/").pop()),
      ["alpha.md", "mu.md", "zeta.md"]
    );
  });

  it("returns user rules under <userHome>/.iknow/rules/", async () => {
    const dir = join(userHome, ".iknow", "rules");
    await mkdir(dir, { recursive: true });
    await writeFileUtf8(join(dir, "rule.md"), "x");
    const out = await listRulesFiles(userHome, "user");
    assert.equal(out.length, 1);
    assert.equal(out[0]!.path, join(dir, "rule.md"));
  });

  it("skips non-md files", async () => {
    const dir = join(cwd, ".iknow", "rules");
    await mkdir(dir, { recursive: true });
    await writeFileUtf8(join(dir, "real.md"), "ok");
    await writeFileUtf8(join(dir, "ignored.txt"), "no");
    const out = await listRulesFiles(cwd, "project");
    assert.equal(out.length, 1);
    assert.equal(out[0]!.path.endsWith("real.md"), true);
  });

  it("returns entries with mtime + size metadata", async () => {
    const dir = join(cwd, ".iknow", "rules");
    await mkdir(dir, { recursive: true });
    await writeFileUtf8(join(dir, "rule.md"), "hello world");
    const [entry] = await listRulesFiles(cwd, "project");
    assert.ok(entry !== undefined);
    assert.equal(typeof entry!.mtimeMs, "number");
    assert.equal(typeof entry!.size, "number");
    assert.ok(entry!.size > 0);
  });

  it("rejects symlinks (v0 find filters them out)", async () => {
    const target = join(cwd, "target.md");
    await writeFileUtf8(target, "real");
    const dir = join(cwd, ".iknow", "rules");
    await mkdir(dir, { recursive: true });
    // Symlink within the rules dir to a target file outside the scan set.
    const link = join(dir, "link.md");
    await symlink(target, link);
    const out = await listRulesFiles(cwd, "project");
    // The direct link entry must be filtered; only the directly-listed
    // target (which lives outside the rules dir) is not part of the scan.
    assert.equal(out.length, 0);
  });

  it("skips non-UTF-8 files and warns on stderr", async () => {
    const dir = join(cwd, ".iknow", "rules");
    await mkdir(dir, { recursive: true });
    const bad = join(dir, "bad.md");
    // Invalid UTF-8 sequence (lonely continuation byte).
    const buf = Buffer.from([0x80, 0x80, 0x80, 0x80]);
    await writeFile(bad, buf);
    written.push(bad);
    // Capture stderr.
    const original = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as unknown as { write: typeof original }).write = ((
      chunk: string | Uint8Array
    ) => {
      captured.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      );
      return (original as unknown as (...args: unknown[]) => boolean)(chunk);
    }) as typeof original;
    try {
      const out = await listRulesFiles(cwd, "project");
      assert.equal(out.length, 0, "non-UTF-8 file must be skipped");
      assert.ok(
        captured.some((s) => s.includes("bad.md")),
        "expected stderr warning to mention the skipped file"
      );
    } finally {
      (process.stderr as unknown as { write: typeof original }).write =
        original;
    }
  });
});
