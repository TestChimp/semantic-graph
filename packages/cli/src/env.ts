import {
  DEFAULT_ANTHROPIC_CHEAP_MODEL,
  VERY_CHEAP_MODEL,
} from '@testchimp/semantic-graph-core';

export type Provider = 'openai' | 'anthropic';

export interface EnvConfig {
  databaseUrl: string;
  /** LLM provider (cluster naming, etc.). */
  provider: Provider;
  /** API key for the LLM provider (`API_KEY`). */
  apiKey: string;
  /** Voyage API key — required when `provider=anthropic` (Anthropic has no embedding API). */
  voyageApiKey?: string;
  embeddingModel: string;
  llmModel: string;
  thresholds: {
    edge: number;
    duplicate: number;
    similar: number;
  };
}

const DEFAULT_EMBEDDING_MODEL: Record<Provider, string> = {
  openai: 'text-embedding-3-small',
  anthropic: 'voyage-4',
};

const DEFAULT_LLM_MODEL: Record<Provider, string> = {
  openai: VERY_CHEAP_MODEL,
  anthropic: DEFAULT_ANTHROPIC_CHEAP_MODEL,
};

function readProvider(): Provider | undefined {
  const raw = process.env.PROVIDER ?? process.env.EMBEDDING_PROVIDER;
  if (raw === 'openai' || raw === 'anthropic') return raw;
  return undefined;
}

function readApiKey(): string | undefined {
  return process.env.API_KEY;
}

export function loadEnvConfig(): EnvConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const provider = readProvider();
  const apiKey = readApiKey();
  const voyageApiKey = process.env.VOYAGE_API_KEY;

  const missing: string[] = [];
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (!provider) missing.push('PROVIDER (openai | anthropic)');
  if (!apiKey) missing.push('API_KEY (LLM provider key)');
  if (provider === 'anthropic' && !voyageApiKey) {
    missing.push('VOYAGE_API_KEY (required when PROVIDER=anthropic)');
  }

  if (missing.length) {
    console.error('Missing required environment variables:\n');
    for (const m of missing) console.error(`  - ${m}`);
    console.error(`
Example (OpenAI — one key for embeddings + LLM):
  export DATABASE_URL="postgresql://user:pass@localhost:5432/tests"
  export PROVIDER=openai
  export API_KEY=sk-...
  export EMBEDDING_MODEL=text-embedding-3-small   # optional
  export LLM_MODEL=gpt-5-nano                     # optional

Example (Claude + Voyage — Anthropic has no embedding API):
  export PROVIDER=anthropic
  export API_KEY=sk-ant-...                       # Anthropic key (LLM / cluster naming)
  export VOYAGE_API_KEY=pa-...                  # Voyage key (index embeddings)
  export EMBEDDING_MODEL=voyage-4                 # optional
  export LLM_MODEL=claude-3-5-haiku-latest        # optional
`);
    process.exit(1);
  }

  return {
    databaseUrl: databaseUrl!,
    provider: provider!,
    apiKey: apiKey!,
    voyageApiKey: voyageApiKey || undefined,
    embeddingModel: process.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL[provider!],
    llmModel: process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL[provider!],
    thresholds: {
      edge: parseFloat(process.env.SEMANTIC_GRAPH_EDGE_THRESHOLD ?? '0.75'),
      duplicate: parseFloat(process.env.SEMANTIC_GRAPH_DUPLICATE_THRESHOLD ?? '0.92'),
      similar: parseFloat(process.env.SEMANTIC_GRAPH_SIMILAR_THRESHOLD ?? '0.80'),
    },
  };
}
