/**
 * CLI slash skill-load — spec skill-index-increment T3（CLI 纳入与 TUI/Web
 * 同一 slash 入口）。此前 CLI 只有静态词表（`parseChatLine` → 未知命令
 * error），技能名一律落进 unknown 分支；本切片让 `/skill-name [remainder]`
 * 走可加载技能面并装配 skill-load 信封。
 *
 * 钉住的不变式：
 *   - 信封 byte 形态 = `buildSkillLoadText`（SSOT `src/harness/skill/body.ts`），
 *     与 TUI / hub 同源；
 *   - remainder 按 **typed token 长度**（裸名不被 canonical 长度吃掉）；
 *   - 静态词表优先（`/help` 永不落进 skill 分支）；
 *   - 未知名仍是未知命令（不误判 / 不静默）；
 *   - agents 不进 slash（CLI 侧无 agent 面，技能面即 catalog 面）。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillLoad, slashRemainder } from "../../src/cli/skill-load.ts";
import {
  buildSkillLoadText,
  createSkillBody,
} from "../../src/harness/skill/body.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createSkillScanner } from "../../src/harness/skill/scanner.ts";
import { processChatLine } from "../../src/cli/chat-session.ts";
import { makeCtx } from "./_fixtures.ts";
import { assistantResult } from "./_fixtures.ts";

const ENTRIES = [
  { name: "echo", description: "回声" },
  { name: "no-desc" },
  { name: "manual-only", description: "仅人侧" },
] as const;

describe("cli parseSkillLoad — 静态词表优先 / 可加载面 / remainder", () => {
  it("精确命中技能名 → name（remainder 按 typed token 长度）", () => {
    assert.deepEqual(parseSkillLoad("/echo 帮我做 X", ENTRIES), {
      name: "echo",
      remainder: "帮我做 X",
    });
  });

  it("静态词表优先：/help 不因技能同形而抢", () => {
    const withHelp = [...ENTRIES, { name: "help" }];
    assert.equal(parseSkillLoad("/help", withHelp), undefined);
  });

  it("无 description 条目仍在可加载面（SC5）", () => {
    assert.deepEqual(parseSkillLoad("/no-desc", ENTRIES), {
      name: "no-desc",
      remainder: "",
    });
  });

  it("未知名 → undefined（不误判为 skill-load）", () => {
    assert.equal(parseSkillLoad("/definitely-not-a-skill", ENTRIES), undefined);
  });

  it("裸名命中 canonical 时 remainder 不被 canonical 长度吃掉", () => {
    const plugin = [
      {
        name: "arthurpower:using-agent-skills",
        aliases: ["using-agent-skills"],
      },
    ];
    assert.deepEqual(parseSkillLoad("/using-agent-skills 帮我调度", plugin), {
      name: "arthurpower:using-agent-skills",
      remainder: "帮我调度",
    });
    assert.deepEqual(
      parseSkillLoad("/using-agent-skills 帮我调度", plugin),
      parseSkillLoad("/arthurpower:using-agent-skills 帮我调度", plugin)
    );
  });

  it("slashRemainder 是单一实现：首 token 之后 trim", () => {
    assert.equal(slashRemainder("/echo  a  b "), "a  b");
    assert.equal(slashRemainder("/echo"), "");
  });
});

describe("cli skill-load 端到端 — processChatLine 走信封装配", () => {
  it("静态词表未命中且技能命中 → 落盘 user 文本为 skill-load 信封（模型索引不参与的条目也能加载）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-cli-skill-load-"));
    try {
      const dir = join(root, "no-desc");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        "---\nname: no-desc\n---\n# 无描述技能\n\n正文行\n",
        "utf8"
      );
      const entries = await createSkillScanner({
        userHome: join(root, "home"),
        projectIdentityRoot: join(root, "project"),
        env: { IKNOW_SKILL_DIRS: root },
      }).scan();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.description, undefined);
      const catalog = createSkillCatalog(entries);
      const entry = catalog.get("no-desc")!;
      const expectedBody = await createSkillBody({ entry, dir: entry.dir });
      const expected = buildSkillLoadText("no-desc", expectedBody, "帮我做 X");

      const ctx = makeCtx({
        responses: [assistantResult({ texts: ["收到"] })],
      });
      ctx.skillCatalog = catalog;
      const result = await processChatLine({ line: "/no-desc 帮我做 X", ctx });
      assert.equal(result.quit, false);
      assert.equal(result.ranQuery, true);
      const userText = (
        ctx.state.messages[0]!.content[0] as { type: "text"; text: string }
      ).text;
      assert.equal(
        userText,
        expected,
        "CLI 信封必须与 buildSkillLoadText 逐字节相等（与 TUI/hub 同源）"
      );
      assert.ok(userText.includes("正文行"));
      assert.ok(userText.endsWith("帮我做 X"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("未知名仍是未知命令（不静默 / 不误判）", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["不应发生"] })],
    });
    const result = await processChatLine({ line: "/nope", ctx });
    assert.equal(result.quit, false);
    assert.equal(result.ranQuery, undefined);
    // 未知命令走 stderr（processSlash 的 error 分支），不是 output。
    assert.ok(
      (result.stderr ?? "").includes("Unknown command"),
      `未知名必须回未知命令，实际 stderr：${result.stderr}`
    );
    assert.equal(ctx.state.messages.length, 0, "未知名不得建档");
  });

  it("catalog 缺席（ask/tests）→ 行为与今日一致：技能名落未知命令", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["不应发生"] })],
    });
    const result = await processChatLine({ line: "/echo 帮我做 X", ctx });
    assert.equal(result.ranQuery, undefined);
    assert.ok(
      (result.stderr ?? "").includes("Unknown command"),
      `catalog 缺席时技能名必须落未知命令，实际 stderr：${result.stderr}`
    );
    assert.equal(ctx.state.messages.length, 0);
  });
});
