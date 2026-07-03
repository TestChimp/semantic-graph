import fs from 'fs';
import path from 'path';
import { extractEmbeddingDraftsFromFile } from '@testchimp/semantic-graph-core';
import { loadEnvConfig } from './env';
import { ensureSchema, withPool } from './db';
import { embedTexts, toPgVector } from './embedder';

const EMBED_BATCH_SIZE = 64;

function globTests(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(spec|test)\.(ts|js|mjs|cjs)$/.test(ent.name)) out.push(p);
    }
  }
  walk(root);
  return out;
}

function truncateForTerminal(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 3) return text.slice(0, maxLen);
  return `${text.slice(0, maxLen - 3)}...`;
}

function createFileProgressReporter(totalFiles: number) {
  const isTty = Boolean(process.stdout.isTTY);
  const width = Math.max(40, (process.stdout.columns ?? 80) - 1);

  return {
    isTty,
    report(processedFiles: number, relPath: string, extra?: string) {
      if (totalFiles === 0) return;
      const label = truncateForTerminal(relPath, Math.min(40, width - 28));
      const suffix = extra ? ` — ${extra}` : '';
      const line = `Processing ${processedFiles}/${totalFiles} files — ${label}${suffix}`;
      if (isTty) {
        process.stdout.write(`\r${line.padEnd(width)}`);
        return;
      }
      if (processedFiles === 1 || processedFiles === totalFiles || processedFiles % 25 === 0) {
        console.log(line);
      }
    },
    finish() {
      if (isTty && totalFiles > 0) process.stdout.write('\n');
    },
    warnUnparseable(relPath: string, reason: string) {
      if (isTty) {
        process.stderr.write(`\nWarn: skip unparseable ${relPath}: ${reason}\n`);
      } else {
        console.warn(`Skip unparseable ${relPath}: ${reason}`);
      }
    },
  };
}

interface PendingEmbed {
  relPath: string;
  testName: string;
  suiteJson: string;
  title: string;
  content: string;
  contentHash: string;
}

export async function runIndex(testsDir: string): Promise<void> {
  const config = loadEnvConfig();
  const absRoot = path.resolve(testsDir);
  const files = globTests(absRoot);
  console.log(`Found ${files.length} test files under ${absRoot}`);

  const progress = createFileProgressReporter(files.length);
  let indexed = 0;
  let skipped = 0;
  let unparseable = 0;
  const pending: PendingEmbed[] = [];
  const fileIndexByPath = new Map<string, number>();

  await withPool(config.databaseUrl, async (pool) => {
    await ensureSchema(pool);

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
        const suiteJson = JSON.stringify(draft.suitePath);
        const existing = await pool.query(
          `SELECT content_hash FROM test_embeddings WHERE rel_path = $1 AND test_name = $2 AND suite_path = $3::jsonb`,
          [relPath, draft.testName, suiteJson],
        );
        if (existing.rows[0]?.content_hash === draft.contentHash) {
          skipped++;
          continue;
        }
        pending.push({
          relPath,
          testName: draft.testName,
          suiteJson,
          title: draft.title,
          content: draft.content,
          contentHash: draft.contentHash,
        });
      }
      progress.report(i + 1, relPath, pending.length ? `${pending.length} queued` : undefined);
    }

    for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
      const chunk = pending.slice(i, i + EMBED_BATCH_SIZE);
      const embeddings = await embedTexts(config, chunk.map((p) => p.content));
      for (let j = 0; j < chunk.length; j++) {
        const item = chunk[j];
        await pool.query(
          `INSERT INTO test_embeddings (rel_path, test_name, suite_path, title, content, embedding, content_hash)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6::vector, $7)
           ON CONFLICT (rel_path, test_name, suite_path)
           DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content,
             embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash`,
          [
            item.relPath,
            item.testName,
            item.suiteJson,
            item.title,
            item.content,
            toPgVector(embeddings[j]),
            item.contentHash,
          ],
        );
        indexed++;
      }
      const lastItem = chunk[chunk.length - 1];
      const fileIdx = fileIndexByPath.get(lastItem.relPath) ?? files.length - 1;
      progress.report(
        fileIdx + 1,
        lastItem.relPath,
        `embedded ${Math.min(i + chunk.length, pending.length)}/${pending.length} tests`,
      );
    }
  });

  progress.finish();
  const parts = [`Indexed/updated: ${indexed}`, `skipped (unchanged): ${skipped}`];
  if (unparseable > 0) parts.push(`unparseable files: ${unparseable}`);
  console.log(`Done. ${parts.join(', ')}.`);
}
