/**
 * tests/tui/composer-draft.test.ts
 *
 * Contract of the single TUI draft interface: folded-paste presentation,
 * attachment labels, whole-draft operations, and the submit projection. Buffer
 * text is the display truth; the draft table is the payload authority — a label
 * the table does not know is ordinary text, which is what keeps a typed
 * "[image#1]" from becoming an attachment.
 */
import { describe, expect, test } from "bun:test";

import {
  createComposerDraft,
  draftText,
  formatImageLabel,
  formatPasteLabel,
  measurePastedText,
  scanDraftLabels,
  skillImageContent,
  toUserContentBlocks,
  transcriptEchoText,
  type ComposerDraft,
  type DraftPayload,
} from "../../src/tui/composer-draft.ts";

describe("measurePastedText", () => {
  test("counts logical lines, not terminal wraps", () => {
    const oneLongLine = "x".repeat(4000);
    expect(measurePastedText(oneLongLine)).toEqual({ lines: 1, chars: 4000 });
  });

  test("counts every actual line break", () => {
    expect(measurePastedText("a\nb\nc\nd")).toEqual({ lines: 4, chars: 7 });
  });

  test("counts CR and CRLF as the same logical breaks a terminal paste delivers", () => {
    // Windows Terminal (and xterm) turn clipboard CRLF into CR before the
    // process reads it. A Unix paste is LF. Both are three lines of the same
    // text, and the draft's char count is the LF form it will store.
    expect(measurePastedText("alpha\rbeta\rgamma")).toEqual({
      lines: 3,
      chars: 16,
    });
    expect(measurePastedText("alpha\r\nbeta\r\ngamma")).toEqual({
      lines: 3,
      chars: 16,
    });
  });

  test("counts UTF-16 code units, matching the repo char measure", () => {
    // CJK: 2 code units per char here, and one logical line.
    expect(measurePastedText("中文\n英文")).toEqual({ lines: 2, chars: 5 });
    // An astral-plane emoji is a surrogate pair: 2 code units.
    expect(measurePastedText("😀")).toEqual({ lines: 1, chars: 2 });
  });

  test("empty payload is one line of zero chars", () => {
    expect(measurePastedText("")).toEqual({ lines: 1, chars: 0 });
  });
});

describe("label grammar", () => {
  test("paste label shape is byte-exact", () => {
    expect(formatPasteLabel(1, 12, 1480)).toBe(
      "[paste#1 · 12 lines · 1480 chars]"
    );
  });

  test("image label is the bare reference", () => {
    expect(formatImageLabel(1)).toBe("[image#1]");
  });

  test("scan finds both label families and reports their offsets", () => {
    const pasteLabel = formatPasteLabel(1, 2, 5);
    const imageLabel = formatImageLabel(2);
    const buffer = `pre ${pasteLabel} mid ${imageLabel} end`;
    const spans = scanDraftLabels(buffer);
    expect(spans.map((s) => s.label)).toEqual([pasteLabel, imageLabel]);
    expect(spans.map((s) => s.start)).toEqual([4, buffer.indexOf(imageLabel)]);
    expect(spans.map((s) => s.end)).toEqual([
      4 + pasteLabel.length,
      buffer.indexOf(imageLabel) + imageLabel.length,
    ]);
  });

  test("scan ignores bracket text that is not a draft label", () => {
    expect(
      scanDraftLabels("see [note] and [paste] and [paste#] and [image#x]")
    ).toEqual([]);
  });
});

describe("folded paste round trip", () => {
  test("folding registers the payload and hands back its label", () => {
    const draft = createComposerDraft();
    const folded = draft.foldPaste("alpha\nbeta\ngamma");
    expect(folded.label).toBe("[paste#1 · 3 lines · 16 chars]");
    expect(draft.text(folded.label)).toBe("alpha\nbeta\ngamma");
  });

  test("labels are never reused after a fold is dropped", () => {
    const draft = createComposerDraft();
    const first = draft.foldPaste("one\ntwo");
    const second = draft.foldPaste("one\ntwo");
    expect(first.label).not.toBe(second.label);
    expect(second.label).toBe("[paste#2 · 2 lines · 7 chars]");
  });

  test("unfolding puts the exact payload back at the label", () => {
    const draft = createComposerDraft();
    const folded = draft.foldPaste("alpha\nbeta");
    const buffer = `head ${folded.label} tail`;
    expect(draft.unfold(buffer, folded.label)).toBe("head alpha\nbeta tail");
  });

  test("an untouched expansion collapses back to the same buffer", () => {
    const draft = createComposerDraft();
    const folded = draft.foldPaste("alpha\nbeta");
    const buffer = `x ${folded.label} y`;
    const inline = draft.unfold(buffer, folded.label);
    expect(inline).toBe("x alpha\nbeta y");
    expect(draft.refold(inline, folded.label)).toBe(buffer);
  });

  test("an edited expansion stays expanded and submits its edited text", () => {
    const draft = createComposerDraft();
    const folded = draft.foldPaste("alpha\nbeta");
    const edited = draft
      .unfold(`x ${folded.label} y`, folded.label)
      .replace("beta", "BETA-EDITED\nEXTRA");
    // Guessing a span boundary would silently swallow the user's edit, so a
    // payload that no longer matches verbatim is simply not collapsible.
    expect(draft.refold(edited, folded.label)).toBe(edited);
    expect(draft.expand(edited)).toEqual([
      { type: "text", text: "x alpha\nBETA-EDITED\nEXTRA y" },
    ]);
  });
});

describe("submit projection", () => {
  test("known labels expand to their exact payload, in buffer order", () => {
    const draft = createComposerDraft();
    const a = draft.foldPaste("first\npaste");
    const b = draft.foldPaste("second\npaste");
    const segments = draft.expand(`lead ${a.label} mid ${b.label} tail`);
    expect(segments).toEqual([
      { type: "text", text: "lead " },
      { type: "text", text: "first\npaste" },
      { type: "text", text: " mid " },
      { type: "text", text: "second\npaste" },
      { type: "text", text: " tail" },
    ]);
  });

  test("a typed label with no payload stays literal text", () => {
    const draft = createComposerDraft();
    expect(draft.expand("just [paste#1 · 1 lines · 2 chars] typed")).toEqual([
      { type: "text", text: "just [paste#1 · 1 lines · 2 chars] typed" },
    ]);
  });

  test("a typed image label does not create an attachment", () => {
    const draft = createComposerDraft();
    expect(draft.expand("look [image#1] please")).toEqual([
      { type: "text", text: "look [image#1] please" },
    ]);
  });

  test("empty buffer projects to nothing to send", () => {
    expect(createComposerDraft().expand("")).toEqual([]);
  });
});

describe("transcriptEchoText", () => {
  test("expands paste labels and leaves an image label in place", () => {
    const draft = createComposerDraft();
    const paste = draft.foldPaste("alpha\nbeta");
    const image = draft.addImage({
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
    const buffer = `lead ${paste.label} ${image}`;
    const payloads = draft.takeSubmission(buffer);
    expect(transcriptEchoText(buffer, payloads)).toBe(
      "lead alpha\nbeta [image#1]"
    );
  });

  test("does not expand a label that only appears inside a paste payload", () => {
    const draft = createComposerDraft();
    const inner = draft.foldPaste("hidden\nbody");
    const outer = draft.foldPaste(`see ${inner.label} later`);
    const payloads: DraftPayload[] = [
      { label: outer.label, kind: "paste", text: `see ${inner.label} later` },
    ];
    expect(transcriptEchoText(outer.label, payloads)).toBe(
      `see ${inner.label} later`
    );
  });

  test("a buffer with no paste payload is unchanged", () => {
    expect(transcriptEchoText("plain [image#1]", [])).toBe("plain [image#1]");
  });
});

describe("skillImageContent", () => {
  test("no image payload stays on the text-only skill path", () => {
    const draft = createComposerDraft();
    const paste = draft.foldPaste("alpha\nbeta");
    const payloads = draft.takeSubmission(paste.label);
    expect(skillImageContent("envelope", payloads)).toBeUndefined();
  });

  test("keeps the envelope text and appends each image the model reads", () => {
    const draft = createComposerDraft();
    const image = draft.addImage({
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
    const payloads = draft.takeSubmission(image);
    expect(skillImageContent(`[skill-load]\n\n${image}`, payloads)).toEqual([
      { type: "text", text: `[skill-load]\n\n${image}` },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgo=",
        },
      },
    ]);
  });
});

describe("image attachments", () => {
  test("adding an image returns a label bound to the real bytes", () => {
    const draft = createComposerDraft();
    const label = draft.addImage({
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(label).toBe("[image#1]");
    expect(draft.image(label)).toEqual({
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
  });

  test("image labels keep their own sequence and never collide", () => {
    const draft = createComposerDraft();
    expect(draft.addImage({ mediaType: "image/png", data: "AAA=" })).toBe(
      "[image#1]"
    );
    draft.foldPaste("a\nb");
    expect(draft.addImage({ mediaType: "image/jpeg", data: "/9o=" })).toBe(
      "[image#2]"
    );
  });

  test("projection keeps gesture order across text and images", () => {
    const draft = createComposerDraft();
    const first = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    const paste = draft.foldPaste("body\ntext");
    const second = draft.addImage({ mediaType: "image/gif", data: "R0lGOD" });
    expect(
      draft.expand(`open ${first} ${paste.label} ${second} close`)
    ).toEqual([
      { type: "text", text: "open " },
      { type: "image", mediaType: "image/png", data: "AAA=" },
      { type: "text", text: " " },
      { type: "text", text: "body\ntext" },
      { type: "text", text: " " },
      { type: "image", mediaType: "image/gif", data: "R0lGOD" },
      { type: "text", text: " close" },
    ]);
  });

  test("a deleted image label stops resolving and becomes inert text", () => {
    const draft = createComposerDraft();
    const label = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    const buffer = `x ${label}`;
    expect(
      draft.deleteLabelUnit(buffer, buffer.length, "backward").removed
    ).toBe(true);
    expect(draft.image(label)).toBeUndefined();
    expect(draft.expand(`x ${label} y`)).toEqual([
      { type: "text", text: `x ${label} y` },
    ]);
  });
});

describe("deleting a folded unit as one unit", () => {
  test("a backspace just past the label removes the whole label", () => {
    const draft = createComposerDraft();
    const folded = draft.foldPaste("alpha\nbeta\ngamma");
    const buffer = `keep ${folded.label}`;
    const removed = draft.deleteLabelUnit(buffer, buffer.length, "backward");
    expect(removed.buffer).toBe("keep ");
    expect(removed.caret).toBe(5);
    expect(removed.removed).toBe(true);
    // Dropping the unit must not leave a hidden payload behind.
    expect(draft.text(folded.label)).toBeUndefined();
  });

  test("a delete just before the label removes the whole label", () => {
    const draft = createComposerDraft();
    const folded = draft.foldPaste("alpha\nbeta\ngamma");
    const buffer = `${folded.label} tail`;
    const removed = draft.deleteLabelUnit(buffer, 0, "forward");
    expect(removed.buffer).toBe(" tail");
    expect(removed.caret).toBe(0);
    expect(removed.removed).toBe(true);
  });

  test("a caret stranded inside a label still removes the whole unit", () => {
    const draft = createComposerDraft();
    const folded = draft.foldPaste("alpha\nbeta");
    const buffer = `a${folded.label}b`;
    const caret = 1 + Math.floor(folded.label.length / 2);
    expect(draft.deleteLabelUnit(buffer, caret, "backward").buffer).toBe("ab");
    expect(draft.text(folded.label)).toBeUndefined();
  });

  test("an adjacent run of two labels removes exactly one unit", () => {
    const draft = createComposerDraft();
    const a = draft.foldPaste("one\ntwo");
    const b = draft.foldPaste("three\nfour");
    const buffer = `${a.label}${b.label}`;
    const removed = draft.deleteLabelUnit(buffer, buffer.length, "backward");
    expect(removed.buffer).toBe(a.label);
    expect(draft.text(b.label)).toBeUndefined();
    expect(draft.text(a.label)).toBe("one\ntwo");
  });

  test("a typed lookalike is not a unit", () => {
    const draft = createComposerDraft();
    const buffer = "plain [paste#1 · 2 lines · 7 chars] text";
    const removed = draft.deleteLabelUnit(buffer, 11, "backward");
    expect(removed.removed).toBe(false);
  });

  test("an image label is one unit too", () => {
    const draft = createComposerDraft();
    const image = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    const buffer = `x${image}`;
    const removed = draft.deleteLabelUnit(buffer, buffer.length, "backward");
    expect(removed.buffer).toBe("x");
    expect(draft.image(image)).toBeUndefined();
  });
});

describe("whole-draft operations", () => {
  test("clear drops every payload and label index", () => {
    const draft = createComposerDraft();
    const folded = draft.foldPaste("a\nb");
    const image = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    draft.clear();
    expect(draft.text(folded.label)).toBeUndefined();
    expect(draft.image(image)).toBeUndefined();
    // The next label restarts numbering only if the draft is truly empty.
    expect(draft.foldPaste("c\nd").label).toBe("[paste#1 · 2 lines · 3 chars]");
    expect(draft.addImage({ mediaType: "image/png", data: "BBB=" })).toBe(
      "[image#1]"
    );
  });

  test("labelsIn reports only payloads the draft still holds", () => {
    const draft = createComposerDraft();
    const a = draft.foldPaste("a\nb");
    const image = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    const buffer = `${a.label}${image} [paste#9 · 1 lines · 1 chars]`;
    expect(draft.knownLabels(buffer).map((s) => s.label)).toEqual([
      a.label,
      image,
    ]);
  });
});

describe("submission payload transfer", () => {
  test("take moves every named payload out, in buffer order", () => {
    const draft = createComposerDraft();
    const paste = draft.foldPaste("body\ntext");
    const image = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    const buffer = `a${paste.label} b${image}`;
    expect(draft.takeSubmission(buffer)).toEqual([
      { label: paste.label, kind: "paste", text: "body\ntext" },
      {
        label: image,
        kind: "image",
        image: { mediaType: "image/png", data: "AAA=" },
      },
    ]);
    expect(draft.heldPayloadCount()).toBe(0);
    // Authority gone: the very same buffer is now literal text.
    expect(draft.expand(buffer)).toEqual([{ type: "text", text: buffer }]);
  });

  test("adopt puts the exact labels back, so the same buffer expands again", () => {
    const draft = createComposerDraft();
    const image = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    const paste = draft.foldPaste("body\ntext");
    const buffer = `open ${image} ${paste.label} close`;
    const expanded = draft.expand(buffer);
    const taken = draft.takeSubmission(buffer);
    expect(draft.expand(buffer)).toEqual([
      {
        type: "text",
        text: "open [image#1] [paste#1 · 2 lines · 9 chars] close",
      },
    ]);
    draft.adoptSubmission(taken);
    expect(draft.expand(buffer)).toEqual(expanded);
    expect(draft.heldPayloadCount()).toBe(2);
  });

  test("a taken label is never handed to a later fold, and the counters stay advanced", () => {
    const draft = createComposerDraft();
    const first = draft.foldPaste("one\ntwo");
    const firstImage = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    draft.takeSubmission(`${first.label}${firstImage}`);
    // A whole-draft clear restarts numbering; a submission does not.
    expect(draft.foldPaste("three\nfour").label).toBe(
      "[paste#2 · 2 lines · 10 chars]"
    );
    expect(draft.addImage({ mediaType: "image/png", data: "BBB=" })).toBe(
      "[image#2]"
    );
  });

  test("a label the buffer mentions twice is taken once", () => {
    const draft = createComposerDraft();
    const paste = draft.foldPaste("a\nb");
    const taken = draft.takeSubmission(`${paste.label} & ${paste.label}`);
    expect(taken).toEqual([
      { label: paste.label, kind: "paste", text: "a\nb" },
    ]);
  });

  test("an unknown label in the buffer takes nothing", () => {
    const draft = createComposerDraft();
    draft.foldPaste("a\nb");
    expect(draft.takeSubmission("typed [paste#9 · 1 lines · 1 chars]")).toEqual(
      []
    );
    expect(draft.heldPayloadCount()).toBe(1);
  });

  test("heldPayloadCount counts paste payloads and images together", () => {
    const draft = createComposerDraft();
    expect(draft.heldPayloadCount()).toBe(0);
    draft.foldPaste("a\nb");
    expect(draft.heldPayloadCount()).toBe(1);
    draft.addImage({ mediaType: "image/png", data: "AAA=" });
    expect(draft.heldPayloadCount()).toBe(2);
    draft.clear();
    expect(draft.heldPayloadCount()).toBe(0);
  });
});

describe("payload-discarded observer", () => {
  function observedDraft(): {
    readonly draft: ComposerDraft;
    readonly events: string[];
  } {
    const events: string[] = [];
    return {
      draft: createComposerDraft({
        onPayloadsDiscarded: () => events.push("discarded"),
      }),
      events,
    };
  }

  test("a whole-draft clear and a removed unit both report the loss", () => {
    const { draft, events } = observedDraft();
    draft.foldPaste("a\nb");
    draft.clear();
    expect(events).toEqual(["discarded"]);
    const label = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    draft.deleteLabelUnit(label, label.length, "backward");
    expect(events).toEqual(["discarded", "discarded"]);
  });

  test("a submission reports only when it actually took something", () => {
    const { draft, events } = observedDraft();
    const folded = draft.foldPaste("a\nb");
    draft.takeSubmission("no known label here");
    expect(events).toEqual([]);
    draft.takeSubmission(folded.label);
    expect(events).toEqual(["discarded"]);
  });

  test("a lookalike deletion removes no unit and says nothing", () => {
    const { draft, events } = observedDraft();
    draft.foldPaste("a\nb");
    const buffer = "plain [paste#9 · 2 lines · 3 chars] text";
    expect(draft.deleteLabelUnit(buffer, 11, "backward").removed).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("transport projection", () => {
  test("blocks carry gesture order and merge adjacent text", () => {
    const draft = createComposerDraft();
    const image = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    const paste = draft.foldPaste("body\ntext");
    const blocks = toUserContentBlocks(
      draft.expand(`open ${image} ${paste.label} close`)
    );
    expect(blocks).toEqual([
      { type: "text", text: "open " },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAA=" },
      },
      { type: "text", text: " body\ntext close" },
    ]);
  });

  test("a buffer of only pasted text projects to one text block", () => {
    const draft = createComposerDraft();
    const a = draft.foldPaste("first\npaste");
    const b = draft.foldPaste("second\npaste");
    expect(
      toUserContentBlocks(draft.expand(`${a.label} mid ${b.label}`))
    ).toEqual([{ type: "text", text: "first\npaste mid second\npaste" }]);
  });

  test("a typed image label projects to text, never to a block", () => {
    expect(
      toUserContentBlocks(createComposerDraft().expand("look [image#1]"))
    ).toEqual([{ type: "text", text: "look [image#1]" }]);
  });

  test("draftText reads the text blocks only, so the text field can stay a string", () => {
    const draft = createComposerDraft();
    const image = draft.addImage({ mediaType: "image/png", data: "AAA=" });
    const paste = draft.foldPaste("body");
    const blocks = toUserContentBlocks(
      draft.expand(`a${image}${paste.label}b`)
    );
    expect(draftText(blocks)).toBe("abodyb");
  });

  test("an image-only buffer projects to one image block and empty text", () => {
    const draft = createComposerDraft();
    const image = draft.addImage({ mediaType: "image/jpeg", data: "/9o=" });
    const blocks = toUserContentBlocks(draft.expand(image));
    expect(blocks).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "/9o=" },
      },
    ]);
    expect(draftText(blocks)).toBe("");
  });
});
