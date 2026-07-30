/**
 * PostgreSQL + pgvector storage backend (production).
 *
 * Requires: PostgreSQL 16 + pgvector ≥ 0.7.
 * Table: chunks(id uuid PK, content text, embedding vector(1536),
 *        valid_from timestamptz, valid_until timestamptz NULL,
 *        source_ref text, metadata jsonb, created_at timestamptz)
 *
 * Vector search: cosine distance via the `<=>` operator (lower = more
 * similar; we expose similarity = 1 - distance to match MemoryBackend's
 * convention so callers can compare scores across backends).
 *
 * valid_window filter: valid_from <= $validAt AND (valid_until IS NULL OR
 * valid_until > $validAt). Matches the spec at src/core/types.ts and the
 * reference implementation in MemoryBackend.
 *
 * This backend is NOT tested in CI (no PostgreSQL available). It compiles
 * (typecheck) and is verified by code review + local manual testing. The
 * "no pg at import time" guarantee lets memory-mode users skip the
 * dependency entirely: see the dynamic import in the constructor and in
 * src/index.ts:buildDeps.
 */
import type {
  ChunkRecord,
  RetrievedChunk,
  SearchOptions,
  StorageBackend,
} from "../types.js";
import { GraphragError, EMBEDDING_DIM } from "../errors.js";

/**
 * Minimal structural subset of the `pg` package we use. Declared as an
 * interface (not `import type`) so the file compiles even when `pg` is not
 * installed — we `await import("pg")` at runtime and accept the result
 * only if it matches.
 */
interface PgModule {
  Pool: new (config: { connectionString: string }) => PgPool;
}
interface PgPool {
  query: (text: string, values: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
}

/** Serialized pgvector literal: `[0.1,0.2,...]` with no spaces. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Cast for the row shape we expect from our SELECT/UPSERT queries. */
interface ChunkRow {
  id: string;
  content: string;
  source_ref: string;
  valid_from: Date;
  valid_until: Date | null;
  distance: number;
}

function rowToRetrievedChunk(row: ChunkRow): RetrievedChunk {
  return {
    id: row.id,
    content: row.content,
    source_ref: row.source_ref,
    valid_window: [
      row.valid_from.toISOString(),
      row.valid_until?.toISOString() ?? null,
    ],
    // pgvector `<=>` returns cosine *distance* (1 - similarity). Flip so
    // the public score field matches MemoryBackend's cosine similarity
    // convention (1 = perfect match, 0 = orthogonal).
    score: 1 - row.distance,
  };
}

/**
 * Storage backend backed by PostgreSQL + the pgvector extension.
 *
 * Lazy init: the `pg` module is imported on the first call to `upsert`
 * or `search`, not in the constructor. This keeps `import { PgvectorBackend }`
 * from forcing every consumer to install `pg` — operators running with
 * GRAPHRAG_MEMORY_STORAGE=memory never touch the dependency.
 *
 * `ensureTable()` is called once per backend instance (idempotent
 * CREATE EXTENSION + CREATE TABLE IF NOT EXISTS), so a fresh database
 * works out of the box.
 */
export class PgvectorBackend implements StorageBackend {
  private pool: PgPool | undefined;
  private initPromise: Promise<void> | undefined;

  constructor(private readonly dbUrl: string) {}

  /**
   * Lazily initialize the pg module + connection pool + schema.
   *
   * Why a memoized promise (and not an `async` constructor): JS classes
   * don't support async constructors, and callers (index.ts:buildDeps) want
   * to construct + run async init + use in a single await chain. A
   * memoized promise means concurrent `upsert` calls share one init.
   */
  private async ensureReady(): Promise<PgPool> {
    if (this.pool) return this.pool;
    if (this.initPromise) {
      await this.initPromise;
      return this.pool!;
    }
    this.initPromise = (async () => {
      let mod: PgModule;
      try {
        mod = (await import("pg")) as unknown as PgModule;
      } catch (err) {
        throw new GraphragError(
          `PgvectorBackend: failed to load optional dependency "pg" — install it to use storage=pgvector (${(err as Error).message})`,
          "STORAGE_ERROR"
        );
      }
      const pool = new mod.Pool({ connectionString: this.dbUrl });
      this.pool = pool;
      try {
        await this.ensureTable();
      } catch (err) {
        // Reset pool so the next call retries from scratch (High-fix:
        // without this, a failed ensureTable leaves a broken pool that
        // every subsequent call returns via the `if (this.pool)` guard).
        this.pool = undefined;
        throw err;
      }
    })();
    try {
      await this.initPromise;
    } finally {
      // Allow re-entry if init failed; the next call will retry.
      this.initPromise = undefined;
    }
    return this.pool!;
  }

  /**
   * Create the `vector` extension and the `chunks` table if they don't
   * already exist. Both statements are idempotent (IF NOT EXISTS) so a
   * re-run is safe.
   *
   * Why on every fresh pool: an operator pointing the server at a new
   * database should not have to run a separate migration step. T8 ships
   * the inline CREATE as the migration; later stages may replace this
   * with a versioned migration runner if the schema grows.
   */
  private async ensureTable(): Promise<void> {
    const pool = this.pool!;
    try {
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector", []);
      await pool.query(
        `CREATE TABLE IF NOT EXISTS chunks (
           id uuid PRIMARY KEY,
           content text NOT NULL,
           embedding vector(1536) NOT NULL,
           valid_from timestamptz NOT NULL,
           valid_until timestamptz NULL,
           source_ref text NOT NULL,
           metadata jsonb NOT NULL,
           created_at timestamptz NOT NULL
         )`,
        []
      );
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend: ensureTable failed (${(err as Error).message})`,
        "STORAGE_ERROR"
      );
    }
  }

  async upsert(chunks: ChunkRecord[]): Promise<string[]> {
    if (chunks.length === 0) return [];
    const pool = await this.ensureReady();

    // Validate embedding dimensions BEFORE any DB round-trip so a bad
    // batch fails fast and the whole upsert is atomic on the caller's
    // side. (Postgres would reject with a dimension error, but we'd rather
    // surface a typed GraphragError than a pg driver error.)
    for (const chunk of chunks) {
      if (chunk.embedding.length !== EMBEDDING_DIM) {
        throw new GraphragError(
          `PgvectorBackend.upsert: chunk "${chunk.id}" embedding length ${chunk.embedding.length} !== ${EMBEDDING_DIM}`,
          "EMBEDDING_DIM_MISMATCH"
        );
      }
    }

    // Each chunk is its own INSERT ... ON CONFLICT. A single multi-row
    // INSERT would be marginally faster, but per-row keeps the SQL
    // straightforward and lets pg report which id failed. We do NOT wrap
    // in a transaction here: ON CONFLICT (id) DO UPDATE is per-row atomic
    // already, and a partial failure mode (some chunks persist, others
    // don't) is acceptable — the caller can retry the missing ids.
    const ids: string[] = [];
    try {
      for (const chunk of chunks) {
        await pool.query(
          `INSERT INTO chunks
             (id, content, embedding, valid_from, valid_until,
              source_ref, metadata, created_at)
           VALUES ($1, $2, $3::vector, $4, $5, $6, $7::jsonb, $8)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             embedding = EXCLUDED.embedding,
             valid_from = EXCLUDED.valid_from,
             valid_until = EXCLUDED.valid_until,
             source_ref = EXCLUDED.source_ref,
             metadata = EXCLUDED.metadata,
             created_at = EXCLUDED.created_at`,
          [
            chunk.id,
            chunk.content,
            toVectorLiteral(chunk.embedding),
            chunk.valid_from,
            chunk.valid_until,
            chunk.source_ref,
            JSON.stringify(chunk.metadata),
            chunk.created_at,
          ]
        );
        ids.push(chunk.id);
      }
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend.upsert failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }
    return ids;
  }

  async search(
    queryEmbedding: number[],
    opts: SearchOptions
  ): Promise<RetrievedChunk[]> {
    if (queryEmbedding.length !== EMBEDDING_DIM) {
      throw new GraphragError(
        `PgvectorBackend.search: query embedding length ${queryEmbedding.length} !== ${EMBEDDING_DIM}`,
        "EMBEDDING_DIM_MISMATCH"
      );
    }
    const pool = await this.ensureReady();

    // Build dynamic WHERE clauses for source_ref and metadata filters.
    // We collect parameters in order so the $N placeholders stay in sync
    // with the values array.
    const where: string[] = [
      "valid_from <= $2::timestamptz",
      "(valid_until IS NULL OR valid_until > $2::timestamptz)",
    ];
    const params: unknown[] = [toVectorLiteral(queryEmbedding), opts.validAt];
    let p = params.length;

    const filters = opts.filters ?? {};
    if (filters["source_ref"] !== undefined) {
      p += 1;
      where.push(`source_ref = $${p}`);
      params.push(filters["source_ref"]);
    }
    for (const [key, value] of Object.entries(filters)) {
      if (key === "source_ref") continue;
      if (key.startsWith("metadata.")) {
        const metaKey = key.slice("metadata.".length);
        p += 1;
        // JSONB text extraction via `->>` is the canonical exact-match
        // pattern; it casts the value to text so `=` works for any JSON
        // scalar (string, number, bool) without operator juggling.
        where.push(`metadata ->> $${p} = $${p + 1}`);
        params.push(metaKey, value);
        p += 1;
      }
      // Unknown top-level keys are ignored — mirrors MemoryBackend's
      // permissive filter parsing so caller code is portable.
    }
    p += 1;
    const limitPlaceholder = `$${p}`;
    params.push(opts.limit);

    const sql = `
      SELECT id, content, source_ref, valid_from, valid_until,
             embedding <=> $1::vector AS distance
      FROM chunks
      WHERE ${where.join(" AND ")}
      ORDER BY embedding <=> $1::vector ASC
      LIMIT ${limitPlaceholder}
    `;

    let rows: unknown[];
    try {
      const result = await pool.query(sql, params);
      rows = result.rows;
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend.search failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    }

    return rows.map((r) => rowToRetrievedChunk(r as ChunkRow));
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.end();
    } catch (err) {
      throw new GraphragError(
        `PgvectorBackend.close failed: ${(err as Error).message}`,
        "STORAGE_ERROR"
      );
    } finally {
      this.pool = undefined;
    }
  }
}
