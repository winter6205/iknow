import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import type {
  KbVerifyCitationInput,
  KbVerifyCitationOutput,
  Verdict,
} from "../shared/schema.js";
import { ValidationError } from "../shared/errors.js";
import { tokenize } from "../kb-retrieve/keyword.js";

/** Span coverage thresholds for three-state verdict. */
const COVERAGE_SUPPORTED = 0.72;
const COVERAGE_PARTIAL_SPAN = 0.4;
const COVERAGE_PARTIAL_FULL = 0.55;

/** Max chars returned in evidence_span. */
const EVIDENCE_UNSUPPORTED_LEN = 120;
const EVIDENCE_SUPPORTED_LEN = 200;

function isDocRevoked(doc: { freshness: string }): boolean {
  return doc.freshness === "revoked";
}

/** Stale doc whose version no longer anchors the chunk (superseded lineage). */
function isChunkStaleAgainstDoc(
  doc: { freshness: string; document_version: string },
  chunk: { chunk_version: string },
): boolean {
  return (
    doc.document_version !== chunk.chunk_version.split("@")[0] &&
    doc.freshness === "stale" &&
    doc.document_version.endsWith("-superseded")
  );
}

function extractSpanText(
  full: string,
  source: KbVerifyCitationInput["source_span"],
): string {
  if (source.quote && source.quote.trim().length > 0) {
    return source.quote;
  }
  if (source.offset) {
    if (source.offset.length !== 2) {
      throw new ValidationError("invalid source_span.offset", {
        offset: source.offset,
      });
    }
    const [start, end] = source.offset;
    // half-open [start, end)
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > full.length
    ) {
      throw new ValidationError("invalid source_span.offset", {
        offset: source.offset,
      });
    }
    return full.slice(start, end);
  }
  return full;
}

function coverage(claimTokens: string[], spanTokens: Set<string>): number {
  if (claimTokens.length === 0) return 0;
  let hit = 0;
  for (const t of claimTokens) {
    if (spanTokens.has(t)) hit += 1;
  }
  return hit / claimTokens.length;
}

/**
 * Deterministic three-state verify against chunk **original text** only.
 * Never uses fact text (principle 1).
 */
export function kbVerifyCitation(
  store: InMemoryKnowledgeStore,
  input: KbVerifyCitationInput,
): KbVerifyCitationOutput {
  if (!input.claim || input.claim.trim().length === 0) {
    throw new ValidationError("claim is required");
  }
  if (!input.source_span?.chunk_id) {
    throw new ValidationError("source_span.chunk_id is required");
  }

  const { chunk, doc } = store.resolveChunkDocument(input.source_span.chunk_id);

  const versionStale =
    isDocRevoked(doc) || isChunkStaleAgainstDoc(doc, chunk);

  const spanText = extractSpanText(chunk.text, input.source_span);
  const claimTokens = tokenize(input.claim);
  const spanTokenSet = new Set(tokenize(spanText));
  const fullTokenSet = new Set(tokenize(chunk.text));

  const spanCov = coverage(claimTokens, spanTokenSet);
  const fullCov = coverage(claimTokens, fullTokenSet);

  let verdict: Verdict;
  if (
    spanCov >= COVERAGE_SUPPORTED ||
    (spanText.includes(input.claim.trim()) && claimTokens.length > 0)
  ) {
    verdict = "supported";
  } else if (
    spanCov >= COVERAGE_PARTIAL_SPAN ||
    fullCov >= COVERAGE_PARTIAL_FULL
  ) {
    verdict = "partially_supported";
  } else {
    verdict = "unsupported";
  }

  const out: KbVerifyCitationOutput = {
    verdict,
    chunk_version: chunk.chunk_version,
  };

  if (verdict === "unsupported") {
    out.evidence_span = chunk.text.slice(0, EVIDENCE_UNSUPPORTED_LEN);
  } else {
    out.evidence_span = spanText.slice(0, EVIDENCE_SUPPORTED_LEN);
  }

  if (versionStale) {
    out.version_stale = true;
  }

  return out;
}
