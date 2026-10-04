# Backups and restore

## What protects the data

1. **Neon history (point-in-time restore).** Neon keeps a history window for the root branch. Within it, the branch can be restored to any second, in seconds. The length depends on the Neon plan: check Project settings in the Neon console and record the value here: `______`. This is the first choice for recovering from bad deploys, bad migrations or accidental deletes.
2. **Daily logical backups (`npm run db:backup`).** A `pg_dump` custom-format file plus a manifest (migrations, row count per table, triggers, SHA-256), taken in one consistent snapshot. With `--upload` both files go to private object storage under `BACKUP_KEY_PREFIX` (default `database-backups/YYYY/MM/DD/`). This protects against losing the Neon project or account, and outlasts the Neon history window.
3. **Monthly restore drill (`npm run db:restore-drill`).** Proves a backup actually restores, and measures how long it takes.

Targets for the pilot: data loss of at most 24 hours from logical backups (seconds within the Neon history window), and service back within 4 hours.

Uploaded documents and vouchers live in object storage, not the database. Enable versioning (S3) or soft delete (Azure) on the bucket/container so deleted files can be recovered, and keep the lifecycle rule for retention.

## Prerequisites

- PostgreSQL client tools (`pg_dump`, `pg_restore`) of the **same major version as the Neon server or newer**. Check the server with `SHOW server_version;`. Set `PG_BIN_DIRECTORY` if they are not on `PATH`. In CI, run the job in the official `postgres:<major>` image.
- `BACKUP_DATABASE_URL`: the **direct** (non-pooled) Neon connection string. `pg_dump --snapshot` does not work through the pooler (`-pooler` host). If unset, `DATABASE_URL` is used.
- For `--upload`: the storage settings already used for documents (`STORAGE_PROVIDER` and its credentials). Use a lifecycle rule on the `database-backups/` prefix, for example keep 35 daily backups.

## Daily backup

```powershell
npm run db:backup -- --upload
```

Success prints the file, SHA-256, table count and latest migration, and records a `database_backup` row in `operation_runs`. A failure also records a row with the error, and exits with code 1 so the scheduler can alert.

If it fails:
- `pg_dump was not found`: install client tools or set `PG_BIN_DIRECTORY`.
- `server version mismatch`: the client tools are older than the server. Install the newer major version.
- `cannot import a snapshot` or errors mentioning the pooler: use the direct connection string in `BACKUP_DATABASE_URL`.
- Upload errors: see "Documents cannot be uploaded" in [common failures](common-failures.md); the local file is still valid.

## Monthly restore drill

1. Create an empty scratch database on a non-production branch (or in the Neon console):
   ```bash
   neon databases create --name restore_drill_YYYYMM --branch <non-production branch>
   ```
   The drill refuses to run if the target has any table, and refuses a target that is the `DATABASE_URL` database.
2. Put the scratch connection string in `RESTORE_DRILL_DATABASE_URL` for this shell only (do not save it in `.env`).
3. Run the drill against the newest uploaded backup, so the off-site copy is what gets tested:
   ```powershell
   npm run db:restore-drill -- --key database-backups/YYYY/MM/DD/voyagehub-<timestamp>.dump
   ```
   Or `--backup <path>` for a local file; with no option it uses the newest file in `BACKUP_DIRECTORY`.
4. The drill checks the SHA-256, restores with `pg_restore --single-transaction --exit-on-error`, then compares every table's row count, the applied migrations and the triggers with the manifest. It prints PASSED or FAILED, writes `<backup>.restore-drill.json`, and records a `restore_drill` row in `operation_runs` (when `DATABASE_URL` is set).
5. Delete the drill database immediately (`neon databases delete restore_drill_YYYYMM --branch <branch>`): it holds production personal data.
6. Record the restore time in the ops log. If it trends toward the 4-hour target, plan for it before it gets there.

A failed drill is a P1 incident: the backups are not trustworthy until a drill passes. Fix the cause, take a new backup, and drill again.

## Recover from a bad change (within the Neon history window)

Use this for a bad migration, a buggy deploy that corrupted data, or accidental deletes.

1. Stop writes: scale the API to zero or put it in maintenance. Workers run inside the API process, so this stops them too.
2. Find the last good moment. Use Neon Time Travel Assist (read-only queries at a past time) to confirm it.
3. Restore the root branch to that time. Neon keeps the current state as a backup branch:
   ```bash
   neon branches restore production ^self@2026-10-04T09:58:00Z --preserve-under-name production_before_restore_20261004
   ```
   The connection string does not change. Every database on the branch is restored.
4. If the bad change was a migration, deploy the previous application version before starting the API; `schema_migrations` now matches the old schema.
5. Start the API, check `/v1/health/ready`, sign in, open a request and a booking.
6. Data written after the restore point is lost from the live branch but still in the backup branch. Decide with the product owner whether any of it must be copied back by hand.
7. Object storage is not rolled back. Documents uploaded after the restore point remain in the bucket without database rows; the retention job does not see them. List and delete them by key prefix if needed.

## Recover from a logical backup (Neon project lost, or beyond the history window)

1. Create a new Neon project in the launch region (or another PostgreSQL 16+ server). Note its direct connection string.
2. Restore the newest backup with the drill script, which downloads it, checks the SHA-256 and verifies the result: set `RESTORE_DRILL_DATABASE_URL` to the **new, empty production** database and run `npm run db:restore-drill -- --key <key>`. Leave `DATABASE_URL` pointing at the lost database for this step; the script only uses it for the same-database safety check and to record the run (it will report that it could not record). A PASSED result means the new database matches the backup exactly.
3. Point `DATABASE_URL` at the new database and run `npm run db:migrate`; it applies only migrations newer than the backup.
4. Set `DATABASE_URL` (pooled) and `BACKUP_DATABASE_URL` (direct) in the hosting platform, redeploy, and check `/v1/health/ready`.
5. Everything since the backup is lost. Tell affected organizations what window was lost; this may also be a notifiable incident (see [incident response](incident-response.md)).
6. Take a fresh backup straight away.
