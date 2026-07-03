#!/usr/bin/env node
import { runIndex } from './index-command';
import { runVisualize } from './visualize-command';

const [, , cmd, ...args] = process.argv;

function usage(): never {
  console.error(`
@testchimp/semantic-graph — Test suite semantic similarity

Required environment variables:
  DATABASE_URL       Postgres connection string (pgvector enabled)
  PROVIDER           openai | anthropic
  API_KEY            LLM provider API key
  VOYAGE_API_KEY     Required when PROVIDER=anthropic (embeddings via Voyage)

Optional:
  EMBEDDING_MODEL    Default: text-embedding-3-small (openai) | voyage-4 (anthropic)
  LLM_MODEL          Default: gpt-5-nano (openai) | claude-3-5-haiku-latest (anthropic)
  SEMANTIC_GRAPH_EDGE_THRESHOLD       Default: 0.75
  SEMANTIC_GRAPH_DUPLICATE_THRESHOLD  Default: 0.92
  SEMANTIC_GRAPH_SIMILAR_THRESHOLD    Default: 0.80

Legacy env name: EMBEDDING_PROVIDER (alias for PROVIDER)

Commands:
  index --tests-dir <path>     Scan tests and upsert embeddings
  visualize [--port 3847]      Local UI server
`);
  process.exit(1);
}

async function main() {
  if (cmd === 'index') {
    const dirIdx = args.indexOf('--tests-dir');
    const testsDir = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
    if (!testsDir) usage();
    await runIndex(testsDir);
    return;
  }
  if (cmd === 'visualize') {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 3847;
    await runVisualize(port);
    return;
  }
  usage();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
