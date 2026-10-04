# Secrets and key rotation

Rotate a secret immediately if it was pasted anywhere public (chat, ticket, commit, log), if a laptop holding it is lost, or when someone with access leaves. Secrets live only in the hosting platform's environment settings and the team secret store; `.env` files are local and gitignored.

## Inventory

| Secret | Used for | Effect of changing it | How to rotate |
|---|---|---|---|
| `DATABASE_URL` / `BACKUP_DATABASE_URL` password | Database access | Old connections fail | Neon console: reset the role password, update both variables, redeploy |
| `RESEND_API_KEY` | Sending email | Email queues as `retrying` until the new key is set | Create a new key in Resend, update, redeploy, delete the old key |
| `S3_*` / `AZURE_STORAGE_*` credentials | Documents, vouchers, backups | Uploads, downloads and backup uploads fail until updated | Create new credentials, update, redeploy, revoke old ones |
| `EMAIL_TOKEN_ENCRYPTION_KEY` | Encrypts email links waiting to be sent | Links still queued cannot be sent; users request a new one | Generate a new key, update, redeploy |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | Encrypts each endpoint's signing secret | Every endpoint fails with `secret_unreadable` until its owner rotates the endpoint secret | See below |
| `MFA_ENCRYPTION_KEY` | Encrypts authenticator secrets | **Every user's authenticator stops working** | Do not rotate without a re-encryption step (not built yet) |
| `GUEST_DATA_ENCRYPTION_KEY` | Encrypts guest details | **All stored guest details become unreadable** | Do not rotate without a re-encryption step (not built yet) |
| Endpoint signing secrets (`whsec_...`) | Per organization | Receivers must switch secrets | Integrations, Rotate secret (old one keeps working for `WEBHOOK_SECRET_ROTATION_GRACE_HOURS`) |

Generate a 32-byte key with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Each key must be different. Losing `MFA_ENCRYPTION_KEY` or `GUEST_DATA_ENCRYPTION_KEY` loses that data for good, so keep them in the secret store and in the restore documentation; backups are useless for those columns without the keys.

## Rotating `WEBHOOK_SECRET_ENCRYPTION_KEY`

Only on exposure, since it forces every organization to update its receiver.

1. Set the new key and redeploy.
2. Deliveries now dead-letter with `secret_unreadable`. Notify every organization with an active endpoint: press Rotate secret, put the new secret in the receiver, then Retry failed deliveries.

## If `MFA_ENCRYPTION_KEY` or `GUEST_DATA_ENCRYPTION_KEY` is exposed

The ciphertext is only at risk if the database is also exposed. Treat it as a P1 incident: if the database may have been read, handle it as a personal data breach. Building a re-encryption command (decrypt with the old key, encrypt with the new key, in one transaction per row) is a prerequisite for rotating these keys; until it exists, keep the old key and restrict access to the database instead.

## After any rotation

- Check `/v1/health/ready` and the startup log lines for the feature.
- Record the rotation (what, when, who, why) in the ops log, without the value.
