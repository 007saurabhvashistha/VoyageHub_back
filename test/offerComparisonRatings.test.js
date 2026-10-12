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
async function registerUser(baseUrl, role, cityId) {
  accountCounter += 1;
  const email = `${role}-comparison-${accountCounter}@example.test`;
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: `${role} User ${accountCounter}`,
      organization_name: `${role} Org ${accountCounter}`,
      email,
      country_code: 'AQ',
      business_type: role,
      ...(role === 'dmc' ? { coverage_destination_ids: [cityId] } : {}),
      ...(role === 'hotelier' ? { property_destination_id: cityId } : {}),
      password: 'test-password-123',
    }),
  });
  assert.equal(response.status, 201);
  const account = await response.json();
  const pool = pools.get(baseUrl);
  await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [account.user.id]);
  if (role !== 'agency') {
    await pool.query("UPDATE seller_profiles SET verification_status = 'approved' WHERE organization_id = $1", [account.organization.id]);
  }
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'test-password-123', business_type: role }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { account, cookie, csrfToken: session.csrfToken };
}

async function seedReview(pool, agencyOrgId, sellerOrgId, rating) {
  const reqId = randomUUID();
  const offerId = randomUUID();
  const awardId = randomUUID();
  const reviewId = randomUUID();

  await pool.query(
    `INSERT INTO marketplace_requests (id, request_code, agency_organization_id, destination, destination_country, requirement_type, nights, adults, group_type, services, response_deadline, status)
     VALUES ($1, $2, $3, 'Old Destination', 'AQ', 'itinerary', 3, 2, 'honeymoon', ARRAY['guide']::text[], NOW() + INTERVAL '1 day', 'awarded')`,
    [reqId, `OLD-${randomUUID().slice(0, 8)}`, agencyOrgId],
  );

  await pool.query(
    `INSERT INTO offers (id, request_id, seller_organization_id, offer_kind, total_minor, currency, validity_until, status)
     VALUES ($1, $2, $3, 'land_package', 10000, 'USD', NOW() + INTERVAL '1 day', 'accepted')`,
    [offerId, reqId, sellerOrgId],
  );

  await pool.query(
    `INSERT INTO awards (id, request_id, offer_id, agency_organization_id, seller_organization_id, status)
     VALUES ($1, $2, $3, $4, $5, 'awarded')`,
    [awardId, reqId, offerId, agencyOrgId, sellerOrgId],
  );

  await pool.query(
    `INSERT INTO organization_reviews (id, award_id, reviewer_organization_id, reviewee_organization_id, rating, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [reviewId, awardId, agencyOrgId, sellerOrgId, rating],
  );
}

test('Offer comparison labels include best_rated badge and seller rating metrics', async (t) => {
  const { pool, baseUrl, city } = await startApp(t);
  const agency = await registerUser(baseUrl, 'agency', city.id);
  const dmc1 = await registerUser(baseUrl, 'dmc', city.id);
  const dmc2 = await registerUser(baseUrl, 'dmc', city.id);

  // 1. Agency creates marketplace request
  const reqResponse = await fetch(`${baseUrl}/v1/marketplace/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: agency.cookie, 'x-csrf-token': agency.csrfToken },
    body: JSON.stringify({
      destinations: [{ destination_id: city.id, nights: 3 }],
      requirement_type: 'itinerary',
      travel_start_date: '2026-11-01',
      travel_end_date: '2026-11-04',
      nights: 3,
      adults: 2,
      group_type: 'honeymoon',
      services: ['guide', 'transfers'],
      response_deadline: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    }),
  });
  assert.equal(reqResponse.status, 201);
  const { request } = await reqResponse.json();

  // Publish the request so DMCs are targeted and can submit offers
  const pubResponse = await fetch(`${baseUrl}/v1/marketplace/requests/${request.id}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: agency.cookie, 'x-csrf-token': agency.csrfToken },
    body: JSON.stringify({}),
  });
  assert.equal(pubResponse.status, 200);

  // 2. Insert past reviews for sellers: DMC 1 gets rating 5 (>= 4.0), DMC 2 gets rating 3 (< 4.0)
  await seedReview(pool, agency.account.organization.id, dmc1.account.organization.id, 5);
  await seedReview(pool, agency.account.organization.id, dmc2.account.organization.id, 3);

  // 3. DMC 1 submits offer (higher price: 50000, 1 inclusion)
  const offer1Response = await fetch(`${baseUrl}/v1/marketplace/requests/${request.id}/offers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: dmc1.cookie, 'x-csrf-token': dmc1.csrfToken },
    body: JSON.stringify({
      trip_version: request.tripVersion,
      currency: 'USD',
      total_minor: 50000,
      validity_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      inclusions: ['breakfast'],
    }),
  });
  assert.equal(offer1Response.status, 201);

  // 4. DMC 2 submits offer (lower price: 30000, 3 inclusions)
  const offer2Response = await fetch(`${baseUrl}/v1/marketplace/requests/${request.id}/offers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: dmc2.cookie, 'x-csrf-token': dmc2.csrfToken },
    body: JSON.stringify({
      trip_version: request.tripVersion,
      currency: 'USD',
      total_minor: 30000,
      validity_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      inclusions: ['breakfast', 'transfers', 'guide'],
    }),
  });
  assert.equal(offer2Response.status, 201);

  // 5. Agency fetches comparison offers
  const comparisonResponse = await fetch(`${baseUrl}/v1/marketplace/requests/${request.id}/offers`, {
    headers: { cookie: agency.cookie },
  });
  assert.equal(comparisonResponse.status, 200);
  const { offers } = await comparisonResponse.json();
  assert.equal(offers.length, 2);

  const offer1 = offers.find((item) => item.sellerName === dmc1.account.organization.name);
  const offer2 = offers.find((item) => item.sellerName === dmc2.account.organization.name);

  // Check DMC 1 (best_rated)
  assert.equal(offer1.sellerRatingAverage, 5);
  assert.equal(offer1.sellerRatingCount, 1);
  assert.ok(offer1.comparisonLabels.includes('best_rated'), 'DMC 1 should have best_rated label');

  // Check DMC 2 (lowest price & most inclusive)
  assert.equal(offer2.sellerRatingAverage, 3);
  assert.equal(offer2.sellerRatingCount, 1);
  assert.ok(offer2.comparisonLabels.includes('lowest'), 'DMC 2 should have lowest label');
  assert.ok(offer2.comparisonLabels.includes('most_inclusive'), 'DMC 2 should have most_inclusive label');
  assert.ok(!offer2.comparisonLabels.includes('best_rated'), 'DMC 2 should NOT have best_rated label');

  // Response time check
  assert.ok(typeof offer1.responseTimeMinutes === 'number');
  assert.ok(offer1.responseTimeMinutes >= 0);
});
