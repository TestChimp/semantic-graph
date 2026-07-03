import pg from 'pg';
import {
  applyClusterNames,
  buildGraph,
  type EmbeddingRecord,
  type SemanticGraphPayload,
} from '@testchimp/semantic-graph-core';
import type { EnvConfig } from './env';

function parsePgVector(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const trimmed = raw.replace(/^\[|\]$/g, '');
  if (!trimmed.trim()) return [];
  return trimmed.split(',').map((v) => Number(v.trim()));
}

function relPathToFolderPath(relPath: string): string[] {
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 1) return [];
  return parts.slice(0, -1);
}

export interface TestRow {
  id: string;
  rel_path: string;
  test_name: string;
  suite_path: string[] | unknown;
  title: string;
}

export async function loadScopedEmbeddings(
  pool: pg.Pool,
  scope: { folderPrefix?: string; relPath?: string },
): Promise<EmbeddingRecord[]> {
  let query = `SELECT id, rel_path, title, embedding::text AS embedding_text FROM test_embeddings WHERE embedding IS NOT NULL`;
  const params: string[] = [];
  if (scope.relPath) {
    params.push(scope.relPath);
    query += ` AND rel_path = $${params.length}`;
  } else if (scope.folderPrefix !== undefined && scope.folderPrefix !== '') {
    params.push(scope.folderPrefix);
    const base = params.length;
    params.push(`${scope.folderPrefix}/%`);
    query += ` AND (rel_path = $${base} OR rel_path LIKE $${base + 1})`;
  }
  query += ' ORDER BY rel_path, title';
  const r = await pool.query(query, params);
  return r.rows
    .map((row: { id: string; rel_path: string; title: string; embedding_text: string }) => ({
      id: row.id,
      title: row.title,
      folderPath: relPathToFolderPath(row.rel_path),
      fileId: row.rel_path,
      embedding: parsePgVector(row.embedding_text),
    }))
    .filter((rec: EmbeddingRecord) => rec.embedding.length > 0);
}

function clusterNamingConfig(config: EnvConfig) {
  return {
    apiKey: config.apiKey,
    model: config.llmModel,
    provider: config.provider,
  };
}

export async function buildScopedGraph(
  pool: pg.Pool,
  config: EnvConfig,
  scope: { folderPrefix?: string; relPath?: string },
  viewMode: 'graph' | 'list' = 'graph',
): Promise<SemanticGraphPayload> {
  const records = await loadScopedEmbeddings(pool, scope);
  if (records.length === 0) {
    return { nodes: [], edges: [], clusters: [] };
  }
  const graph = buildGraph(records, {
    maxNodes: records.length,
    thresholds: config.thresholds,
    ...(viewMode === 'list' ? { skipLayout: true, skipEdges: true } : {}),
  });
  const naming = clusterNamingConfig(config);
  if (viewMode === 'list') {
    return applyClusterNames({ ...graph, edges: [] }, naming);
  }
  return applyClusterNames(graph, naming);
}

export async function findSimilarTests(
  pool: pg.Pool,
  testId: string,
  limit: number,
  duplicateThreshold: number,
  similarThreshold: number,
): Promise<
  Array<{
    testId: string;
    title: string;
    folderPath: string[];
    relPath: string;
    similarity: number;
    potentialDuplicate: boolean;
  }>
> {
  const focus = await pool.query(
    `SELECT id, rel_path, title, embedding::text AS embedding_text FROM test_embeddings WHERE id = $1`,
    [testId],
  );
  const row = focus.rows[0];
  if (!row?.embedding_text) return [];

  const fetchLimit = Math.max(limit * 3, limit + 5);
  const neighbors = await pool.query(
    `SELECT id, rel_path, title,
            1 - (embedding <=> $1::vector) AS similarity
     FROM test_embeddings
     WHERE id != $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [row.embedding_text, testId, fetchLimit],
  );

  return neighbors.rows
    .map(
      (n: { id: string; rel_path: string; title: string; similarity: number }) => ({
        testId: n.id,
        title: n.title,
        relPath: n.rel_path,
        folderPath: relPathToFolderPath(n.rel_path),
        similarity: Number(n.similarity),
        potentialDuplicate: Number(n.similarity) >= duplicateThreshold,
      }),
    )
    .filter((n) => n.similarity >= similarThreshold)
    .slice(0, limit);
}

export interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  files: Array<{ relPath: string; title: string; testCount: number }>;
}

export function buildFolderTree(tests: TestRow[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [], files: [] };
  const byPath = new Map<string, TreeNode>();
  byPath.set('', root);

  const fileCounts = new Map<string, number>();
  for (const t of tests) {
    fileCounts.set(t.rel_path, (fileCounts.get(t.rel_path) ?? 0) + 1);
  }

  const folderSet = new Set<string>();
  for (const rel of fileCounts.keys()) {
    const parts = rel.split(/[/\\]/).filter(Boolean);
    for (let i = 0; i < parts.length - 1; i++) {
      folderSet.add(parts.slice(0, i + 1).join('/'));
    }
  }

  const sortedFolders = [...folderSet].sort();
  for (const folderPath of sortedFolders) {
    const parts = folderPath.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parent = byPath.get(parentPath) ?? root;
    const node: TreeNode = { name, path: folderPath, children: [], files: [] };
    parent.children.push(node);
    byPath.set(folderPath, node);
  }

  for (const [relPath, count] of fileCounts) {
    const parts = relPath.split(/[/\\]/).filter(Boolean);
    const fileName = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parent = byPath.get(parentPath) ?? root;
    parent.files.push({ relPath, title: fileName, testCount: count });
  }

  const sortTree = (node: TreeNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    node.children.forEach(sortTree);
  };
  sortTree(root);
  return root;
}
