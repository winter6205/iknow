export interface EmbeddingClient {
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface ChunkEmbedInput {
  chunk_id: string;
  text: string;
  summary: string;
}
