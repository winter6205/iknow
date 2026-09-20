/**
 * identity / soul segment assembly + the cognition-vs-personality boundary +
 * the "identity before soul" order + a file-level drift guard.
 */
import { describe, it, expect } from "vitest";
import { IKNOW_IDENTITY_DEFAULT } from "../../../src/harness/identity/identity.ts";
import { IKNOW_SOUL_DEFAULT } from "../../../src/harness/identity/soul.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("identity vs soul boundary (SSOT)", () => {
  // identity carries no core truths (cognition layer: Name/Kind/Signature only)
  it("identity does NOT contain 'core truths' (cognition layer is Name/Kind/Signature only)", () => {
    expect(IKNOW_IDENTITY_DEFAULT.toLowerCase()).not.toContain("core truths");
  });
  // soul carries no Name field
  it("soul does NOT contain 'name:' (personality layer is behavior only)", () => {
    expect(IKNOW_SOUL_DEFAULT.toLowerCase()).not.toMatch(/name\s*:/);
  });
  // identity carries no vibe
  it("identity does NOT contain 'vibe'", () => {
    expect(IKNOW_IDENTITY_DEFAULT.toLowerCase()).not.toContain("vibe");
  });
  // soul carries no signature
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

/** Extract only the **body** of the const template string in a source file:
 *  first strip the file-top JSDoc block, then match the first backtick
 *  template — so `specs/...` references inside top comments are not mistaken
 *  for template content. Comments may legitimately mention boundary words
 *  (e.g. soul.ts's header states it excludes Signature); that is not drift. */
function constTemplateBody(file: string): string {
  const raw = readFileSync(
    join(process.cwd(), "src/harness/identity", file),
    "utf8"
  );
  // strip the file-top JSDoc /** ... */ block (if present)
  const stripped = raw.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, "");
  const match = stripped.match(/`([\s\S]*?)`\.trim\(\)/);
  return (match?.[1] ?? "").toLowerCase();
}

describe("file-level boundary check (drift guard)", () => {
  // Check only the const template body (the SSOT content), not top comments —
  // soul.ts's header states it excludes Name / Kind / Signature to document
  // the boundary; that is legal documentation, not drift.
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

/**
 * Soul Continuity must NOT direct the agent to read/update `~/.iknow/user.md`
 * via tool calls — the workspace root isolates read_file/glob, and bash
 * hard-wall rejects compound commands, so any such instruction triggers a
 * cascade of `[失败]` ("failed") rows and the agent never answers the user. Continuity
 * must point at the host-managed profile instead.
 */
describe("soul Continuity: does not direct agent to read/update ~/.iknow", () => {
  it("does not say 'Read user.md. Update it'", () => {
    expect(constTemplateBody("soul.ts")).not.toMatch(/read\s+user\.md/i);
  });
  it("does not say 'update' as an agent action against user.md", () => {
    expect(constTemplateBody("soul.ts")).not.toMatch(/update\s+it\s+when/i);
  });
  // The "/profile done" host slash command was removed (chat-session /
  // app.tsx / hub); a soul reference would make the agent hallucinate it.
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
