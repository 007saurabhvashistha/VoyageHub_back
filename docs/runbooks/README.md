# VoyageHub operations runbooks

Use these when something is wrong, or on the schedule below. Each runbook says when to use it, what to check, and what to do, in order. Commands run from `VoyageHub/backend` unless stated otherwise.

| Runbook | Use it when |
|---|---|
| [Backups and restore](backup-and-restore.md) | Daily backup, monthly restore drill, or data has to be recovered |
| [Incident response](incident-response.md) | The site is down, data may have leaked, or an account is compromised |
| [Common failures](common-failures.md) | Email, documents, scanning, workers or the database misbehave |
| [Webhooks](webhooks.md) | A customer's webhooks fail, or an endpoint was disabled |
| [Secrets and key rotation](secrets-and-key-rotation.md) | A secret is exposed, a staff member leaves, or a key must change |

## Schedule

| When | What | Evidence |
|---|---|---|
| Daily | `npm run db:backup -- --upload` (scheduled job) | `operation_runs` row; admin Operations shows "On schedule" |
| Monthly, and after every migration that changes data shape | Restore drill (see backup runbook) | `operation_runs` row and `.restore-drill.json` report |
| Weekly | Look at admin Operations, notification outbox and report queue | Note in the ops log |
| Quarterly | Review who has database, hosting, storage and Neon access; remove leavers | Note in the ops log |

The admin workspace (Platform admin, Operations) turns a check red when the last successful backup is older than `BACKUP_MAX_AGE_HOURS` (default 26) or the last successful drill is older than `RESTORE_DRILL_MAX_AGE_DAYS` (default 35), or when the latest run failed.

## Health checks

- `GET /v1/health/live` returns 200 while the process runs. Use it as the liveness probe.
- `GET /v1/health/ready` returns 200 only when the database answers. Use it as the readiness probe and for uptime alerts.
- Startup logs state which optional services are configured (email, storage, scanner, guest-data key, webhook signing). "not configured" means the feature is off, not broken.

## Ground rules

- Never paste secrets, connection strings or guest data into chat, tickets or commit messages. If it happens, rotate the secret (see the key rotation runbook).
- Restored copies and backup files contain personal data. Keep them in private storage, and delete drill databases when the drill ends.
- Write down what you did and when, in the ops log, while you do it. Incident reviews depend on it.
