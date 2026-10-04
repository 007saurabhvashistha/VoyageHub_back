import 'dotenv/config';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { config } from '../src/config/index.js';
import { captureManifest, compareManifests, describeDatabase, pgEnvironment, pgToolVersion, recordOperationRun, runPgTool, sameDatabase, sha256File } from '../src/services/databaseBackup.js';
import { createStorage } from '../src/services/storage/index.js';

// Usage: npm run db:restore-drill [-- --backup <file.dump> | --key <storage key of a .dump>]
// Restores a backup into RESTORE_DRILL_DATABASE_URL (an empty, throwaway database) and proves it matches its manifest.
const { values: options } = parseArgs({ options: { backup: { type: 'string' }, key: { type: 'string' } } });
const targetUrl = process.env.RESTORE_DRILL_DATABASE_URL;
const primaryUrl = process.env.DATABASE_URL || null;
if (!targetUrl) {
  console.error('Set RESTORE_DRILL_DATABASE_URL to an empty scratch database (for Neon, a new branch or database). It must not be the production database.');
  process.exit(1);
}
if (primaryUrl && sameDatabase(primaryUrl, targetUrl)) {
  console.error('RESTORE_DRILL_DATABASE_URL points at the DATABASE_URL database. Refusing to restore over it.');
  process.exit(1);
}

const directory = resolve(config.operations.backupDirectory);

async function latestLocalBackup() {
  const dumps = (await readdir(directory)).filter((name) => name.endsWith('.dump')).sort();
  if (!dumps.length) throw new Error(`No .dump files in ${directory}. Run npm run db:backup first or pass --backup / --key.`);
  return join(directory, dumps.at(-1));
}

async function downloadFromStorage(key) {
  const storage = createStorage();
  if (!storage) throw new Error('--key needs STORAGE_PROVIDER configured.');
  await mkdir(directory, { recursive: true });
  const dumpPath = join(directory, basename(key));
  await writeFile(dumpPath, await storage.getObject(key));
  await writeFile(dumpPath.replace(/\.dump$/, '.manifest.json'), await storage.getObject(key.replace(/\.dump$/, '.manifest.json')));
  return dumpPath;
}

const startedAt = new Date();
const target = new pg.Client({ connectionString: targetUrl });
const details = { target: describeDatabase(targetUrl) };
let status = 'failed';

try {
  const dumpPath = options.key ? await downloadFromStorage(options.key) : resolve(options.backup ?? await latestLocalBackup());
  details.backup = basename(dumpPath);
  if (options.key) details.storageKey = options.key;
  const manifest = JSON.parse(await readFile(dumpPath.replace(/\.dump$/, '.manifest.json'), 'utf8'));
  details.backupTakenAt = manifest.capturedAt;
  details.pgRestoreVersion = await pgToolVersion('pg_restore', config.operations.pgBinDirectory);

  const sha256 = await sha256File(dumpPath);
  if (sha256 !== manifest.sha256) throw new Error(`Checksum mismatch: manifest ${manifest.sha256}, file ${sha256}. The backup is corrupt or was altered.`);
  details.checksum = 'verified';

  await target.connect();
  const existing = await target.query("SELECT COUNT(*)::int AS tables FROM pg_catalog.pg_tables WHERE schemaname = 'public'");
  if (existing.rows[0].tables > 0) throw new Error('The drill database is not empty. Create a fresh branch or database for each drill.');

  const restoreStartedAt = Date.now();
  await runPgTool('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--dbname=${pgEnvironment(targetUrl).PGDATABASE}`, dumpPath], {
    connectionString: targetUrl,
    binDirectory: config.operations.pgBinDirectory,
  });
  details.restoreSeconds = Math.round((Date.now() - restoreStartedAt) / 100) / 10;

  const restored = await captureManifest(target);
  const comparison = compareManifests(manifest, restored);
  Object.assign(details, { tablesChecked: comparison.tablesChecked, rowsChecked: comparison.rowsChecked, problems: comparison.problems.slice(0, 50) });
  if (!comparison.ok) throw new Error(`Restored copy does not match the backup manifest (${comparison.problems.length} problem(s)).`);
  status = 'succeeded';
} catch (error) {
  details.error = error.message.slice(0, 500);
} finally {
  await target.end().catch(() => {});
}

const finishedAt = new Date();
details.totalSeconds = Math.round((finishedAt - startedAt) / 100) / 10;
const report = { kind: 'restore_drill', status, startedAt, finishedAt, ...details };
if (details.backup) await writeFile(join(directory, details.backup.replace(/\.dump$/, '.restore-drill.json')), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});

if (primaryUrl) {
  const primary = new pg.Client({ connectionString: primaryUrl });
  try {
    await primary.connect();
    await recordOperationRun(primary, { kind: 'restore_drill', status, startedAt, finishedAt, details });
  } catch {
    console.error('Could not record the drill in operation_runs on DATABASE_URL.');
  } finally {
    await primary.end().catch(() => {});
  }
}

if (status === 'succeeded') {
  console.log(`Restore drill PASSED: ${details.backup} -> ${details.target}`);
  console.log(`${details.tablesChecked} tables and ${details.rowsChecked} rows match the manifest. Restore took ${details.restoreSeconds}s (total ${details.totalSeconds}s).`);
  console.log('Delete the drill database or branch now; it contains production data.');
} else {
  console.error(`Restore drill FAILED: ${details.error}`);
  for (const problem of details.problems ?? []) console.error(`  - ${problem}`);
  process.exitCode = 1;
}
