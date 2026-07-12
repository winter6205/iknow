import type { ChunkRecord, DocumentRecord, FactRecord } from "./types.js";
import { NotFoundError } from "../shared/errors.js";

/** Defensive deep copy so callers cannot mutate store internals. */
function cloneRecord<T>(value: T): T {
  return structuredClone(value);
}

/** In-process knowledge store. No DB / gbrain dependency. */
export class InMemoryKnowledgeStore {
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly chunks = new Map<string, ChunkRecord>();
  private readonly facts = new Map<string, FactRecord>();
  private readonly compileHashes = new Map<string, string[]>();

  upsertDocument(doc: DocumentRecord): void {
    this.documents.set(doc.doc_id, doc);
  }

  upsertChunk(chunk: ChunkRecord): void {
    this.chunks.set(chunk.chunk_id, chunk);
  }

  upsertFact(fact: FactRecord): void {
    const previous = this.facts.get(fact.fact_id);
    // Secondary index: drop fact_id from old content_hash bucket before re-index.
    if (previous && previous.content_hash !== fact.content_hash) {
      const oldBucket = this.compileHashes.get(previous.content_hash);
      if (oldBucket) {
        const idx = oldBucket.indexOf(fact.fact_id);
        if (idx >= 0) {
          oldBucket.splice(idx, 1);
        }
        if (oldBucket.length === 0) {
          this.compileHashes.delete(previous.content_hash);
        }
      }
    }

    this.facts.set(fact.fact_id, fact);
    const existing = this.compileHashes.get(fact.content_hash) ?? [];
    if (!existing.includes(fact.fact_id)) {
      existing.push(fact.fact_id);
      this.compileHashes.set(fact.content_hash, existing);
    }
  }

  getDocument(docId: string): DocumentRecord {
    const doc = this.documents.get(docId);
    if (!doc) {
      throw new NotFoundError(`document not found: ${docId}`, { doc_id: docId });
    }
    return cloneRecord(doc);
  }

  tryGetDocument(docId: string): DocumentRecord | undefined {
    const doc = this.documents.get(docId);
    return doc === undefined ? undefined : cloneRecord(doc);
  }

  getChunk(chunkId: string): ChunkRecord {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) {
      throw new NotFoundError(`chunk not found: ${chunkId}`, {
        chunk_id: chunkId,
      });
    }
    return cloneRecord(chunk);
  }

  tryGetChunk(chunkId: string): ChunkRecord | undefined {
    const chunk = this.chunks.get(chunkId);
    return chunk === undefined ? undefined : cloneRecord(chunk);
  }

  listChunks(): ChunkRecord[] {
    return [...this.chunks.values()].map(cloneRecord);
  }

  listDocuments(): DocumentRecord[] {
    return [...this.documents.values()].map(cloneRecord);
  }

  listFacts(): FactRecord[] {
    return [...this.facts.values()].map(cloneRecord);
  }

  listFactsForChunk(chunkId: string): FactRecord[] {
    return this.listFacts().filter((f) => f.source_chunk_id === chunkId);
  }

  findFactsByContentHash(contentHash: string): FactRecord[] {
    const ids = this.compileHashes.get(contentHash) ?? [];
    return ids
      .map((id) => this.facts.get(id))
      .filter((f): f is FactRecord => f !== undefined)
      .map(cloneRecord);
  }

  resolveChunkDocument(chunkId: string): {
    chunk: ChunkRecord;
    doc: DocumentRecord;
  } {
    // getChunk/getDocument already return defensive clones
    const chunk = this.getChunk(chunkId);
    const doc = this.getDocument(chunk.doc_id);
    return { chunk, doc };
  }
}
