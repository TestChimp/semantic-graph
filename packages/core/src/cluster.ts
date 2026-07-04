import { DBSCAN } from 'density-clustering';
import type { EmbeddingRecord } from './types';

/** DBSCAN cluster assignment. Returns cluster id per record index (-1 = noise). */
export function clusterEmbeddings(
  records: EmbeddingRecord[],
  edgeThreshold = 0.75,
  minPts = 2,
): number[] {
  if (records.length < 2) {
    return records.map(() => 0);
  }
  // For L2-normalized embeddings, euclidean distance d relates to cosine: d^2 = 2(1-cos)
  const eps = Math.sqrt(Math.max(0, 2 * (1 - edgeThreshold)));
  const points = records.map((r) => r.embedding);
  const dbscan = new DBSCAN();
  const clusters: number[][] = dbscan.run(points, eps, minPts);
  const labels = new Array(records.length).fill(-1);
  clusters.forEach((indices, clusterId) => {
    for (const idx of indices) {
      labels[idx] = clusterId;
    }
  });
  // Assign noise points to singleton clusters
  let nextId = clusters.length;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === -1) {
      labels[i] = nextId++;
    }
  }
  return labels;
}

export function clusterTitles(
  records: EmbeddingRecord[],
  labels: number[],
): Map<number, string[]> {
  const map = new Map<number, string[]>();
  labels.forEach((cid, i) => {
    const arr = map.get(cid) ?? [];
    arr.push(records[i].title);
    map.set(cid, arr);
  });
  return map;
}

const STOPWORDS = new Set([
  'test', 'tests', 'should', 'the', 'a', 'an', 'and', 'or', 'for', 'with', 'when',
  'that', 'this', 'is', 'are', 'to', 'of', 'in', 'on', 'at', 'be', 'can', 'it',
  'as', 'by', 'from', 'not', 'has', 'have', 'will', 'user', 'users', 'verify',
  'validates', 'validate', 'checks', 'check',
]);

/** Derive a short theme label from test titles when LLM naming fails. */
export function heuristicClusterLabel(titles: string[]): string | null {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    for (const word of words) {
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = 0;
  for (const [word, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = word;
    }
  }
  return best;
}
