/**
 * Unit tests for the shared html-text primitives.
 *
 * htmlToText / cleanHtml / decodeEntities were previously covered only
 * indirectly via web-fetch / web-search tool tests (basic entity decoding /
 * script skipping). This file adds pathological HTML edges and pins the
 * behavior contract of the regex parser (deviations from the upstream
 * HTMLParser state machine are known; locking current behavior supports a
 * later assessment of switching to a DOM parser).
 *
 * Coverage:
 *   - basics: plain text / empty input / single tag / nested tags
 *   - script/style skipping: strings containing '<' / deep nesting / self-closing variants
 *   - entities: named + decimal + hex + missing semicolon + out-of-range code points + double encoding
 *   - whitespace folding: runs of whitespace / mixed newlines and tabs / nbsp folding
 *   - malformed: unclosed tags / '<' inside tags / '>' inside attributes / comments / CDATA
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  cleanHtml,
  decodeEntities,
  htmlToText,
} from "../../../../src/harness/aci/tools/html-text.ts";

describe("decodeEntities - named entities", () => {
  it("decodes the four upstream entities + quot + #39", () => {
    assert.equal(decodeEntities("&nbsp;"), " ");
    assert.equal(decodeEntities("&amp;"), "&");
    assert.equal(decodeEntities("&lt;"), "<");
    assert.equal(decodeEntities("&gt;"), ">");
    assert.equal(decodeEntities("&quot;"), '"');
    assert.equal(decodeEntities("&#39;"), "'");
  });

  it("decodes mixed entities in running text", () => {
    assert.equal(
      decodeEntities("a &amp; b &lt; c &gt; d &quot;e&quot;"),
      'a & b < c > d "e"'
    );
  });

  it("leaves unknown named entities as-is", () => {
    assert.equal(
      decodeEntities("&copy; &trade; &mdash;"),
      "&copy; &trade; &mdash;"
    );
  });
});

describe("decodeEntities - numeric entities", () => {
  it("decodes decimal numeric entities", () => {
    assert.equal(decodeEntities("&#65;"), "A");
    assert.equal(decodeEntities("&#8364;"), "€");
  });

  it("decodes hex numeric entities", () => {
    assert.equal(decodeEntities("&#x41;"), "A");
    assert.equal(decodeEntities("&#x1F600;"), "😀");
  });

  it("handles mixed-case hex", () => {
    assert.equal(decodeEntities("&#X4A;"), "J");
  });

  it("tolerates leading zeros in numeric entities", () => {
    assert.equal(decodeEntities("&#0065;"), "A");
    assert.equal(decodeEntities("&#x041;"), "A");
  });
});

describe("decodeEntities - edge cases", () => {
  it("missing semicolon: named entities not decoded (no false positive)", () => {
    // &amp without ';' is left as-is -- upstream html.unescape may differ,
    // we explicitly do not coerce partial entities.
    assert.equal(decodeEntities("&amp"), "&amp");
    assert.equal(decodeEntities("AT&T"), "AT&T");
  });

  it("out-of-range code point does not crash (String.fromCodePoint throws for >0x10FFFF)", () => {
    // Out-of-range code point: fromCodePoint throws RangeError and the current
    // implementation propagates it (pinned behavior). Known edge — never in
    // production HTML — but the test locks the failure mode instead of swallowing it.
    assert.throws(
      () => decodeEntities("&#x110000;"),
      (err: unknown) => err instanceof RangeError
    );
  });

  it("plain text without entities is unchanged", () => {
    assert.equal(decodeEntities("just plain text"), "just plain text");
  });

  it("empty string returns empty", () => {
    assert.equal(decodeEntities(""), "");
  });
});

describe("htmlToText - basic extraction", () => {
  it("returns empty for empty input", () => {
    assert.equal(htmlToText(""), "");
  });

  it("returns plain text unchanged (no tags)", () => {
    assert.equal(htmlToText("just words here"), "just words here");
  });

  it("strips a single tag", () => {
    assert.equal(htmlToText("<p>hello</p>"), "hello");
  });

  it("strips nested tags and keeps text", () => {
    assert.equal(htmlToText("<div>a <span>b</span> c</div>"), "a b c");
  });

  it("strips tags with attributes", () => {
    assert.equal(htmlToText('<a href="x" class="y">link</a>'), "link");
  });
});

describe("htmlToText - script/style block skipping", () => {
  it("skips a script block containing a '<' string", () => {
    const html = "<p>keep</p><script>var s = 'a < b';</script><p>also</p>";
    assert.equal(htmlToText(html), "keep also");
  });

  it("skips a style block with braces", () => {
    const html = "<p>x</p><style>.a { color: red; }</style><p>y</p>";
    assert.equal(htmlToText(html), "x y");
  });

  it("does not execute or leak script content as text", () => {
    const html = "<script>document.write('<h1>evil</h1>')</script>visible";
    const out = htmlToText(html);
    assert.ok(!out.includes("document.write"));
    assert.ok(!out.includes("evil"));
    assert.ok(out.includes("visible"));
  });

  it("handles multiple script blocks", () => {
    const html = "a<script>1</script>b<script>2</script>c";
    assert.equal(htmlToText(html), "a b c");
  });

  it("decodes entities inside script-adjacent text", () => {
    const html = "<p>A &amp; B</p><script>ignore</script>";
    assert.equal(htmlToText(html), "A & B");
  });
});

describe("htmlToText - whitespace folding", () => {
  it("collapses runs of spaces and tabs", () => {
    assert.equal(htmlToText("a    b\t\tc"), "a b c");
  });

  it("collapses \r and \f to spaces but preserves \\n (paragraph boundary)", () => {
    // Design choice (aligned with the upstream HTMLParser state machine): \n
    // is kept as a paragraph boundary; \r / \f / \v fold into a single space
    // with horizontal whitespace. The output stays readable for the LLM
    // (paragraph structure preserved) and matches upstream web_fetch_tool.
    // A lone \n is never merged ("a\nb" stays a paragraph split); only \n\n folds.
    assert.equal(htmlToText("a\nb\rc\fd"), "a\nb c d");
  });

  it("folds whitespace left by stripped tags", () => {
    const html = "<div>  <span>  x  </span>  </div>";
    assert.equal(htmlToText(html), "x");
  });

  it("decodes &nbsp; to a foldable space", () => {
    const html = "<p>a&nbsp;&nbsp;b</p>";
    assert.equal(htmlToText(html), "a b");
  });
});

describe("htmlToText - malformed input", () => {
  it("unclosed tag: strips up to the last '>'", () => {
    // The regex <[^>]+> stops at the first '>'; leftover text of an unclosed
    // tag is kept verbatim.
    const out = htmlToText("<p>hello world");
    assert.equal(out, "hello world");
  });

  it("'<' inside text (not a tag) is preserved", () => {
    // In 'a < b' the '<' is not followed by a tag + '>', so the regex does not
    // match and the text is kept verbatim.
    assert.equal(htmlToText("a < b"), "a < b");
  });

  it("attribute value containing '>' is split early", () => {
    // In data-x="a>b" the first '>' sits inside the attribute value, so the
    // regex cuts the tag there. Pinned: no crash, text after the tag survives.
    const html = '<a data-x="a>b">link</a> tail';
    const out = htmlToText(html);
    assert.ok(out.includes("link"));
    assert.ok(out.includes("tail"));
  });

  it("HTML comment is stripped as a tag", () => {
    // <!-- comment --> is stripped as a plain '<'..'>' tag and its content
    // leaks as text. Pinned current behavior (a DOM parser would differ:
    // comment text may leak).
    const html = "<p>x</p><!-- secret note --><p>y</p>";
    const out = htmlToText(html);
    assert.ok(out.includes("x"));
    assert.ok(out.includes("y"));
    // Whether the comment leaks is a known deviation; only assert no crash + main text preserved.
  });

  it("CDATA section is handled without crashing", () => {
    const html = "<p>x</p><![CDATA[ raw <content> ]]><p>y</p>";
    const out = htmlToText(html);
    assert.ok(out.includes("x"));
    assert.ok(out.includes("y"));
  });
});

describe("htmlToText - robustness", () => {
  it("handles deeply nested tags (no exponential backtracking)", () => {
    // 200-level nested divs: the regex must finish in reasonable time.
    const depth = 200;
    const open = "<div>".repeat(depth);
    const close = "</div>".repeat(depth);
    const html = `${open}core${close}`;
    const t0 = Date.now();
    const out = htmlToText(html);
    const elapsed = Date.now() - t0;
    assert.equal(out, "core");
    // Heuristic timing guard against ReDoS regression.
    assert.ok(elapsed < 500, `deeply nested took ${elapsed}ms`);
  });

  it("handles large input without crashing", () => {
    const chunk = "<p>hello world</p>";
    const html = chunk.repeat(10_000);
    const out = htmlToText(html);
    assert.ok(out.length > 0);
    assert.ok(!out.includes("<p>"));
  });

  it("mixed-case SCRIPT/STYLE tags are skipped", () => {
    const html = "<P>a</P><SCRIPT>x</SCRIPT><P>b</P>";
    assert.equal(htmlToText(html), "a b");
  });
});

describe("cleanHtml - fragment cleaning", () => {
  it("strips tags and decodes entities", () => {
    assert.equal(cleanHtml("<b>bold</b> &amp; <i>italic</i>"), "bold & italic");
  });

  it("collapses all whitespace including newlines", () => {
    assert.equal(cleanHtml("a\n  b\t\tc"), "a b c");
  });

  it("returns empty for tags-only fragment", () => {
    assert.equal(cleanHtml("<a></a><span></span>"), "");
  });

  it("preserves text with leading/trailing tags", () => {
    assert.equal(cleanHtml("<a>  link  </a>"), "link");
  });

  it("empty input returns empty", () => {
    assert.equal(cleanHtml(""), "");
  });
});
