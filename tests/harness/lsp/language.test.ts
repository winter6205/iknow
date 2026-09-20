/**
 * LANGUAGE_EXTENSIONS table + languageIdFor lookup unit test.
 *
 * Table-driven coverage:
 *   1. each extension → languageId mapping (.ts/.mts/.cts/.tsx/.jsx/.py/.pyi/.yaml/.yml/.json/.dockerfile);
 *   2. fallback to typescript: extension-less files (including the full
 *      filename Dockerfile) and unknown extensions.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  LANGUAGE_EXTENSIONS,
  languageIdFor,
} from "../../../src/harness/lsp/language.js";

describe("LANGUAGE_EXTENSIONS", () => {
  it("表完整：TS 系列 → typescript/typescriptreact", () => {
    assert.equal(LANGUAGE_EXTENSIONS[".ts"], "typescript");
    assert.equal(LANGUAGE_EXTENSIONS[".mts"], "typescript");
    assert.equal(LANGUAGE_EXTENSIONS[".cts"], "typescript");
    assert.equal(LANGUAGE_EXTENSIONS[".tsx"], "typescriptreact");
    assert.equal(LANGUAGE_EXTENSIONS[".jsx"], "javascriptreact");
  });

  it("表完整：python / yaml / json / dockerfile", () => {
    assert.equal(LANGUAGE_EXTENSIONS[".py"], "python");
    assert.equal(LANGUAGE_EXTENSIONS[".pyi"], "python");
    assert.equal(LANGUAGE_EXTENSIONS[".yaml"], "yaml");
    assert.equal(LANGUAGE_EXTENSIONS[".yml"], "yaml");
    assert.equal(LANGUAGE_EXTENSIONS[".json"], "json");
    assert.equal(LANGUAGE_EXTENSIONS[".dockerfile"], "dockerfile");
  });
});

describe("languageIdFor", () => {
  const table: ReadonlyArray<[file: string, expected: string]> = [
    // per-extension mapping (table-driven)
    ["a.ts", "typescript"],
    ["a.mts", "typescript"],
    ["a.cts", "typescript"],
    ["a.tsx", "typescriptreact"],
    ["a.jsx", "javascriptreact"],
    ["a.py", "python"],
    ["a.pyi", "python"],
    ["a.yaml", "yaml"],
    ["a.yml", "yaml"],
    ["a.json", "json"],
    ["a.dockerfile", "dockerfile"],
    // Dockerfile (extension-less full filename) → dockerfile; matches the
    // basename routing in resolveServer
    ["Dockerfile", "dockerfile"],
    ["/proj/Dockerfile", "dockerfile"],
    [".dockerfile", "dockerfile"],
    ["Makefile", "typescript"],
    ["a.txt", "typescript"],
    ["a.md", "typescript"],
    ["noext", "typescript"],
  ];

  for (const [file, expected] of table) {
    it(`${file} → ${expected}`, () => {
      assert.equal(languageIdFor(file), expected);
    });
  }
});
