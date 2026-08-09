/**
 * LANGUAGE_EXTENSIONS 表 + languageIdFor 查表单测 — spec 302-lsp-multilang（T3，#304 决策4）。
 *
 * 表驱动覆盖：
 *   1. 每扩展名 → languageId 映射（.ts/.mts/.cts/.tsx/.jsx/.py/.pyi/.yaml/.yml/.json/.dockerfile）；
 *   2. 回退 typescript：无扩展名文件（含 Dockerfile 全文件名）、未知扩展名。
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
    // 每扩展名映射（表驱动）
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
    // Dockerfile（无扩展名全文件名）→ dockerfile；与 resolveServer basename 路由一致
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
