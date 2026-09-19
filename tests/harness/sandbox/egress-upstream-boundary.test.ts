/**
 * tests/harness/sandbox/egress-upstream-boundary.test.ts
 *
 * specs/egress-credential-sentinel.md SC10（自此弹成立）/ ADR-0097
 * 「Dependency fork 纪律」grep 钉：`src/` 内除 `egress/upstream.ts` 外，
 * 任何文件不得 import `@anthropic-ai/sandbox-runtime` 的**深路径**
 * （`/dist/...`）—— 包内件复用一律经 upstream.ts 单点收口，版本升级只
 * 改该文件（0097 文件承载纪律）。
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
      // 只钉 import/export ... from 深路径语句（注释里的路径提及不算接入面）。
      for (const line of text.split("\n")) {
        if (/from\s+["'`]@anthropic-ai\/sandbox-runtime\/dist/.test(line)) {
          offenders.push(rel);
          break;
        }
      }
    }
    assert.deepEqual(offenders, []);
    // 反证：upstream.ts 本身确实在用深路径（收口层活着，非空规则假绿）。
    assert.match(
      readFileSync(join(SRC_ROOT, ALLOWED), "utf8"),
      new RegExp(DEEP.replace("/", "\\/") + "dist")
    );
  });
});
