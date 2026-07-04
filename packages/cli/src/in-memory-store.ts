import { randomUUID } from 'crypto';
import {
  findNearestNeighbors,
  type EmbeddingRecord,
  type Thresholds,
} from '@testchimp/semantic-graph-core';
import type { TestRow } from './graph-service';

export interface StoredTest {
  id: string;
  relPath: string;
  testName: string;
  suitePath: string[];
  title: string;
  content: string;
  embedding: number[];
}

function relPathToFolderPath(relPath: string): string[] {
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 1) return [];
  return parts.slice(0, -1);
}

function matchesScope(relPath: string, scope: { folderPrefix?: string; relPath?: string }): boolean {
  if (scope.relPath) return relPath === scope.relPath;
  if (scope.folderPrefix !== undefined && scope.folderPrefix !== '') {
    return relPath === scope.folderPrefix || relPath.startsWith(`${scope.folderPrefix}/`);
  }
  return true;
}

export class InMemoryEmbeddingStore {
  private records: StoredTest[] = [];

  addMany(rows: Omit<StoredTest, 'id'>[]): void {
    for (const row of rows) {
      this.records.push({ ...row, id: randomUUID() });
    }
  }

  listForTree(): TestRow[] {
    return this.records.map((r) => ({
      id: r.id,
      rel_path: r.relPath,
      test_name: r.testName,
      suite_path: r.suitePath,
      title: r.title,
    }));
  }

  loadScoped(scope: { folderPrefix?: string; relPath?: string }): EmbeddingRecord[] {
    return this.records
      .filter((r) => r.embedding.length > 0 && matchesScope(r.relPath, scope))
      .sort((a, b) => {
        const pathCmp = a.relPath.localeCompare(b.relPath);
        if (pathCmp !== 0) return pathCmp;
        return a.title.localeCompare(b.title);
      })
      .map((r) => ({
        id: r.id,
        title: r.title,
        folderPath: relPathToFolderPath(r.relPath),
        fileId: r.relPath,
        embedding: r.embedding,
      }));
  }

  findSimilar(
    testId: string,
    limit: number,
    thresholds: Thresholds,
  ): Array<{
    testId: string;
    title: string;
    folderPath: string[];
    relPath: string;
    similarity: number;
    potentialDuplicate: boolean;
  }> {
    const focus = this.records.find((r) => r.id === testId);
    if (!focus || focus.embedding.length === 0) return [];

    const corpus: EmbeddingRecord[] = this.records
      .filter((r) => r.embedding.length > 0)
      .map((r) => ({
        id: r.id,
        title: r.title,
        folderPath: relPathToFolderPath(r.relPath),
        fileId: r.relPath,
        embedding: r.embedding,
      }));

    const focusRecord: EmbeddingRecord = {
      id: focus.id,
      title: focus.title,
      folderPath: relPathToFolderPath(focus.relPath),
      fileId: focus.relPath,
      embedding: focus.embedding,
    };

    const relById = new Map(this.records.map((r) => [r.id, r.relPath]));

    return findNearestNeighbors(focusRecord, corpus, limit, thresholds).map((e) => ({
      testId: e.testId,
      title: e.title,
      folderPath: e.folderPath,
      relPath: relById.get(e.testId) ?? '',
      similarity: e.similarity,
      potentialDuplicate: e.potentialDuplicate,
    }));
  }
}
