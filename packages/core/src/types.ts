/** Minimal pathway key used by vendored TestFileParser repair paths. */
export interface TestPathway {
  suitePath?: string[];
  testName: string;
}

export interface Thresholds {
  edge: number;
  similar: number;
  duplicate: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  edge: 0.75,
  similar: 0.8,
  duplicate: 0.92,
};

export interface EmbeddingRecord {
  id: string;
  title: string;
  folderPath?: string[];
  fileId?: string;
  embedding: number[];
}

export interface TestSemanticNode {
  testId: string;
  title: string;
  folderPath: string[];
  fileId?: string;
  x?: number;
  y?: number;
  clusterId?: number;
}

export interface TestSemanticEdge {
  sourceTestId: string;
  targetTestId: string;
  similarity: number;
}

export interface TestSemanticCluster {
  clusterId: number;
  label?: string;
  testIds: string[];
}

export interface SimilarTestEntry {
  testId: string;
  title: string;
  folderPath: string[];
  fileId?: string;
  similarity: number;
  potentialDuplicate: boolean;
}

export interface SemanticGraphPayload {
  nodes: TestSemanticNode[];
  edges: TestSemanticEdge[];
  clusters: TestSemanticCluster[];
  scopeTruncatedWarning?: string;
  skippedUnparseableCount?: number;
}

export interface BuildGraphOptions {
  thresholds?: Partial<Thresholds>;
  maxNodes?: number;
  umapRandomState?: number;
  /** Skip UMAP layout (e.g. cluster list view). */
  skipLayout?: boolean;
  /** Skip O(n²) similarity matrix and edges (e.g. cluster list view). */
  skipEdges?: boolean;
}
