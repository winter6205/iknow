import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (
        name === "node_modules" ||
        name === "dist" ||
        name === "_upstream_ref"
      ) {
        continue;
      }
      out.push(...walkTsFiles(p));
    } else if (name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("standalone iknow boundary", () => {
  it("package.json name is iknow", async () => {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8")
    ) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    assert.equal(pkg.name, "iknow");
    const all = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    };
    for (const [name, ver] of Object.entries(all)) {
      assert.equal(
        /_upstream_ref/i.test(name),
        false,
        `dependency name must not reference upstream ref: ${name}`
      );
      assert.equal(
        /_upstream_ref/i.test(ver),
        false,
        `dependency version must not reference upstream ref: ${name}@${ver}`
      );
    }
  });

  it("no file under src/ imports path containing _upstream_ref/", async () => {
    const srcDir = join(root, "src");
    const files = walkTsFiles(srcDir);
    assert.ok(files.length > 0, "expected src ts files");

    const importRe =
      /(?:from|import)\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((m = importRe.exec(text)) !== null) {
        const spec = m[1] ?? m[2] ?? "";
        assert.equal(
          spec.includes("_upstream_ref"),
          false,
          `${relative(root, file)} imports ${spec}`
        );
      }
      // also catch dynamic path strings that look like package imports
      assert.equal(
        /from\s+['"][^'"]*_upstream_ref[^'"]*['"]/.test(text),
        false,
        `${relative(root, file)} has upstream-ref import string`
      );
    }
  });
});
