import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { clusterEmbeddings, clusterTitles } from './cluster';
import { DEFAULT_ANTHROPIC_CHEAP_MODEL, VERY_CHEAP_MODEL } from './models';
import { layout2D } from './layout';
import { buildKnnEdges, buildSimilarityMatrix } from './similarity';
import type {
  BuildGraphOptions,
  EmbeddingRecord,
  SemanticGraphPayload,
  TestSemanticCluster,
  TestSemanticEdge,
  TestSemanticNode,
} from './types';
import { DEFAULT_THRESHOLDS } from './types';

const MAX_GRAPH_NODES = 5000;

export function buildGraph(
  records: EmbeddingRecord[],
  options: BuildGraphOptions = {},
): SemanticGraphPayload {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const maxNodes = options.maxNodes ?? MAX_GRAPH_NODES;
  const umapRandomState = options.umapRandomState ?? 42;

  let scopeTruncatedWarning: string | undefined;
  let scoped = [...records];
  if (scoped.length > maxNodes) {
    scoped.sort((a, b) => {
      const fa = (a.folderPath ?? []).join('/');
      const fb = (b.folderPath ?? []).join('/');
      if (fa !== fb) return fa.localeCompare(fb);
      return a.title.localeCompare(b.title);
    });
    scoped = scoped.slice(0, maxNodes);
    scopeTruncatedWarning = `Showing first ${maxNodes} tests in scope (sorted by folder path and title).`;
  }

  if (scoped.length === 0) {
    return { nodes: [], edges: [], clusters: [], scopeTruncatedWarning };
  }

  const matrix = options.skipEdges ? null : buildSimilarityMatrix(scoped);
  const labels = scoped.length >= 5
    ? clusterEmbeddings(scoped, thresholds.edge)
    : scoped.map((_, i) => i);

  const positions = options.skipLayout
    ? scoped.map(() => ({ x: undefined, y: undefined }))
    : layout2D(
        scoped.map((r) => r.embedding),
        umapRandomState,
      );

  const nodes: TestSemanticNode[] = scoped.map((r, i) => ({
    testId: r.id,
    title: r.title,
    folderPath: r.folderPath ?? [],
    fileId: r.fileId,
    x: positions[i]?.x,
    y: positions[i]?.y,
    clusterId: labels[i],
  }));

  const rawEdges = options.skipEdges || !matrix
    ? []
    : buildKnnEdges(scoped, matrix, 4, thresholds.edge);
  const edges: TestSemanticEdge[] = rawEdges.map((e) => ({
    sourceTestId: e.source,
    targetTestId: e.target,
    similarity: e.similarity,
  }));

  const titleMap = clusterTitles(scoped, labels);
  const clusters: TestSemanticCluster[] = [...titleMap.entries()].map(([clusterId]) => ({
    clusterId,
    label: `Cluster ${clusterId + 1}`,
    testIds: scoped.filter((_, i) => labels[i] === clusterId).map((r) => r.id),
  }));

  return {
    nodes,
    edges,
    clusters,
    scopeTruncatedWarning,
  };
}

/** Apply LLM theme labels to graph clusters. */
export async function applyClusterNames(
  graph: SemanticGraphPayload,
  config: ClusterNamingConfig,
): Promise<SemanticGraphPayload> {
  if (!config.apiKey || graph.clusters.length === 0) return graph;
  const nodeById = new Map(graph.nodes.map((n) => [n.testId, n]));
  const clusters: TestSemanticCluster[] = [];
  for (const c of graph.clusters) {
    const titles = c.testIds
      .map((id) => nodeById.get(id)?.title)
      .filter((t): t is string => !!t);
    if (!titles.length) {
      clusters.push(c);
      continue;
    }
    const label = await nameCluster(titles, config);
    clusters.push({ ...c, label });
  }
  return { ...graph, clusters };
}

export type LlmProvider = 'openai' | 'anthropic';

export interface ClusterNamingConfig {
  apiKey: string;
  model?: string;
  provider?: LlmProvider;
}

const CLUSTER_LABEL_PROMPT = (titles: string[]) =>
  `Given these test titles, return a 1-3 word theme label (e.g. auth, checkout). Titles:\n${titles.map((t) => `- ${t}`).join('\n')}\nLabel only:`;

function sanitizeClusterLabel(text: string | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim().replace(/^["']|["']$/g, '');
  return trimmed.length > 0 && trimmed.length <= 40 ? trimmed : null;
}

/** LLM cluster naming — uses VERY_CHEAP_MODEL on OpenAI by default. */
export async function nameCluster(
  titles: string[],
  config: ClusterNamingConfig,
): Promise<string> {
  const sample = titles.slice(0, 20);
  const provider = config.provider ?? 'openai';
  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey: config.apiKey });
      const res = await client.messages.create({
        model: config.model ?? DEFAULT_ANTHROPIC_CHEAP_MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: CLUSTER_LABEL_PROMPT(sample) }],
      });
      const block = res.content.find((b) => b.type === 'text');
      const label = sanitizeClusterLabel(block?.type === 'text' ? block.text : undefined);
      if (label) return label;
    } else {
      const client = new OpenAI({ apiKey: config.apiKey });
      const res = await client.chat.completions.create({
        model: config.model ?? VERY_CHEAP_MODEL,
        max_tokens: 16,
        temperature: 0,
        messages: [{ role: 'user', content: CLUSTER_LABEL_PROMPT(sample) }],
      });
      const label = sanitizeClusterLabel(res.choices[0]?.message?.content?.trim());
      if (label) return label;
    }
  } catch {
    // fall through
  }
  return 'Cluster';
}
