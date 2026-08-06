/**
 * #196 IKNOW T6:identity / soul 段拼装 + 认知 vs 人格边界 (SC 11-14) +
 * "identity before soul" 顺序 (SC 29) + 文件级 drift guard。
 */
import { describe, it, expect } from "vitest";
import { IKNOW_IDENTITY_DEFAULT } from "../../../src/harness/identity/identity.ts";
import { IKNOW_SOUL_DEFAULT } from "../../../src/harness/identity/soul.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("identity vs soul boundary (SSOT)", () => {
  // SC 11: identity 段不含 core truths (认知层 Name/Kind/Signature only)
  it("identity does NOT contain 'core truths' (cognition layer is Name/Kind/Signature only)", () => {
    expect(IKNOW_IDENTITY_DEFAULT.toLowerCase()).not.toContain("core truths");
  });
  // SC 12: soul 段不含 Name 字段
  it("soul does NOT contain 'name:' (personality layer is behavior only)", () => {
    expect(IKNOW_SOUL_DEFAULT.toLowerCase()).not.toMatch(/name\s*:/);
  });
  // SC 13: identity 不含 vibe
  it("identity does NOT contain 'vibe'", () => {
    expect(IKNOW_IDENTITY_DEFAULT.toLowerCase()).not.toContain("vibe");
  });
  // SC 14: soul 不含 signature
  it("soul does NOT contain 'signature'", () => {
    expect(IKNOW_SOUL_DEFAULT.toLowerCase()).not.toContain("signature");
  });
});

describe("identity and soul const string shape", () => {
  it("identity is non-empty string", () => {
    expect(typeof IKNOW_IDENTITY_DEFAULT).toBe("string");
    expect(IKNOW_IDENTITY_DEFAULT.length).toBeGreaterThan(0);
  });
  it("soul is non-empty string", () => {
    expect(typeof IKNOW_SOUL_DEFAULT).toBe("string");
    expect(IKNOW_SOUL_DEFAULT.length).toBeGreaterThan(0);
  });
  it("identity mentions iknow self-reference", () => {
    expect(IKNOW_IDENTITY_DEFAULT).toContain("iknow");
  });
});

/** 提取源文件中 const 模板字符串的**正文**（先剥离文件顶 JSDoc 注释块，
 *  再匹配第一个反引号模板——避免把顶注释里的 `specs/...` 引用当成模板内容）。
 *  注释可合法提到边界词（如 soul.ts 顶明示"不含 Signature"），不算 drift。 */
function constTemplateBody(file: string): string {
  const raw = readFileSync(
    join(process.cwd(), "src/harness/identity", file),
    "utf8"
  );
  // 剥掉文件顶 JSDoc /** ... */（如果有）
  const stripped = raw.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, "");
  const match = stripped.match(/`([\s\S]*?)`\.trim\(\)/);
  return (match?.[1] ?? "").toLowerCase();
}

describe("file-level boundary check (drift guard)", () => {
  // 只检查 const 模板正文（SSOT 实际内容），不读顶注释——注释如 soul.ts 顶
  // 明示"不含 Name / Kind / Signature"以说明边界，是合法文档，不算 drift。
  it("identity.ts const body does NOT contain 'core truths' (drift guard)", () => {
    expect(constTemplateBody("identity.ts")).not.toContain("core truths");
  });
  it("identity.ts const body does NOT contain 'vibe' (drift guard)", () => {
    expect(constTemplateBody("identity.ts")).not.toContain("vibe");
  });
  it("soul.ts const body does NOT contain 'name:' or 'signature' (drift guard)", () => {
    const body = constTemplateBody("soul.ts");
    expect(body).not.toMatch(/name\s*:/);
    expect(body).not.toContain("signature");
  });
});
