import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import type {
  CompiledFact,
  CompileStatus,
  KbCompileInput,
  KbCompileOutput,
} from "../shared/schema.js";
import { ValidationError } from "../shared/errors.js";
import { sha256Hex } from "../shared/hash.js";

function extractFactsFromText(
  text: string,
  docId: string,
  chunkId: string,
  chunkVersion: string,
): CompiledFact[] {
  const facts: CompiledFact[] = [];
  // Simple rule: lines like "Key: Value" or "Key：Value"
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^(.{1,40})[:：]\s*(.+)$/);
    if (!m) continue;
    const key = m[1]!.trim();
    const value = m[2]!.trim();
    if (key.length < 2 || value.length < 1) continue;
    facts.push({
      entity: key,
      attributes: [{ key: "value", value }],
      source_span: line.trim().slice(0, 200),
      source_chunk_id: chunkId,
      source_doc_id: docId,
      chunk_version: chunkVersion,
    });
  }

  // Fallback: one bag fact from first sentence if nothing structured
  if (facts.length === 0 && text.trim().length > 0) {
    const sentence = text.trim().split(/[。.!?\n]/)[0] ?? text.trim();
    facts.push({
      entity: docId,
      attributes: [{ key: "summary", value: sentence.slice(0, 200) }],
      source_span: sentence.slice(0, 200),
      source_chunk_id: chunkId,
      source_doc_id: docId,
      chunk_version: chunkVersion,
    });
  }
  return facts;
}

/**
 * kb_compile: agent-driven fact extraction + content_hash dedup.
 * Queue/async long jobs are out of band; this call is synchronous.
 */
export function kbCompile(
  store: InMemoryKnowledgeStore,
  input: KbCompileInput,
): KbCompileOutput {
  if (!input.doc_id) {
    throw new ValidationError("doc_id is required");
  }
  if (!input.content_hash || input.content_hash.length < 8) {
    throw new ValidationError("content_hash is required");
  }
  if (!input.document_version) {
    throw new ValidationError("document_version is required");
  }

  const doc = store.getDocument(input.doc_id);

  // Single lookup for content_hash dedup path
  const existingByHash = store.findFactsByContentHash(input.content_hash);
  if (!input.force && existingByHash.length > 0) {
    return {
      facts: existingByHash.map((f) => ({
        entity: f.entity,
        attributes: f.attributes,
        source_span: f.source_span,
        source_chunk_id: f.source_chunk_id,
        source_doc_id: f.source_doc_id,
        chunk_version: f.chunk_version,
      })),
      compile_status: "ok",
    };
  }

  const chunks = store.listChunks().filter((c) => c.doc_id === input.doc_id);
  // Non-empty inline content wins for both hashing and extraction.
  const useInline =
    typeof input.content === "string" && input.content.trim().length > 0;
  const content = useInline
    ? input.content!
    : chunks.map((c) => c.text).join("\n");

  if (!content || content.trim().length === 0) {
    return { facts: [], compile_status: "failed" };
  }

  const expectedHash = sha256Hex(content);
  // Contract: content_hash must match the bytes used for extraction unless force.
  // Prefer ValidationError over silent failed/hallucination_flag so callers see an explicit failure.
  if (!input.force && expectedHash !== input.content_hash) {
    throw new ValidationError(
      "content_hash does not match content",
      { expected: expectedHash, received: input.content_hash },
    );
  }

  const compiled: CompiledFact[] = [];
  if (useInline) {
    compiled.push(
      ...extractFactsFromText(
        content,
        input.doc_id,
        `${input.doc_id}#inline`,
        `${input.document_version}@0`,
      ),
    );
  } else {
    for (const chunk of chunks) {
      compiled.push(
        ...extractFactsFromText(
          chunk.text,
          input.doc_id,
          chunk.chunk_id,
          chunk.chunk_version,
        ),
      );
    }
  }

  for (const [i, fact] of compiled.entries()) {
    store.upsertFact({
      fact_id: `${input.doc_id}:fact:${i}:${input.content_hash.slice(0, 8)}`,
      entity: fact.entity,
      attributes: fact.attributes,
      source_span: fact.source_span,
      source_chunk_id: fact.source_chunk_id,
      source_doc_id: fact.source_doc_id,
      chunk_version: fact.chunk_version,
      content_hash: input.content_hash,
      document_version: input.document_version || doc.document_version,
    });
    // attach keywords onto chunk for fact-arm ranking (text not exposed to agent)
    const ch = store.tryGetChunk(fact.source_chunk_id);
    if (ch) {
      const kw = new Set(ch.fact_keywords ?? []);
      kw.add(fact.entity.toLowerCase());
      for (const a of fact.attributes) {
        kw.add(a.value.toLowerCase().slice(0, 32));
      }
      store.upsertChunk({ ...ch, fact_keywords: [...kw] });
    }
  }

  let status: CompileStatus;
  if (compiled.length === 0) {
    status = "failed";
  } else if (compiled.length < 2) {
    status = "partial";
  } else {
    status = "ok";
  }

  return {
    facts: compiled,
    compile_status: status,
    hallucination_flag: false,
  };
}
