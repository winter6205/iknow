/**
 * src/tui/composer-draft.ts
 *
 * Draft model behind the composer's folded units: a multiline paste collapses to
 * `[paste#N · L lines · C chars]` and a clipboard image to `[image#N]`, so the
 * buffer stays readable while the real payload waits in this table.
 *
 * Two sources of truth with a strict division: the buffer is *display* truth
 * (what the user sees, edits and submits around), the table is *payload*
 * authority. A label the table does not know is ordinary text — that is what
 * keeps a hand-typed "[image#1]" from becoming an attachment, and what makes
 * `refold` refuse to guess the span of edited inline text rather than silently
 * swallowing the edit.
 */

import { IMAGE_MEDIA_TYPES } from "../harness/aci/tools/image-format.js";
import type { UserContentBlock } from "../session-api/contract.js";

/** Byte-exact label grammar: one alternation, so `scanDraftLabels` and the
 *  formatters can never drift apart. `·` is U+00B7. */
const LABEL_SOURCE =
  "\\[(?:paste#\\d+ · \\d+ lines · \\d+ chars|image#\\d+)\\]";

export interface LabelSpan {
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

export interface DraftImage {
  readonly mediaType: (typeof IMAGE_MEDIA_TYPES)[number];
  readonly data: string;
}

export type DraftSegment =
  | { readonly type: "text"; readonly text: string }
  | ({ readonly type: "image" } & DraftImage);

export interface DeleteUnitResult {
  readonly buffer: string;
  readonly caret: number;
  readonly removed: boolean;
}

/** One payload the draft held under a label, in the form that lets it be put
 *  back under that exact label. */
export type DraftPayload =
  | { readonly label: string; readonly kind: "paste"; readonly text: string }
  | {
      readonly label: string;
      readonly kind: "image";
      readonly image: DraftImage;
    };

/** Called whenever payload authority is destroyed, so a holder that tracked the
 *  draft's lifetime (an in-flight clipboard read targeting it) can give up. */
export interface ComposerDraftObserver {
  readonly onPayloadsDiscarded: () => void;
}

/**
 * A terminal paste does not arrive as LF. Windows Terminal and xterm turn a
 * clipboard CRLF into CR before the process reads it; a Unix paste is LF.
 * Both are one logical break. The draft stores LF, which is what expand,
 * submit, and the composer's `\n` checks already assume.
 */
export function normalizePastedNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** True when the paste carries a line break in either encoding. A long single
 *  line does not: folding follows breaks, not terminal wraps. */
export function pasteHasLineBreak(text: string): boolean {
  return text.includes("\n") || text.includes("\r");
}

/**
 * Count semantics: `lines` counts logical breaks after CR/CRLF are normalized
 * to LF, not terminal wraps; `chars` counts UTF-16 code units of that
 * normalized payload, including the breaks — the same measure the
 * message-length cap uses.
 */
export function measurePastedText(text: string): {
  readonly lines: number;
  readonly chars: number;
} {
  const normalized = normalizePastedNewlines(text);
  return { lines: normalized.split("\n").length, chars: normalized.length };
}

export function formatPasteLabel(
  index: number,
  lines: number,
  chars: number
): string {
  return `[paste#${index} · ${lines} lines · ${chars} chars]`;
}

export function formatImageLabel(index: number): string {
  return `[image#${index}]`;
}

/**
 * Offsets of every label *shaped* string in the buffer, in buffer order.
 * Says nothing about whether the draft holds a payload for it.
 */
export function scanDraftLabels(buffer: string): LabelSpan[] {
  const spans: LabelSpan[] = [];
  for (const match of buffer.matchAll(new RegExp(LABEL_SOURCE, "g"))) {
    const label = match[0];
    const start = match.index ?? 0;
    spans.push({ label, start, end: start + label.length });
  }
  return spans;
}

function pushText(segments: DraftSegment[], text: string): void {
  if (text.length > 0) segments.push({ type: "text", text });
}

export interface ComposerDraft {
  foldPaste(payload: string): { readonly label: string };
  addImage(image: DraftImage): string;
  text(label: string): string | undefined;
  image(label: string): DraftImage | undefined;
  knownLabels(buffer: string): LabelSpan[];
  expand(buffer: string): DraftSegment[];
  unfold(buffer: string, label: string): string;
  refold(buffer: string, label: string): string;
  deleteLabelUnit(
    buffer: string,
    caret: number,
    direction: "backward" | "forward"
  ): DeleteUnitResult;
  /** Move out every payload `buffer`'s known labels resolve to, in buffer
   *  order and deduped by label. The counters stay advanced on purpose: a label
   *  a submission took is never handed to a later paste. */
  takeSubmission(buffer: string): DraftPayload[];
  /** Reinstall taken payloads under their exact labels. Only valid on a draft
   *  that holds none of them — the caller gates on `heldPayloadCount` — since
   *  re-folding would renumber the label away from the saved buffer text. */
  adoptSubmission(payloads: ReadonlyArray<DraftPayload>): void;
  heldPayloadCount(): number;
  clear(): void;
}

export function createComposerDraft(
  observer?: ComposerDraftObserver
): ComposerDraft {
  const payloads = new Map<string, string>();
  const images = new Map<string, DraftImage>();
  let pasteIndex = 0;
  let imageIndex = 0;

  const heldSpans = (buffer: string): LabelSpan[] =>
    scanDraftLabels(buffer).filter(
      (span) => payloads.has(span.label) || images.has(span.label)
    );

  const forgetLabel = (label: string): void => {
    payloads.delete(label);
    images.delete(label);
  };

  const discarded = (): void => {
    observer?.onPayloadsDiscarded();
  };

  const segmentFor = (label: string): DraftSegment | undefined => {
    const paste = payloads.get(label);
    if (paste !== undefined) return { type: "text", text: paste };
    const image = images.get(label);
    if (image !== undefined) return { type: "image", ...image };
    return undefined;
  };

  return {
    foldPaste(payload) {
      const text = normalizePastedNewlines(payload);
      pasteIndex += 1;
      const measured = measurePastedText(text);
      const label = formatPasteLabel(
        pasteIndex,
        measured.lines,
        measured.chars
      );
      payloads.set(label, text);
      return { label };
    },

    addImage(image) {
      imageIndex += 1;
      const label = formatImageLabel(imageIndex);
      images.set(label, image);
      return label;
    },

    text: (label) => payloads.get(label),
    image: (label) => images.get(label),

    knownLabels: (buffer) => heldSpans(buffer),

    expand(buffer) {
      const segments: DraftSegment[] = [];
      let literal = "";
      let cursor = 0;
      for (const span of scanDraftLabels(buffer)) {
        literal += buffer.slice(cursor, span.start);
        cursor = span.end;
        const segment = segmentFor(span.label);
        if (segment === undefined) {
          literal += span.label;
          continue;
        }
        pushText(segments, literal);
        literal = "";
        segments.push(segment);
      }
      pushText(segments, literal + buffer.slice(cursor));
      return segments;
    },

    unfold(buffer, label) {
      const payload = payloads.get(label);
      if (payload === undefined) return buffer;
      // split/join, not replaceAll: a payload may contain "$&"-style
      // sequences that a replacement string would reinterpret.
      return buffer.split(label).join(payload);
    },

    refold(buffer, label) {
      const payload = payloads.get(label);
      if (payload === undefined || !buffer.includes(payload)) return buffer;
      return buffer.split(payload).join(label);
    },

    deleteLabelUnit(buffer, caret, direction) {
      const spans = heldSpans(buffer);
      const backward = direction === "backward";
      const target = (backward ? spans.slice().reverse() : spans).find(
        (span) =>
          backward
            ? span.start < caret && caret <= span.end
            : span.start <= caret && caret < span.end
      );
      if (target === undefined) return { buffer, caret, removed: false };
      forgetLabel(target.label);
      discarded();
      return {
        buffer: buffer.slice(0, target.start) + buffer.slice(target.end),
        caret: target.start,
        removed: true,
      };
    },

    takeSubmission(buffer) {
      const taken: DraftPayload[] = [];
      const claimed = new Set<string>();
      for (const span of scanDraftLabels(buffer)) {
        if (claimed.has(span.label)) continue;
        const text = payloads.get(span.label);
        if (text !== undefined) {
          claimed.add(span.label);
          forgetLabel(span.label);
          taken.push({ label: span.label, kind: "paste", text });
          continue;
        }
        const image = images.get(span.label);
        if (image === undefined) continue;
        claimed.add(span.label);
        forgetLabel(span.label);
        taken.push({ label: span.label, kind: "image", image });
      }
      if (taken.length > 0) discarded();
      return taken;
    },

    adoptSubmission(incoming) {
      for (const payload of incoming) {
        if (payload.kind === "paste") {
          payloads.set(payload.label, payload.text);
          continue;
        }
        images.set(payload.label, payload.image);
      }
    },

    heldPayloadCount: () => payloads.size + images.size,

    clear() {
      payloads.clear();
      images.clear();
      pasteIndex = 0;
      imageIndex = 0;
      discarded();
    },
  };
}

/** The submit payload: draft segments as ordered user content blocks. Adjacent
 *  text merges into one block so the block text stays byte-identical to the
 *  string `text` field carries (`expand` splits text at every label). */
export function toUserContentBlocks(
  segments: ReadonlyArray<DraftSegment>
): UserContentBlock[] {
  const blocks: UserContentBlock[] = [];
  for (const segment of segments) {
    if (segment.type === "image") {
      const { mediaType, data } = segment;
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      });
      continue;
    }
    const previous = blocks[blocks.length - 1];
    if (previous?.type === "text") {
      blocks[blocks.length - 1] = {
        type: "text",
        text: previous.text + segment.text,
      };
    } else {
      blocks.push({ type: "text", text: segment.text });
    }
  }
  return blocks;
}

/**
 * Transcript text for a submitted buffer. Paste labels expand to the payload
 * the model receives, so the message bubble renders that text and not the
 * input-box summary. Image labels stay: they name an attachment, and the
 * bubble has no other way to show one. A payload is spliced in as literal
 * text — a label-shaped string inside it is not expanded again.
 */
export function transcriptEchoText(
  displayText: string,
  payloads: ReadonlyArray<DraftPayload>
): string {
  const pasteByLabel = new Map<string, string>();
  for (const payload of payloads) {
    if (payload.kind === "paste") pasteByLabel.set(payload.label, payload.text);
  }
  if (pasteByLabel.size === 0) return displayText;
  let out = "";
  let cursor = 0;
  for (const span of scanDraftLabels(displayText)) {
    out += displayText.slice(cursor, span.start);
    cursor = span.end;
    out += pasteByLabel.get(span.label) ?? span.label;
  }
  return out + displayText.slice(cursor);
}

/**
 * Image blocks that accompany a skill-load envelope. The envelope already
 * keeps each `[image#N]` so the transcript remainder can name the attachment;
 * these bytes are what the model reads. No image payload → `undefined`, and
 * the turn stays on the text-only skill path.
 */
export function skillImageContent(
  envelope: string,
  payloads: ReadonlyArray<DraftPayload>
): UserContentBlock[] | undefined {
  const images: UserContentBlock[] = [];
  for (const payload of payloads) {
    if (payload.kind !== "image") continue;
    const { mediaType, data } = payload.image;
    images.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data },
    });
  }
  if (images.length === 0) return undefined;
  return [{ type: "text", text: envelope }, ...images];
}

/** Text of an ordered payload, ignoring image bytes — what the command parser,
 *  the text cap and the memory-prefetch query read. */
export function draftText(blocks: ReadonlyArray<UserContentBlock>): string {
  let text = "";
  for (const block of blocks) {
    if (block.type === "text") text += block.text;
  }
  return text;
}
