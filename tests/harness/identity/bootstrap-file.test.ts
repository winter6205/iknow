/**
 * BOOTSTRAP_TEMPLATE is a file template (mirroring ohmo's BOOTSTRAP.md) with
 * a "When done" deletion notice; bootstrapFilePath returns the correct path.
 *
 * Certified:
 * 1. BOOTSTRAP_TEMPLATE is a string with Goals / Style / When done sections
 * 2. it ends with ohmo's "This file can be deleted when done. If it is gone
 *    later, do not assume it should come back."
 * 3. bootstrapFilePath(workspace) returns <workspace>/BOOTSTRAP.md
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  BOOTSTRAP_TEMPLATE,
  bootstrapFilePath,
} from "../../../src/harness/identity/index.ts";

describe("BOOTSTRAP_TEMPLATE (rev 2026-08-11 file template)", () => {
  it("is a non-empty string", () => {
    expect(typeof BOOTSTRAP_TEMPLATE).toBe("string");
    expect(BOOTSTRAP_TEMPLATE.trim().length).toBeGreaterThan(0);
  });

  it("has three sections: Goals / Style / When done", () => {
    expect(BOOTSTRAP_TEMPLATE).toMatch(/^##\s+Goals\s*$/m);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/^##\s+Style\s*$/m);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/^##\s+When\s+done\s*$/m);
  });

  it("ends with ohmo-style deletable notice", () => {
    expect(BOOTSTRAP_TEMPLATE).toMatch(
      /This file can be deleted when done\.?\s*\n?\s*If it is gone later, do not assume it\s*should come back\.?/
    );
  });

  it("directs agent to read ~/.iknow/ with read_file + write via bash", () => {
    // read_file is allowed on ~/.iknow/ (extraReadRoots); write_file/edit_file
    // stay cwd-scoped (operator decision) — the agent writes/deletes via bash
    // and bwrap --binds the whole home.
    expect(BOOTSTRAP_TEMPLATE).toMatch(/read_file/);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/write_file/);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/edit_file/);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/bash/);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/\.iknow/);
  });

  it("does NOT instruct /profile done (rev 2026-08-11 removes the host hook)", () => {
    // The old /profile done was a stopgap; the new mechanism has the agent
    // rm the file itself.
    expect(BOOTSTRAP_TEMPLATE).not.toMatch(/\/profile\s+done/);
  });
});

describe("bootstrapFilePath (rev 2026-08-11)", () => {
  it("returns <workspace>/BOOTSTRAP.md", () => {
    expect(bootstrapFilePath("/home/user/.iknow")).toBe(
      "/home/user/.iknow/BOOTSTRAP.md"
    );
    expect(bootstrapFilePath("/tmp/test")).toBe("/tmp/test/BOOTSTRAP.md");
  });

  it("uses path.join (no manual slash concat)", () => {
    // guards against OS-specific separator bugs
    expect(bootstrapFilePath("/a")).toBe(join("/a", "BOOTSTRAP.md"));
    expect(bootstrapFilePath("/a/")).toBe(join("/a/", "BOOTSTRAP.md"));
  });
});
