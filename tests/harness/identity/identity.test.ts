/**
 * #196 IKNOW T6:identity / soul 段拼装 + 认知 vs 人格边界 (SC 11-14) +
 * "identity before soul" 顺序 (SC 29) + 文件级 drift guard。
 * #symbol-primary T1: usage 段拼装 + 与 soul / identity 的边界守卫 (SC 5 + 8)。
 */
import { describe, it, expect } from "vitest";
import { IKNOW_IDENTITY_DEFAULT } from "../../../src/harness/identity/identity.ts";
import { IKNOW_SOUL_DEFAULT } from "../../../src/harness/identity/soul.ts";
import { IKNOW_USAGE_DEFAULT } from "../../../src/harness/identity/usage.ts";
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

describe("usage boundary (SSOT) — symbol-primary T1", () => {
  // SC 5: usage 不承担本体事实(归 identity.ts)
  it("usage does NOT contain 'name:' (ontology stays in identity.ts)", () => {
    expect(IKNOW_USAGE_DEFAULT.toLowerCase()).not.toMatch(/name\s*:/);
  });
  // SC 5: usage 不承担人格边界 / vibe 排版(归 soul.ts)
  it("usage does NOT contain 'core truths' (boundaries stay in soul.ts)", () => {
    expect(IKNOW_USAGE_DEFAULT.toLowerCase()).not.toContain("core truths");
  });
  it("usage does NOT contain 'vibe' (soul Vibe is the only vibe carrier)", () => {
    expect(IKNOW_USAGE_DEFAULT.toLowerCase()).not.toContain("vibe");
  });
  // SC 5: usage 不写 markdown 排版纪律(soul Vibe 仍是唯一载体,spec 假设 6)
  it("usage does NOT contain 'signature' (ontology stays in identity.ts)", () => {
    expect(IKNOW_USAGE_DEFAULT.toLowerCase()).not.toContain("signature");
  });
  // 使用规则必须含 spec 假设 2 / 使用规则段 / SC8 的优先级要点
  it("usage mentions symbol tools (find_symbol / find_declaration)", () => {
    expect(IKNOW_USAGE_DEFAULT).toContain("find_symbol");
    expect(IKNOW_USAGE_DEFAULT).toContain("find_declaration");
  });
  it("usage mentions the three grep fallbacks (non-code / unknown name / LSP unavailable)", () => {
    expect(IKNOW_USAGE_DEFAULT).toMatch(/non-code/i);
    expect(IKNOW_USAGE_DEFAULT).toMatch(/unknown symbol/i);
    expect(IKNOW_USAGE_DEFAULT).toMatch(/language server unavailable/i);
  });
  it("usage mentions edit_file surrender rule", () => {
    expect(IKNOW_USAGE_DEFAULT).toContain("edit_file");
  });
  it("usage forbids line/character as primary input", () => {
    expect(IKNOW_USAGE_DEFAULT).toMatch(/line\s*\/\s*character/i);
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
  it("usage is non-empty string", () => {
    expect(typeof IKNOW_USAGE_DEFAULT).toBe("string");
    expect(IKNOW_USAGE_DEFAULT.length).toBeGreaterThan(0);
  });
  it("identity mentions iknow self-reference", () => {
    expect(IKNOW_IDENTITY_DEFAULT).toContain("iknow");
  });
  it("usage title is '# Usage rules'", () => {
    expect(IKNOW_USAGE_DEFAULT).toContain("# Usage rules");
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
  it("usage.ts const body does NOT contain 'core truths' / 'vibe' / 'name:' / 'signature' (drift guard)", () => {
    const body = constTemplateBody("usage.ts");
    expect(body).not.toContain("core truths");
    expect(body).not.toContain("vibe");
    expect(body).not.toMatch(/name\s*:/);
    expect(body).not.toContain("signature");
  });
});

/**
 * Soul Continuity must NOT direct the agent to read/update `~/.iknow/user.md`
 * via tool calls — the workspace root isolates read_file/glob, and bash
 * hard-wall rejects compound commands, so any such instruction triggers a
 * cascade of [失败] rows and the agent never answers the user. Continuity
 * must point at the host-managed profile instead.
 */
describe("soul Continuity: does not direct agent to read/update ~/.iknow", () => {
  it("does not say 'Read user.md. Update it'", () => {
    expect(constTemplateBody("soul.ts")).not.toMatch(/read\s+user\.md/i);
  });
  it("does not say 'update' as an agent action against user.md", () => {
    expect(constTemplateBody("soul.ts")).not.toMatch(/update\s+it\s+when/i);
  });
  // rev 2026-08-11: /profile done 宿主斜杠命令已删（chat-session / app.tsx / hub），
  // soul 若再引用会让 agent 幻想它存在。
  it("does not reference the removed '/profile done' host slash command", () => {
    expect(constTemplateBody("soul.ts")).not.toContain("/profile done");
  });
  it("points to the bash channel (bwrap binds home read-write) for ~/.iknow updates", () => {
    const body = constTemplateBody("soul.ts");
    expect(body).toContain("bash");
    expect(body).toMatch(/bind-mounts? home/);
  });
  it("hints the bootstrap completion mechanism (BOOTSTRAP.md gone => implicit done)", () => {
    const body = constTemplateBody("soul.ts");
    expect(body).toContain("bootstrap");
    expect(body).toMatch(/bootstrap\.md/);
  });
});
