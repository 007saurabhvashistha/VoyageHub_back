# Incident response

## Severity

| Level | Examples | Response |
|---|---|---|
| P1 | Site down; personal or guest data exposed; a secret leaked; data lost; a restore drill failed | Start now, any hour. One person leads, one person writes the log. |
| P2 | One feature broken for everyone (email, uploads, bookings, webhooks); a worker stopped | Same working day |
| P3 | One organization affected; slow but working | Next working day |

## First 15 minutes (any P1)

1. Name a lead. The lead decides; everyone else reports to the lead.
2. Start the incident log: time, what was seen, who is doing what. Keep it for the review.
3. Check `/v1/health/ready`, the hosting platform's logs and status, and the Neon console status.
4. Contain before you fix:
   - Data exposure or abuse by one organization: suspend it (Platform admin, Moderation). Suspension signs out all its members, withdraws its offers and cancels its open requests.
   - A compromised user: reset their password (signs out every session) or suspend the organization. A compromised platform admin: `npm run admin:demote -- email@example.com` first.
   - A leaked secret: rotate it now (see [secrets and key rotation](secrets-and-key-rotation.md)).
   - A bad deploy: roll back to the previous version on the hosting platform. If it changed data, see [backups and restore](backup-and-restore.md).
5. Preserve evidence. Do not delete logs, audit rows (`organization_audit_events`, `booking_guest_access_log`, `platform_setting_changes`) or storage objects involved. Take a backup now if the database is reachable.

## Personal data breach

A personal data breach is any unauthorized access, disclosure, change or loss of personal data (users, organizations, guest details, uploaded documents). Treat a suspected breach as a breach until ruled out.

1. Work out the scope from the audit trail: which organizations, which records, which time window. `booking_guest_access_log` shows every guest-details view and voucher open; `organization_document_access_log` shows every admin document open; `organization_audit_events` shows team, webhook, export and deletion actions.
2. Decide the notifications with the legal owner the same day. For India, plan for:
   - CERT-In: report specified cyber security incidents within 6 hours of noticing them.
   - DPDP Act and Rules: inform affected people and the Data Protection Board without delay, with a detailed report to the Board within 72 hours.
   - Organizations whose guest data is involved (they are the data controllers for their travellers) and any other country's regulator where affected users live.
   These timelines must be confirmed by counsel and written into this runbook before launch.
3. Use the grievance officer contact configured in `GRIEVANCE_OFFICER_*` for user communication.

## Close and review

1. Confirm the fix with the same checks that showed the problem.
2. Within 5 working days, write a blameless review: timeline, cause, impact (organizations, records, duration), what worked, and actions with owners and dates.
3. Update the runbook that was missing or wrong.
