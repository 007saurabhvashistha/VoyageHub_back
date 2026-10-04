import 'dotenv/config';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import pg from 'pg';
import { config } from '../src/config/index.js';
import { backupFileStem, captureManifest, describeDatabase, pgToolVersion, recordOperationRun, runPgTool, sha256File } from '../src/services/databaseBackup.js';
import { createStorage } from '../src/services/storage/index.js';

// Usage: npm run db:backup [-- --upload]
// Takes a pg_dump (custom format) and a manifest captured in the same snapshot, so the restore drill can verify it exactly.
const upload = process.argv.includes('--upload');
// pg_dump --snapshot needs a direct (non-pooled) connection; BACKUP_DATABASE_URL lets you use one.
const sourceUrl = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
if (!sourceUrl) {
  console.error('Set DATABASE_URL (or BACKUP_DATABASE_URL for a direct, non-pooled connection).');
  process.exit(1);
}

const startedAt = new Date();
const directory = resolve(config.operations.backupDirectory);
const stem = backupFileStem(startedAt);
const dumpPath = join(directory, `${stem}.dump`);
const manifestPath = join(directory, `${stem}.manifest.json`);
const client = new pg.Client({ connectionString: sourceUrl });
const details = { database: describeDatabase(sourceUrl), file: basename(dumpPath) };
let status = 'failed';
let connected = false;
let inTransaction = false;

try {
  await mkdir(directory, { recursive: true });
  await client.connect();
  connected = true;
  details.pgDumpVersion = await pgToolVersion('pg_dump', config.operations.pgBinDirectory);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  inTransaction = true;
  const snapshot = (await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
  const manifest = await captureManifest(client);
  await runPgTool('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, `--file=${dumpPath}`], {
    connectionString: sourceUrl,
    binDirectory: config.operations.pgBinDirectory,
  });
  await client.query('COMMIT');
  inTransaction = false;

  const sha256 = await sha256File(dumpPath);
  const sizeBytes = (await stat(dumpPath)).size;
  const fullManifest = { format: 'pg_dump-custom', file: basename(dumpPath), sha256, sizeBytes, database: details.database, pgDumpVersion: details.pgDumpVersion, ...manifest };
  await writeFile(manifestPath, `${JSON.stringify(fullManifest, null, 2)}\n`);
  Object.assign(details, { sha256, sizeBytes, migrations: manifest.migrations.at(-1) ?? null, tables: Object.keys(manifest.rowCounts).length });

  if (upload) {
    const storage = createStorage();
    if (!storage) throw new Error('--upload needs STORAGE_PROVIDER configured.');
    const datePath = startedAt.toISOString().slice(0, 10).replaceAll('-', '/');
    const key = `${config.operations.backupKeyPrefix}/${datePath}/${stem}.dump`;
    await storage.putObject({ key, body: await readFile(dumpPath), contentType: 'application/octet-stream' });
    await storage.putObject({ key: key.replace(/\.dump$/, '.manifest.json'), body: Buffer.from(JSON.stringify(fullManifest, null, 2)), contentType: 'application/json' });
    details.storage = { provider: storage.provider, key };
  }
  status = 'succeeded';
  console.log(`Backup written: ${dumpPath}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`SHA-256 ${sha256}, ${sizeBytes} bytes, ${details.tables} tables, latest migration ${details.migrations}.`);
  if (details.storage) console.log(`Uploaded to ${details.storage.provider}: ${details.storage.key}`);
} catch (error) {
  if (inTransaction) await client.query('ROLLBACK').catch(() => {});
  await rm(dumpPath, { force: true });
  details.error = error.message.slice(0, 500);
  console.error(`Backup failed: ${details.error}`);
  process.exitCode = 1;
} finally {
  if (connected) {
    try {
      await recordOperationRun(client, { kind: 'database_backup', status, startedAt, finishedAt: new Date(), details });
    } catch {
      console.error('Could not record the backup run in operation_runs.');
    }
  }
  await client.end().catch(() => {});
}
