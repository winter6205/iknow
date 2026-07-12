import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import type {
  CallerRole,
  Chunk,
  FactStatus,
  KbRetrieveInput,
  KbRetrieveOutput,
  SessionContext,
} from "../shared/schema.js";
import { ValidationError } from "../shared/errors.js";
import { buildIdf, scoreKeyword, scoreOverlap } from "./keyword.js";
import { rrfFusion, type RankedHit } from "./rrf.js";

const TOP_ARM = 50;
const TOP_OUT = 5;
/** Absolute keyword score floor after IDF (edge-002 empty results). */
const MIN_KEYWORD = 2.5;
/** Overlap arm rescue: admit candidates with low keyword but meaningful overlap. */
const MIN_OVERLAP_FLOOR = 0.12;
const ADMIN_ROLE: CallerRole = "admin";

function factStatusFromFacts(
  facts: { document_version: string }[],
  docVersion: string,
): FactStatus {
  if (facts.length === 0) return "missing";
  const sameVersion = facts.some((f) => f.document_version === docVersion);
  return sameVersion ? "compiled" : "outdated";
}

function callerMayRead(
  rolesAllowed: string[] | undefined,
  role: string,
): boolean {
  if (!rolesAllowed || rolesAllowed.length === 0) return true;
  return rolesAllowed.includes(role) || role === ADMIN_ROLE;
}

/**
 * kb_retrieve: dual-arm keyword + overlap → RRF; fact arm only contributes chunk_id ranks.
 * Fact text is never returned.
 */
export function kbRetrieve(
  store: InMemoryKnowledgeStore,
  input: KbRetrieveInput,
  session: SessionContext,
): KbRetrieveOutput {
  if (!input.query || input.query.trim().length === 0) {
    throw new ValidationError("query is required");
  }

  const index = input.index ?? "both";
  const freshnessWanted = input.filter?.freshness_level ?? "any";
  let governanceDegraded = false;
  let degradationNote: string | undefined;

  if (session.simulate_governance_timeout) {
    governanceDegraded = true;
    degradationNote =
      "governance A-filter timeout: returning results with stale/unverified marks; do not treat as fully filtered";
  }

  const priorBoost = new Map<string, number>();
  for (const p of input.prior_chunks ?? []) {
    priorBoost.set(p.chunk_id, 0.15);
  }

  const expandedQuery =
    input.prior_chunks && input.prior_chunks.length > 0
      ? `${input.query} ${input.prior_chunks.map((p) => p.summary).join(" ")}`
      : input.query;

  type Candidate = {
    chunk_id: string;
    keyword: number;
    overlap: number;
    factBoost: number;
  };

  const corpusTexts = store
    .listChunks()
    .map((c) => `${c.summary} ${c.text}`);
  const idf = buildIdf(corpusTexts);

  const candidates: Candidate[] = [];
  const factStatusByChunk = new Map<string, FactStatus>();

  for (const chunk of store.listChunks()) {
    const doc = store.tryGetDocument(chunk.doc_id);
    if (!doc) continue;

    if (!callerMayRead(doc.roles_allowed, session.caller_role)) {
      continue;
    }

    // competitor / external knowledge hard deny for non-admin
    if (
      doc.sensitivity === "competitor_external" &&
      session.caller_role !== ADMIN_ROLE
    ) {
      continue;
    }

    if (input.filter?.doc_type && doc.doc_type !== input.filter.doc_type) {
      continue;
    }

    if (input.filter?.time_range && doc.effective_at) {
      const [from, to] = input.filter.time_range;
      if (doc.effective_at < from || doc.effective_at > to) continue;
    }

    // A-filter online freshness (skip strict filter when degraded).
    // Revoked docs stay discoverable under freshness "any" so edge-003 can govern them.
    // When freshnessWanted === "fresh", non-fresh (incl. revoked) is already excluded.
    if (!governanceDegraded && freshnessWanted !== "any") {
      if (freshnessWanted === "fresh" && doc.freshness !== "fresh") continue;
      if (freshnessWanted === "stale" && doc.freshness === "fresh") continue;
    }

    const body = `${chunk.summary} ${chunk.text}`;
    const kw = scoreKeyword(expandedQuery, body, idf);
    const ov = scoreOverlap(expandedQuery, body, idf);

    const facts = store.listFactsForChunk(chunk.chunk_id);
    factStatusByChunk.set(
      chunk.chunk_id,
      factStatusFromFacts(facts, doc.document_version),
    );

    let factBoost = 0;
    if (index === "fact" || index === "both") {
      const kwFacts = (chunk.fact_keywords ?? []).join(" ");
      const factHaystack = [
        kwFacts,
        ...facts.map(
          (f) =>
            `${f.entity} ${f.attributes.map((a: { key: string; value: string }) => a.value).join(" ")}`,
        ),
      ].join(" ");
      // Use fact arm only for ranking scores; never expose fact text in output
      factBoost =
        scoreKeyword(expandedQuery, factHaystack, idf) * 0.5 +
        scoreOverlap(expandedQuery, factHaystack, idf) * 0.5;
    }

    const prior = priorBoost.get(chunk.chunk_id) ?? 0;
    // Floor: require keyword/fact signal, prior boost, or meaningful overlap
    if (kw + factBoost < MIN_KEYWORD && prior <= 0 && ov < MIN_OVERLAP_FLOOR) {
      continue;
    }

    candidates.push({
      chunk_id: chunk.chunk_id,
      keyword: kw + prior,
      overlap: ov + prior,
      factBoost,
    });
  }

  const keywordList: RankedHit[] = candidates
    .slice()
    .sort((a, b) => b.keyword - a.keyword)
    .slice(0, TOP_ARM)
    .filter((c) => c.keyword > 0)
    .map((c) => ({ id: c.chunk_id, score: c.keyword }));

  const vectorList: RankedHit[] = candidates
    .slice()
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, TOP_ARM)
    .filter((c) => c.overlap > 0)
    .map((c) => ({ id: c.chunk_id, score: c.overlap }));

  const factList: RankedHit[] =
    index === "chunk"
      ? []
      : candidates
          .slice()
          .sort((a, b) => b.factBoost - a.factBoost)
          .slice(0, TOP_ARM)
          .filter((c) => c.factBoost > 0)
          .map((c) => ({ id: c.chunk_id, score: c.factBoost }));

  const lists: RankedHit[][] = [];
  if (index === "chunk" || index === "both") {
    lists.push(keywordList, vectorList);
  }
  if (index === "fact" || index === "both") {
    lists.push(factList);
  }

  const fused = rrfFusion(lists).slice(0, TOP_OUT);

  const chunks: Chunk[] = [];
  for (const hit of fused) {
    const { chunk, doc } = store.resolveChunkDocument(hit.id);
    let summary = chunk.summary;
    if (governanceDegraded || doc.freshness !== "fresh") {
      summary = `[${doc.freshness}${governanceDegraded ? ",unverified" : ""}] ${summary}`;
    }
    chunks.push({
      chunk_id: chunk.chunk_id,
      doc_id: chunk.doc_id,
      doc_type: doc.doc_type,
      summary,
      source_ref: chunk.source_ref,
      chunk_version: chunk.chunk_version,
      fact_status:
        factStatusByChunk.get(hit.id) ??
        factStatusFromFacts(
          store.listFactsForChunk(hit.id),
          doc.document_version,
        ),
    });
  }

  return {
    chunks,
    ...(governanceDegraded
      ? { governance_degraded: true, degradation_note: degradationNote }
      : {}),
  };
}
