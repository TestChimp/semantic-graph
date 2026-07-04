# @testchimp/semantic-graph

Test suite semantic similarity — find duplicate and related tests via embeddings, clustering, and a 2D graph.

## Packages

| Package | Description |
|---------|-------------|
| `@testchimp/semantic-graph-core` | Parser (vendored), embedding text, cosine similarity, UMAP layout, DBSCAN clusters |
| `@testchimp/semantic-graph` | CLI: `visualize` (scan → embed → serve UI) |
| `@testchimp/semantic-graph-viz` | Static freebie UI (folder tree + graph / clusters) |

## Quick start (OpenAI)

One API key for embeddings and LLM (cluster naming). No database required — embeddings are computed in memory each run.

```bash
export PROVIDER=openai
export API_KEY=sk-...
# optional:
# export EMBEDDING_MODEL=text-embedding-3-small
# export LLM_MODEL=gpt-5-nano

npx @testchimp/semantic-graph visualize --tests-dir ./tests
```

The CLI scans your tests, embeds them (with progress on TTY), then prints the UI URL (default port `3859`, or the next free port).

## Claude + Voyage (Anthropic LLM)

Anthropic does not ship an embedding API. Use **Voyage** for embeddings and **Claude** for LLM tasks:

```bash
export PROVIDER=anthropic
export API_KEY=sk-ant-...          # Anthropic — cluster naming / LLM
export VOYAGE_API_KEY=pa-...       # Voyage — embeddings
# optional:
# export EMBEDDING_MODEL=voyage-4
# export LLM_MODEL=claude-3-5-haiku-latest

npx @testchimp/semantic-graph visualize --tests-dir ./tests
```

## Commands

```bash
npx @testchimp/semantic-graph visualize --tests-dir <path> [--port <n>] [--verbose]
npx @testchimp/semantic-graph help
```

| Flag | Required | Description |
|------|----------|-------------|
| `--tests-dir` | yes | Root folder to scan for `*.spec/test.(ts\|js\|mjs\|cjs)` |
| `--port` | no | Listen port (default `3859`; scans upward if busy) |
| `--verbose` / `-v` | no | Diagnostics to stderr |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PROVIDER` | yes | `openai` \| `anthropic` |
| `API_KEY` | yes | LLM provider API key |
| `VOYAGE_API_KEY` | when `PROVIDER=anthropic` | Voyage API key for embeddings |
| `EMBEDDING_MODEL` | no | Embedding model (`text-embedding-3-small` or `voyage-4` defaults) |
| `LLM_MODEL` | no | LLM model (`gpt-5-nano` or `claude-3-5-haiku-latest` defaults) |

Legacy name `EMBEDDING_PROVIDER` is still accepted as an alias for `PROVIDER`.

## Continuous governance with TestChimp

This CLI is a local, standalone view of semantic similarity in your test suite. For **continuous** duplicate detection and broader quality governance — requirement traceability, release confidence, and keeping your suite healthy as it grows — see [TestChimp](https://testchimp.io).

## Monorepo

```bash
npm install
npm run build
```

## Publishing to npm

Publishable packages (in order):

1. `@testchimp/semantic-graph-core`
2. `@testchimp/semantic-graph` (bundles the viz UI in `static/viz/`)

Dry-run tarball contents before publishing:

```bash
npm run pack:check
```

Publish (requires `@testchimp` npm org access):

```bash
npm publish -w @testchimp/semantic-graph-core --access public
npm publish -w @testchimp/semantic-graph --access public
```

Bump **both** package versions together and update the CLI’s `@testchimp/semantic-graph-core` dependency to match before each release.
