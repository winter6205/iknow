/**
 * tests/tui/skill-load-projection.test.ts
 *
 * skill-load chip projection.
 *
 * The render layer (message-blocks user branch) and the echo's displayText reuse the same
 * pure function `projectSkillLoadUserText` to extract `{name, remainder}` from user message
 * text. The render layer consumes only these two fields; the body (SKILL body) never enters the ❯ bubble.
 *
 * Accepted shape (matches `buildSkillLoadText` assembly):
 *   `[skill-load name="<name>"]\n<body>[ + \n\n<remainder>]`
 *
 * Rejected shapes (return null → fall back to plain user-text rendering):
 *   - does not start with `[skill-load ` at all;
 *   - no closing `"` after `[skill-load name="` (short prefix hits but name unclosed);
 *   - no `\n` after `]` (not buildSkillLoadText shape).
 *
 * Boundaries:
 *   - huge body (huge SKILL.md): lastIndexOf `\n\n` still locates the single separator
 *     buildSkillLoadText adds (by convention `createSkillBody` ends with `</skill_files>`
 *     without trailing `\n\n`, so the body itself never collides with the separator);
 *   - remainder non-empty → `{name, remainder}`;
 *   - remainder empty → `{name, ""}` (chip-only path);
 *   - body containing internal `\n\n` segments → still the last `\n\n` separates the remainder.
 */
import { describe, expect, test } from "bun:test";
import { projectSkillLoadUserText } from "../../src/tui/session-state.js";
import { buildSkillLoadText } from "../../src/harness/skill/body.js";
import {
  MEMORY_ADVISORY_PREFIX,
  MEMORY_PREFETCH_DISCIPLINE,
  MEMORY_PREFETCH_END,
} from "../../src/harness/memory/prefetch.js";

describe("projectSkillLoadUserText: 闭合形态命中", () => {
  test("[skill-load name=...] 仅 body，无 remainder → chip-only", () => {
    expect(projectSkillLoadUserText('[skill-load name="echo"]\nbody')).toEqual({
      name: "echo",
      remainder: "",
    });
  });

  test("[skill-load name=...] + body + remainder → 抽出 name + remainder", () => {
    expect(
      projectSkillLoadUserText(
        '[skill-load name="echo"]\nbody line\n\n帮我做 X'
      )
    ).toEqual({ name: "echo", remainder: "帮我做 X" });
  });

  test("body 含多段（\\n\\n 内部），最后 \\n\\n 才是 separator", () => {
    expect(
      projectSkillLoadUserText(
        '[skill-load name="x"]\nseg1\n\nseg2\n\nseg3\n\n帮我做 X'
      )
    ).toEqual({ name: "x", remainder: "帮我做 X" });
  });

  test("buildSkillLoadText 装配形态（巨大 body + remainder）→ 正确抽出", () => {
    const huge = "x".repeat(10_000);
    const text = buildSkillLoadText("echo", huge, "帮我做 X");
    expect(projectSkillLoadUserText(text)).toEqual({
      name: "echo",
      remainder: "帮我做 X",
    });
  });

  test("buildSkillLoadText 装配形态（巨大 body，无 remainder）→ chip-only", () => {
    const huge = "x".repeat(10_000);
    const text = buildSkillLoadText("echo", huge);
    expect(projectSkillLoadUserText(text)).toEqual({
      name: "echo",
      remainder: "",
    });
  });

  test("buildSkillLoadText 空 body + remainder → 抽出 remainder", () => {
    const text = buildSkillLoadText("echo", "", "帮我做 X");
    expect(projectSkillLoadUserText(text)).toEqual({
      name: "echo",
      remainder: "帮我做 X",
    });
  });

  test("buildSkillLoadText 空 body + 空 remainder → chip-only", () => {
    const text = buildSkillLoadText("echo", "");
    expect(projectSkillLoadUserText(text)).toEqual({
      name: "echo",
      remainder: "",
    });
  });

  // bug repro: session-api persists the user turn as
  // attachPrefetchOverlay(overlay + MEMORY_PREFETCH_END + envelope);
  // disk text with a memory advisory prefix must still hit the chip, otherwise projection
  // fails after reload → the whole 78KB body floods the render (only Ctrl+C forced reflow "snaps it back").
  test("memory prefetch overlay 前缀 + envelope → 剥离 overlay 后命中 chip", () => {
    const envelope = buildSkillLoadText("echo", "body text", "帮我做 X");
    const overlay = `${MEMORY_ADVISORY_PREFIX}\n\n${MEMORY_PREFETCH_DISCIPLINE}\n\n### 过去的工作\nid: m1\n\n一些正文`;
    const diskText = `${overlay}${MEMORY_PREFETCH_END}${envelope}`;
    expect(projectSkillLoadUserText(diskText)).toEqual({
      name: "echo",
      remainder: "帮我做 X",
    });
  });

  test("memory prefetch overlay 前缀 + chip-only envelope → chip-only", () => {
    const envelope = buildSkillLoadText("echo", "body text");
    const overlay = `${MEMORY_ADVISORY_PREFIX}\n\n${MEMORY_PREFETCH_DISCIPLINE}`;
    const diskText = `${overlay}${MEMORY_PREFETCH_END}${envelope}`;
    expect(projectSkillLoadUserText(diskText)).toEqual({
      name: "echo",
      remainder: "",
    });
  });

  test("name 含连字符 / 大小写混合 → 原样保留", () => {
    expect(
      projectSkillLoadUserText(
        '[skill-load name="code-review"]\nbody\n\n帮我审 diff'
      )
    ).toEqual({ name: "code-review", remainder: "帮我审 diff" });
    expect(
      projectSkillLoadUserText('[skill-load name="CodeReview"]\nbody')
    ).toEqual({ name: "CodeReview", remainder: "" });
  });
});

describe("projectSkillLoadUserText: 拒绝形态（不 throw，按普通文本）", () => {
  test("完全不以 [skill-load 开头 → null", () => {
    expect(projectSkillLoadUserText("你好 iknow")).toBeNull();
    expect(projectSkillLoadUserText("")).toBeNull();
    expect(projectSkillLoadUserText("[]\n...")).toBeNull();
  });

  test("[skill-load 短前缀命中但 name 没闭合 → null", () => {
    // malformed `[skill-load` with unclosed name → no throw, treated as plain user text
    expect(projectSkillLoadUserText("[skill-load name=echo]\nbody")).toBeNull();
    expect(projectSkillLoadUserText("[skill-load name=]")).toBeNull();
    // no `"` anywhere in the segment:
    expect(projectSkillLoadUserText("[skill-load name=echo]\nbody")).toBeNull();
  });

  test("[skill-load 单独短前缀（无 name=...）→ null", () => {
    expect(projectSkillLoadUserText("[skill-load something]")).toBeNull();
  });

  test("[skill-load name=...] 但 ] 后没有 \\n → null（不是 buildSkillLoadText 形态）", () => {
    // shape manually broken: newline missing.
    expect(projectSkillLoadUserText('[skill-load name="echo"]body')).toBeNull();
  });

  test("trim 后不再以 [skill-load 开头 → null", () => {
    expect(
      projectSkillLoadUserText(' [skill-load name="echo"]\nbody')
    ).toBeNull();
  });
});
