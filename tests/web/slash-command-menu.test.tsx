/**
 * tests/web/slash-command-menu.test.tsx
 *
 * SlashCommandMenu rendering asserts: candidate hint + description,
 * aria-selected on the selected item, empty candidates render nothing,
 * out-of-range selectedIndex is clamped.
 * renderToStaticMarkup follows the existing tests/web convention.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SlashCommandMenu } from "../../web/src/components/SlashCommandMenu.tsx";
import { SLASH_COMMANDS, slashCandidates } from "../../web/src/lib/slash.ts";
import type { SlashCandidate } from "../../web/src/lib/slash.ts";

function render(
  selectedIndex: number,
  candidates: ReadonlyArray<SlashCandidate> = slashCandidates("/")
): string {
  return renderToStaticMarkup(
    <SlashCommandMenu
      candidates={candidates}
      selectedIndex={selectedIndex}
      onPick={() => {}}
    />
  );
}

describe("SlashCommandMenu — 候选渲染", () => {
  it("全部候选的 hint 与说明均在场", () => {
    const html = render(0);
    for (const c of SLASH_COMMANDS) {
      assert.ok(html.includes(c.hint), `must include hint ${c.hint}`);
      assert.ok(
        html.includes(c.description),
        `must include description ${c.description}`
      );
    }
    assert.ok(html.includes('role="listbox"'));
    assert.ok(html.includes('role="option"'));
  });

  it("选中项 aria-selected=true，其余 false", () => {
    const html = render(1, slashCandidates("/").slice(0, 3));
    assert.equal(
      (html.match(/aria-selected="true"/g) ?? []).length,
      1,
      "exactly one option selected"
    );
    assert.equal((html.match(/aria-selected="false"/g) ?? []).length, 2);
    // The highlight class lands on the second item (the full bg-accent-soft form appears only on the selected one).
    const secondIdx = html.indexOf("/new");
    const before = html.slice(0, secondIdx);
    assert.ok(before.includes('bg-accent-soft"'));
  });

  it("selectedIndex 越界 → 钳制到边界（不崩溃）", () => {
    const over = render(99, SLASH_COMMANDS);
    assert.equal((over.match(/aria-selected="true"/g) ?? []).length, 1);
    const under = render(-5, SLASH_COMMANDS);
    assert.equal((under.match(/aria-selected="true"/g) ?? []).length, 1);
  });

  it("空候选 → 不渲染", () => {
    const html = render(0, []);
    assert.equal(html, "");
  });
});
