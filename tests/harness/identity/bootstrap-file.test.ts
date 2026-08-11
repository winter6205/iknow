/**
 * #196 rev 2026-08-11:BOOTSTRAP_TEMPLATE 是文件模板(对齐 ohmo BOOTSTRAP.md),
 * 含 "When done" 删除提示;bootstrapFilePath 返回正确路径。
 *
 * T1 Acceptance:
 * 1. BOOTSTRAP_TEMPLATE 是 string,含 Goals / Style / When done 三节
 * 2. 结尾对齐 ohmo "This file can be deleted when done. If it is gone later,
 *    do not assume it should come back."
 * 3. bootstrapFilePath(workspace) 返回 <workspace>/BOOTSTRAP.md
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
    // rev 2026-08-11:read_file 放行 ~/.iknow/(extraReadRoots);write_file/edit_file
    // 保持 cwd-scoped(操作员裁决)——agent 用 bash 写/删,bwrap 把整个 home --bind。
    expect(BOOTSTRAP_TEMPLATE).toMatch(/read_file/);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/write_file/);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/edit_file/);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/bash/);
    expect(BOOTSTRAP_TEMPLATE).toMatch(/\.iknow/);
  });

  it("does NOT instruct /profile done (rev 2026-08-11 removes the host hook)", () => {
    // 旧 /profile done 是 14cd709 应急设计;新机制是 agent 自己 rm 文件
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
    // 防 OS-specific 分隔符 bug
    expect(bootstrapFilePath("/a")).toBe(join("/a", "BOOTSTRAP.md"));
    expect(bootstrapFilePath("/a/")).toBe(join("/a/", "BOOTSTRAP.md"));
  });
});
