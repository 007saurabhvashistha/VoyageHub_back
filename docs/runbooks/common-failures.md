# Common failures

Background workers (notification email, request deadlines, reminders, document scans, retention, webhooks) run inside the API process on timers. If the API is up, they run. If you run more than one API instance, every instance runs them; queue jobs lock rows (`FOR UPDATE SKIP LOCKED`) and reminders are claimed once per deadline, so work is not done twice.

## API down or `/v1/health/ready` returns 503

1. `checks.database: unavailable`: check the Neon console (compute suspended, quota, outage) and that `DATABASE_URL` is the pooled string with `sslmode=require`.
2. Process will not start: the log names the bad setting. Configuration is validated at startup (zod); fix the variable on the hosting platform. `DATABASE_URL is required in production` means it is missing.
3. Started after a deploy: roll back to the previous version, then investigate.

## Emails are not arriving

Platform admin, Notification outbox shows each email's status.
- `blocked_config` / `provider_not_configured`: email is not configured. For Resend, set `EMAIL_PROVIDER=resend` and `RESEND_API_KEY`; for SMTP, set `EMAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`. Both providers need `NOTIFICATION_EMAIL_FROM` (authorized sender), `APP_BASE_URL`, and `EMAIL_TOKEN_ENCRYPTION_KEY`; then restart or redeploy. Blocked entries are picked up automatically.
- `retrying`: provider errors; they back off and retry. Check Resend status and the API key.
- `dead_letter`: retries exhausted. Fix the cause, then use Retry on the entry.
- `recipient_email_unverified`: expected for unverified accounts.
- Users waiting on a verification email can be verified by an operator: `npm run account:verify -- user@example.com`.

## Documents cannot be uploaded or opened

- Upload returns "not configured": `STORAGE_PROVIDER` and its settings are missing.
- Upload or download errors: check the bucket/container exists, the credentials are valid and not expired, and the region matches. Signed links expire after `DOCUMENT_DOWNLOAD_URL_TTL_SECONDS`.
- Documents stay "Awaiting malware scan": `MALWARE_SCANNER` is not set, or clamd is unreachable at `CLAMAV_HOST:CLAMAV_PORT`/`CLAMAV_SOCKET`. After `DOCUMENT_SCAN_MAX_ATTEMPTS` the document is marked failed and the seller must upload it again.
- clamd up but scans fail: its signature database may be loading or out of date; check `freshclam` and the clamd log.

## Bookings cannot be confirmed

"Guest-data encryption not configured": `GUEST_DATA_ENCRYPTION_KEY` is missing. Set it from the secret store; never generate a new one if one was ever used (existing guest details would become unreadable; see the key rotation runbook).

## Requests do not close, or reminders do not go out

The deadline and reminder workers run every `DEADLINE_JOB_INTERVAL_SECONDS` / `REMINDER_JOB_INTERVAL_SECONDS`. If they stop, the API process is usually restarting in a loop or hung; check the logs for "processing failed" lines and restart. Both jobs catch up on the next run; nothing is lost.

## Database is slow or full

1. Neon console, Monitoring: CPU, connections, storage.
2. Too many connections: each API instance has a pool; reduce instances or raise the compute size.
3. Storage growing: the retention jobs delete old webhook deliveries, purged guest data and expired documents. Check they are running (no repeated "retention ... failed" lines).
