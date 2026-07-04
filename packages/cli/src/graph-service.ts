import {
  applyClusterNames,
  buildGraph,
  type EmbeddingRecord,
  type SemanticGraphPayload,
} from '@testchimp/semantic-graph-core';
import type { InMemoryEmbeddingStore } from './in-memory-store';
import type { EnvConfig } from './env';

export interface TestRow {
  id: string;
  rel_path: string;
  test_name: string;
  suite_path: string[] | unknown;
  title: string;
}

function clusterNamingConfig(config: EnvConfig, verbose?: boolean) {
  return {
    apiKey: config.apiKey,
    model: config.llmModel,
    provider: config.provider,
    ...(verbose
      ? { log: (message: string) => console.error('[semantic-graph]', message) }
      : {}),
  };
}

export async function buildScopedGraph(
  store: InMemoryEmbeddingStore,
  config: EnvConfig,
  scope: { folderPrefix?: string; relPath?: string },
  viewMode: 'graph' | 'list' = 'graph',
  options?: { verbose?: boolean },
): Promise<SemanticGraphPayload> {
  const records: EmbeddingRecord[] = store.loadScoped(scope);
  if (records.length === 0) {
    return { nodes: [], edges: [], clusters: [] };
  }
  const graph = buildGraph(records, {
    maxNodes: records.length,
    thresholds: config.thresholds,
    ...(viewMode === 'list' ? { skipLayout: true, skipEdges: true } : {}),
  });
  const naming = clusterNamingConfig(config, options?.verbose);
  if (viewMode === 'list') {
    return applyClusterNames({ ...graph, edges: [] }, naming);
  }
  return applyClusterNames(graph, naming);
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
