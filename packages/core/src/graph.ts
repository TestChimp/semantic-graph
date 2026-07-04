import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { clusterEmbeddings, clusterTitles, heuristicClusterLabel } from './cluster';
import {
  DEFAULT_ANTHROPIC_CHEAP_MODEL,
  VERY_CHEAP_MODEL,
} from './models';
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
  if (graph.clusters.length === 0) return graph;
  if (!config.apiKey) {
    logNaming(config, 'Cluster naming skipped: API_KEY not set');
    return graph;
  }

  const nodeById = new Map(graph.nodes.map((n) => [n.testId, n]));
  const clusterInputs: ClusterNamingInput[] = [];
  for (const c of graph.clusters) {
    const titles = c.testIds
      .map((id) => nodeById.get(id)?.title)
      .filter((t): t is string => !!t);
    if (titles.length) {
      clusterInputs.push({ clusterId: c.clusterId, titles });
    }
  }

  if (clusterInputs.length === 0) return graph;

  const provider = config.provider ?? 'openai';
  const model = config.model ?? (provider === 'anthropic' ? DEFAULT_ANTHROPIC_CHEAP_MODEL : VERY_CHEAP_MODEL);
  const batchCount = Math.ceil(clusterInputs.length / BATCH_CLUSTER_LIMIT);
  logNaming(
    config,
    `Naming ${clusterInputs.length} clusters in ${batchCount} LLM call${batchCount === 1 ? '' : 's'} (provider=${provider}, model=${model})`,
  );

  const labelById = new Map<number, string>();
  for (let i = 0; i < clusterInputs.length; i += BATCH_CLUSTER_LIMIT) {
    const chunk = clusterInputs.slice(i, i + BATCH_CLUSTER_LIMIT);
    const batchLabels = await nameClusterBatch(chunk, config);
    for (const [id, label] of batchLabels) {
      labelById.set(id, label);
    }
  }

  let llmNamed = 0;
  const clusters: TestSemanticCluster[] = graph.clusters.map((c) => {
    const titles = c.testIds
      .map((id) => nodeById.get(id)?.title)
      .filter((t): t is string => !!t);
    const llmLabel = labelById.get(c.clusterId);
    if (llmLabel) {
      llmNamed++;
      return { ...c, label: llmLabel };
    }
    const fallback = resolveClusterLabel(c, titles, config);
    return { ...c, label: fallback };
  });

  logNaming(config, `LLM named ${llmNamed}/${clusterInputs.length} clusters`);
  return { ...graph, clusters };
}

export type LlmProvider = 'openai' | 'anthropic';

export interface ClusterNamingConfig {
  apiKey: string;
  model?: string;
  provider?: LlmProvider;
  /** When set, naming diagnostics are emitted here (CLI wires to stderr). */
  log?: (message: string) => void;
}

const BATCH_CLUSTER_LIMIT = 50;
const MAX_TITLES_PER_CLUSTER = 12;
const MAX_LABEL_WORDS = 6;

const SYSTEM_BATCH_NAMING_PROMPT = `You name test clusters for a semantic graph UI legend.

For each cluster id, assign ONE short category name (1-3 words, max 40 characters). Examples: auth, checkout, api-contracts, settings-page, admin-tasks etc.

Rules:
- Summarize the shared theme across the test titles.
- Do NOT list keywords, concatenate title words, or repeat test names.
- Do NOT explain your reasoning.
- Respond with valid JSON only, matching the required output schema.`;

interface ClusterNamingInput {
  clusterId: number;
  titles: string[];
}

function logNaming(config: ClusterNamingConfig, message: string): void {
  config.log?.(message);
}

function sanitizeClusterLabel(text: string | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim().replace(/^["']|["']$/g, '');
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  if (/^cluster$/i.test(trimmed)) return null;
  if (isKeywordDumpLabel(trimmed)) return null;
  return trimmed;
}

function isKeywordDumpLabel(label: string): boolean {
  return label.trim().split(/\s+/).filter(Boolean).length > MAX_LABEL_WORDS;
}

function buildBatchNamingPrompt(inputs: ClusterNamingInput[]): string {
  const payload = {
    clusters: inputs.map((c) => ({
      id: c.clusterId,
      titles: c.titles.slice(0, MAX_TITLES_PER_CLUSTER),
    })),
  };
  return `Name each cluster below. Return JSON only in this exact shape:
{"labels":[{"id":0,"label":"auth"},{"id":1,"label":"api-contracts"}]}

Bad labels (never do this):
- "http contract screen states json bunnyshell events workflow" (keyword list)
- "scenario-mappings scenario-mappings test-runs execution-history" (repeated title words)

Good labels: "auth", "test-runs", "api-contracts", "checkout"

If titles share a domain, name the domain. If mixed, pick the dominant theme. Never enumerate words from titles.

Input:
${JSON.stringify(payload, null, 2)}`;
}

function parseBatchLabelResponse(raw: string): Map<number, string> {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const jsonText = fence ? fence[1].trim() : trimmed;
  const parsed = JSON.parse(jsonText) as unknown;
  if (!parsed || typeof parsed !== 'object' || !('labels' in parsed)) {
    throw new Error('missing labels array');
  }
  const labels = (parsed as { labels: unknown }).labels;
  if (!Array.isArray(labels)) throw new Error('labels is not an array');

  const out = new Map<number, string>();
  for (const entry of labels) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, label } = entry as { id?: unknown; label?: unknown };
    if (typeof id !== 'number' || typeof label !== 'string') continue;
    const clean = sanitizeClusterLabel(label);
    if (clean) out.set(id, clean);
  }
  return out;
}

async function callBatchNamingLlm(
  inputs: ClusterNamingInput[],
  config: ClusterNamingConfig,
): Promise<string> {
  const provider = config.provider ?? 'openai';
  const model = config.model ?? (provider === 'anthropic' ? DEFAULT_ANTHROPIC_CHEAP_MODEL : VERY_CHEAP_MODEL);
  const userContent = buildBatchNamingPrompt(inputs);

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: config.apiKey });
    const res = await client.messages.create({
      model,
      max_tokens: Math.min(4096, 256 + inputs.length * 32),
      system: SYSTEM_BATCH_NAMING_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });
    const block = res.content.find((b) => b.type === 'text');
    if (block?.type !== 'text' || !block.text.trim()) {
      throw new Error('empty Anthropic response');
    }
    return block.text.trim();
  }

  const client = new OpenAI({ apiKey: config.apiKey });
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_BATCH_NAMING_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
  });
  const content = res.choices[0]?.message?.content?.trim();
  if (!content) throw new Error('empty OpenAI response');
  return content;
}

async function nameClusterBatch(
  inputs: ClusterNamingInput[],
  config: ClusterNamingConfig,
): Promise<Map<number, string>> {
  if (inputs.length === 0) return new Map();
  try {
    const raw = await callBatchNamingLlm(inputs, config);
    return parseBatchLabelResponse(raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logNaming(config, `Batch LLM naming failed: ${msg}`);
    return new Map();
  }
}

function resolveClusterLabel(
  cluster: TestSemanticCluster,
  titles: string[],
  config: ClusterNamingConfig,
): string {
  const prefix = `Cluster ${cluster.clusterId + 1}`;
  const heuristic = heuristicClusterLabel(titles);
  if (heuristic) {
    logNaming(config, `${prefix}: using heuristic label "${heuristic}"`);
    return heuristic;
  }
  logNaming(config, `${prefix}: keeping placeholder label`);
  return cluster.label ?? prefix;
}

/** @deprecated Use applyClusterNames — kept for callers naming a single cluster. */
export async function nameCluster(
  titles: string[],
  config: ClusterNamingConfig,
  clusterId?: number,
): Promise<string | null> {
  if (clusterId == null) {
    const heuristic = heuristicClusterLabel(titles);
    return heuristic;
  }
  const batch = await nameClusterBatch([{ clusterId, titles }], config);
  const label = batch.get(clusterId);
  if (label) return label;
  return heuristicClusterLabel(titles);
}
