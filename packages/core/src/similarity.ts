import type { EmbeddingRecord, SimilarTestEntry, Thresholds } from './types';
import { DEFAULT_THRESHOLDS } from './types';

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function buildSimilarityMatrix(records: EmbeddingRecord[]): number[][] {
  const n = records.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(records[i].embedding, records[j].embedding);
      matrix[i][j] = s;
      matrix[j][i] = s;
    }
  }
  return matrix;
}

export function findNearestNeighbors(
  focus: EmbeddingRecord,
  corpus: EmbeddingRecord[],
  limit: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): SimilarTestEntry[] {
  const scored = corpus
    .filter((r) => r.id !== focus.id)
    .map((r) => {
      const similarity = cosineSimilarity(focus.embedding, r.embedding);
      return {
        testId: r.id,
        title: r.title,
        folderPath: r.folderPath ?? [],
        fileId: r.fileId,
        similarity,
        potentialDuplicate: similarity >= thresholds.duplicate,
      };
    })
    .filter((e) => e.similarity >= thresholds.similar)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
  return scored;
}

export function buildKnnEdges(
  records: EmbeddingRecord[],
  matrix: number[][],
  k: number,
  edgeThreshold: number,
): Array<{ source: string; target: string; similarity: number }> {
  const edges: Array<{ source: string; target: string; similarity: number }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const neighbors = matrix[i]
      .map((sim, j) => ({ j, sim }))
      .filter(({ j, sim }) => j !== i && sim >= edgeThreshold)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);
    for (const { j, sim } of neighbors) {
      const a = records[i].id;
      const b = records[j].id;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: a, target: b, similarity: sim });
    }
  }
  return edges;
}
