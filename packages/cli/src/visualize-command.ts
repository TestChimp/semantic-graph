import fs from 'fs';
import path from 'path';
import express from 'express';
import { extractEmbeddingDraftsFromFile } from '@testchimp/semantic-graph-core';
import { loadEnvConfig } from './env';
import { embedTexts } from './embedder';
import { InMemoryEmbeddingStore } from './in-memory-store';
import { resolveListenPort } from './port';
import { createFileProgressReporter, globTests } from './scan-tests';
import { buildFolderTree, buildScopedGraph } from './graph-service';
import { resolveVizDistDir } from './viz-static';

const EMBED_BATCH_SIZE = 64;

export interface VisualizeOptions {
  verbose?: boolean;
  port?: number;
}

interface PendingEmbed {
  relPath: string;
  testName: string;
  suitePath: string[];
  title: string;
  content: string;
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return '…';
  return `…${key.slice(-6)}`;
}

async function buildStoreFromTests(
  testsDir: string,
  options: VisualizeOptions,
): Promise<InMemoryEmbeddingStore> {
  const config = loadEnvConfig();
  const verbose = options.verbose ?? false;
  const absRoot = path.resolve(testsDir);
  const files = globTests(absRoot);
  console.log(`Found ${files.length} test files under ${absRoot}`);
  if (verbose) {
    console.error(`[semantic-graph] provider=${config.provider} embeddingModel=${config.embeddingModel}`);
  }

  const progress = createFileProgressReporter(files.length);
  let unparseable = 0;
  const pending: PendingEmbed[] = [];
  const fileIndexByPath = new Map<string, number>();

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const relPath = path.relative(absRoot, filePath);
    fileIndexByPath.set(relPath, i);
    const content = fs.readFileSync(filePath, 'utf8');
    const { drafts, parseError } = extractEmbeddingDraftsFromFile(content);
    if (parseError) {
      unparseable++;
      progress.warnUnparseable(relPath, parseError);
      progress.report(i + 1, relPath);
      continue;
    }
    for (const draft of drafts) {
      pending.push({
        relPath,
        testName: draft.testName,
        suitePath: draft.suitePath,
        title: draft.title,
        content: draft.content,
      });
    }
    progress.report(i + 1, relPath, pending.length ? `${pending.length} queued` : undefined);
  }

  const store = new InMemoryEmbeddingStore();

  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const chunk = pending.slice(i, i + EMBED_BATCH_SIZE);
    if (verbose) {
      console.error(
        `[semantic-graph] Embedding batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1} (${chunk.length} tests)`,
      );
    }
    const embeddings = await embedTexts(config, chunk.map((p) => p.content));
    store.addMany(
      chunk.map((item, j) => ({
        relPath: item.relPath,
        testName: item.testName,
        suitePath: item.suitePath,
        title: item.title,
        content: item.content,
        embedding: embeddings[j],
      })),
    );
    const lastItem = chunk[chunk.length - 1];
    const fileIdx = fileIndexByPath.get(lastItem.relPath) ?? files.length - 1;
    progress.report(
      fileIdx + 1,
      lastItem.relPath,
      `embedded ${Math.min(i + chunk.length, pending.length)}/${pending.length} tests`,
    );
  }

  progress.finish();
  const parts = [`Embedded ${pending.length} tests from ${files.length} files`];
  if (unparseable > 0) parts.push(`${unparseable} unparseable`);
  console.log(`${parts.join(', ')}.`);

  return store;
}

export async function runVisualize(testsDir: string, options: VisualizeOptions = {}): Promise<void> {
  const config = loadEnvConfig();
  const verbose = options.verbose ?? false;
  const port = await resolveListenPort(options.port);

  const store = await buildStoreFromTests(testsDir, options);

  const app = express();

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/tree', (_req, res) => {
    try {
      const rows = store.listForTree();
      res.json({ tree: buildFolderTree(rows), testCount: rows.length });
    } catch (e: unknown) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/graph', async (req, res) => {
    try {
      const folderPrefix = typeof req.query.folder === 'string' ? req.query.folder : undefined;
      const relPath = typeof req.query.file === 'string' ? req.query.file : undefined;
      const viewMode = req.query.view === 'list' ? 'list' : 'graph';
      const payload = await buildScopedGraph(
        store,
        config,
        { folderPrefix, relPath },
        viewMode,
        { verbose },
      );
      res.json(payload);
    } catch (e: unknown) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/similar', (req, res) => {
    try {
      const testId = typeof req.query.testId === 'string' ? req.query.testId : '';
      const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10));
      if (!testId) {
        res.status(400).json({ error: 'testId required' });
        return;
      }
      const entries = store.findSimilar(testId, limit, config.thresholds);
      res.json({ entries });
    } catch (e: unknown) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  const vizDist = resolveVizDistDir();
  app.use(express.static(vizDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(vizDist, 'index.html'));
  });

  app.listen(port, () => {
    console.log(`Semantic graph UI: http://localhost:${port}`);
    console.log('Built by TestChimp — Git-Native QA Governance platform for agentic teams');
    if (verbose) {
      console.error('[semantic-graph] Verbose logging enabled');
      console.error(
        `[semantic-graph] provider=${config.provider} embeddingModel=${config.embeddingModel} llmModel=${config.llmModel} apiKey=${maskApiKey(config.apiKey)}`,
      );
    }
  });
}
