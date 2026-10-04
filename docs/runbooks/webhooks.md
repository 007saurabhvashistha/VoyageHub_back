# Webhooks

Organizations (owners and managers) add HTTPS endpoints under Integrations and choose which events to receive. Events come from the same transaction as the in-app notification, so a webhook is never sent for a change that was rolled back, and never lost for one that was saved.

## How a delivery works

- Format: [Standard Webhooks](https://www.standardwebhooks.com/). Headers `webhook-id` (stable across retries; use it to drop duplicates), `webhook-timestamp` (seconds) and `webhook-signature` (`v1,<base64 HMAC-SHA256>` over `id.timestamp.body`). During the secret rotation grace period two signatures are sent, separated by a space.
- Body: `{"type": "<event>", "timestamp": "...", "data": {...}}`. `data` has ids, the request code, title and message, never guest details or contact details.
- Success is any 2xx within `WEBHOOK_TIMEOUT_MS` (default 10 s). Redirects are not followed.
- Failures retry with exponential backoff (base `WEBHOOK_RETRY_BASE_SECONDS`, capped at `WEBHOOK_RETRY_MAX_MINUTES`) up to `WEBHOOK_MAX_ATTEMPTS`, then become `dead_letter`.
- After `WEBHOOK_DISABLE_AFTER_FAILURES` failed attempts in a row the endpoint is disabled, its queued deliveries are cancelled, and the organization is notified.
- Private, loopback, link-local and reserved IP addresses are refused at connect time, after DNS resolution (`blocked_destination`). This blocks requests to internal services and cloud metadata endpoints.
- Delivered, dead-letter and cancelled rows are deleted after `WEBHOOK_DELIVERY_RETENTION_DAYS`.

Receiver example (Node.js, `standardwebhooks` package):

```js
import { Webhook } from 'standardwebhooks';
const verifier = new Webhook(process.env.VOYAGEHUB_WEBHOOK_SECRET); // whsec_...
const event = verifier.verify(rawBodyString, request.headers); // throws if invalid or older than 5 minutes
```

Libraries exist for most languages at standardwebhooks.com. Verify against the raw body bytes, not re-serialized JSON.

## Customer says webhooks stopped

1. Ask them to open Integrations and look at the endpoint status and Delivery log.
2. Read the last result on recent deliveries:
   - `HTTP 4xx/5xx`: their receiver rejected it. 401/403 usually means signature verification fails: wrong secret, verifying parsed JSON instead of the raw body, or a clock more than 5 minutes off.
   - `timeout`: their receiver takes longer than the timeout. They should return 2xx first and process in the background.
   - `dns_not_found`, `connection_failed`, `tls_failed`: the URL is wrong, the server is down, or its certificate is invalid or expired.
   - `blocked_destination`: the hostname resolves to a private or reserved address. Only public addresses are allowed.
   - `secret_unreadable`: our side, see below.
3. Once fixed: they press Enable (if disabled), then Retry on the failed deliveries they need. Cancelled and dead-letter deliveries are kept until the retention period ends.
4. They can press Test to send a `webhook_test` event at any time.

## `secret_unreadable` on many endpoints

`WEBHOOK_SECRET_ENCRYPTION_KEY` changed or is wrong. Restore the previous value from the secret store and redeploy; then retry the affected deliveries. If the key was rotated on purpose, each organization must press Rotate secret and update its receiver (see the key rotation runbook).

## Signing key not configured

Without `WEBHOOK_SECRET_ENCRYPTION_KEY`, endpoints cannot be created or rotated (503 `WEBHOOKS_NOT_CONFIGURED`) and queued events wait unsent; nothing is sent unsigned.

## Platform view

Platform admin, Operations shows active endpoints, queued and failed deliveries, and endpoints disabled for failures. A sudden jump in failures across many organizations points to our side (outbound network, DNS, key); a single organization points to their receiver.
