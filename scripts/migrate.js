import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../src/db/connect.js';

const { pool, close, mode } = await createDatabase();
try {
  const migrationDirectory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    const version = Number(name.slice(0, 3));
    if (!Number.isInteger(version) || version < 1) throw new Error(`Invalid migration filename: ${name}`);
    const ledger = await pool.query("SELECT to_regclass('public.schema_migrations') AS table_name");
    if (ledger.rows[0].table_name) {
      const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (applied.rowCount) {
        console.log(`Skipped ${name}; already applied.`);
        continue;
      }
    }
    const migration = await readFile(join(migrationDirectory, name), 'utf8');
    if (typeof pool.exec === 'function') await pool.exec(migration);
    else await pool.query(migration);
    await pool.query('INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [version]);
    console.log(`Applied ${name} using ${mode}.`);
  }
} catch {
  console.error('Database migration failed. Verify database access and schema permissions.');
  process.exitCode = 1;
} finally {
  await close();
}