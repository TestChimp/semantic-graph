import { UMAP } from 'umap-js';

/** Mulberry32 PRNG for reproducible UMAP layouts. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D layout via UMAP (seeded for reproducibility). */
export function layout2D(embeddings: number[][], randomState = 42): Array<{ x: number; y: number }> {
  if (embeddings.length === 0) return [];
  if (embeddings.length === 1) return [{ x: 0, y: 0 }];
  // UMAP requires nNeighbors < nSamples; with 2 points Math.max(2, n-1) yields nNeighbors=2 and throws.
  if (embeddings.length === 2) return [{ x: -0.5, y: 0 }, { x: 0.5, y: 0 }];
  const nNeighbors = Math.min(15, Math.max(2, embeddings.length - 1));
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors,
    minDist: 0.1,
    random: mulberry32(randomState),
  } as ConstructorParameters<typeof UMAP>[0]);
  const coords = umap.fit(embeddings);
  return coords.map((c) => ({ x: c[0], y: c[1] }));
}
