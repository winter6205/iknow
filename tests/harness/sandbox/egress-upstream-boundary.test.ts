/**
 * tests/harness/sandbox/egress-upstream-boundary.test.ts
 *
 * grep pin for ADR-0097's dependency-fork discipline (and the boundary clause
 * of specs/egress-credential-sentinel.md): inside `src/`, no file other than
 * `egress/upstream.ts` may import **deep paths** (`/dist/...`) of
 * `@anthropic-ai/sandbox-runtime` — all in-package reuse funnels through the
 * upstream.ts single point, so a version bump touches only that file
 * (file-carried discipline of ADR-0097).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../../../src/", import.meta.url));
const DEEP = "@anthropic-ai/sandbox-runtime/";
const ALLOWED = "harness/sandbox/egress/upstream.ts";

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js)$/.test(name)) yield p;
  }
}

describe("SC10 —— 包深路径 import 收口（仅 egress/upstream.ts）", () => {
  it("src/ 无 upstream.ts 之外的 @anthropic-ai/sandbox-runtime 深路径 import", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
      if (rel === ALLOWED) continue;
      const text = readFileSync(file, "utf8");
      // pins import/export ... from deep-path statements only (a path mention inside a comment is not an integration surface).
      for (const line of text.split("\n")) {
        if (/from\s+["'`]@anthropic-ai\/sandbox-runtime\/dist/.test(line)) {
          offenders.push(rel);
          break;
        }
      }
    }
    assert.deepEqual(offenders, []);
    // counter-check: upstream.ts really uses deep paths (the funnel layer is alive; not a vacuously-green rule).
    assert.match(
      readFileSync(join(SRC_ROOT, ALLOWED), "utf8"),
      new RegExp(DEEP.replace("/", "\\/") + "dist")
    );
  });
});
