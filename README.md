# VoyageHub Backend

Standalone backend foundation for Lead Exchange. It has no runtime dependency on Aviat CRM.

## Requirements

- Node.js 20 or newer
- No local database installation is needed for development; embedded PostgreSQL stores data under `.data/lead-exchange`.

## Run

```powershell
npm install
npm run db:migrate
npm run dev
```

Registration and login are backed by PostgreSQL. Migrations create identity, seller profiles, requests, targeted access, private offers, awards, hotel inventory, verification and profile-change audit records, notifications, request conversations, and a transactional per-member notification outbox. The migration runner applies only versions missing from `schema_migrations`. `DATABASE_URL` can point to a dedicated managed PostgreSQL database; production startup requires it. Do not point it at Aviat CRM.

For Neon, copy `.env.example` to `.env`, set `DATABASE_URL` to the pooled Neon connection string (including `sslmode=require`), then run `npm run db:migrate` before starting the server. `.env` is gitignored. Keep the database URL private and rotate its password if it is exposed.

Email verification and password recovery require `EMAIL_TOKEN_ENCRYPTION_KEY` (base64-encoded 32 random bytes). Real delivery uses the Resend adapter and requires `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, a sender on a verified domain in `NOTIFICATION_EMAIL_FROM`, and the frontend `APP_BASE_URL`. MFA requires a separate `MFA_ENCRYPTION_KEY` (also base64-encoded 32 random bytes). Platform administrators must enroll MFA before using admin, marketplace, or notification APIs; MFA cannot be disabled for admins. Until provider settings are configured, accounts cannot complete email verification and delivery entries are recorded as blocked rather than reported as sent. Keep all keys in the ignored `.env`; never paste keys into chat or source control.

The API supports auth/session operations with email verification, password recovery, TOTP enrollment/challenges and one-use recovery codes; agency request create/list/detail/allowlisted publish/close; verified DMC/hotel targeting, seller detail and decline; agency-only verified supplier search; audited seller profile changes with re-verification; DMC package and hotel room offers; agency comparison/award; offer detail/revision history/revise/withdraw; matched agency-seller conversations with contact-detail blocking; award detail; hotel inventory; admin-only seller verification and notification-outbox monitoring/requeue; and tenant-scoped notification list/read operations. The worker retries provider failures with bounded backoff and dead-letters exhausted entries. Without a configured provider, entries are marked `blocked_config`; no email is simulated or marked sent.

To grant the first platform-admin role, register the trusted operator account and run `npm run admin:promote -- operator@example.com` from this repo. Promotion is a direct database-owner operation; public registration cannot create admins.
Revoke it with `npm run admin:demote -- operator@example.com`.

Marketplace rules (migration 012): requests can be `open`, `invite_only` or `open_and_invite`, with up to 20 invited verified suppliers. Offers and revisions are rejected after the response deadline, and a background worker closes due requests (or marks them `expired` when they have no offers); agencies can still award a closed request. Each request accepts at most `max_offers_per_request` active offers (default 10), which admins change through `GET /v1/admin/settings` and `PUT /v1/admin/settings/max-offers-per-request`; every change is recorded in `platform_setting_changes`. Awards accept an optional `not_selected_reason` that is stored on rejected offers and included in seller notifications.

Without an email provider, an operator with database access can mark a registered account verified with `npm run account:verify -- owner@example.com`.

## Verify

```powershell
npm test
```

This is a working private MVP slice, not production launch readiness. Email verification/recovery workflows and MFA are implemented, but real email delivery and the MFA encryption key must be configured before use. SSO, KYC evidence upload and retention, verified booking confirmation and scoped guest-data release, and CRM integrations remain. Do not put credentials in source control; local environment files and embedded data are ignored.