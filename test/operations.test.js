import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgDump } from '@electric-sql/pglite-tools/pg_dump';
import { Webhook } from 'standardwebhooks';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { EmbeddedPostgresPool } from '../src/db/embeddedPool.js';
import { processWebhookDeliveries, processWebhookDeliveryRetention } from '../src/jobs/webhookDeliveries.js';
import { captureManifest, compareManifests, pgEnvironment, sameDatabase } from '../src/services/databaseBackup.js';
import { createTotpEnrollment } from '../src/services/totp.js';
import { webhookUrlProblem } from '../src/services/webhooks.js';

const migrationDirectory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const migrations = await Promise.all((await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort()
  .map((name) => readFile(`${migrationDirectory}${name}`, 'utf8')));
const webhookKey = Buffer.alloc(32, 41);
const mfaKey = Buffer.alloc(32, 43);
const tokenKey = Buffer.alloc(32, 47);

async function migratedDatabase() {
  const database = new PGlite();
  await database.waitReady;
  const pool = new EmbeddedPostgresPool(database);
  for (const migration of migrations) await pool.exec(migration);
  return { database, pool };
}

async function startApp(context, { webhookEncryptionKey = webhookKey } = {}) {
  const { pool } = await migratedDatabase();
  const server = createApp({ pool, secureCookies: false, tokenEncryptionKey: tokenKey, mfaEncryptionKey: mfaKey, webhookEncryptionKey, webhookAllowInsecureUrls: true }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });
  return { pool, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function startReceiver(context) {
  const received = [];
  let respondWith = 204;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.writeHead(respondWith).end();
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/hooks/voyagehub`, received, respond: (status) => { respondWith = status; } };
}

async function registerAgency(baseUrl, pool, email) {
  const created = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ full_name: 'Webhook Owner', organization_name: `Agency ${email}`, email, country_code: 'IN', business_type: 'agency', password: 'operations-test-password' }),
  });
  assert.equal(created.status, 201);
  const account = await created.json();
  await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [account.user.id]);
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'operations-test-password', business_type: 'agency' }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  return { userId: account.user.id, organizationId: account.organization.id, cookie: login.headers.get('set-cookie').split(';')[0], csrfToken: session.csrfToken };
}

async function api(baseUrl, account, path, { method = 'GET', body } = {}) {
  const headers = { cookie: account.cookie };
  if (method !== 'GET') headers['x-csrf-token'] = account.csrfToken;
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

async function notify(pool, organizationId, eventType, data = {}) {
  await pool.query(
    'INSERT INTO notifications (id, organization_id, event_type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), organizationId, eventType, 'New seller offer', 'LX-1001 / Kyoto', JSON.stringify(data)],
  );
}

const fastSettings = { ...config.webhooks, retryBaseMs: 1000, retryMaxMs: 1000 };
const later = (minutes) => () => new Date(Date.now() + minutes * 60000);

test('webhook URLs must be https without credentials unless insecure URLs are allowed', () => {
  assert.equal(webhookUrlProblem('https://crm.example.com/hooks'), null);
  assert.match(webhookUrlProblem('http://crm.example.com/hooks'), /https/);
  assert.match(webhookUrlProblem('https://user:pass@crm.example.com/hooks'), /credentials/);
  assert.match(webhookUrlProblem('not a url'), /full URL/);
  assert.equal(webhookUrlProblem('http://127.0.0.1:9000/hooks', { allowInsecureUrls: true }), null);
});

test('webhook endpoints stay unavailable until the signing key is configured', async (context) => {
  const { pool, baseUrl } = await startApp(context, { webhookEncryptionKey: null });
  const agency = await registerAgency(baseUrl, pool, 'nokey@agency.example');
  const created = await api(baseUrl, agency, '/v1/webhooks/endpoints', { method: 'POST', body: { url: 'https://crm.example.com/hooks', event_types: ['offer_submitted'] } });
  assert.equal(created.status, 503);
  assert.equal(created.body.error.code, 'WEBHOOKS_NOT_CONFIGURED');
  const list = await api(baseUrl, agency, '/v1/webhooks/endpoints');
  assert.equal(list.body.signingConfigured, false);
});

test('signed webhooks are delivered, verified, rotated, retried, disabled and re-enabled', async (context) => {
  const { pool, baseUrl } = await startApp(context);
  const receiver = await startReceiver(context);
  const agency = await registerAgency(baseUrl, pool, 'owner@agency.example');

  const sellerOnly = await api(baseUrl, agency, '/v1/webhooks/endpoints', { method: 'POST', body: { url: receiver.url, event_types: ['request_matched'] } });
  assert.equal(sellerOnly.status, 400);

  const created = await api(baseUrl, agency, '/v1/webhooks/endpoints', { method: 'POST', body: { url: receiver.url, description: 'Aviat CRM', event_types: ['offer_submitted', 'offer_withdrawn'] } });
  assert.equal(created.status, 201);
  assert.match(created.body.secret, /^whsec_/);
  const endpointId = created.body.endpoint.id;
  const firstSecret = created.body.secret;
  const listed = await api(baseUrl, agency, '/v1/webhooks/endpoints');
  assert.equal(listed.body.endpoints.length, 1);
  assert.equal(JSON.stringify(listed.body).includes(firstSecret), false, 'secret must never be listed');

  await notify(pool, agency.organizationId, 'offer_submitted', { requestCode: 'LX-1001', offerId: 'offer-1' });
  await notify(pool, agency.organizationId, 'email_verification', { authEmailTokenId: 'secret-token-id' });
  await notify(pool, agency.organizationId, 'offer_revised', { offerId: 'offer-1' });
  const queued = await pool.query('SELECT event_type FROM webhook_deliveries WHERE endpoint_id = $1', [endpointId]);
  assert.deepEqual(queued.rows.map((row) => row.event_type), ['offer_submitted'], 'only subscribed, allowlisted events are queued');

  const firstRun = await processWebhookDeliveries(pool, { encryptionKey: webhookKey, allowPrivateNetwork: true, settings: fastSettings });
  assert.equal(firstRun.delivered, 1);
  assert.equal(receiver.received.length, 1);
  const [delivery] = receiver.received;
  const verified = new Webhook(firstSecret).verify(delivery.body, delivery.headers);
  assert.equal(verified.type, 'offer_submitted');
  assert.equal(verified.data.requestCode, 'LX-1001');
  assert.equal(verified.data.organizationId, agency.organizationId);
  assert.match(delivery.headers['webhook-id'], /^msg_[0-9a-f]{32}$/);
  assert.throws(() => new Webhook(`whsec_${Buffer.alloc(32, 1).toString('base64')}`).verify(delivery.body, delivery.headers));
  assert.throws(() => new Webhook(firstSecret).verify(delivery.body.replace('LX-1001', 'LX-9999'), delivery.headers));

  const rotated = await api(baseUrl, agency, `/v1/webhooks/endpoints/${endpointId}/rotate-secret`, { method: 'POST' });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.secret, firstSecret);
  assert.ok(rotated.body.endpoint.previousSecretExpiresAt);
  const tested = await api(baseUrl, agency, `/v1/webhooks/endpoints/${endpointId}/test`, { method: 'POST' });
  assert.equal(tested.status, 202);
  await processWebhookDeliveries(pool, { encryptionKey: webhookKey, allowPrivateNetwork: true, settings: fastSettings });
  const testDelivery = receiver.received[1];
  assert.equal(testDelivery.headers['webhook-signature'].split(' ').length, 2, 'signed with new and previous secret during grace period');
  assert.equal(new Webhook(rotated.body.secret).verify(testDelivery.body, testDelivery.headers).type, 'webhook_test');
  assert.equal(new Webhook(firstSecret).verify(testDelivery.body, testDelivery.headers).type, 'webhook_test');

  // Receiver failures retry with backoff, dead-letter after max attempts, and disable the endpoint after repeated failures.
  receiver.respond(500);
  const failing = { ...fastSettings, maxAttempts: 2, disableAfterFailures: 3 };
  await notify(pool, agency.organizationId, 'offer_withdrawn', { offerId: 'offer-2' });
  const retry = await processWebhookDeliveries(pool, { encryptionKey: webhookKey, allowPrivateNetwork: true, settings: failing });
  assert.equal(retry.retrying, 1);
  const deadLetter = await processWebhookDeliveries(pool, { encryptionKey: webhookKey, allowPrivateNetwork: true, settings: failing, now: later(5) });
  assert.equal(deadLetter.deadLetter, 1);
  const history = await api(baseUrl, agency, `/v1/webhooks/endpoints/${endpointId}/deliveries?status=dead_letter`);
  assert.equal(history.body.deliveries.length, 1);
  assert.equal(history.body.deliveries[0].lastStatusCode, 500);
  assert.equal(history.body.deliveries[0].lastErrorCode, 'http_500');
  const deadId = history.body.deliveries[0].id;

  await notify(pool, agency.organizationId, 'offer_submitted', { offerId: 'offer-3' });
  const disabling = await processWebhookDeliveries(pool, { encryptionKey: webhookKey, allowPrivateNetwork: true, settings: failing });
  assert.equal(disabling.disabledEndpoints, 1);
  const endpointRow = (await pool.query('SELECT status, disabled_reason FROM webhook_endpoints WHERE id = $1', [endpointId])).rows[0];
  assert.deepEqual(endpointRow, { status: 'disabled', disabled_reason: 'failing' });
  const disabledNotice = await pool.query("SELECT 1 FROM notifications WHERE organization_id = $1 AND event_type = 'webhook_endpoint_disabled'", [agency.organizationId]);
  assert.equal(disabledNotice.rowCount, 1);
  await notify(pool, agency.organizationId, 'offer_submitted', { offerId: 'offer-4' });
  assert.equal((await pool.query("SELECT 1 FROM webhook_deliveries WHERE payload->'data'->>'offerId' = 'offer-4'")).rowCount, 0, 'disabled endpoints receive nothing');

  const blockedRetry = await api(baseUrl, agency, `/v1/webhooks/deliveries/${deadId}/retry`, { method: 'POST' });
  assert.equal(blockedRetry.status, 409);
  const enabled = await api(baseUrl, agency, `/v1/webhooks/endpoints/${endpointId}`, { method: 'PATCH', body: { enabled: true } });
  assert.equal(enabled.body.endpoint.status, 'active');
  assert.equal(enabled.body.endpoint.consecutiveFailures, 0);
  receiver.respond(200);
  const requeued = await api(baseUrl, agency, `/v1/webhooks/deliveries/${deadId}/retry`, { method: 'POST' });
  assert.equal(requeued.status, 200);
  assert.equal(requeued.body.delivery.status, 'pending');
  const redelivered = await processWebhookDeliveries(pool, { encryptionKey: webhookKey, allowPrivateNetwork: true, settings: fastSettings });
  assert.equal(redelivered.delivered, 1);
  const replayed = receiver.received.at(-1);
  assert.equal(new Webhook(rotated.body.secret).verify(replayed.body, replayed.headers).data.offerId, 'offer-2');

  const audit = await pool.query("SELECT action FROM organization_audit_events WHERE organization_id = $1 AND action LIKE 'webhook.%' ORDER BY created_at", [agency.organizationId]);
  assert.deepEqual(new Set(audit.rows.map((row) => row.action)), new Set(['webhook.created', 'webhook.secret_rotated', 'webhook.disabled', 'webhook.updated']));

  await pool.query("UPDATE webhook_deliveries SET updated_at = NOW() - INTERVAL '400 days' WHERE status = 'delivered'");
  const purged = await processWebhookDeliveryRetention(pool);
  assert.ok(purged.deleted >= 3);

  const removed = await api(baseUrl, agency, `/v1/webhooks/endpoints/${endpointId}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal((await pool.query('SELECT 1 FROM webhook_deliveries WHERE endpoint_id = $1', [endpointId])).rowCount, 0);
});

test('webhooks to private network addresses are refused at connect time', async (context) => {
  const { pool, baseUrl } = await startApp(context);
  const receiver = await startReceiver(context);
  const agency = await registerAgency(baseUrl, pool, 'ssrf@agency.example');
  const created = await api(baseUrl, agency, '/v1/webhooks/endpoints', { method: 'POST', body: { url: receiver.url, event_types: ['offer_submitted'] } });
  assert.equal(created.status, 201);
  await notify(pool, agency.organizationId, 'offer_submitted');
  const run = await processWebhookDeliveries(pool, { encryptionKey: webhookKey, allowPrivateNetwork: false, settings: fastSettings });
  assert.equal(run.deadLetter, 1);
  assert.equal(receiver.received.length, 0);
  const row = (await pool.query('SELECT status, last_error_code FROM webhook_deliveries')).rows[0];
  assert.deepEqual(row, { status: 'dead_letter', last_error_code: 'blocked_destination' });
});

test('members without the integration capability cannot manage webhooks', async (context) => {
  const { pool, baseUrl } = await startApp(context);
  const agency = await registerAgency(baseUrl, pool, 'staff@agency.example');
  await pool.query("UPDATE organization_memberships SET access_role = 'member' WHERE user_id = $1", [agency.userId]);
  const list = await api(baseUrl, agency, '/v1/webhooks/endpoints');
  assert.equal(list.status, 403);
});

test('a database dump restores into an empty database that matches its manifest, triggers included', async () => {
  const { database: source, pool: sourcePool } = await migratedDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  await sourcePool.query("INSERT INTO organizations (id, name, business_type, country_code) VALUES ($1, 'Restore Drill Travel', 'agency', 'IN')", [organizationId]);
  await sourcePool.query("INSERT INTO users (id, full_name, email, password_hash) VALUES ($1, 'Drill Owner', 'drill@agency.example', 'x')", [userId]);
  await sourcePool.query("INSERT INTO organization_memberships (id, organization_id, user_id, access_role) VALUES ($1, $2, $3, 'owner')", [randomUUID(), organizationId, userId]);
  await notify(sourcePool, organizationId, 'offer_submitted');
  const expected = await captureManifest(sourcePool);
  assert.equal(expected.rowCounts.notification_outbox, 1);
  assert.ok(expected.triggers.includes('notifications.notifications_enqueue_webhooks'));

  const dump = await pgDump({ pg: source, args: ['--no-owner', '--no-privileges'] });
  const restoredDatabase = new PGlite();
  await restoredDatabase.waitReady;
  await restoredDatabase.exec(await dump.text());
  await restoredDatabase.exec('SET search_path TO "$user", public');
  const restoredPool = new EmbeddedPostgresPool(restoredDatabase);
  const comparison = compareManifests(expected, await captureManifest(restoredPool));
  assert.deepEqual(comparison.problems, []);
  assert.equal(comparison.ok, true);

  // Restored identity sequences and triggers keep working.
  await notify(restoredPool, organizationId, 'offer_withdrawn');
  const outbox = await restoredPool.query('SELECT id FROM notification_outbox ORDER BY id');
  assert.equal(outbox.rowCount, 2);
  assert.ok(Number(outbox.rows[1].id) > Number(outbox.rows[0].id));

  await restoredPool.query('DELETE FROM notification_outbox');
  await restoredPool.query('DELETE FROM schema_migrations WHERE version = 18');
  const broken = compareManifests(expected, await captureManifest(restoredPool));
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some((problem) => problem.includes('Missing migrations: 18')));
  assert.ok(broken.problems.some((problem) => problem.includes('notification_outbox')));
  await sourcePool.end();
  await restoredPool.end();
});

test('backup tooling keeps passwords out of arguments and refuses to restore over production', () => {
  const env = pgEnvironment('postgresql://lx_user:p%40ss@ep-cool-1234-pooler.ap-southeast-1.aws.neon.tech/lead_exchange?sslmode=require&channel_binding=require');
  assert.equal(env.PGPASSWORD, 'p@ss');
  assert.equal(env.PGSSLMODE, 'require');
  assert.equal(env.PGCHANNELBINDING, 'require');
  assert.equal(env.PGDATABASE, 'lead_exchange');
  assert.equal(sameDatabase(
    'postgresql://a:b@ep-cool-1234-pooler.ap-southeast-1.aws.neon.tech/lead_exchange',
    'postgresql://a:b@ep-cool-1234.ap-southeast-1.aws.neon.tech/lead_exchange',
  ), true);
  assert.equal(sameDatabase(
    'postgresql://a:b@ep-cool-1234.ap-southeast-1.aws.neon.tech/lead_exchange',
    'postgresql://a:b@ep-drill-5678.ap-southeast-1.aws.neon.tech/lead_exchange',
  ), false);
});

test('admins see backup and restore-drill freshness', async (context) => {
  const { pool, baseUrl } = await startApp(context);
  const admin = await registerAgency(baseUrl, pool, 'ops@platform.example');
  await pool.query('UPDATE users SET is_platform_admin = TRUE WHERE id = $1', [admin.userId]);
  const enrollment = createTotpEnrollment('ops@platform.example', mfaKey);
  await pool.query('INSERT INTO user_mfa (user_id, secret_ciphertext, enabled) VALUES ($1, $2, TRUE)', [admin.userId, enrollment.secretCiphertext]);

  const empty = await api(baseUrl, admin, '/v1/admin/operations');
  assert.equal(empty.status, 200);
  assert.ok(empty.body.checks.every((check) => check.overdue));

  await pool.query(
    `INSERT INTO operation_runs (id, kind, status, started_at, finished_at, details) VALUES
     ($1, 'database_backup', 'succeeded', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '50 minutes', '{"sha256":"abc"}'),
     ($2, 'restore_drill', 'succeeded', NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days', '{}'),
     ($3, 'restore_drill', 'failed', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', '{"error":"checksum"}')`,
    [randomUUID(), randomUUID(), randomUUID()],
  );
  const status = await api(baseUrl, admin, '/v1/admin/operations');
  const byKind = Object.fromEntries(status.body.checks.map((check) => [check.kind, check]));
  assert.equal(byKind.database_backup.overdue, false);
  assert.equal(byKind.restore_drill.overdue, true);
  assert.equal(byKind.restore_drill.failingSinceSuccess, true);
  assert.equal(status.body.recentRuns.length, 3);
});
