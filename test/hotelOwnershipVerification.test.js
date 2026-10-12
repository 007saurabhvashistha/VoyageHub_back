import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app.js';
import { EmbeddedPostgresPool } from '../src/db/embeddedPool.js';
import { createDestination } from '../src/services/destinations.js';
import { createTotpEnrollment } from '../src/services/totp.js';

const migrationDirectory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const migrations = await Promise.all((await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort()
  .map((name) => readFile(`${migrationDirectory}${name}`, 'utf8')));
const tokenKey = Buffer.alloc(32, 71);
const mfaKey = Buffer.alloc(32, 73);
const pools = new Map();

async function startApp(context) {
  const database = new PGlite();
  await database.waitReady;
  const pool = new EmbeddedPostgresPool(database);
  for (const migration of migrations) await pool.exec(migration);
  const country = await createDestination(pool, { kind: 'country', countryCode: 'AQ' });
  const city = await createDestination(pool, { kind: 'city', name: 'Test Place', countryCode: 'AQ', parentId: country.id });
  const server = createApp({ pool, secureCookies: false, tokenEncryptionKey: tokenKey, mfaEncryptionKey: mfaKey, emailDelivery: async () => {} }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  pools.set(baseUrl, pool);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    pools.delete(baseUrl);
    await pool.end();
  });
  return { pool, baseUrl, city };
}

let accountCounter = 0;
async function registerHotelier(baseUrl, cityId) {
  accountCounter += 1;
  const email = `hotelier-ownership-${accountCounter}@example.test`;
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: `Hotelier ${accountCounter}`, organization_name: `Grand Hotel ${accountCounter}`, email, country_code: 'AQ', business_type: 'hotelier',
      property_destination_id: cityId, password: 'ownership-test-password',
    }),
  });
  assert.equal(response.status, 201);
  const account = await response.json();
  const pool = pools.get(baseUrl);
  await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [account.user.id]);
  await pool.query("UPDATE seller_profiles SET verification_status = 'approved' WHERE organization_id = $1", [account.organization.id]);
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'ownership-test-password', business_type: 'hotelier' }),
  });
  assert.equal(login.status, 200);
  return { session: await login.json(), cookie: login.headers.get('set-cookie').split(';')[0], organizationId: account.organization.id, userId: account.user.id };
}

async function promoteAdmin(pool, account) {
  await pool.query('UPDATE users SET is_platform_admin = TRUE WHERE id = $1', [account.userId]);
  const enrollment = createTotpEnrollment(account.session.user.email, mfaKey);
  await pool.query('INSERT INTO user_mfa (user_id, secret_ciphertext, enabled) VALUES ($1, $2, TRUE)', [account.userId, enrollment.secretCiphertext]);
}

test('hotel ownership verification proof linking and admin review workflow', async (context) => {
  const { pool, baseUrl, city } = await startApp(context);
  const hotelier = await registerHotelier(baseUrl, city.id);

  // List properties
  const propRes = await fetch(`${baseUrl}/v1/hotel-properties`, { headers: { cookie: hotelier.cookie } });
  assert.equal(propRes.status, 200);
  const properties = (await propRes.json()).properties;
  assert.equal(properties.length, 1);
  const property = properties[0];
  assert.equal(property.ownershipCheckStatus, 'pending');

  // Insert a clean property_proof document directly for testing
  const docId = randomUUID();
  await pool.query(
    `INSERT INTO organization_documents (id, organization_id, document_type, storage_provider, storage_key, original_filename, content_type, size_bytes, sha256, scan_status)
     VALUES ($1, $2, 'property_proof', 's3', $3, 'deed.pdf', 'application/pdf', 1024, '0000000000000000000000000000000000000000000000000000000000000000', 'clean')`,
    [docId, hotelier.organizationId, `key/${docId}.pdf`],
  );

  // Link property proof as hotelier
  const linkRes = await fetch(`${baseUrl}/v1/hotel-properties/${property.id}/proof`, {
    method: 'POST',
    headers: { cookie: hotelier.cookie, 'content-type': 'application/json', 'x-csrf-token': hotelier.session.csrfToken },
    body: JSON.stringify({ document_id: docId, proof_type: 'property_deed' }),
  });
  assert.equal(linkRes.status, 200);
  const linkedProperty = (await linkRes.json()).property;
  assert.equal(linkedProperty.ownershipCheckStatus, 'evidence_ready');
  assert.equal(linkedProperty.propertyProofDocumentId, docId);
  assert.equal(linkedProperty.ownershipProofType, 'property_deed');

  // Admin reviews ownership proof
  const admin = await registerHotelier(baseUrl, city.id);
  await promoteAdmin(pool, admin);

  const reviewRes = await fetch(`${baseUrl}/v1/admin/hotel-properties/${property.id}/ownership-review`, {
    method: 'POST',
    headers: { cookie: admin.cookie, 'content-type': 'application/json', 'x-csrf-token': admin.session.csrfToken },
    body: JSON.stringify({ decision: 'verified', reason: 'Reviewed property deed document successfully.' }),
  });
  assert.equal(reviewRes.status, 200);
  const verifiedProperty = (await reviewRes.json()).property;
  assert.equal(verifiedProperty.ownershipCheckStatus, 'verified');
});
