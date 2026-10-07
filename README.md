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

Email verification and password recovery require `EMAIL_TOKEN_ENCRYPTION_KEY` (base64-encoded 32 random bytes). Real delivery supports Resend (`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`) or SMTP (`EMAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and optional `SMTP_SECURE`). Both require a sender in `NOTIFICATION_EMAIL_FROM` and the frontend `APP_BASE_URL`; use a sender authorized by your email provider. SMTP defaults to STARTTLS on port 587 and implicit TLS on port 465. MFA requires a separate `MFA_ENCRYPTION_KEY` (also base64-encoded 32 random bytes). Platform administrators must enroll MFA before using admin, marketplace, or notification APIs; MFA cannot be disabled for admins. Until provider settings are configured, accounts cannot complete email verification and delivery entries are recorded as blocked rather than reported as sent. Keep all keys in the ignored `.env`; never paste keys into chat or source control.

The API supports auth/session operations with email verification, password recovery, TOTP enrollment/challenges and one-use recovery codes; agency request create/list/detail/allowlisted publish/close; verified DMC/hotel targeting, seller detail and decline; agency-only verified supplier search; audited seller profile changes with re-verification; DMC package and hotel room offers; agency comparison/award; offer detail/revision history/revise/withdraw; matched agency-seller conversations with contact-detail blocking; award detail; hotel inventory; admin-only seller verification and notification-outbox monitoring/requeue; and tenant-scoped notification list/read operations. The worker retries provider failures with bounded backoff and dead-letters exhausted entries. Without a configured provider, entries are marked `blocked_config`; no email is simulated or marked sent.

Multi-organization accounts: a verified existing user can be invited to another organization and accept while signed in with the invited email. `GET /v1/auth/organizations` lists active memberships. `POST /v1/auth/organizations/:organizationId/switch` requires CSRF protection and replaces the current browser's organization-bound session; it cannot switch to an organization without a membership. The invitation preview does not reveal whether an email already has an account.

Preferred suppliers: agencies list saved sellers with `GET /v1/marketplace/suppliers/favorites`, save an active verified DMC/hotel with `POST /v1/marketplace/suppliers/:sellerOrganizationId/favorite`, and remove it with `DELETE` on that route. The directory accepts `favorites_only=true` to limit results for request invitations. If a saved seller becomes unavailable, the preference stays visible with `isEligible=false` so the agency can remove it; no seller contact details are exposed.

Admin audit search: MFA-protected `GET /v1/admin/audit-events` unifies organization activity, seller profile changes, seller/agency verification decisions, platform setting changes, and request trip/deadline changes. Filter with `q`, `source`, `action`, `organizationId`, `from`, and `to`; paginate with `page` and `limit` (bounded by `ADMIN_AUDIT_MAX_PAGE_SIZE` and `ADMIN_AUDIT_MAX_OFFSET`). Sensitive action details are returned only to platform administrators with MFA enabled.

Monetization gates: platform admins can change audited Boolean settings for subscriptions, seller credits, award commissions and paid featured seller listings. All default to off and are returned under `/v1/reference-data` → `monetization`. These are rollout gates only; enabling one does not create plans, collect money, debit credits, calculate commissions, or rank paid placements. Those workflows require separate implementation and launch review.

Session security: `GET /v1/auth/sessions` lists the signed-in user's active sessions, their organization, sign-in time, expiry and which session is current. Device/browser fingerprints are not collected. `DELETE /v1/auth/sessions/:sessionId` revokes one of that user's sessions, while `POST /v1/auth/sessions/sign-out-everywhere` revokes every session and clears the current cookie. Both mutation endpoints require CSRF protection; password reset already invalidates all sessions.

Document expiry (migration 033): verification uploads may include an `expires_at` date (`YYYY-MM-DD`) when the document itself has an expiry. Optional reminder offsets are configured by `DOCUMENT_EXPIRY_REMINDER_DAYS` (default `30,7,0`); the worker interval and batch size are also configurable. Each threshold notification is sent once. Expired required documents automatically remove agency verification or return a seller to pending review; marketplace approval remains blocked until a current replacement is uploaded and re-reviewed. Expiry metadata and reminder history are retained with the document record. No reminder is scheduled when an upload has no expiry date.

Request reuse: agencies can copy a request from the request list into a new draft. The create-request modal imports JSON exports containing a request object with `requirement_type`, `group_type`, `destinations` (names, with optional per-stop `nights`), travel dates or month+nights, traveller counts, services, and optional budget fields. Enum values must come from `/v1/reference-data`; destination names must match active destination master data and are reselected for review. Budget bounds use major currency units and require `budget_currency`. The import is CRM-neutral JSON, not a live connector to a specific CRM. Example shape:

```json
{
	"requirement_type": "<requirementTypes value>",
	"group_type": "<groupTypes value>",
	"destinations": [{ "name": "<active destination name>", "nights": 2 }],
	"travel_start_date": "YYYY-MM-DD",
	"travel_end_date": "YYYY-MM-DD",
	"nights": 2,
	"adults": 2,
	"children": 0,
	"infants": 0,
	"services": ["<services value>"],
	"budget_min": null,
	"budget_max": null,
	"budget_currency": "<ISO 4217 code>"
}
```

DMC offer reuse and itinerary: `GET/POST/DELETE /v1/marketplace/offer-library` stores private drafts and templates per DMC organization. Land-package offers accept ordered `itinerary` days with a day number, optional destination, title and description. Offer alternatives continue to carry hotel category and price. DMCs and requesting agencies can print the itinerary and hotel options from the offer form/comparison view and choose Save as PDF in the browser print dialog. Apply pending backend migrations before deploying this feature (028 itinerary, 029 offer library).

Request matching and lifecycle (migration 030): DMC owners/managers set handled trip types, minimum group size, budget range/currency and BCP 47 language tags under `PUT /v1/marketplace/seller-settings`. DMC matching requires compatible trip type, minimum size and overlapping budget in the same currency. Hotels with any nightly inventory configured must have enough rooms on every night of an exact-date request; hotels without configured inventory retain destination/category matching, and month-only requests do not require a date-specific inventory match. Both seller types can pause new targets; current inbox entries remain, and resuming re-routes open requests. Requests carry child ages and screened special requests. Agencies can independently extend an open response deadline (audited and notified) or cancel a draft/open/closed request; award and booking states cannot be cancelled through this endpoint.

Hotel catalog and room holds (migration 031): hotel properties store room types, meal plans and facilities; JPEG/PNG photos use private storage and the malware scanner, and requesting agencies receive short-lived URLs only for photos on their active hotel offers. When exact-date nightly inventory is configured, awarding a hotel offer creates an atomic room hold using `hotel_room_hold_minutes` (admin-editable). A worker expires holds; booking confirmation rechecks inventory and renews an expired hold before guest details are released. Holds remain allocated through seller confirmation and are released on accepted cancellation. Ownership evidence still receives manual review; automated registry verification requires a configured third-party source.

To grant the first platform-admin role, register the trusted operator account and run `npm run admin:promote -- operator@example.com` from this repo. Promotion is a direct database-owner operation; public registration cannot create admins.
Revoke it with `npm run admin:demote -- operator@example.com`.

Marketplace rules (migration 012): requests can be `open`, `invite_only` or `open_and_invite`, with up to 20 invited verified suppliers. Offers and revisions are rejected after the response deadline, and a background worker closes due requests (or marks them `expired` when they have no offers); agencies can still award a closed request. Each request accepts at most `max_offers_per_request` active offers (default 10), which admins change through `GET /v1/admin/settings` and `PUT /v1/admin/settings/max-offers-per-request`; every change is recorded in `platform_setting_changes`. Awards accept an optional `not_selected_reason` that is stored on rejected offers and included in seller notifications.

Without an email provider, an operator with database access can mark a registered account verified with `npm run account:verify -- owner@example.com`.

Signed webhooks (migration 018): owners and managers add HTTPS endpoints under Integrations (`/v1/webhooks`), choose event types from `/v1/reference-data` (`webhookEventTypes`), and receive Standard Webhooks-signed POSTs. Seller `request_matched` events include `data.leadSnapshot`, the allowlisted seller-visible request fields (route, travel dates, party, requirements, budget and response deadline) for CRM/CMS intake; guest contact details are never included. Every matched lead is queued for subscribed CRM endpoints regardless of instant, digest or muted in-app alert preferences. Events are queued in the same transaction as the match. Secrets are shown once, stored encrypted with `WEBHOOK_SECRET_ENCRYPTION_KEY`, and can be rotated with a grace period. Deliveries retry with backoff, dead-letter, can be retried manually, and endpoints are disabled after repeated failures. Private and reserved IP addresses are refused at connect time.

Public read API (migration 032): owners and managers create and revoke organization-scoped, read-only bearer tokens in Integrations. A token is shown once, stored only as a SHA-256 hash, expires according to `API_TOKEN_TTL_DAYS`, and is rejected after revocation, expiry, organization suspension or scheduled closure. Send it as `Authorization: Bearer vh_live_...` to `GET /v1/public/marketplace/requests`, `/offers` or `/awards`; each endpoint returns only the caller organization's records (agency-owned requests and their offers/awards, or seller-targeted requests and its own offers/awards). Responses are paginated with `page` and `limit` (maximum `PUBLIC_API_MAX_PAGE_SIZE`). Guest details, documents, messages and mutations are not exposed. Requests are rate-limited by `PUBLIC_API_RATE_LIMIT_PER_MINUTE`.

Reports: `GET /v1/reports/agency` and `GET /v1/reports/seller` return organization-scoped metrics; platform administrators use `GET /v1/admin/analytics/marketplace` (MFA required). Optional inclusive `from` and `to` query dates use `YYYY-MM-DD`; omitting both returns all-time results. Agency award rate is requests with at least one non-cancelled award divided by published requests. Response time is the average time from request publication to its first offer. Savings include only positive underspend against the request's maximum budget when currencies match; split-award prices are combined per request. Seller win rate uses accepted and rejected offers, loss reasons come from rejected-offer outcomes, and ratings average received organization reviews. Admin booking conversion is booked awards divided by non-cancelled awards in the selected period.

Operations: `npm run db:backup [-- --upload]` writes a consistent `pg_dump` plus manifest; `npm run db:restore-drill` restores it into an empty scratch database (`RESTORE_DRILL_DATABASE_URL`) and verifies every table's row count, migrations and triggers. Both record results in `operation_runs`, shown to admins at `GET /v1/admin/operations`. Runbooks are in [docs/runbooks](docs/runbooks/README.md).

## Verify

```powershell
npm test
```

This is a working private MVP slice, not production launch readiness. Email verification/recovery workflows and MFA are implemented, but real email delivery and the MFA encryption key must be configured before use. Seller verification documents need private storage (`STORAGE_PROVIDER=s3|azure`) and a ClamAV scanner (`MALWARE_SCANNER=clamav`); see `.env.example`. A load test and a re-encryption command for the MFA and guest-data keys remain. Do not put credentials in source control; local environment files and embedded data are ignored.