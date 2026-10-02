import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { EmbeddedPostgresPool } from './embeddedPool.js';

const { Pool } = pg;

export async function createDatabase() {
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query('SELECT 1');
    return { pool, close: () => pool.end(), mode: 'managed-postgresql' };
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production.');
  }

  const dataDirectory = resolve(process.env.LOCAL_DATABASE_DIRECTORY ?? '.data/lead-exchange');
  await mkdir(dataDirectory, { recursive: true });
  const database = new PGlite(dataDirectory);
  await database.waitReady;
  const pool = new EmbeddedPostgresPool(database);
  return { pool, close: () => pool.end(), mode: 'embedded-postgresql' };
}