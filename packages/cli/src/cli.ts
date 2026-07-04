#!/usr/bin/env node
import { runVisualize } from './visualize-command';

const [, , cmd, ...args] = process.argv;

function parseVerbose(argv: string[]): boolean {
  return argv.includes('--verbose') || argv.includes('-v');
}

function printHelp(): void {
  console.log(`
@testchimp/semantic-graph — Test suite semantic similarity

Required:
  --tests-dir <path>   Root folder to scan for *.spec/test.(ts|js|mjs|cjs)

Required environment variables:
  PROVIDER           openai | anthropic
  API_KEY            LLM provider API key
  VOYAGE_API_KEY     Required when PROVIDER=anthropic (embeddings via Voyage)

Optional:
  --port <n>         Listen port (default: 3859, or next free port if busy)
  --verbose, -v      Diagnostics to stderr
  EMBEDDING_MODEL    Default: text-embedding-3-small (openai) | voyage-4 (anthropic)
  LLM_MODEL          Default: gpt-5-nano (openai) | claude-3-5-haiku-latest (anthropic)
  SEMANTIC_GRAPH_EDGE_THRESHOLD       Default: 0.75
  SEMANTIC_GRAPH_DUPLICATE_THRESHOLD  Default: 0.92
  SEMANTIC_GRAPH_SIMILAR_THRESHOLD    Default: 0.80

Legacy env name: EMBEDDING_PROVIDER (alias for PROVIDER)

Commands:
  visualize --tests-dir <path> [--port <n>] [--verbose|-v]
    Scan tests, embed, and serve the semantic graph UI
  help
    Show this message
`);
}

function usage(): never {
  printHelp();
  process.exit(1);
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(cmd ? 0 : 1);
  }

  const verbose = parseVerbose(args);

  if (cmd === 'visualize') {
    const dirIdx = args.indexOf('--tests-dir');
    const testsDir = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
    if (!testsDir) {
      console.error('Error: --tests-dir is required\n');
      usage();
    }
    const portIdx = args.indexOf('--port');
    const port =
      portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : undefined;
    await runVisualize(testsDir, { verbose, port });
    return;
  }

  console.error(`Unknown command: ${cmd}\n`);
  usage();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
