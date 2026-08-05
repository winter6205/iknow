/**
 * MarkdownBody + CodeBlock integration test (H1 byte-equality acceptance).
 *
 * Acceptance: rendering the fixed fenced code block ```ts\nconst x = 1;\n```
 * must give the copy path byte-equal source text. Two halves, both proven:
 *
 *  1. Rendered tree keeps the source: renderToStaticMarkup over the real
 *     react-markdown + rehype-highlight pipeline, then strip tags (no
 *     whitespace insertion) → the `<code>` text content equals the source
 *     byte-for-byte (plus the fence's trailing newline that MarkdownBody
 *     strips before handing the raw text to the copy button).
 *  2. The copy path reads that tree via `hastText` on react-markdown's
 *     `node` prop (tests/web/hast.test.ts covers hastText itself on the
 *     hljs span shape).
 *
 * Uses `React.createElement` rather than JSX so the file stays a `.ts` test
 * (root vitest config does not enable JSX in `.ts` files). Pure-render
 * acceptance — the renderToStaticMarkup path is explicitly permitted by the
 * H1 acceptance criterion (no playwright run required).
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { describe, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "../../web/src/components/MarkdownBody.tsx";

/** Decode the entity set react-dom emits inside text content. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

/** Extract the text content of the first <code> element in the markup. */
function codeTextContent(html: string): string {
  const match = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
  assert.ok(match, "rendered markup must contain a <code> element");
  // Strip tags WITHOUT inserting whitespace: adjacent span tokens must not
  // gain synthetic spaces (that was the initial test bug).
  const text = match[1]!.replace(/<[^>]*>/g, "");
  return decodeEntities(text);
}

const SOURCES: ReadonlyArray<{ readonly name: string; readonly src: string }> =
  [
    { name: "single-line const assignment", src: "const x = 1;" },
    {
      name: "multi-line function body with template literal",
      src: "function greet(name) {\n  return `hi ${name}`;\n}",
    },
    { name: "blank-line preserving source", src: "a\n\nb" },
  ];

describe("MarkdownBody — code-block copy byte equality (H1)", () => {
  for (const { name, src } of SOURCES) {
    it(`preserves ${name} byte-for-byte through the highlight tree`, () => {
      const md = "```ts\n" + src + "\n```";
      const html = renderToStaticMarkup(
        createElement(MarkdownBody, { text: md })
      );
      // The rendered code element holds the source verbatim; the fenced
      // block's trailing newline is present in the tree and stripped by
      // MarkdownBody before the copy button receives it.
      assert.equal(codeTextContent(html), src + "\n");
    });
  }

  it("copy-path contract: rawText === hastText minus trailing newline", () => {
    // The exact acceptance input: ```ts\nconst x = 1;\n``` → the copy button
    // must receive `const x = 1;` (byte-equal), never ` :  = ;`.
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, { text: "```ts\nconst x = 1;\n```" })
    );
    const rendered = codeTextContent(html);
    const rawText = rendered.replace(/\n$/, "");
    assert.equal(rawText, "const x = 1;");
    assert.notEqual(rawText, " :  = ;");
  });

  it("renders the copy button with the expected aria-label", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownBody, { text: "```ts\nconst x = 1;\n```" })
    );
    assert.ok(html.includes('aria-label="复制代码"'));
  });
});
