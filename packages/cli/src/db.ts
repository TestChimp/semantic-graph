import pg from 'pg';

export async function withPool<T>(databaseUrl: string, fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export async function ensureSchema(pool: pg.Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_embeddings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rel_path TEXT NOT NULL,
      test_name TEXT NOT NULL,
      suite_path JSONB NOT NULL DEFAULT '[]',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding vector,
      content_hash VARCHAR(64) NOT NULL,
      UNIQUE(rel_path, test_name, suite_path)
    )
  `);
}
