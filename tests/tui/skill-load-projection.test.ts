/**
 * tests/tui/skill-load-projection.test.ts
 *
 * plans/tui-chrome-interaction.md Task 5：skill-load chip 投影。
 *
 * 给渲染层（message-blocks user 分支）+ 给 echo 的 displayText 复用同一组纯函数
 * `projectSkillLoadUserText`，从 user message 文本中抽出 `{name, remainder}`。
 * 渲染层只消费这两个字段，正文（SKILL body）永不进 ❯ 气泡。
 *
 * 接受形态（与 `buildSkillLoadText` 装配一致）：
 *   `[skill-load name="<name>"]\n<body>[ + \n\n<remainder>]`
 *
 * 拒绝形态（返回 null → 落回普通 user 文本渲染）：
 *   - 完全不以 `[skill-load ` 开头；
 *   - `[skill-load name="` 之后没有闭合的 `"`（短前缀命中但 name 没闭合）；
 *   - `]` 之后没有 `\n`（不是 buildSkillLoadText 形态）。
 *
 * 边界：
 *   - body 巨大（huge SKILL.md）：lastIndexOf `\n\n` 仍能定位 buildSkillLoadText
 *     唯一添加的分隔符（约定 `createSkillBody` 末尾是 `</skill_files>` 不带
 *     末尾 `\n\n`，所以 body 自身不会撞上分隔符）；
 *   - remainder 非空 → `{name, remainder}`；
 *   - remainder 空 → `{name, ""}`（chip-only 路径）；
 *   - body 含 `\n\n` 内部段 → 仍是最后一个 `\n\n` 分隔 remainder。
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

  // Bug 复现（2026-09-07）：session-api 落盘的 user turn 是
  // attachPrefetchOverlay(overlay + MEMORY_PREFETCH_END + envelope)，
  // 带 memory advisory 前缀的磁盘文本必须仍命中 chip，否则 reload 后
  // 投影失败 → 78KB body 全文溢出渲染（Ctrl+C 强制重排才「弹回」）。
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
    // # AC: malformed `[skill-load` 没闭合 name → 不 throw, 按普通用户文本
    expect(projectSkillLoadUserText("[skill-load name=echo]\nbody")).toBeNull();
    expect(projectSkillLoadUserText("[skill-load name=]")).toBeNull();
    // 整段没有 `"`:
    expect(projectSkillLoadUserText("[skill-load name=echo]\nbody")).toBeNull();
  });

  test("[skill-load 单独短前缀（无 name=...）→ null", () => {
    expect(projectSkillLoadUserText("[skill-load something]")).toBeNull();
  });

  test("[skill-load name=...] 但 ] 后没有 \\n → null（不是 buildSkillLoadText 形态）", () => {
    // 形态被人工破坏：缺 newline。
    expect(projectSkillLoadUserText('[skill-load name="echo"]body')).toBeNull();
  });

  test("trim 后不再以 [skill-load 开头 → null", () => {
    expect(
      projectSkillLoadUserText(' [skill-load name="echo"]\nbody')
    ).toBeNull();
  });
});
