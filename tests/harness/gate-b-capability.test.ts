/**
 * Gate B 扫描器契约：扫可执行面（含字符串 / import），不扫注释用词。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { findGateBViolations } from "./gate-b-capability.ts";

describe("findGateBViolations", () => {
  it("empty source yields no violations", () => {
    assert.deepEqual(findGateBViolations(""), []);
    assert.deepEqual(findGateBViolations("   \n\t"), []);
  });

  it("line and block comments mentioning checkpoint are not leaks", () => {
    const src = [
      "// host-side checkpoint; harness does not persist",
      "/* no retry in the kernel */",
      "/** JSDoc: checkpoint IO lives in session-api */",
      "const n = 1;",
    ].join("\n");
    assert.deepEqual(findGateBViolations(src), []);
  });

  it("retry identifiers are allowed on the executable surface", () => {
    assert.deepEqual(findGateBViolations("function retry() {}"), []);
    assert.deepEqual(findGateBViolations('const policy = "retry";'), []);
  });

  it("identifier and import leaks are reported with 1-based lines", () => {
    const src = [
      "function saveCheckpoint() {}",
      'import { x } from "../../session-api/store/checkpoint.js";',
      'import { trace } from "@opentelemetry/api";',
      "function retry() {}",
    ].join("\n");
    const hits = findGateBViolations(src);
    const keys = hits.map((h) => `${h.line}:${h.keyword}`);
    assert.ok(keys.includes("1:checkpoint"), keys.join(","));
    assert.ok(keys.includes("2:session-api"), keys.join(","));
    assert.ok(keys.includes("2:checkpoint"), keys.join(","));
    assert.ok(keys.includes("3:otel"), keys.join(","));
    assert.ok(!keys.includes("4:retry"), "retry must not be a Gate B keyword");
  });

  it("overflow: tens of thousands of banned-word comments do not leak; trailing identifier does", () => {
    const comments = Array.from(
      { length: 12_000 },
      () => "// checkpoint retry otel span metric"
    ).join("\n");
    assert.deepEqual(findGateBViolations(comments + "\nconst n = 1;\n"), []);
    const withLeak = comments + "\nfunction saveCheckpoint() {}\n";
    const hits = findGateBViolations(withLeak);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.keyword, "checkpoint");
    assert.equal(hits[0]?.line, 12_001);
  });

  it("concurrent scans of the same source are isolated and equal", async () => {
    const src = "const saveCheckpoint = 1;\n// retry in comment\n";
    const runs = await Promise.all(
      Array.from({ length: 16 }, () =>
        Promise.resolve(findGateBViolations(src))
      )
    );
    const first = JSON.stringify(runs[0]);
    for (const run of runs) {
      assert.equal(JSON.stringify(run), first);
    }
    assert.equal(runs[0]?.length, 1);
    assert.equal(runs[0]?.[0]?.keyword, "checkpoint");
  });

  it("unclosed block comment never throws; remainder is comment", () => {
    const src =
      "const ok = 1;\n/* checkpoint retry\nstill comment saveCheckpoint";
    let hits;
    try {
      hits = findGateBViolations(src);
    } catch (err) {
      assert.fail(`scanner must not throw: ${String(err)}`);
    }
    assert.deepEqual(hits, []);
  });

  it("generic span/metric identifiers without OTel are not leaks", () => {
    assert.deepEqual(
      findGateBViolations("const span = 1;\nconst metric = 2;"),
      []
    );
  });

  it("regular expression literals are not scanned (HTML parsers are not OTel)", () => {
    assert.deepEqual(
      findGateBViolations('const re = /<span class="otel-not-real">/;'),
      []
    );
  });

  it("template interpolation is code; surrounding template text is not stripped as comment", () => {
    const src = "const s = `// checkpoint`;\nconst t = `${saveCheckpoint()}`;";
    const hits = findGateBViolations(src);
    assert.ok(hits.some((h) => h.keyword === "checkpoint" && h.line === 2));
    assert.equal(
      hits.filter((h) => h.line === 1).length,
      1,
      "line 1 string still counts as executable surface"
    );
  });
});
