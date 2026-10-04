import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

// Libpq reads these instead of command-line arguments, so the password never appears in the process list.
export function pgEnvironment(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Database URL must start with postgresql://.');
  const env = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
    PGAPPNAME: 'voyagehub-operations',
  };
  const params = { sslmode: 'PGSSLMODE', channel_binding: 'PGCHANNELBINDING', options: 'PGOPTIONS', sslrootcert: 'PGSSLROOTCERT' };
  for (const [name, variable] of Object.entries(params)) {
    if (url.searchParams.has(name)) env[variable] = url.searchParams.get(name);
  }
  return env;
}

// Host, port and database only; safe to log and store.
export function describeDatabase(connectionString) {
  const env = pgEnvironment(connectionString);
  return `${env.PGHOST}:${env.PGPORT}/${env.PGDATABASE}`;
}

// Neon pooled and direct hosts differ only by "-pooler", so both point at the same database.
export function sameDatabase(left, right) {
  const normalize = (value) => describeDatabase(value).toLowerCase().replace('-pooler.', '.');
  return normalize(left) === normalize(right);
}

export function runPgTool(tool, args, { connectionString, binDirectory = null }) {
  const command = binDirectory ? join(binDirectory, tool) : tool;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...pgEnvironment(connectionString) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(error.code === 'ENOENT'
      ? new Error(`${tool} was not found. Install the PostgreSQL client tools (same major version as the server or newer) or set PG_BIN_DIRECTORY.`)
      : error));
    child.on('close', (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${tool} exited with code ${code}: ${stderr.trim().split('\n').slice(-5).join(' | ')}`)));
  });
}

export async function pgToolVersion(tool, binDirectory = null) {
  const command = binDirectory ? join(binDirectory, tool) : tool;
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => reject(error.code === 'ENOENT' ? new Error(`${tool} was not found. Install the PostgreSQL client tools or set PG_BIN_DIRECTORY.`) : error));
    child.on('close', () => resolve(output.trim()));
  });
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// Facts a restored copy must reproduce exactly: applied migrations, every table with its row count, and triggers.
export async function captureManifest(db) {
  const migrations = await db.query('SELECT version FROM public.schema_migrations ORDER BY version');
  const tables = await db.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  const triggers = await db.query(
    `SELECT c.relname AS table_name, t.tgname AS trigger_name
     FROM pg_catalog.pg_trigger t
     JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY c.relname, t.tgname`,
  );
  const version = await db.query('SHOW server_version');
  const rowCounts = {};
  if (tables.rowCount) {
    const statements = await db.query(
      `SELECT string_agg(format('SELECT %L AS table_name, COUNT(*)::bigint AS row_count FROM public.%I', tablename, tablename), ' UNION ALL ' ORDER BY tablename) AS sql
       FROM pg_catalog.pg_tables WHERE schemaname = 'public'`,
    );
    const counts = await db.query(statements.rows[0].sql);
    for (const row of counts.rows) rowCounts[row.table_name] = Number(row.row_count);
  }
  return {
    capturedAt: new Date().toISOString(),
    serverVersion: version.rows[0].server_version,
    migrations: migrations.rows.map((row) => Number(row.version)),
    rowCounts: Object.fromEntries(Object.entries(rowCounts).sort(([left], [right]) => left.localeCompare(right))),
    triggers: triggers.rows.map((row) => `${row.table_name}.${row.trigger_name}`),
  };
}

export function compareManifests(expected, actual) {
  const problems = [];
  const missingMigrations = expected.migrations.filter((version) => !actual.migrations.includes(version));
  const extraMigrations = actual.migrations.filter((version) => !expected.migrations.includes(version));
  if (missingMigrations.length) problems.push(`Missing migrations: ${missingMigrations.join(', ')}`);
  if (extraMigrations.length) problems.push(`Unexpected migrations: ${extraMigrations.join(', ')}`);
  for (const [table, count] of Object.entries(expected.rowCounts)) {
    if (!(table in actual.rowCounts)) problems.push(`Missing table: ${table}`);
    else if (actual.rowCounts[table] !== count) problems.push(`Row count mismatch in ${table}: expected ${count}, restored ${actual.rowCounts[table]}`);
  }
  for (const table of Object.keys(actual.rowCounts)) {
    if (!(table in expected.rowCounts)) problems.push(`Unexpected table: ${table}`);
  }
  for (const trigger of expected.triggers) {
    if (!actual.triggers.includes(trigger)) problems.push(`Missing trigger: ${trigger}`);
  }
  return {
    ok: problems.length === 0,
    problems,
    tablesChecked: Object.keys(expected.rowCounts).length,
    rowsChecked: Object.values(expected.rowCounts).reduce((sum, count) => sum + count, 0),
  };
}

export async function recordOperationRun(db, { kind, status, startedAt, finishedAt, details }) {
  await db.query(
    `INSERT INTO operation_runs (id, kind, status, started_at, finished_at, details, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), kind, status, startedAt, finishedAt, JSON.stringify(details), hostname().slice(0, 120)],
  );
}

export function backupFileStem(date = new Date()) {
  return `voyagehub-${date.toISOString().replace(/[:.]/g, '-')}`;
}
