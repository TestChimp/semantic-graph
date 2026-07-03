import express from 'express';
import path from 'path';
import { loadEnvConfig } from './env';
import { withPool } from './db';
import {
  buildFolderTree,
  buildScopedGraph,
  findSimilarTests,
  type TestRow,
} from './graph-service';
import { resolveVizDistDir } from './viz-static';

export async function runVisualize(port: number): Promise<void> {
  const config = loadEnvConfig();
  const app = express();

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/tree', async (_req, res) => {
    try {
      const rows = await withPool(config.databaseUrl, async (pool) => {
        const r = await pool.query<TestRow>(
          `SELECT id, rel_path, test_name, suite_path, title FROM test_embeddings ORDER BY rel_path, test_name`,
        );
        return r.rows;
      });
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
      const payload = await withPool(config.databaseUrl, async (pool) =>
        buildScopedGraph(pool, config, { folderPrefix, relPath }, viewMode),
      );
      res.json(payload);
    } catch (e: unknown) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/similar', async (req, res) => {
    try {
      const testId = typeof req.query.testId === 'string' ? req.query.testId : '';
      const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10));
      if (!testId) {
        res.status(400).json({ error: 'testId required' });
        return;
      }
      const entries = await withPool(config.databaseUrl, async (pool) =>
        findSimilarTests(
          pool,
          testId,
          limit,
          config.thresholds.duplicate,
          config.thresholds.similar,
        ),
      );
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
  });
}
