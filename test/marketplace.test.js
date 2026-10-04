import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { EmbeddedPostgresPool } from '../src/db/embeddedPool.js';
import { processNotificationOutbox } from '../src/jobs/notificationOutbox.js';
import { processRequestDeadlines } from '../src/jobs/requestDeadlines.js';
import { processReminders } from '../src/jobs/reminders.js';
import { processAccountRetention } from '../src/jobs/accountRetention.js';
import { createResendEmailDelivery } from '../src/services/resendEmailDelivery.js';
import { createTotpEnrollment } from '../src/services/totp.js';
import { createDestination } from '../src/services/destinations.js';
import { processDocumentRetention, processDocumentScans } from '../src/jobs/verificationDocuments.js';
import { documentRequirementsFor } from '../src/services/verificationDocuments.js';
import { processGuestDataRetention } from '../src/jobs/bookingGuestData.js';

const migrationNames = (await readdir(fileURLToPath(new URL('../db/migrations/', import.meta.url)))).filter((name) => name.endsWith('.sql')).sort();
const migrations = await Promise.all(migrationNames.map(async (name) => {
  const migrationUrl = new URL(`../db/migrations/${name}`, import.meta.url);
  return readFile(fileURLToPath(migrationUrl), 'utf8');
}));
const testPools = new Map();
const testTokenEncryptionKey = Buffer.alloc(32, 29);
const testMfaEncryptionKey = Buffer.alloc(32, 31);
const testGuestDataEncryptionKey = Buffer.alloc(32, 37);
const destinationIds = {
  jp: '00000000-0000-4000-8000-000000000001',
  kyoto: '00000000-0000-4000-8000-000000000002',
  osaka: '00000000-0000-4000-8000-000000000003',
  ma: '00000000-0000-4000-8000-000000000004',
  marrakech: '00000000-0000-4000-8000-000000000005',
};

async function seedDestinations(pool) {
  await createDestination(pool, { id: destinationIds.jp, kind: 'country', countryCode: 'JP' });
  await createDestination(pool, { id: destinationIds.kyoto, kind: 'city', name: 'Kyoto', countryCode: 'JP', parentId: destinationIds.jp });
  await createDestination(pool, { id: destinationIds.osaka, kind: 'city', name: 'Osaka', countryCode: 'JP', parentId: destinationIds.jp });
  await createDestination(pool, { id: destinationIds.ma, kind: 'country', countryCode: 'MA' });
  await createDestination(pool, { id: destinationIds.marrakech, kind: 'city', name: 'Marrakech', countryCode: 'MA', parentId: destinationIds.ma });
}

function destinationIdsFor(names = '') {
  return names.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean).map((name) => destinationIds[name]);
}

function createMemoryStorage() {
  const objects = new Map();
  return {
    provider: 'memory',
    keyPrefix: 'test-documents',
    objects,
    async putObject({ key, body, contentType }) { objects.set(key, { body: Buffer.from(body), contentType }); },
    async getObject(key) {
      if (!objects.has(key)) throw new Error('Object not found.');
      return objects.get(key).body;
    },
    async deleteObject(key) { objects.delete(key); },
    async createDownloadUrl(key, { expiresInSeconds, contentDisposition }) {
      return `https://storage.test/${key}?expires=${expiresInSeconds}&disposition=${encodeURIComponent(contentDisposition)}`;
    },
  };
}

async function startMarketplaceApp(context) {
  const database = new PGlite();
  await database.waitReady;
  const pool = new EmbeddedPostgresPool(database);
  for (const migration of migrations) await pool.exec(migration);
  await seedDestinations(pool);
  const storage = createMemoryStorage();
  const server = createApp({ pool, secureCookies: false, emailDelivery: async () => {}, tokenEncryptionKey: testTokenEncryptionKey, mfaEncryptionKey: testMfaEncryptionKey, storage, guestDataEncryptionKey: testGuestDataEncryptionKey }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  testPools.set(baseUrl, pool);
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    testPools.delete(baseUrl);
    await pool.end();
  });
  return { pool, baseUrl, storage };
}

// Stands in for uploads that already passed the malware scan, so approval tests stay focused.
async function seedCleanDocuments(pool, organizationId, businessType, countryCode) {
  for (const { type, required } of documentRequirementsFor(businessType, countryCode)) {
    if (!required) continue;
    await pool.query(
      `INSERT INTO organization_documents (id, organization_id, document_type, storage_provider, storage_key, original_filename, content_type, size_bytes, sha256, scan_status, scanned_at)
       VALUES ($1, $2, $3, 'memory', $4, $5, 'application/pdf', 1, $6, 'clean', NOW())`,
      [randomUUID(), organizationId, type, `seed/${organizationId}/${type}`, `${type}.pdf`, '0'.repeat(64)],
    );
  }
}

async function register(baseUrl, { name, organization, email, role, countryCode, coverage, propertyCity, documents = true }) {
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: name,
      organization_name: organization,
      email,
      country_code: countryCode,
      business_type: role,
      coverage_destination_ids: destinationIdsFor(coverage),
      property_destination_id: propertyCity ? destinationIdsFor(propertyCity)[0] : null,
      password: 'marketplace-test-password',
    }),
  });
  assert.equal(response.status, 201);
  const account = await response.json();
  const pool = testPools.get(baseUrl);
  await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [account.user.id]);
  if (role !== 'agency' && documents) await seedCleanDocuments(pool, account.organization.id, role, countryCode);
  await pool.query("UPDATE notification_outbox SET status = 'delivered' WHERE recipient_user_id = $1 AND event_type = 'email_verification'", [account.user.id]);
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'marketplace-test-password', business_type: role }),
  });
  assert.equal(login.status, 200);
  return {
    session: await login.json(),
    cookie: login.headers.get('set-cookie').split(';')[0],
  };
}

async function promoteTestAdmin(pool, account) {
  await pool.query('UPDATE users SET is_platform_admin = TRUE WHERE id = $1', [account.session.user.id]);
  const enrollment = createTotpEnrollment(account.session.user.email, testMfaEncryptionKey);
  await pool.query(
    'INSERT INTO user_mfa (user_id, secret_ciphertext, enabled) VALUES ($1, $2, TRUE)',
    [account.session.user.id, enrollment.secretCiphertext],
  );
}

async function api(baseUrl, path, session, { method = 'GET', body } = {}) {
  const headers = { cookie: session.cookie };
  if (body) {
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = session.session.csrfToken;
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: response.status === 204 ? null : await response.json() };
}

function requestInput() {
  return {
    destination_id: destinationIds.kyoto,
    travel_start_date: '2027-04-14',
    travel_end_date: '2027-04-21',
    nights: 7,
    adults: 2,
    children: 0,
    infants: 0,
    group_type: 'family',
    hotel_category: 4,
    room_count: 1,
    meal_plan: 'breakfast',
    services: ['hotel', 'transfers', 'guide'],
    budget_min_minor: 100000,
    budget_max_minor: 250000,
    budget_currency: 'USD',
    response_deadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  };
}

test('agency publishes an allowlisted request, only matched verified DMC sees it, and award stays tenant-scoped', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const agency = await register(baseUrl, {
    name: 'Maya Chen', organization: 'Northstar Travel', email: 'agency@example.test', role: 'agency', countryCode: 'US',
  });
  const matchedDmc = await register(baseUrl, {
    name: 'Omar Haddad', organization: 'Kyoto Local Experts', email: 'dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto, JP',
  });
  const unmatchedDmc = await register(baseUrl, {
    name: 'Amina Ali', organization: 'Atlas Morocco', email: 'unmatched@example.test', role: 'dmc', countryCode: 'MA', coverage: 'marrakech, MA',
  });
  const admin = await register(baseUrl, {
    name: 'Platform Reviewer', organization: 'Operations', email: 'admin@example.test', role: 'agency', countryCode: 'US',
  });
  await promoteTestAdmin(pool, admin);

  const draftResult = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  assert.equal(draftResult.response.status, 201);
  assert.equal(draftResult.body.request.status, 'draft');
  const unpublishedInbox = await api(baseUrl, '/v1/marketplace/requests', matchedDmc);
  assert.equal(unpublishedInbox.body.requests.length, 0);

  const published = await api(baseUrl, `/v1/marketplace/requests/${draftResult.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  assert.equal(published.response.status, 200);
  assert.equal(published.body.targetedSellerCount, 0);

  const forbiddenQueue = await api(baseUrl, '/v1/admin/seller-profiles/pending', agency);
  assert.equal(forbiddenQueue.response.status, 403);
  const pendingQueue = await api(baseUrl, '/v1/admin/seller-profiles/pending', admin);
  assert.equal(pendingQueue.body.sellers.length, 2);
  const approval = await api(baseUrl, `/v1/admin/seller-profiles/${matchedDmc.session.organization.id}/decision`, admin, {
    method: 'POST', body: { decision: 'approved', reason: 'Business details reviewed by operations.' },
  });
  assert.equal(approval.response.status, 200);
  const supplierDirectory = await api(baseUrl, '/v1/marketplace/suppliers', agency);
  assert.equal(supplierDirectory.body.pagination.total, 1);
  assert.equal(supplierDirectory.body.suppliers[0].name, 'Kyoto Local Experts');
  assert.equal(supplierDirectory.body.suppliers[0].verified, true);
  assert.equal(Object.hasOwn(supplierDirectory.body.suppliers[0], 'email'), false);
  const filteredDirectory = await api(baseUrl, '/v1/marketplace/suppliers?search=Morocco', agency);
  assert.equal(filteredDirectory.body.pagination.total, 0);
  const sellerDirectory = await api(baseUrl, '/v1/marketplace/suppliers', matchedDmc);
  assert.equal(sellerDirectory.response.status, 403);
  const adminFlag = await pool.query('SELECT is_platform_admin FROM users WHERE id = $1', [admin.session.user.id]);
  assert.equal(adminFlag.rows[0].is_platform_admin, true);

  const matchedInbox = await api(baseUrl, '/v1/marketplace/requests', matchedDmc);
  assert.equal(matchedInbox.body.requests.length, 1);
  assert.equal(matchedInbox.body.requests[0].agencyName, 'Northstar Travel');
  assert.equal(matchedInbox.body.requests[0].agencyVerified, false);
  assert.equal(Object.hasOwn(matchedInbox.body.requests[0], 'agencyOrganizationId'), false);
  assert.equal(Object.hasOwn(matchedInbox.body.requests[0], 'leadId'), false);
  const unmatchedInbox = await api(baseUrl, '/v1/marketplace/requests', unmatchedDmc);
  assert.equal(unmatchedInbox.body.requests.length, 0);
  const matchNotifications = await api(baseUrl, '/v1/notifications', matchedDmc);
  assert.equal(matchNotifications.body.unreadCount, 1);
  assert.equal(matchNotifications.body.notifications[0].type, 'request_matched');
  assert.equal((await api(baseUrl, '/v1/notifications', unmatchedDmc)).body.unreadCount, 0);

  const offer = await api(baseUrl, `/v1/marketplace/requests/${draftResult.body.request.id}/offers`, matchedDmc, {
    method: 'POST',
    body: {
      total_minor: 183000,
      currency: 'USD',
      inclusions: ['accommodation', 'breakfast', 'guide'],
      exclusions: ['flights'],
      validity_until: new Date(Date.now() + 5 * 86400000).toISOString(),
    },
  });
  assert.equal(offer.response.status, 201);
  const ownOffers = await api(baseUrl, '/v1/marketplace/offers', matchedDmc);
  assert.equal(ownOffers.body.offers.length, 1);
  assert.deepEqual({ rank: ownOffers.body.offers[0].rank, eligible: ownOffers.body.offers[0].eligibleCount }, { rank: 1, eligible: 1 });

  const compared = await api(baseUrl, `/v1/marketplace/requests/${draftResult.body.request.id}/offers`, agency);
  assert.equal(compared.body.offers.length, 1);
  assert.equal(compared.body.offers[0].sellerName, 'Kyoto Local Experts');
  const offerNotifications = await api(baseUrl, '/v1/notifications', agency);
  assert.equal(offerNotifications.body.unreadCount, 1);
  assert.equal(offerNotifications.body.notifications[0].type, 'offer_submitted');
  const wrongAgency = await register(baseUrl, {
    name: 'Other User', organization: 'Other Agency', email: 'other@example.test', role: 'agency', countryCode: 'US',
  });
  const forbiddenCompare = await api(baseUrl, `/v1/marketplace/requests/${draftResult.body.request.id}/offers`, wrongAgency);
  assert.equal(forbiddenCompare.response.status, 404);

  const award = await api(baseUrl, `/v1/marketplace/requests/${draftResult.body.request.id}/award`, agency, {
    method: 'POST', body: { offer_id: offer.body.offer.id },
  });
  assert.equal(award.response.status, 201);
  assert.equal(award.body.award.status, 'awarded');
  const awardDetails = await api(baseUrl, `/v1/marketplace/awards/${award.body.award.id}`, agency);
  assert.equal(awardDetails.body.award.status, 'awarded');
  assert.equal(awardDetails.body.award.guestDetailsReleased, false);
  const awardNotifications = await api(baseUrl, '/v1/notifications', matchedDmc);
  assert.ok(awardNotifications.body.notifications.some((item) => item.type === 'offer_awarded'));
  const markRead = await api(baseUrl, `/v1/notifications/${awardNotifications.body.notifications.find((item) => item.type === 'offer_awarded').id}/read`, matchedDmc, { method: 'POST', body: {} });
  assert.equal(markRead.response.status, 204);
  assert.equal((await api(baseUrl, '/v1/notifications', matchedDmc)).body.unreadCount, 1);
  const closedInbox = await api(baseUrl, '/v1/marketplace/requests', matchedDmc);
  assert.equal(closedInbox.body.requests.length, 1);
  assert.equal(closedInbox.body.requests[0].status, 'awarded');
});

test('unverified DMCs cannot receive targets or submit offers', async (context) => {
  const { baseUrl } = await startMarketplaceApp(context);
  const agency = await register(baseUrl, {
    name: 'Agency Owner', organization: 'Pilot Agency', email: 'pilot@example.test', role: 'agency', countryCode: 'US',
  });
  const dmc = await register(baseUrl, {
    name: 'DMC Owner', organization: 'Pending DMC', email: 'pending@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto, JP',
  });
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', dmc)).body.requests.length, 0);

  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  await api(baseUrl, `/v1/marketplace/requests/${draft.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  const forbiddenOffer = await api(baseUrl, `/v1/marketplace/requests/${draft.body.request.id}/offers`, dmc, {
    method: 'POST',
    body: { total_minor: 10000, currency: 'USD', inclusions: ['guide'], exclusions: [], validity_until: new Date(Date.now() + 86400000).toISOString() },
  });
  assert.equal(forbiddenOffer.response.status, 403);
  assert.equal(forbiddenOffer.body.error.code, 'SELLER_NOT_VERIFIED');
});

test('hotel room requests, nightly quotes, and date inventory are persisted and tenant-scoped', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const agency = await register(baseUrl, {
    name: 'Hotel Buyer', organization: 'Kyoto Travel Desk', email: 'hotel-agency@example.test', role: 'agency', countryCode: 'US',
  });
  const hotelier = await register(baseUrl, {
    name: 'Property Manager', organization: 'Linden Kyoto', email: 'hotel@example.test', role: 'hotelier', countryCode: 'JP', propertyCity: 'Kyoto',
  });
  const admin = await register(baseUrl, {
    name: 'Operations Reviewer', organization: 'Platform Ops', email: 'hotel-admin@example.test', role: 'agency', countryCode: 'US',
  });
  await promoteTestAdmin(pool, admin);

  const roomRequest = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const published = await api(baseUrl, `/v1/marketplace/requests/${roomRequest.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  assert.equal(published.body.targetedSellerCount, 0);
  const approval = await api(baseUrl, `/v1/admin/seller-profiles/${hotelier.session.organization.id}/decision`, admin, {
    method: 'POST', body: { decision: 'approved', reason: 'Property registration evidence verified.' },
  });
  assert.equal(approval.response.status, 200);

  const inbox = await api(baseUrl, '/v1/marketplace/requests', hotelier);
  assert.equal(inbox.body.requests.length, 1);
  assert.equal(inbox.body.requests[0].agencyName, 'Kyoto Travel Desk');
  const roomQuote = await api(baseUrl, `/v1/marketplace/requests/${roomRequest.body.request.id}/offers`, hotelier, {
    method: 'POST',
    body: { rate_per_night_minor: 18500, room_type: 'Garden Suite', meal_plan: 'breakfast', currency: 'JPY', inclusions: ['breakfast'], exclusions: [], validity_until: new Date(Date.now() + 5 * 86400000).toISOString() },
  });
  assert.equal(roomQuote.response.status, 201);
  assert.equal(roomQuote.body.offer.kind, 'hotel_room');
  assert.equal(roomQuote.body.offer.ratePerNightMinor, 18500);
  const ownQuotes = await api(baseUrl, '/v1/marketplace/offers', hotelier);
  assert.equal(ownQuotes.body.offers.length, 1);
  assert.equal(ownQuotes.body.offers[0].roomType, 'Garden Suite');

  const comparison = await api(baseUrl, `/v1/marketplace/requests/${roomRequest.body.request.id}/offers`, agency);
  assert.equal(comparison.body.offers.length, 1);
  assert.equal(comparison.body.offers[0].kind, 'hotel_room');
  assert.equal(comparison.body.offers[0].ratePerNightMinor, 18500);

  const inventory = await api(baseUrl, '/v1/marketplace/hotel/inventory', hotelier, {
    method: 'PUT',
    body: { inventory: [{ date: '2027-04-14', room_type: 'Garden Suite', available_rooms: 3, nightly_rate_minor: 18500, currency: 'JPY' }] },
  });
  assert.equal(inventory.response.status, 200);
  assert.equal(inventory.body.savedCount, 1);
  const inventoryRead = await api(baseUrl, '/v1/marketplace/hotel/inventory?from=2027-04-14&to=2027-04-14', hotelier);
  assert.equal(inventoryRead.body.inventory.length, 1);
  assert.equal(inventoryRead.body.inventory[0].availableRooms, 3);
  const agencyInventory = await api(baseUrl, '/v1/marketplace/hotel/inventory?from=2027-04-14&to=2027-04-14', agency);
  assert.equal(agencyInventory.response.status, 403);
});

test('request detail, decline, offer revision history, withdrawal, and close are tenant-scoped', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const agency = await register(baseUrl, {
    name: 'Workflow Owner', organization: 'Workflow Agency', email: 'workflow-agency@example.test', role: 'agency', countryCode: 'US',
  });
  const dmc = await register(baseUrl, {
    name: 'Workflow Seller', organization: 'Workflow DMC', email: 'workflow-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto, JP',
  });
  const admin = await register(baseUrl, {
    name: 'Workflow Admin', organization: 'Workflow Ops', email: 'workflow-admin@example.test', role: 'agency', countryCode: 'US',
  });
  const otherDmc = await register(baseUrl, {
    name: 'Other Seller', organization: 'Other DMC', email: 'other-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto, JP',
  });
  await promoteTestAdmin(pool, admin);
  const firstDraft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const secondDraft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const privateDraft = await api(baseUrl, `/v1/marketplace/requests/${firstDraft.body.request.id}`, otherDmc);
  assert.equal(privateDraft.response.status, 404);
  await api(baseUrl, `/v1/marketplace/requests/${firstDraft.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  await api(baseUrl, `/v1/marketplace/requests/${secondDraft.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  await api(baseUrl, `/v1/admin/seller-profiles/${dmc.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Seller documents reviewed for the API test.' } });

  const sellerDetail = await api(baseUrl, `/v1/marketplace/requests/${firstDraft.body.request.id}`, dmc);
  assert.equal(sellerDetail.body.request.agencyName, 'Workflow Agency');
  assert.equal(Object.hasOwn(sellerDetail.body.request, 'agencyOrganizationId'), false);
  assert.equal(Object.hasOwn(sellerDetail.body.request, 'leadId'), false);
  const declined = await api(baseUrl, `/v1/marketplace/requests/${secondDraft.body.request.id}/decline`, dmc, { method: 'POST', body: { reason: 'Outside our current delivery capacity.' } });
  assert.equal(declined.response.status, 204);

  const submitted = await api(baseUrl, `/v1/marketplace/requests/${firstDraft.body.request.id}/offers`, dmc, {
    method: 'POST',
    body: { total_minor: 172000, currency: 'USD', inclusions: ['guide'], exclusions: [], validity_until: new Date(Date.now() + 4 * 86400000).toISOString() },
  });
  const revised = await api(baseUrl, `/v1/marketplace/offers/${submitted.body.offer.id}`, dmc, {
    method: 'PUT',
    body: { total_minor: 169000, currency: 'USD', inclusions: ['guide', 'transfers'], exclusions: [], validity_until: new Date(Date.now() + 6 * 86400000).toISOString() },
  });
  assert.equal(revised.response.status, 200);
  assert.equal(revised.body.offer.totalMinor, 169000);
  const history = await api(baseUrl, `/v1/marketplace/offers/${submitted.body.offer.id}/revisions`, dmc);
  assert.equal(history.body.revisions.length, 1);
  assert.equal(history.body.revisions[0].snapshot.totalMinor, 172000);
  const hiddenOffer = await api(baseUrl, `/v1/marketplace/offers/${submitted.body.offer.id}`, otherDmc);
  assert.equal(hiddenOffer.response.status, 404);

  const withdrawn = await api(baseUrl, `/v1/marketplace/offers/${submitted.body.offer.id}/withdraw`, dmc, { method: 'POST', body: {} });
  assert.equal(withdrawn.body.status, 'withdrawn');
  const close = await api(baseUrl, `/v1/marketplace/requests/${firstDraft.body.request.id}/close`, agency, { method: 'POST', body: {} });
  assert.equal(close.body.status, 'closed');
  const closedSellerDetail = await api(baseUrl, `/v1/marketplace/requests/${firstDraft.body.request.id}`, dmc);
  assert.equal(closedSellerDetail.response.status, 404);
  const ownedClosedDetail = await api(baseUrl, `/v1/marketplace/requests/${firstDraft.body.request.id}`, agency);
  assert.equal(ownedClosedDetail.body.request.status, 'closed');
});

test('seller profile changes invalidate approval, targets and active offers until reviewed again', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const agency = await register(baseUrl, {
    name: 'Agency Owner', organization: 'Profile Buyer', email: 'profile-agency@example.test', role: 'agency', countryCode: 'US',
  });
  const dmc = await register(baseUrl, {
    name: 'DMC Owner', organization: 'Profile DMC', email: 'profile-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto, JP',
  });
  const admin = await register(baseUrl, {
    name: 'Operations Reviewer', organization: 'Profile Operations', email: 'profile-admin@example.test', role: 'agency', countryCode: 'US',
  });
  await promoteTestAdmin(pool, admin);
  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  await api(baseUrl, `/v1/marketplace/requests/${draft.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  await api(baseUrl, `/v1/admin/seller-profiles/${dmc.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Seller details reviewed.' } });
  const submitted = await api(baseUrl, `/v1/marketplace/requests/${draft.body.request.id}/offers`, dmc, {
    method: 'POST', body: { total_minor: 120000, currency: 'USD', inclusions: ['guide'], validity_until: new Date(Date.now() + 86400000).toISOString() },
  });

  const update = await api(baseUrl, '/v1/auth/profile', dmc, { method: 'PUT', body: { coverage_destination_ids: [destinationIds.kyoto, destinationIds.osaka] } });
  assert.equal(update.body.verificationStatus, 'pending');
  assert.equal(update.body.changed, true);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM seller_profile_changes WHERE seller_organization_id = $1', [dmc.session.organization.id])).rows[0].count, 1);
  assert.equal((await pool.query('SELECT status FROM offers WHERE id = $1', [submitted.body.offer.id])).rows[0].status, 'withdrawn');
  assert.equal((await pool.query('SELECT declined_at IS NOT NULL AS declined FROM request_targets WHERE request_id = $1 AND seller_organization_id = $2', [draft.body.request.id, dmc.session.organization.id])).rows[0].declined, true);

  await api(baseUrl, `/v1/admin/seller-profiles/${dmc.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Updated seller details reviewed.' } });
  const inbox = await api(baseUrl, '/v1/marketplace/requests', dmc);
  assert.equal(inbox.body.requests.length, 1);
  assert.equal(inbox.body.requests[0].destination, 'Kyoto');
});

test('request messages are matched-seller-only, notify the peer and reject obvious contact details', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const agency = await register(baseUrl, {
    name: 'Agency Owner', organization: 'Messaging Agency', email: 'messages-agency@example.test', role: 'agency', countryCode: 'US',
  });
  const dmc = await register(baseUrl, {
    name: 'DMC Owner', organization: 'Messaging DMC', email: 'messages-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto, JP',
  });
  const otherDmc = await register(baseUrl, {
    name: 'Other Seller', organization: 'Unmatched DMC', email: 'messages-other@example.test', role: 'dmc', countryCode: 'MA', coverage: 'marrakech, MA',
  });
  const admin = await register(baseUrl, {
    name: 'Operations Reviewer', organization: 'Messaging Operations', email: 'messages-admin@example.test', role: 'agency', countryCode: 'US',
  });
  await promoteTestAdmin(pool, admin);
  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  await api(baseUrl, `/v1/marketplace/requests/${draft.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  await api(baseUrl, `/v1/admin/seller-profiles/${dmc.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Seller details reviewed.' } });
  const sellerId = dmc.session.organization.id;

  const sent = await api(baseUrl, `/v1/marketplace/requests/${draft.body.request.id}/messages`, agency, {
    method: 'POST', body: { seller_organization_id: sellerId, body: 'Can you include a private guide for the arrival day?' },
  });
  assert.equal(sent.response.status, 201);
  const agencyThread = await api(baseUrl, `/v1/marketplace/requests/${draft.body.request.id}/messages?seller_organization_id=${sellerId}`, agency);
  assert.equal(agencyThread.body.messages.length, 1);
  assert.equal(agencyThread.body.messages[0].isMine, true);
  const sellerThread = await api(baseUrl, `/v1/marketplace/requests/${draft.body.request.id}/messages`, dmc);
  assert.equal(sellerThread.body.messages[0].body, sent.body.message.body);
  assert.equal(sellerThread.body.messages[0].isMine, false);
  const hiddenThread = await api(baseUrl, `/v1/marketplace/requests/${draft.body.request.id}/messages`, otherDmc);
  assert.equal(hiddenThread.response.status, 404);
  const contactMessage = await api(baseUrl, `/v1/marketplace/requests/${draft.body.request.id}/messages`, agency, {
    method: 'POST', body: { seller_organization_id: sellerId, body: 'Contact me at traveler@example.com' },
  });
  assert.equal(contactMessage.response.status, 400);
  assert.equal(contactMessage.body.error.code, 'CONTACT_DETAILS_NOT_ALLOWED');
  const notices = await api(baseUrl, '/v1/notifications', dmc);
  assert.ok(notices.body.notifications.some((notification) => notification.type === 'request_message'));
});

test('notification outbox is transactional, blocks missing providers, retries, dead-letters and delivers idempotently', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const account = await register(baseUrl, {
    name: 'Outbox Owner', organization: 'Outbox Agency', email: 'outbox@example.test', role: 'agency', countryCode: 'US',
  });
  await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [account.session.user.id]);
  const rolledBackNotificationId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO notifications (id, organization_id, event_type, title, message, data)
       VALUES ($1, $2, 'request_matched', 'Rolled back', 'This notification must not persist.', '{}'::jsonb)`,
      [rolledBackNotificationId, account.session.organization.id],
    );
    const transactionalOutbox = await client.query('SELECT id FROM notification_outbox WHERE notification_id = $1', [rolledBackNotificationId]);
    assert.equal(transactionalOutbox.rowCount, 1);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const rolledBack = await pool.query('SELECT COUNT(*) AS count FROM notification_outbox WHERE notification_id = $1', [rolledBackNotificationId]);
  assert.equal(Number(rolledBack.rows[0].count), 0);

  const notificationId = randomUUID();
  await pool.query(
    `INSERT INTO notifications (id, organization_id, event_type, title, message, data)
     VALUES ($1, $2, 'request_matched', 'New request', 'A request matches your coverage.', '{}'::jsonb)`,
    [notificationId, account.session.organization.id],
  );
  const initial = await pool.query('SELECT * FROM notification_outbox WHERE notification_id = $1', [notificationId]);
  assert.equal(initial.rowCount, 1);
  assert.equal(initial.rows[0].recipient_user_id, account.session.user.id);

  const blocked = await processNotificationOutbox(pool);
  assert.equal(blocked.blockedConfig, 1);
  let state = await pool.query('SELECT status, attempts FROM notification_outbox WHERE notification_id = $1', [notificationId]);
  assert.deepEqual(state.rows[0], { status: 'blocked_config', attempts: 0 });

  await pool.query("UPDATE notification_outbox SET status = 'pending', last_error_code = NULL WHERE notification_id = $1", [notificationId]);
  const firstAttemptAt = new Date(Date.now() + 1000);
  const failDelivery = async () => { throw Object.assign(new Error('private provider response'), { code: 'ECONNRESET' }); };
  const retry = await processNotificationOutbox(pool, {
    deliver: failDelivery, maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000,
    now: () => firstAttemptAt, random: () => 0.5,
  });
  assert.equal(retry.retrying, 1);
  state = await pool.query('SELECT status, attempts, last_error_code, available_at FROM notification_outbox WHERE notification_id = $1', [notificationId]);
  assert.equal(state.rows[0].status, 'retrying');
  assert.equal(state.rows[0].attempts, 1);
  assert.equal(state.rows[0].last_error_code, 'ECONNRESET');

  const secondAttemptAt = new Date(new Date(state.rows[0].available_at).getTime() + 1);
  const deadLetter = await processNotificationOutbox(pool, {
    deliver: failDelivery, maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000,
    now: () => secondAttemptAt, random: () => 0.5,
  });
  assert.equal(deadLetter.deadLetter, 1);
  state = await pool.query('SELECT status, attempts FROM notification_outbox WHERE notification_id = $1', [notificationId]);
  assert.deepEqual(state.rows[0], { status: 'dead_letter', attempts: 2 });

  await pool.query("UPDATE notification_outbox SET status = 'pending', attempts = 0, available_at = NOW() WHERE notification_id = $1", [notificationId]);
  const idempotencyKeys = [];
  const delivered = await processNotificationOutbox(pool, {
    deliver: async (event) => {
      idempotencyKeys.push(event.idempotencyKey);
      assert.equal(event.recipientEmail, 'outbox@example.test');
    },
  });
  assert.equal(delivered.delivered, 1);
  state = await pool.query('SELECT status, attempts FROM notification_outbox WHERE notification_id = $1', [notificationId]);
  assert.deepEqual(state.rows[0], { status: 'delivered', attempts: 1 });
  assert.equal(idempotencyKeys[0], `notification-outbox-${initial.rows[0].id}`);
});

test('only platform admins can inspect and manually retry blocked notification outbox entries', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const agency = await register(baseUrl, {
    name: 'Agency Owner', organization: 'Outbox Tenant', email: 'outbox-tenant@example.test', role: 'agency', countryCode: 'US',
  });
  const admin = await register(baseUrl, {
    name: 'Operations Reviewer', organization: 'Outbox Operations', email: 'outbox-admin@example.test', role: 'agency', countryCode: 'US',
  });
  await promoteTestAdmin(pool, admin);
  const notificationId = randomUUID();
  await pool.query(
    `INSERT INTO notifications (id, organization_id, event_type, title, message, data)
     VALUES ($1, $2, 'request_matched', 'New request', 'A request matches your coverage.', '{}'::jsonb)`,
    [notificationId, agency.session.organization.id],
  );
  await processNotificationOutbox(pool);
  const unauthorized = await api(baseUrl, '/v1/admin/notification-outbox', agency);
  assert.equal(unauthorized.response.status, 403);
  const queue = await api(baseUrl, '/v1/admin/notification-outbox?status=blocked_config', admin);
  assert.equal(queue.body.entries.length, 1);
  assert.equal(queue.body.entries[0].organizationName, 'Outbox Tenant');
  assert.equal(Object.hasOwn(queue.body.entries[0], 'recipientEmail'), false);
  const retried = await api(baseUrl, `/v1/admin/notification-outbox/${queue.body.entries[0].id}/retry`, admin, { method: 'POST', body: {} });
  assert.equal(retried.response.status, 202);
  assert.equal(retried.body.status, 'pending');
  const state = await pool.query('SELECT status, manual_retries FROM notification_outbox WHERE id = $1', [queue.body.entries[0].id]);
  assert.deepEqual(state.rows[0], { status: 'pending', manual_retries: 1 });
});

test('Resend adapter stays disabled without configuration and sends encrypted action links idempotently when configured', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const account = await register(baseUrl, {
    name: 'Email Owner', organization: 'Email Adapter Agency', email: 'email-adapter@example.test', role: 'agency', countryCode: 'US',
  });
  assert.equal(createResendEmailDelivery({ pool }), null);
  const action = await pool.query(
    "SELECT id FROM auth_email_tokens WHERE user_id = $1 AND purpose = 'verify_email' AND used_at IS NULL",
    [account.session.user.id],
  );
  let sentRequest;
  const deliver = createResendEmailDelivery({
    pool,
    provider: 'resend',
    apiKey: 'test-provider-key',
    from: 'Lead Exchange <no-reply@example.test>',
    appBaseUrl: 'https://lead.example.test',
    tokenEncryptionKey: testTokenEncryptionKey,
    fetchImpl: async (url, options) => {
      sentRequest = { url, options };
      return { ok: true, status: 200 };
    },
  });
  assert.equal(typeof deliver, 'function');
  await deliver({
    idempotencyKey: 'notification-outbox-42',
    recipientEmail: 'email-adapter@example.test',
    notification: { title: 'Verify your email', message: 'Confirm your address.', data: { authEmailTokenId: action.rows[0].id } },
  });
  assert.equal(sentRequest.url, 'https://api.resend.com/emails');
  assert.equal(sentRequest.options.headers['idempotency-key'], 'notification-outbox-42');
  const payload = JSON.parse(sentRequest.options.body);
  assert.deepEqual(payload.to, ['email-adapter@example.test']);
  assert.match(payload.text, /https:\/\/lead\.example\.test\/verify-email\?token=/);
});

test('ordinary notification delivery remains blocked until the recipient verifies email', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const account = await register(baseUrl, {
    name: 'Unverified Owner', organization: 'Unverified Inbox', email: 'unverified-inbox@example.test', role: 'agency', countryCode: 'US',
  });
  await pool.query('UPDATE users SET email_verified_at = NULL WHERE id = $1', [account.session.user.id]);
  const notificationId = randomUUID();
  await pool.query(
    `INSERT INTO notifications (id, organization_id, event_type, title, message, data)
     VALUES ($1, $2, 'request_matched', 'New request', 'A request matches your coverage.', '{}'::jsonb)`,
    [notificationId, account.session.organization.id],
  );
  const outbox = await pool.query('SELECT id, allow_unverified FROM notification_outbox WHERE notification_id = $1', [notificationId]);
  assert.equal(outbox.rows[0].allow_unverified, false);
  let delivered = false;
  const result = await processNotificationOutbox(pool, { deliver: async () => { delivered = true; } });
  assert.equal(result.blockedConfig, 1);
  assert.equal(delivered, false);
  const state = await pool.query('SELECT status, last_error_code FROM notification_outbox WHERE id = $1', [outbox.rows[0].id]);
  assert.deepEqual(state.rows[0], { status: 'blocked_config', last_error_code: 'recipient_email_unverified' });
});

test('invite-only targeting, offer limit, deadline closing and not-selected reasons are enforced', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const agency = await register(baseUrl, {
    name: 'Rules Owner', organization: 'Rules Agency', email: 'rules-agency@example.test', role: 'agency', countryCode: 'IN',
  });
  const firstDmc = await register(baseUrl, {
    name: 'First Seller', organization: 'Kyoto First', email: 'rules-first@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto',
  });
  const secondDmc = await register(baseUrl, {
    name: 'Second Seller', organization: 'Kyoto Second', email: 'rules-second@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto',
  });
  const invitedDmc = await register(baseUrl, {
    name: 'Invited Seller', organization: 'Osaka Partner', email: 'rules-invited@example.test', role: 'dmc', countryCode: 'JP', coverage: 'osaka',
  });
  const admin = await register(baseUrl, {
    name: 'Rules Admin', organization: 'Rules Operations', email: 'rules-admin@example.test', role: 'agency', countryCode: 'IN',
  });
  await promoteTestAdmin(pool, admin);
  for (const seller of [firstDmc, secondDmc, invitedDmc]) {
    await api(baseUrl, `/v1/admin/seller-profiles/${seller.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Seller documents reviewed.' } });
  }
  const offerBody = (totalMinor) => ({ total_minor: totalMinor, currency: 'INR', inclusions: ['guide'], exclusions: [], validity_until: new Date(Date.now() + 5 * 86400000).toISOString() });

  const settings = await api(baseUrl, '/v1/admin/settings', admin);
  assert.equal(settings.body.settings.find((setting) => setting.key === 'max_offers_per_request').value, 10);
  assert.equal((await api(baseUrl, '/v1/admin/settings/max_offers_per_request', agency, { method: 'PUT', body: { value: 1 } })).response.status, 403);
  assert.equal((await api(baseUrl, '/v1/admin/settings/max_offers_per_request', admin, { method: 'PUT', body: { value: 0 } })).response.status, 400);
  assert.equal((await api(baseUrl, '/v1/admin/settings/unknown_setting', admin, { method: 'PUT', body: { value: 1 } })).response.status, 404);
  assert.equal((await api(baseUrl, '/v1/admin/settings/max_offers_per_request', admin, { method: 'PUT', body: { value: 1 } })).response.status, 200);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM platform_setting_changes WHERE setting_key = 'max_offers_per_request'")).rows[0].count, 1);

  const openWithInvites = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: { ...requestInput(), invited_seller_ids: [invitedDmc.session.organization.id] } });
  assert.equal(openWithInvites.response.status, 400);
  const unknownInvite = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: { ...requestInput(), visibility: 'invite_only', invited_seller_ids: [randomUUID()] } });
  assert.equal(unknownInvite.body.error.code, 'INVALID_INVITATION');
  const inviteOnly = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: { ...requestInput(), visibility: 'invite_only', invited_seller_ids: [invitedDmc.session.organization.id] } });
  assert.equal(inviteOnly.response.status, 201);
  assert.equal(inviteOnly.body.request.invitedSellers[0].name, 'Osaka Partner');
  const invitePublished = await api(baseUrl, `/v1/marketplace/requests/${inviteOnly.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  assert.equal(invitePublished.body.targetedSellerCount, 1);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', firstDmc)).body.requests.length, 0);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', invitedDmc)).body.requests.length, 1);

  const openRequest = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const openPublished = await api(baseUrl, `/v1/marketplace/requests/${openRequest.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  assert.equal(openPublished.body.targetedSellerCount, 2);
  const firstOffer = await api(baseUrl, `/v1/marketplace/requests/${openRequest.body.request.id}/offers`, firstDmc, { method: 'POST', body: offerBody(150000) });
  assert.equal(firstOffer.response.status, 201);
  const cappedOffer = await api(baseUrl, `/v1/marketplace/requests/${openRequest.body.request.id}/offers`, secondDmc, { method: 'POST', body: offerBody(140000) });
  assert.equal(cappedOffer.response.status, 409);
  assert.equal(cappedOffer.body.error.code, 'OFFER_LIMIT_REACHED');
  const cappedInbox = await api(baseUrl, '/v1/marketplace/requests', secondDmc);
  assert.equal(cappedInbox.body.requests[0].offerLimitReached, true);
  assert.equal(cappedInbox.body.requests[0].hasActiveOffer, false);
  await api(baseUrl, '/v1/admin/settings/max_offers_per_request', admin, { method: 'PUT', body: { value: 10 } });
  const secondOffer = await api(baseUrl, `/v1/marketplace/requests/${openRequest.body.request.id}/offers`, secondDmc, { method: 'POST', body: offerBody(140000) });
  assert.equal(secondOffer.response.status, 201);

  const contactReason = await api(baseUrl, `/v1/marketplace/requests/${openRequest.body.request.id}/award`, agency, { method: 'POST', body: { offer_id: firstOffer.body.offer.id, not_selected_reason: 'Call 9876543210 for details' } });
  assert.equal(contactReason.body.error.code, 'CONTACT_DETAILS_NOT_ALLOWED');
  const award = await api(baseUrl, `/v1/marketplace/requests/${openRequest.body.request.id}/award`, agency, { method: 'POST', body: { offer_id: firstOffer.body.offer.id, not_selected_reason: 'Client preferred the included hotel category.' } });
  assert.equal(award.response.status, 201);
  const lostOffers = await api(baseUrl, '/v1/marketplace/offers', secondDmc);
  assert.equal(lostOffers.body.offers[0].status, 'rejected');
  assert.equal(lostOffers.body.offers[0].outcomeReason, 'Client preferred the included hotel category.');
  const lostNotice = (await api(baseUrl, '/v1/notifications', secondDmc)).body.notifications.find((item) => item.type === 'offer_not_selected');
  assert.match(lostNotice.message, /Reason: Client preferred/);

  const noOffers = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  await api(baseUrl, `/v1/marketplace/requests/${noOffers.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  const withOffer = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  await api(baseUrl, `/v1/marketplace/requests/${withOffer.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  const pendingOffer = await api(baseUrl, `/v1/marketplace/requests/${withOffer.body.request.id}/offers`, firstDmc, { method: 'POST', body: offerBody(160000) });
  assert.equal(pendingOffer.response.status, 201);
  await pool.query("UPDATE marketplace_requests SET response_deadline = NOW() - INTERVAL '1 minute' WHERE id = ANY($1::uuid[])", [[noOffers.body.request.id, withOffer.body.request.id]]);
  const lateOffer = await api(baseUrl, `/v1/marketplace/requests/${noOffers.body.request.id}/offers`, secondDmc, { method: 'POST', body: offerBody(130000) });
  assert.equal(lateOffer.body.error.code, 'RESPONSE_DEADLINE_PASSED');
  const lateRevision = await api(baseUrl, `/v1/marketplace/offers/${pendingOffer.body.offer.id}`, firstDmc, { method: 'PUT', body: offerBody(155000) });
  assert.equal(lateRevision.body.error.code, 'RESPONSE_DEADLINE_PASSED');

  const processed = await processRequestDeadlines(pool);
  assert.deepEqual(processed, { closed: 1, expired: 1 });
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${noOffers.body.request.id}`, agency)).body.request.status, 'expired');
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${withOffer.body.request.id}`, agency)).body.request.status, 'closed');
  const sellerClosedView = await api(baseUrl, `/v1/marketplace/requests/${withOffer.body.request.id}`, firstDmc);
  assert.equal(sellerClosedView.response.status, 200);
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${withOffer.body.request.id}`, secondDmc)).response.status, 404);
  const closedAward = await api(baseUrl, `/v1/marketplace/requests/${withOffer.body.request.id}/award`, agency, { method: 'POST', body: { offer_id: pendingOffer.body.offer.id } });
  assert.equal(closedAward.response.status, 201);
  assert.deepEqual(await processRequestDeadlines(pool), { closed: 0, expired: 0 });
});

async function signIn(baseUrl, email, password, role) {
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, business_type: role }),
  });
  assert.equal(login.status, 200);
  return { session: await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] };
}

test('reference data comes from standard sources and team roles gate invitations, requests and awards', async (context) => {
  const { baseUrl } = await startMarketplaceApp(context);
  const owner = await register(baseUrl, {
    name: 'Team Owner', organization: 'Team Agency', email: 'team-owner@example.test', role: 'agency', countryCode: 'IN',
  });

  const reference = await (await fetch(`${baseUrl}/v1/reference-data`)).json();
  assert.ok(reference.countries.some((country) => country.code === 'IN'));
  assert.ok(reference.currencies.includes('INR'));
  assert.equal(reference.defaults.currency, 'INR');
  assert.deepEqual(reference.memberRoles.map((role) => role.value), ['owner', 'admin', 'member', 'viewer']);
  const badDestination = await api(baseUrl, '/v1/marketplace/requests', owner, { method: 'POST', body: { ...requestInput(), destination_id: randomUUID() } });
  assert.equal(badDestination.response.status, 400);

  const me = await api(baseUrl, '/v1/auth/me', owner);
  assert.ok(me.body.capabilities.includes('team.manage'));
  assert.equal((await api(baseUrl, '/v1/organization/invitations', owner, { method: 'POST', body: { email: 'owner-two@example.test', role: 'owner' } })).response.status, 400);
  assert.equal((await api(baseUrl, '/v1/organization/invitations', owner, { method: 'POST', body: { email: 'team-owner@example.test', role: 'member' } })).body.error.code, 'EMAIL_IN_USE');
  const invited = await api(baseUrl, '/v1/organization/invitations', owner, { method: 'POST', body: { email: 'Staff@Example.test', role: 'member' } });
  assert.equal(invited.response.status, 201);
  assert.equal(invited.body.invitation.email, 'staff@example.test');
  assert.equal((await api(baseUrl, '/v1/organization/invitations', owner, { method: 'POST', body: { email: 'staff@example.test', role: 'viewer' } })).body.error.code, 'INVITATION_PENDING');
  const token = new URLSearchParams(invited.body.acceptPath.split('?')[1]).get('token');

  const preview = await (await fetch(`${baseUrl}/v1/auth/invitations/preview?token=${encodeURIComponent(token)}`)).json();
  assert.equal(preview.invitation.organizationName, 'Team Agency');
  const accept = (body) => fetch(`${baseUrl}/v1/auth/invitations/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await accept({ token, full_name: 'Team Staff', password: 'team-staff-password' })).status, 201);
  assert.equal((await accept({ token, full_name: 'Team Staff', password: 'team-staff-password' })).status, 404);

  const staff = await signIn(baseUrl, 'staff@example.test', 'team-staff-password', 'agency');
  assert.equal(staff.session.organization.id, owner.session.organization.id);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', staff, { method: 'POST', body: requestInput() })).response.status, 201);
  const forbiddenAward = await api(baseUrl, `/v1/marketplace/requests/${randomUUID()}/award`, staff, { method: 'POST', body: { offer_id: randomUUID() } });
  assert.equal(forbiddenAward.body.error.code, 'PERMISSION_DENIED');
  assert.equal((await api(baseUrl, '/v1/organization/invitations', staff, { method: 'POST', body: { email: 'other@example.test', role: 'member' } })).response.status, 403);

  const staffId = staff.session.user.id;
  assert.equal((await api(baseUrl, `/v1/organization/members/${owner.session.user.id}`, owner, { method: 'PATCH', body: { role: 'member' } })).body.error.code, 'CANNOT_CHANGE_SELF');
  assert.equal((await api(baseUrl, `/v1/organization/members/${staffId}`, owner, { method: 'PATCH', body: { role: 'viewer' } })).response.status, 200);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', staff, { method: 'POST', body: requestInput() })).body.error.code, 'PERMISSION_DENIED');
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', staff)).response.status, 200);

  const members = await api(baseUrl, '/v1/organization/members', owner);
  assert.deepEqual(members.body.members.map((member) => member.role).sort(), ['owner', 'viewer']);
  assert.equal((await api(baseUrl, `/v1/organization/members/${staffId}`, owner, { method: 'DELETE', body: {} })).response.status, 204);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', staff)).response.status, 401);

  const audit = await api(baseUrl, '/v1/organization/audit-events', owner);
  assert.deepEqual(audit.body.events.map((event) => event.action).sort(), ['invitation.accepted', 'invitation.created', 'member.removed', 'member.role_changed']);
});

test('offers carry line items, payment terms and hotel fields; reminders fire once; reports and suspension are enforced', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const agency = await register(baseUrl, { name: 'Detail Owner', organization: 'Detail Agency', email: 'detail-agency@example.test', role: 'agency', countryCode: 'IN' });
  const dmc = await register(baseUrl, { name: 'Detail Seller', organization: 'Detail DMC', email: 'detail-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  const hotel = await register(baseUrl, { name: 'Detail Hotel', organization: 'Detail Kyoto Inn', email: 'detail-hotel@example.test', role: 'hotelier', countryCode: 'JP', propertyCity: 'Kyoto' });
  const outsider = await register(baseUrl, { name: 'Outsider', organization: 'Outsider DMC', email: 'detail-outsider@example.test', role: 'dmc', countryCode: 'MA', coverage: 'marrakech' });
  const admin = await register(baseUrl, { name: 'Detail Admin', organization: 'Detail Ops', email: 'detail-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  for (const seller of [dmc, hotel, outsider]) {
    await api(baseUrl, `/v1/admin/seller-profiles/${seller.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Seller documents reviewed.' } });
  }
  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const requestId = draft.body.request.id;
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/publish`, agency, { method: 'POST', body: {} });
  const validity = new Date(Date.now() + 5 * 86400000).toISOString();
  const lineItems = [
    { item_type: 'accommodation', description: '7 nights 4-star hotel', quantity: 7, unit_price_minor: 20000 },
    { item_type: 'transfer', description: 'Airport transfers', quantity: 2, unit_price_minor: 5000 },
  ];
  const dmcOffer = (overrides = {}) => ({ total_minor: 150000, currency: 'INR', inclusions: ['accommodation', 'transfers'], validity_until: validity, line_items: lineItems, deposit_percent: 30, balance_due_days_before_travel: 14, free_cancellation_until: '2027-03-31', cancellation_policy: 'Full refund until free cancellation date.', ...overrides });

  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, dmc, { method: 'POST', body: dmcOffer({ total_minor: 149000 }) })).response.status, 400);
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, dmc, { method: 'POST', body: dmcOffer({ payment_notes: 'Pay via www.example.com' }) })).response.status, 400);
  const landOffer = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, dmc, { method: 'POST', body: dmcOffer() });
  assert.equal(landOffer.response.status, 201);
  assert.equal(landOffer.body.offer.lineItems.length, 2);
  const roomOffer = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, hotel, {
    method: 'POST', body: { rate_per_night_minor: 10000, room_type: 'Garden Suite', meal_plan: 'breakfast', room_count: 2, taxes_included: true, availability_confirmed: true, currency: 'INR', validity_until: validity },
  });
  assert.equal(roomOffer.response.status, 201);

  const comparison = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, agency);
  const comparedLand = comparison.body.offers.find((offer) => offer.kind === 'land_package');
  const comparedRoom = comparison.body.offers.find((offer) => offer.kind === 'hotel_room');
  assert.deepEqual({ perTraveller: comparedLand.perTravellerMinor, deposit: comparedLand.depositPercent, lines: comparedLand.lineItems.length, freeCancel: comparedLand.freeCancellationUntil }, { perTraveller: 75000, deposit: 30, lines: 2, freeCancel: '2027-03-31' });
  assert.deepEqual({ total: comparedRoom.estimatedTotalMinor, taxes: comparedRoom.taxesIncluded, confirmed: comparedRoom.availabilityConfirmed }, { total: 140000, taxes: true, confirmed: true });

  const revised = await api(baseUrl, `/v1/marketplace/offers/${landOffer.body.offer.id}`, dmc, { method: 'PUT', body: dmcOffer({ total_minor: 140000, line_items: [{ item_type: 'other', description: 'Complete land package', quantity: 1, unit_price_minor: 140000 }] }) });
  assert.equal(revised.response.status, 200);
  const history = await api(baseUrl, `/v1/marketplace/offers/${landOffer.body.offer.id}/revisions`, dmc);
  assert.equal(history.body.revisions[0].snapshot.lineItems.length, 2);

  await pool.query("UPDATE marketplace_requests SET response_deadline = NOW() + INTERVAL '1 hour' WHERE id = $1", [requestId]);
  await pool.query("UPDATE offers SET validity_until = NOW() + INTERVAL '2 hours' WHERE id = $1", [landOffer.body.offer.id]);
  assert.deepEqual(await processReminders(pool), { deadlineReminders: 1, offerExpiryReminders: 1 });
  assert.deepEqual(await processReminders(pool), { deadlineReminders: 0, offerExpiryReminders: 0 });
  const agencyNotices = (await api(baseUrl, '/v1/notifications', agency)).body.notifications.map((item) => item.type);
  assert.ok(agencyNotices.includes('request_deadline_near') && agencyNotices.includes('offer_expiring'));

  const offerReport = await api(baseUrl, '/v1/marketplace/reports', agency, { method: 'POST', body: { target_type: 'offer', target_id: landOffer.body.offer.id, category: 'contact_bypass', details: 'Asked to settle payment outside the platform.' } });
  assert.equal(offerReport.response.status, 201);
  assert.equal((await api(baseUrl, '/v1/marketplace/reports', agency, { method: 'POST', body: { target_type: 'offer', target_id: landOffer.body.offer.id, category: 'spam' } })).body.error.code, 'REPORT_ALREADY_OPEN');
  assert.equal((await api(baseUrl, '/v1/marketplace/reports', dmc, { method: 'POST', body: { target_type: 'request', target_id: requestId, category: 'pricing_fraud' } })).response.status, 201);
  assert.equal((await api(baseUrl, '/v1/marketplace/reports', outsider, { method: 'POST', body: { target_type: 'organization', target_id: agency.session.organization.id, category: 'spam' } })).response.status, 404);
  const openReports = await api(baseUrl, '/v1/admin/reports', admin);
  assert.equal(openReports.body.reports.length, 2);
  assert.equal((await api(baseUrl, '/v1/admin/reports', agency)).response.status, 403);
  assert.equal((await api(baseUrl, `/v1/admin/reports/${offerReport.body.report.id}/resolve`, admin, { method: 'POST', body: { decision: 'actioned', note: 'Seller suspended pending review.' } })).response.status, 200);

  const suspended = await api(baseUrl, `/v1/admin/organizations/${dmc.session.organization.id}/suspend`, admin, { method: 'POST', body: { reason: 'Repeated off-platform payment requests.' } });
  assert.equal(suspended.body.withdrawnOffers, 1);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', dmc)).response.status, 401);
  const blockedLogin = await fetch(`${baseUrl}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'detail-dmc@example.test', password: 'marketplace-test-password', business_type: 'dmc' }) });
  assert.equal(blockedLogin.status, 403);
  assert.equal((await blockedLogin.json()).error.code, 'ORGANIZATION_SUSPENDED');
  const directory = await api(baseUrl, '/v1/marketplace/suppliers?search=Detail', agency);
  assert.deepEqual(directory.body.suppliers.map((supplier) => supplier.name), ['Detail Kyoto Inn']);
  assert.equal((await api(baseUrl, `/v1/admin/organizations/${dmc.session.organization.id}/reinstate`, admin, { method: 'POST', body: { reason: 'Appeal reviewed and accepted.' } })).response.status, 200);
  await signIn(baseUrl, 'detail-dmc@example.test', 'marketplace-test-password', 'dmc');
});

async function approveSellers(baseUrl, admin, sellers) {
  for (const seller of sellers) {
    await api(baseUrl, `/v1/admin/seller-profiles/${seller.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Seller documents reviewed.' } });
  }
}

test('destination master data drives search, hierarchical matching and admin management', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Places Admin', organization: 'Places Ops', email: 'places-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);

  const search = await (await fetch(`${baseUrl}/v1/reference-data/destinations?q=KYO`)).json();
  assert.deepEqual(search.destinations.map((item) => item.label), ['Kyoto, Japan']);
  assert.equal((await fetch(`${baseUrl}/v1/reference-data/destinations?q=`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/v1/reference-data/destinations?q=a&kinds=planet`)).status, 400);

  const kansai = await api(baseUrl, '/v1/admin/destinations', admin, { method: 'POST', body: { kind: 'region', name: 'Kansai', country_code: 'JP' } });
  assert.equal(kansai.response.status, 201);
  const nara = await api(baseUrl, '/v1/admin/destinations', admin, { method: 'POST', body: { kind: 'city', name: 'Nara', country_code: 'JP', parent_id: kansai.body.destination.id, aliases: ['Heijo-kyo'] } });
  assert.equal(nara.response.status, 201);
  assert.equal(nara.body.destination.label, 'Nara, Kansai, Japan');
  assert.equal((await api(baseUrl, '/v1/admin/destinations', admin, { method: 'POST', body: { kind: 'city', name: 'nara', country_code: 'JP', parent_id: kansai.body.destination.id } })).response.status, 409);
  assert.equal((await api(baseUrl, '/v1/admin/destinations', admin, { method: 'POST', body: { kind: 'city', name: 'Fes', country_code: 'MA', parent_id: kansai.body.destination.id } })).response.status, 400);
  assert.equal((await fetch(`${baseUrl}/v1/reference-data/destinations?q=heijo`).then((response) => response.json())).destinations[0].name, 'Nara');

  const badSignup = await fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full_name: 'Bad Hotel', organization_name: 'Bad Hotel', email: 'bad-hotel@example.test', country_code: 'JP', business_type: 'hotelier', property_destination_id: destinationIds.jp, password: 'marketplace-test-password' }) });
  assert.equal(badSignup.status, 400);

  const agency = await register(baseUrl, { name: 'Places Agency', organization: 'Places Agency', email: 'places-agency@example.test', role: 'agency', countryCode: 'IN' });
  const countryDmc = await register(baseUrl, { name: 'Japan DMC', organization: 'All Japan DMC', email: 'places-jp@example.test', role: 'dmc', countryCode: 'JP', coverage: 'jp' });
  const regionDmc = await register(baseUrl, { name: 'Kansai DMC', organization: 'Kansai Specialists', email: 'places-kansai@example.test', role: 'dmc', countryCode: 'JP' }).catch(() => null);
  assert.equal(regionDmc, null, 'registration requires at least one coverage destination');
  const kansaiSignup = await fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full_name: 'Kansai DMC', organization_name: 'Kansai Specialists', email: 'places-kansai@example.test', country_code: 'JP', business_type: 'dmc', coverage_destination_ids: [kansai.body.destination.id], password: 'marketplace-test-password' }) });
  assert.equal(kansaiSignup.status, 201);
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE email = 'places-kansai@example.test'");
  const kansaiDmc = await signIn(baseUrl, 'places-kansai@example.test', 'marketplace-test-password', 'dmc');
  await seedCleanDocuments(pool, kansaiDmc.session.organization.id, 'dmc', 'JP');
  const osakaHotel = await register(baseUrl, { name: 'Osaka Hotel', organization: 'Osaka Bay Hotel', email: 'places-osaka@example.test', role: 'hotelier', countryCode: 'JP', propertyCity: 'osaka' });
  await approveSellers(baseUrl, admin, [countryDmc, kansaiDmc, osakaHotel]);

  const naraRequest = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: { ...requestInput(), destination_id: nara.body.destination.id } });
  assert.equal(naraRequest.body.request.destination, 'Nara');
  assert.equal(naraRequest.body.request.destinationCountry, 'JP');
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${naraRequest.body.request.id}/publish`, agency, { method: 'POST', body: {} })).body.targetedSellerCount, 2);
  const kyotoRequest = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${kyotoRequest.body.request.id}/publish`, agency, { method: 'POST', body: {} })).body.targetedSellerCount, 1);
  assert.deepEqual((await api(baseUrl, '/v1/marketplace/requests', kansaiDmc)).body.requests.map((item) => item.destination), ['Nara']);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', countryDmc)).body.requests.length, 2);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', osakaHotel)).body.requests.length, 0);

  await api(baseUrl, `/v1/admin/destinations/${kansai.body.destination.id}`, admin, { method: 'PATCH', body: { name: 'Kansai Region' } });
  const kansaiProfile = await api(baseUrl, '/v1/marketplace/seller-profile', kansaiDmc);
  assert.deepEqual(kansaiProfile.body.coverageDestinations, ['Kansai Region']);
  assert.equal(kansaiProfile.body.coverage[0].kind, 'region');

  await api(baseUrl, `/v1/admin/destinations/${nara.body.destination.id}`, admin, { method: 'PATCH', body: { active: false } });
  assert.equal((await fetch(`${baseUrl}/v1/reference-data/destinations?q=nara`).then((response) => response.json())).destinations.length, 0);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: { ...requestInput(), destination_id: nara.body.destination.id } })).response.status, 400);
  const adminList = await api(baseUrl, '/v1/admin/destinations?q=nara', admin);
  assert.equal(adminList.body.destinations[0].active, false);
});

test('legal documents are versioned, required at sign-up and re-accepted after each update', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Legal Admin', organization: 'Legal Ops', email: 'legal-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Legal Agency', organization: 'Legal Agency', email: 'legal-agency@example.test', role: 'agency', countryCode: 'IN' });

  assert.deepEqual((await (await fetch(`${baseUrl}/v1/legal/documents`)).json()).documents, []);
  assert.equal((await (await fetch(`${baseUrl}/v1/legal/documents/terms`)).json()).error.code, 'DOCUMENT_NOT_PUBLISHED');
  assert.equal((await fetch(`${baseUrl}/v1/legal/documents/unknown`)).status, 404);
  assert.equal((await api(baseUrl, '/v1/admin/legal/documents', agency, { method: 'POST', body: { document_type: 'terms', title: 'Terms', body: 'x'.repeat(60) } })).response.status, 403);

  const legalBody = (topic) => `These ${topic} explain how the Lead Exchange marketplace works for registered businesses.`;
  const published = {};
  for (const type of ['terms', 'privacy', 'dpa', 'cookies']) {
    const result = await api(baseUrl, '/v1/admin/legal/documents', admin, { method: 'POST', body: { document_type: type, title: `${type} v1`, body: legalBody(type) } });
    assert.equal(result.response.status, 201);
    published[type] = result.body.document;
  }
  assert.equal((await api(baseUrl, '/v1/admin/settings', admin)).body.error.code, 'LEGAL_ACCEPTANCE_REQUIRED');
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', agency)).body.error.code, 'LEGAL_ACCEPTANCE_REQUIRED');
  const me = await api(baseUrl, '/v1/auth/me', agency);
  assert.deepEqual(me.body.pendingLegalDocuments.map((item) => item.type).sort(), ['dpa', 'privacy', 'terms']);
  const accepted = await api(baseUrl, '/v1/legal/acceptances', agency, { method: 'POST', body: { document_ids: [published.terms.id, published.privacy.id, published.dpa.id] } });
  assert.deepEqual(accepted.body.pendingLegalDocuments, []);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', agency)).response.status, 200);
  assert.equal((await api(baseUrl, '/v1/legal/acceptances', agency, { method: 'POST', body: { document_ids: [published.cookies.id] } })).body.error.code, 'DOCUMENT_NOT_CURRENT');

  const signup = (acceptedIds) => fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full_name: 'New Agency', organization_name: 'New Agency', email: 'legal-new@example.test', country_code: 'IN', business_type: 'agency', password: 'marketplace-test-password', accepted_legal_document_ids: acceptedIds }) });
  const missing = await signup([published.terms.id]);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'LEGAL_ACCEPTANCE_REQUIRED');
  assert.equal((await signup([published.terms.id, published.privacy.id, published.dpa.id])).status, 201);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM legal_acceptances a JOIN users u ON u.id = a.user_id WHERE u.email = 'legal-new@example.test'")).rows[0].count, 3);

  const termsV2 = await api(baseUrl, '/v1/legal/acceptances', admin, { method: 'POST', body: { document_ids: [published.terms.id, published.privacy.id, published.dpa.id] } })
    .then(() => api(baseUrl, '/v1/admin/legal/documents', admin, { method: 'POST', body: { document_type: 'terms', title: 'Terms v2', body: legalBody('updated terms'), change_summary: 'Clarified offer validity.' } }));
  assert.equal(termsV2.body.document.version, 2);
  const pendingAgain = await api(baseUrl, '/v1/auth/me', agency);
  assert.deepEqual(pendingAgain.body.pendingLegalDocuments.map((item) => [item.type, item.version]), [['terms', 2]]);
  assert.equal((await api(baseUrl, '/v1/legal/acceptances', agency, { method: 'POST', body: { document_ids: [published.terms.id] } })).body.error.code, 'DOCUMENT_NOT_CURRENT');
  const publicTerms = await (await fetch(`${baseUrl}/v1/legal/documents/terms`)).json();
  assert.deepEqual([publicTerms.document.version, publicTerms.document.changeSummary], [2, 'Clarified offer validity.']);
  assert.ok(publicTerms.document.body.includes('updated terms'));
  const history = await api(baseUrl, '/v1/admin/legal/documents', admin);
  assert.equal(history.body.documents.filter((item) => item.type === 'terms').length, 2);
});

test('account export and deletion respect ownership, the grace period and anonymization', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Privacy Admin', organization: 'Privacy Ops', email: 'privacy-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Privacy Owner', organization: 'Privacy Agency', email: 'privacy-agency@example.test', role: 'agency', countryCode: 'IN' });
  const dmc = await register(baseUrl, { name: 'Privacy Seller', organization: 'Privacy DMC', email: 'privacy-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  await approveSellers(baseUrl, admin, [dmc]);
  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const requestId = draft.body.request.id;
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/publish`, agency, { method: 'POST', body: {} });
  const offer = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, dmc, { method: 'POST', body: { total_minor: 120000, currency: 'INR', inclusions: ['guide'], validity_until: new Date(Date.now() + 86400000).toISOString() } });
  assert.equal(offer.response.status, 201);
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}/messages`, dmc, { method: 'POST', body: { body: 'Is an English speaking guide required?' } })).response.status, 201);

  const exported = await fetch(`${baseUrl}/v1/account/export`, { headers: { cookie: dmc.cookie } });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment; filename="voyagehub-export-/);
  const data = await exported.json();
  assert.equal(data.user.email, 'privacy-dmc@example.test');
  assert.equal(data.messagesSent[0].body, 'Is an English speaking guide required?');
  assert.equal(data.organization.offers.length, 1);
  assert.deepEqual(data.organization.coverage.map((item) => item.name), ['Kyoto']);

  const invited = await api(baseUrl, '/v1/organization/invitations', agency, { method: 'POST', body: { email: 'privacy-staff@example.test', role: 'member' } });
  const token = new URLSearchParams(invited.body.acceptPath.split('?')[1]).get('token');
  await fetch(`${baseUrl}/v1/auth/invitations/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, full_name: 'Privacy Staff', password: 'privacy-staff-password' }) });
  const staff = await signIn(baseUrl, 'privacy-staff@example.test', 'privacy-staff-password', 'agency');
  const deleteAccount = (account, password) => api(baseUrl, '/v1/account/deletion', account, { method: 'POST', body: { password } });

  assert.equal((await deleteAccount(admin, 'marketplace-test-password')).body.error.code, 'ADMIN_ACCOUNT');
  assert.equal((await deleteAccount(agency, 'marketplace-test-password')).body.error.code, 'OWNERSHIP_TRANSFER_REQUIRED');
  assert.equal((await deleteAccount(staff, 'wrong-password')).body.error.code, 'INVALID_PASSWORD');
  await api(baseUrl, '/v1/admin/settings/account_deletion_grace_days', admin, { method: 'PUT', body: { value: 7 } });
  const staffDeletion = await deleteAccount(staff, 'privacy-staff-password');
  assert.equal(staffDeletion.response.status, 202);
  assert.equal(staffDeletion.body.closesOrganization, false);
  assert.ok(Math.abs(new Date(staffDeletion.body.scheduledFor) - (Date.now() + 7 * 86400000)) < 60000);

  const dmcDeletion = await deleteAccount(dmc, 'marketplace-test-password');
  assert.deepEqual([dmcDeletion.response.status, dmcDeletion.body.closesOrganization, dmcDeletion.body.withdrawnOffers], [202, true, 1]);
  assert.equal((await pool.query('SELECT status FROM offers WHERE id = $1', [offer.body.offer.id])).rows[0].status, 'withdrawn');
  assert.equal((await api(baseUrl, '/v1/auth/me', dmc)).response.status, 401);
  const returning = await signIn(baseUrl, 'privacy-dmc@example.test', 'marketplace-test-password', 'dmc');
  assert.ok((await api(baseUrl, '/v1/auth/me', returning)).body.account.deletionScheduledFor);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', returning)).body.error.code, 'ACCOUNT_DELETION_PENDING');
  assert.equal((await api(baseUrl, '/v1/marketplace/suppliers?search=Privacy', agency)).body.suppliers.length, 0);
  assert.equal((await api(baseUrl, '/v1/account/deletion/cancel', returning, { method: 'POST', body: {} })).response.status, 200);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', returning)).response.status, 200);
  assert.equal((await api(baseUrl, '/v1/marketplace/suppliers?search=Privacy', agency)).body.suppliers.length, 1);
  assert.equal((await deleteAccount(returning, 'marketplace-test-password')).response.status, 202);

  await fetch(`${baseUrl}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full_name: 'Never Verified', organization_name: 'Abandoned Signup', email: 'privacy-unverified@example.test', country_code: 'IN', business_type: 'agency', password: 'marketplace-test-password' }) });
  await pool.query("UPDATE users SET created_at = NOW() - INTERVAL '31 days' WHERE email = 'privacy-unverified@example.test'");

  assert.deepEqual(await processAccountRetention(pool), { anonymizedUsers: 0, closedOrganizations: 0, purgedUnverifiedUsers: 1, failures: 0 });
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM organizations WHERE name = 'Abandoned Signup'")).rows[0].count, 0);
  const later = new Date(Date.now() + 8 * 86400000);
  assert.deepEqual(await processAccountRetention(pool, { now: () => later }), { anonymizedUsers: 2, closedOrganizations: 1, purgedUnverifiedUsers: 0, failures: 0 });
  const anonymized = await pool.query('SELECT full_name, email, anonymized_at FROM users WHERE id = $1', [dmc.session.user.id]);
  assert.equal(anonymized.rows[0].full_name, 'Deleted user');
  assert.match(anonymized.rows[0].email, /@deleted\.invalid$/);
  const closed = await pool.query('SELECT name, closed_at FROM organizations WHERE id = $1', [dmc.session.organization.id]);
  assert.equal(closed.rows[0].name, 'Closed organization');
  assert.ok(closed.rows[0].closed_at);
  const oldLogin = await fetch(`${baseUrl}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'privacy-dmc@example.test', password: 'marketplace-test-password', business_type: 'dmc' }) });
  assert.equal(oldLogin.status, 401);
  const members = await api(baseUrl, '/v1/organization/members', agency);
  assert.deepEqual(members.body.members.map((member) => member.role), ['owner']);
  const thread = await pool.query('SELECT u.full_name FROM request_messages m JOIN users u ON u.id = m.sender_user_id WHERE m.request_id = $1', [requestId]);
  assert.equal(thread.rows[0].full_name, 'Deleted user');
});

function pdfBytes(marker = '') {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${marker}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);
}

async function uploadDocument(baseUrl, account, documentType, body, { filename = 'certificate.pdf', csrf = true } = {}) {
  const form = new FormData();
  if (documentType) form.append('document_type', documentType);
  form.append('file', new Blob([body]), filename);
  const response = await fetch(`${baseUrl}/v1/verification-documents`, {
    method: 'POST',
    headers: { cookie: account.cookie, ...(csrf ? { 'x-csrf-token': account.session.csrfToken } : {}) },
    body: form,
  });
  return { response, body: await response.json() };
}

test('seller documents are type-checked, malware-scanned, required for approval and removed under retention', async (context) => {
  const { pool, baseUrl, storage } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Docs Admin', organization: 'Docs Ops', email: 'docs-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Docs Agency', organization: 'Docs Agency', email: 'docs-agency@example.test', role: 'agency', countryCode: 'IN' });
  const dmc = await register(baseUrl, { name: 'Docs Seller', organization: 'Docs DMC', email: 'docs-dmc@example.test', role: 'dmc', countryCode: 'IN', coverage: 'kyoto', documents: false });
  const dmcId = dmc.session.organization.id;
  const scanner = { scan: async (body) => body.includes('FAKE-MALWARE-MARKER') ? { infected: true, signature: 'Test.Marker' } : { infected: false } };
  const decide = (decision, reason) => api(baseUrl, `/v1/admin/seller-profiles/${dmcId}/decision`, admin, { method: 'POST', body: { decision, reason } });

  assert.deepEqual((await api(baseUrl, '/v1/verification-documents', agency)).body.missing, ['gst_certificate', 'pan_card', 'business_registration']);
  const initial = await api(baseUrl, '/v1/verification-documents', dmc);
  assert.equal(initial.body.storageConfigured, true);
  assert.deepEqual(initial.body.missing, ['gst_certificate', 'pan_card', 'business_registration']);
  assert.equal((await decide('approved', 'Looks fine.')).body.error.code, 'DOCUMENTS_INCOMPLETE');

  assert.equal((await uploadDocument(baseUrl, dmc, 'gst_certificate', pdfBytes(), { csrf: false })).response.status, 403);
  assert.equal((await uploadDocument(baseUrl, dmc, 'property_proof', pdfBytes())).response.status, 400);
  assert.equal((await uploadDocument(baseUrl, dmc, 'gst_certificate', Buffer.from('<html>not a pdf</html>'), { filename: 'gst.pdf' })).body.error.code, 'UNSUPPORTED_FILE_TYPE');
  assert.equal((await uploadDocument(baseUrl, dmc, 'gst_certificate', Buffer.alloc(10 * 1024 * 1024 + 1, 0x25))).body.error.code, 'FILE_TOO_LARGE');
  assert.equal(storage.objects.size, 0);

  const gst = await uploadDocument(baseUrl, dmc, 'gst_certificate', pdfBytes(), { filename: '../../GST\u202e certificate.pdf' });
  assert.equal(gst.response.status, 201);
  assert.deepEqual([gst.body.document.filename, gst.body.document.contentType, gst.body.document.scanStatus], ['GST certificate.pdf', 'application/pdf', 'pending']);
  const pan = await uploadDocument(baseUrl, dmc, 'pan_card', pdfBytes('FAKE-MALWARE-MARKER'));
  await uploadDocument(baseUrl, dmc, 'business_registration', pdfBytes('registration'));
  assert.equal(storage.objects.size, 3);
  const unscanned = await api(baseUrl, `/v1/admin/documents/${gst.body.document.id}/download-url`, admin, { method: 'POST', body: {} });
  assert.equal(unscanned.body.error.code, 'DOCUMENT_NOT_SCANNED');

  assert.deepEqual(await processDocumentScans(pool, { storage, scanner }), { clean: 2, infected: 1, retrying: 0, failed: 0 });
  assert.deepEqual(await processDocumentScans(pool, { storage, scanner }), { clean: 0, infected: 0, retrying: 0, failed: 0 });
  assert.equal(storage.objects.size, 2);
  const afterScan = await api(baseUrl, '/v1/verification-documents', dmc);
  assert.deepEqual(afterScan.body.missing, ['pan_card']);
  const panSlot = afterScan.body.requirements.find((item) => item.type === 'pan_card');
  assert.deepEqual([panSlot.document.id, panSlot.document.scanStatus, Boolean(panSlot.document.removedAt)], [pan.body.document.id, 'infected', true]);
  assert.ok((await api(baseUrl, '/v1/notifications', dmc)).body.notifications.some((item) => item.type === 'document_blocked'));

  const queue = await api(baseUrl, '/v1/admin/seller-profiles/pending', admin);
  assert.equal(queue.body.sellers.find((seller) => seller.organizationId === dmcId).documents.complete, false);
  const incomplete = await decide('approved', 'Documents reviewed.');
  assert.equal(incomplete.response.status, 409);
  assert.match(incomplete.body.error.message, /Business PAN card/);
  assert.equal((await decide('rejected', 'PAN card failed the malware scan.')).response.status, 200);

  const replacement = await uploadDocument(baseUrl, dmc, 'pan_card', pdfBytes('clean pan'));
  assert.equal(replacement.body.verificationStatus, 'pending');
  await processDocumentScans(pool, { storage, scanner });
  assert.equal((await decide('approved', 'All documents reviewed.')).response.status, 200);

  const adminView = await api(baseUrl, `/v1/admin/organizations/${dmcId}/documents`, admin);
  assert.equal(adminView.body.complete, true);
  assert.equal(adminView.body.history.length, 4);
  assert.ok(adminView.body.history.find((item) => item.id === pan.body.document.id).supersededAt);
  assert.equal((await api(baseUrl, `/v1/admin/documents/${gst.body.document.id}/download-url`, dmc, { method: 'POST', body: {} })).response.status, 403);
  const download = await api(baseUrl, `/v1/admin/documents/${gst.body.document.id}/download-url`, admin, { method: 'POST', body: {} });
  assert.equal(download.response.status, 200);
  assert.match(download.body.url, /disposition=attachment/);
  assert.equal((await api(baseUrl, `/v1/admin/documents/${pan.body.document.id}/download-url`, admin, { method: 'POST', body: {} })).response.status, 404);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM organization_document_access_log WHERE document_id = $1', [gst.body.document.id])).rows[0].count, 1);

  const unreachable = { scan: async () => { throw new Error('clamd unavailable'); } };
  const optional = await uploadDocument(baseUrl, dmc, 'tourism_recognition', pdfBytes('iata'));
  assert.deepEqual(await processDocumentScans(pool, { storage, scanner: unreachable, maxAttempts: 2 }), { clean: 0, infected: 0, retrying: 1, failed: 0 });
  const later = new Date(Date.now() + 3600000);
  assert.deepEqual(await processDocumentScans(pool, { storage, scanner: unreachable, maxAttempts: 2, now: () => later }), { clean: 0, infected: 0, retrying: 0, failed: 1 });
  assert.equal((await pool.query('SELECT scan_status FROM organization_documents WHERE id = $1', [optional.body.document.id])).rows[0].scan_status, 'failed');

  const hotel = await register(baseUrl, { name: 'Docs Hotel', organization: 'Docs Hotel', email: 'docs-hotel@example.test', role: 'hotelier', countryCode: 'IN', propertyCity: 'Kyoto' });
  await api(baseUrl, `/v1/admin/seller-profiles/${hotel.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'rejected', reason: 'Property proof does not match the listing.' } });
  assert.deepEqual(await processDocumentRetention(pool, { storage }), { deletedDocuments: 0, failures: 0 });
  await pool.query("UPDATE seller_verification_reviews SET created_at = NOW() - INTERVAL '91 days' WHERE seller_organization_id = $1", [hotel.session.organization.id]);
  assert.deepEqual(await processDocumentRetention(pool, { storage }), { deletedDocuments: 3, failures: 0 });
  const remaining = await pool.query('SELECT COUNT(*)::int AS count FROM organization_documents WHERE organization_id = $1 AND deleted_at IS NULL', [hotel.session.organization.id]);
  assert.equal(remaining.rows[0].count, 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM organization_documents WHERE organization_id = $1 AND deleted_at IS NULL', [dmcId])).rows[0].count, 4);
});

test('agencies upload verification documents, submit them for review and earn the verified badge', async (context) => {
  const { pool, baseUrl, storage } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Agency Reviewer', organization: 'Review Ops', email: 'agency-review-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Agency Owner', organization: 'Mumbai Journeys', email: 'agency-verify@example.test', role: 'agency', countryCode: 'IN' });
  const agencyId = agency.session.organization.id;
  const dmc = await register(baseUrl, { name: 'Kyoto Seller', organization: 'Kyoto Verified DMC', email: 'agency-verify-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  await api(baseUrl, `/v1/admin/seller-profiles/${dmc.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Seller documents reviewed.' } });
  const scanner = { scan: async (body) => body.includes('FAKE-MALWARE-MARKER') ? { infected: true, signature: 'Test.Marker' } : { infected: false } };
  const submit = () => api(baseUrl, '/v1/verification-documents/submit', agency, { method: 'POST', body: {} });
  const decide = (decision, reason) => api(baseUrl, `/v1/admin/agency-verifications/${agencyId}/decision`, admin, { method: 'POST', body: { decision, reason } });

  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const requestId = draft.body.request.id;
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/publish`, agency, { method: 'POST', body: {} });
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', dmc)).body.requests[0].agencyVerified, false);

  const initial = await api(baseUrl, '/v1/verification-documents', agency);
  assert.equal(initial.body.verification.status, 'unsubmitted');
  assert.deepEqual(initial.body.missing, ['gst_certificate', 'pan_card', 'business_registration']);
  assert.equal((await api(baseUrl, '/v1/verification-documents/submit', dmc, { method: 'POST', body: {} })).response.status, 403);
  const early = await submit();
  assert.equal(early.body.error.code, 'DOCUMENTS_INCOMPLETE');
  assert.match(early.body.error.message, /GST registration certificate/);

  await uploadDocument(baseUrl, agency, 'gst_certificate', pdfBytes('agency gst'));
  const pan = await uploadDocument(baseUrl, agency, 'pan_card', pdfBytes('FAKE-MALWARE-MARKER'));
  assert.equal(pan.body.verificationStatus, 'unsubmitted');
  await uploadDocument(baseUrl, agency, 'business_registration', pdfBytes('agency registration'));
  const submitted = await submit();
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.body.verification.status, 'pending');
  assert.equal((await submit()).body.error.code, 'VERIFICATION_ALREADY_SUBMITTED');

  assert.equal((await api(baseUrl, '/v1/admin/agency-verifications/pending', agency)).response.status, 403);
  const queue = await api(baseUrl, '/v1/admin/agency-verifications/pending', admin);
  assert.deepEqual(queue.body.agencies.map((item) => [item.organizationName, item.status, item.documents.complete]), [['Mumbai Journeys', 'pending', false]]);

  assert.deepEqual(await processDocumentScans(pool, { storage, scanner }), { clean: 2, infected: 1, retrying: 0, failed: 0 });
  assert.equal((await decide('approved', 'x')).response.status, 400);
  const incomplete = await decide('approved', 'Documents reviewed.');
  assert.equal(incomplete.body.error.code, 'DOCUMENTS_INCOMPLETE');
  assert.match(incomplete.body.error.message, /Business PAN card/);
  assert.equal((await decide('rejected', 'PAN card failed the malware scan.')).response.status, 200);
  const rejected = await api(baseUrl, '/v1/verification-documents', agency);
  assert.deepEqual([rejected.body.verification.status, rejected.body.verification.reason], ['rejected', 'PAN card failed the malware scan.']);
  assert.equal((await decide('approved', 'Too late for this one.')).body.error.code, 'PENDING_AGENCY_NOT_FOUND');

  const replacement = await uploadDocument(baseUrl, agency, 'pan_card', pdfBytes('clean agency pan'));
  assert.equal(replacement.body.verificationStatus, 'unsubmitted');
  await processDocumentScans(pool, { storage, scanner });
  assert.equal((await submit()).body.verification.status, 'pending');
  const approved = await decide('approved', 'GST, PAN and registration verified.');
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.verification.status, 'approved');
  assert.equal((await submit()).body.error.code, 'AGENCY_ALREADY_VERIFIED');
  assert.ok((await pool.query('SELECT verified_at FROM organizations WHERE id = $1', [agencyId])).rows[0].verified_at);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', dmc)).body.requests[0].agencyVerified, true);
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}`, dmc)).body.request.agencyVerified, true);
  const notices = (await api(baseUrl, '/v1/notifications', agency)).body.notifications.filter((item) => item.type === 'agency_verification_decided');
  assert.deepEqual(notices.map((item) => item.title), ['Agency verified', 'Agency verification not approved']);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM agency_verification_reviews WHERE agency_organization_id = $1', [agencyId])).rows[0].count, 2);
  const adminView = await api(baseUrl, `/v1/admin/organizations/${agencyId}/documents`, admin);
  assert.deepEqual([adminView.body.complete, adminView.body.history.length], [true, 4]);
  assert.equal((await api(baseUrl, '/v1/admin/agency-verifications/pending', admin)).body.agencies.length, 0);

  const other = await register(baseUrl, { name: 'Rejected Owner', organization: 'Rejected Agency', email: 'agency-rejected@example.test', role: 'agency', countryCode: 'IN' });
  const otherId = other.session.organization.id;
  await seedCleanDocuments(pool, otherId, 'agency', 'IN');
  await api(baseUrl, '/v1/verification-documents/submit', other, { method: 'POST', body: {} });
  await api(baseUrl, `/v1/admin/agency-verifications/${otherId}/decision`, admin, { method: 'POST', body: { decision: 'rejected', reason: 'Registration does not match the business name.' } });
  assert.deepEqual(await processDocumentRetention(pool, { storage }), { deletedDocuments: 0, failures: 0 });
  await pool.query("UPDATE agency_verifications SET decided_at = NOW() - INTERVAL '91 days' WHERE organization_id = $1", [otherId]);
  assert.deepEqual(await processDocumentRetention(pool, { storage }), { deletedDocuments: 3, failures: 0 });
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM organization_documents WHERE organization_id = $1 AND deleted_at IS NULL', [agencyId])).rows[0].count, 3);
});

test('changing published trip details makes sellers re-confirm before an offer can be awarded', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Trip Admin', organization: 'Trip Ops', email: 'trip-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Trip Agent', organization: 'Trip Agency', email: 'trip-agency@example.test', role: 'agency', countryCode: 'IN' });
  const dmc = await register(baseUrl, { name: 'Trip DMC', organization: 'Kyoto Trip DMC', email: 'trip-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  const hotel = await register(baseUrl, { name: 'Trip Hotel', organization: 'Kyoto Trip Inn', email: 'trip-hotel@example.test', role: 'hotelier', countryCode: 'JP', propertyCity: 'Kyoto' });
  const latecomer = await register(baseUrl, { name: 'Late DMC', organization: 'Late Kyoto DMC', email: 'trip-late@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  for (const seller of [dmc, hotel, latecomer]) {
    await api(baseUrl, `/v1/admin/seller-profiles/${seller.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Business details reviewed.' } });
  }
  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const requestId = draft.body.request.id;
  assert.equal(draft.body.request.tripVersion, 1);
  const tripPath = `/v1/marketplace/requests/${requestId}/trip`;
  const change = { travel_start_date: '2027-04-15', travel_end_date: '2027-04-22', nights: 7, adults: 3, children: 1, infants: 0, room_count: 2, trip_version: 1, note: 'Client added a guest and moved the trip by a day.' };
  assert.equal((await api(baseUrl, tripPath, agency, { method: 'PATCH', body: change })).body.error.code, 'REQUEST_NOT_OPEN');
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/publish`, agency, { method: 'POST', body: {} });

  const validityUntil = new Date(Date.now() + 5 * 86400000).toISOString();
  const dmcOffer = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, dmc, { method: 'POST', body: { total_minor: 200000, currency: 'USD', inclusions: ['guide'], exclusions: [], validity_until: validityUntil, trip_version: 1 } });
  assert.equal(dmcOffer.response.status, 201);
  const hotelOffer = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, hotel, { method: 'POST', body: { rate_per_night_minor: 18500, room_type: 'Garden Twin', currency: 'JPY', inclusions: [], exclusions: [], validity_until: validityUntil, room_count: 1, availability_confirmed: true } });
  const dmcOfferId = dmcOffer.body.offer.id;
  const hotelOfferId = hotelOffer.body.offer.id;

  const patch = (account, body) => api(baseUrl, tripPath, account, { method: 'PATCH', body });
  assert.equal((await patch(dmc, change)).response.status, 403);
  assert.equal((await patch(agency, { ...change, trip_version: 2 })).body.error.code, 'TRIP_CHANGED');
  assert.equal((await patch(agency, { ...change, trip_version: undefined })).response.status, 400);
  const original = requestInput();
  assert.equal((await patch(agency, { ...original, trip_version: 1 })).body.error.code, 'NO_TRIP_CHANGES');
  assert.match((await patch(agency, { ...change, nights: 5 })).body.error.message, /match the selected travel dates/);
  assert.equal((await patch(agency, { ...change, note: 'Call 9876543210 for details' })).body.error.code, 'CONTACT_DETAILS_NOT_ALLOWED');
  assert.match((await patch(agency, { ...change, response_deadline: new Date(Date.now() + 24 * 3600000).toISOString() })).body.error.message, /not shortened/);
  await pool.query("UPDATE marketplace_requests SET response_deadline = NOW() + INTERVAL '20 minutes' WHERE id = $1", [requestId]);
  assert.equal((await patch(agency, change)).body.error.code, 'DEADLINE_TOO_CLOSE');

  const changed = await patch(agency, { ...change, response_deadline: new Date(Date.now() + 72 * 3600000).toISOString() });
  assert.equal(changed.response.status, 200);
  assert.deepEqual([changed.body.request.tripVersion, changed.body.request.adults, changed.body.request.roomCount, changed.body.offersAwaitingReconfirmation], [2, 3, 2, 2]);
  assert.deepEqual([changed.body.request.tripChange.previous.travelers, changed.body.request.tripChange.current.travelers], ['2 adults', '3 adults, 1 children']);
  assert.equal((await patch(agency, { ...change, adults: 4 })).body.error.code, 'TRIP_CHANGED');

  const sellerDetail = await api(baseUrl, `/v1/marketplace/requests/${requestId}`, dmc);
  assert.deepEqual([sellerDetail.body.request.adults, sellerDetail.body.request.tripVersion, sellerDetail.body.request.travelStartDate], [3, 2, '2027-04-15']);
  assert.equal(sellerDetail.body.request.tripChange.previous.dates, '2027-04-14 - 2027-04-21');
  assert.equal(sellerDetail.body.request.tripChange.note, change.note);
  const dmcInbox = (await api(baseUrl, '/v1/marketplace/requests', dmc)).body.requests[0];
  assert.deepEqual([dmcInbox.needsReconfirmation, dmcInbox.myOfferId, dmcInbox.tripChange.version], [true, dmcOfferId, 2]);
  const lateInbox = (await api(baseUrl, '/v1/marketplace/requests', latecomer)).body.requests[0];
  assert.deepEqual([lateInbox.needsReconfirmation, lateInbox.hasActiveOffer], [false, false]);
  const titles = async (account) => (await api(baseUrl, '/v1/notifications', account)).body.notifications.filter((item) => item.type === 'request_trip_changed').map((item) => item.title);
  assert.deepEqual(await titles(dmc), ['Trip changed: re-confirm your offer']);
  assert.deepEqual(await titles(latecomer), ['Trip details changed']);
  assert.equal((await api(baseUrl, '/v1/marketplace/offers', dmc)).body.offers[0].needsReconfirmation, true);

  const comparison = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, agency);
  assert.deepEqual(comparison.body.offers.map((offer) => offer.needsReconfirmation), [true, true]);
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}/award`, agency, { method: 'POST', body: { offer_id: dmcOfferId } })).body.error.code, 'OFFER_NEEDS_RECONFIRMATION');

  const reconfirm = (account, offerId, body) => api(baseUrl, `/v1/marketplace/offers/${offerId}/reconfirm`, account, { method: 'POST', body });
  assert.equal((await reconfirm(dmc, dmcOfferId, {})).response.status, 400);
  assert.equal((await reconfirm(dmc, dmcOfferId, { trip_version: 1 })).body.error.code, 'TRIP_CHANGED');
  assert.equal((await reconfirm(hotel, dmcOfferId, { trip_version: 2 })).response.status, 404);
  const reconfirmed = await reconfirm(dmc, dmcOfferId, { trip_version: 2 });
  assert.equal(reconfirmed.response.status, 200);
  assert.deepEqual([reconfirmed.body.offer.needsReconfirmation, reconfirmed.body.offer.confirmedTripVersion, reconfirmed.body.offer.totalMinor], [false, 2, 200000]);
  assert.equal((await reconfirm(dmc, dmcOfferId, { trip_version: 2 })).body.error.code, 'OFFER_ALREADY_CONFIRMED');
  assert.equal((await api(baseUrl, `/v1/marketplace/offers/${dmcOfferId}/revisions`, dmc)).body.revisions[0].snapshot.confirmedTripVersion, 1);
  assert.ok((await api(baseUrl, '/v1/notifications', agency)).body.notifications.some((item) => item.type === 'offer_reconfirmed'));

  const hotelRevision = { rate_per_night_minor: 19500, room_type: 'Garden Twin', currency: 'JPY', inclusions: [], exclusions: [], validity_until: validityUntil, room_count: 2, availability_confirmed: true };
  const revise = (body) => api(baseUrl, `/v1/marketplace/offers/${hotelOfferId}`, hotel, { method: 'PUT', body });
  assert.equal((await revise({ ...hotelRevision, trip_version: 1 })).body.error.code, 'TRIP_CHANGED');
  assert.equal((await revise(hotelRevision)).body.offer.needsReconfirmation, true);
  assert.equal((await revise({ ...hotelRevision, trip_version: 2 })).body.offer.needsReconfirmation, false);

  const lateBody = { total_minor: 210000, currency: 'USD', inclusions: [], exclusions: [], validity_until: validityUntil };
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, latecomer, { method: 'POST', body: { ...lateBody, trip_version: 1 } })).body.error.code, 'TRIP_CHANGED');
  const lateOffer = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, latecomer, { method: 'POST', body: { ...lateBody, trip_version: 2 } });
  assert.equal(lateOffer.body.offer.confirmedTripVersion, 2);

  const agencyView = await api(baseUrl, `/v1/marketplace/requests/${requestId}`, agency);
  assert.deepEqual(agencyView.body.request.tripChanges.map((item) => [item.version, item.previous.adults, item.current.adults]), [[2, 2, 3]]);
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}/award`, agency, { method: 'POST', body: { offer_id: dmcOfferId } })).response.status, 201);
  assert.equal((await patch(agency, { ...change, adults: 4, trip_version: 2 })).body.error.code, 'REQUEST_NOT_OPEN');
});

test('sellers quote alternative options in one offer and the agency awards a specific option', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Option Admin', organization: 'Option Ops', email: 'option-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Option Agent', organization: 'Option Agency', email: 'option-agency@example.test', role: 'agency', countryCode: 'IN' });
  const dmc = await register(baseUrl, { name: 'Option DMC', organization: 'Kyoto Option DMC', email: 'option-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  const hotel = await register(baseUrl, { name: 'Option Hotel', organization: 'Kyoto Option Inn', email: 'option-hotel@example.test', role: 'hotelier', countryCode: 'JP', propertyCity: 'Kyoto' });
  await approveSellers(baseUrl, admin, [dmc, hotel]);
  const reference = await (await fetch(`${baseUrl}/v1/reference-data`)).json();
  assert.equal(reference.limits.maxOfferOptions, 3);

  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const requestId = draft.body.request.id;
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/publish`, agency, { method: 'POST', body: {} });
  const validityUntil = new Date(Date.now() + 5 * 86400000).toISOString();
  const threeStar = { label: '3 star', hotel_category: 3, total_minor: 160000 };
  const fiveStar = { label: '5 star', hotel_category: 5, total_minor: 260000, notes: 'Ryokan with a private onsen.' };
  const landOffer = (overrides = {}) => ({ total_minor: 200000, hotel_category: 4, option_label: '4 star', currency: 'INR', inclusions: ['accommodation'], validity_until: validityUntil, options: [threeStar, fiveStar], ...overrides });
  const submit = (account, body) => api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, account, { method: 'POST', body });

  assert.match((await submit(dmc, landOffer({ option_label: null }))).body.error.message, /Name the main option/);
  assert.match((await submit(dmc, landOffer({ options: [threeStar, { ...fiveStar, label: '4 STAR' }] }))).body.error.message, /different name/);
  assert.match((await submit(dmc, landOffer({ options: [threeStar, fiveStar, { ...threeStar, label: 'A' }, { ...threeStar, label: 'B' }] }))).body.error.message, /at most 3/);
  assert.match((await submit(dmc, landOffer({ options: [{ ...fiveStar, notes: 'Book at www.example.com' }] }))).body.error.message, /contact details/);
  assert.match((await submit(dmc, landOffer({ options: [{ ...threeStar, hotel_category: 2 }] }))).body.error.message, /hotel category/);
  const created = await submit(dmc, landOffer());
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.body.offer.options.map((option) => [option.label, option.hotelCategory, option.totalMinor]), [['3 star', 3, 160000], ['5 star', 5, 260000]]);
  const hotelOffer = await submit(hotel, { rate_per_night_minor: 18000, room_type: 'Deluxe Twin', option_label: 'Deluxe', currency: 'INR', room_count: 1, validity_until: validityUntil, options: [{ label: 'Suite', room_type: 'Garden Suite', rate_per_night_minor: 30000, meal_plan: 'half_board' }] });
  assert.equal(hotelOffer.response.status, 201);

  const comparison = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, agency);
  const comparedLand = comparison.body.offers.find((offer) => offer.kind === 'land_package');
  const comparedRoom = comparison.body.offers.find((offer) => offer.kind === 'hotel_room');
  assert.deepEqual([comparedLand.optionLabel, comparedLand.hotelCategory, comparedLand.options[1].perTravellerMinor], ['4 star', 4, 130000]);
  assert.deepEqual([comparedRoom.options[0].roomType, comparedRoom.options[0].mealPlan, comparedRoom.options[0].estimatedTotalMinor], ['Garden Suite', 'half_board', 210000]);

  const revised = await api(baseUrl, `/v1/marketplace/offers/${created.body.offer.id}`, dmc, { method: 'PUT', body: landOffer({ options: [{ ...fiveStar, total_minor: 250000 }] }) });
  assert.deepEqual(revised.body.offer.options.map((option) => option.totalMinor), [250000]);
  const history = await api(baseUrl, `/v1/marketplace/offers/${created.body.offer.id}/revisions`, dmc);
  assert.equal(history.body.revisions[0].snapshot.options.length, 2);

  const award = (body) => api(baseUrl, `/v1/marketplace/requests/${requestId}/award`, agency, { method: 'POST', body });
  const landOfferId = created.body.offer.id;
  assert.equal((await award({ offer_id: landOfferId, offer_option_id: 'five-star' })).response.status, 400);
  assert.equal((await award({ offer_id: landOfferId, offer_option_id: comparedRoom.options[0].id })).body.error.code, 'OPTION_NOT_AVAILABLE');
  assert.equal((await award({ offer_id: landOfferId, offer_option_id: comparedLand.options[1].id })).body.error.code, 'OPTION_NOT_AVAILABLE');
  const awarded = await award({ offer_id: landOfferId, offer_option_id: revised.body.offer.options[0].id });
  assert.equal(awarded.response.status, 201);
  assert.equal(awarded.body.award.optionLabel, '5 star');
  assert.ok((await api(baseUrl, '/v1/notifications', dmc)).body.notifications.some((item) => item.type === 'offer_awarded' && item.message.endsWith('Option: 5 star')));
  assert.equal((await api(baseUrl, `/v1/marketplace/awards/${awarded.body.award.id}`, dmc)).body.award.optionLabel, '5 star');
  const booking = await api(baseUrl, `/v1/bookings/${awarded.body.award.id}`, agency);
  assert.deepEqual([booking.body.booking.offer.optionLabel, booking.body.booking.offer.totalMinor, booking.body.booking.offer.hotelCategory], ['5 star', 250000, 5]);
});

test('agencies request revisions and send counter-offers; sellers accept, decline or revise even after closing', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Deal Admin', organization: 'Deal Ops', email: 'deal-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Deal Agent', organization: 'Deal Agency', email: 'deal-agency@example.test', role: 'agency', countryCode: 'IN' });
  const dmc = await register(baseUrl, { name: 'Deal DMC', organization: 'Kyoto Deal DMC', email: 'deal-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  const hotel = await register(baseUrl, { name: 'Deal Hotel', organization: 'Kyoto Deal Inn', email: 'deal-hotel@example.test', role: 'hotelier', countryCode: 'JP', propertyCity: 'Kyoto' });
  await approveSellers(baseUrl, admin, [dmc, hotel]);
  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const requestId = draft.body.request.id;
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/publish`, agency, { method: 'POST', body: {} });
  const validityUntil = new Date(Date.now() + 5 * 86400000).toISOString();
  const landBody = { total_minor: 150000, option_label: '4 star', currency: 'INR', validity_until: validityUntil, line_items: [{ item_type: 'other', description: 'Complete land package', quantity: 1, unit_price_minor: 150000 }], options: [{ label: '5 star', total_minor: 260000 }] };
  const landOffer = (await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, dmc, { method: 'POST', body: landBody })).body.offer;
  const roomOffer = (await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, hotel, { method: 'POST', body: { rate_per_night_minor: 18000, room_type: 'Deluxe Twin', currency: 'INR', room_count: 1, validity_until: validityUntil } })).body.offer;
  const negotiate = (account, offerId, body) => api(baseUrl, `/v1/marketplace/offers/${offerId}/negotiations`, account, { method: 'POST', body });
  const answer = (account, negotiationId, verb, body = {}) => api(baseUrl, `/v1/marketplace/negotiations/${negotiationId}/${verb}`, account, { method: 'POST', body });

  assert.match((await negotiate(agency, landOffer.id, { kind: 'revision_request' })).body.error.message, /what to change/);
  assert.match((await negotiate(agency, landOffer.id, { kind: 'counter_offer' })).body.error.message, /counter price/);
  assert.match((await negotiate(agency, landOffer.id, { kind: 'revision_request', message: 'Call 9876543210 to discuss' })).body.error.message, /contact details/);
  assert.equal((await negotiate(dmc, landOffer.id, { kind: 'revision_request', message: 'Please add a guide.' })).response.status, 403);
  const revisionRequest = await negotiate(agency, landOffer.id, { kind: 'revision_request', message: 'Please include a private guide on day two.' });
  assert.equal(revisionRequest.response.status, 201);
  assert.equal((await negotiate(agency, landOffer.id, { kind: 'counter_offer', counter_price_minor: 140000 })).body.error.code, 'NEGOTIATION_ALREADY_OPEN');
  assert.ok((await api(baseUrl, '/v1/notifications', dmc)).body.notifications.some((item) => item.type === 'offer_revision_requested'));
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', dmc)).body.requests[0].openNegotiation.kind, 'revision_request');
  assert.equal((await answer(dmc, revisionRequest.body.negotiation.id, 'accept')).body.error.code, 'NEGOTIATION_NOT_COUNTER');

  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}/close`, agency, { method: 'POST', body: {} })).body.status, 'closed');
  const revise = () => api(baseUrl, `/v1/marketplace/offers/${landOffer.id}`, dmc, { method: 'PUT', body: { ...landBody, inclusions: ['guide'] } });
  assert.equal((await revise()).response.status, 200);
  assert.equal((await api(baseUrl, `/v1/marketplace/offers/${landOffer.id}/negotiations`, agency)).body.negotiations[0].status, 'revised');
  assert.equal((await revise()).body.error.code, 'OFFER_NOT_EDITABLE');

  const mainCounter = await negotiate(agency, landOffer.id, { kind: 'counter_offer', counter_price_minor: 140000, message: 'Client budget is tighter.' });
  assert.equal((await answer(dmc, mainCounter.body.negotiation.id, 'accept')).body.error.code, 'COUNTER_NEEDS_REVISION');
  assert.equal((await answer(dmc, mainCounter.body.negotiation.id, 'decline', { note: 'No' })).response.status, 400);
  const declined = await answer(dmc, mainCounter.body.negotiation.id, 'decline', { note: 'Our hotel rates are already contracted.' });
  assert.equal(declined.body.negotiation.status, 'declined');
  assert.ok((await api(baseUrl, '/v1/notifications', agency)).body.notifications.some((item) => item.type === 'offer_negotiation_declined'));

  const comparison = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, agency);
  const fiveStarId = comparison.body.offers.find((offer) => offer.id === landOffer.id).options[0].id;
  const optionCounter = await negotiate(agency, landOffer.id, { kind: 'counter_offer', counter_price_minor: 240000, offer_option_id: fiveStarId });
  assert.equal(optionCounter.body.negotiation.optionLabel, '5 star');
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, agency)).body.offers.find((offer) => offer.id === landOffer.id).openNegotiation.counterPriceMinor, 240000);
  assert.equal((await answer(hotel, optionCounter.body.negotiation.id, 'accept')).response.status, 404);
  const acceptedOption = await answer(dmc, optionCounter.body.negotiation.id, 'accept');
  assert.deepEqual([acceptedOption.body.offer.totalMinor, acceptedOption.body.offer.options[0].totalMinor, acceptedOption.body.offer.openNegotiation], [150000, 240000, null]);
  assert.equal((await api(baseUrl, `/v1/marketplace/offers/${landOffer.id}/revisions`, dmc)).body.revisions[0].snapshot.options[0].totalMinor, 260000);
  assert.ok((await api(baseUrl, '/v1/notifications', agency)).body.notifications.some((item) => item.type === 'offer_counter_accepted'));

  const withdrawnCounter = await negotiate(agency, roomOffer.id, { kind: 'counter_offer', counter_price_minor: 16000 });
  assert.equal((await api(baseUrl, `/v1/marketplace/negotiations/${withdrawnCounter.body.negotiation.id}/withdraw`, agency, { method: 'POST', body: {} })).body.negotiation.status, 'withdrawn');
  assert.equal((await answer(hotel, withdrawnCounter.body.negotiation.id, 'accept')).body.error.code, 'NEGOTIATION_NOT_OPEN');
  const roomCounter = await negotiate(agency, roomOffer.id, { kind: 'counter_offer', counter_price_minor: 16500 });
  assert.equal((await answer(hotel, roomCounter.body.negotiation.id, 'accept')).body.offer.ratePerNightMinor, 16500);
  assert.deepEqual((await api(baseUrl, `/v1/marketplace/offers/${roomOffer.id}/negotiations`, hotel)).body.negotiations.map((item) => item.status), ['accepted', 'withdrawn']);
  assert.equal((await api(baseUrl, `/v1/marketplace/offers/${roomOffer.id}/negotiations`, dmc)).response.status, 404);

  for (const price of [145000, 146000]) {
    const round = await negotiate(agency, landOffer.id, { kind: 'counter_offer', counter_price_minor: price });
    await api(baseUrl, `/v1/marketplace/negotiations/${round.body.negotiation.id}/withdraw`, agency, { method: 'POST', body: {} });
  }
  assert.equal((await negotiate(agency, landOffer.id, { kind: 'counter_offer', counter_price_minor: 147000 })).body.error.code, 'NEGOTIATION_LIMIT_REACHED');

  const pending = await negotiate(agency, roomOffer.id, { kind: 'revision_request', message: 'Could you add breakfast?' });
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}/award`, agency, { method: 'POST', body: { offer_id: landOffer.id, offer_option_id: fiveStarId } })).response.status, 201);
  assert.equal((await api(baseUrl, `/v1/marketplace/offers/${roomOffer.id}/negotiations`, agency)).body.negotiations.find((item) => item.id === pending.body.negotiation.id).status, 'closed');
});

async function uploadVoucher(baseUrl, account, awardId, body, filename = 'voucher.pdf') {
  const form = new FormData();
  form.append('file', new Blob([body]), filename);
  const response = await fetch(`${baseUrl}/v1/bookings/${awardId}/vouchers`, {
    method: 'POST',
    headers: { cookie: account.cookie, 'x-csrf-token': account.session.csrfToken },
    body: form,
  });
  return { response, body: await response.json() };
}

test('booking confirmation releases sealed guest details only to the winning seller, with revoke, access log and retention', async (context) => {
  const { pool, baseUrl, storage } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Booking Admin', organization: 'Booking Ops', email: 'booking-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Booking Agent', organization: 'Booking Agency', email: 'booking-agency@example.test', role: 'agency', countryCode: 'IN' });
  const hotel = await register(baseUrl, { name: 'Booking Hotel', organization: 'Kyoto Booking Inn', email: 'booking-hotel@example.test', role: 'hotelier', countryCode: 'JP', propertyCity: 'Kyoto' });
  const dmc = await register(baseUrl, { name: 'Losing Seller', organization: 'Losing DMC', email: 'booking-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  for (const seller of [hotel, dmc]) {
    await api(baseUrl, `/v1/admin/seller-profiles/${seller.session.organization.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Business details reviewed.' } });
  }
  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const requestId = draft.body.request.id;
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/publish`, agency, { method: 'POST', body: {} });
  const validityUntil = new Date(Date.now() + 5 * 86400000).toISOString();
  const roomQuote = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, hotel, { method: 'POST', body: { rate_per_night_minor: 18500, room_type: 'Garden Twin', currency: 'JPY', inclusions: [], exclusions: [], validity_until: validityUntil, room_count: 1, availability_confirmed: true } });
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, dmc, { method: 'POST', body: { total_minor: 200000, currency: 'USD', inclusions: ['guide'], exclusions: [], validity_until: validityUntil } });
  const award = await api(baseUrl, `/v1/marketplace/requests/${requestId}/award`, agency, { method: 'POST', body: { offer_id: roomQuote.body.offer.id } });
  const awardId = award.body.award.id;
  const guestPath = `/v1/bookings/${awardId}/guest-details`;

  const sellerList = await api(baseUrl, '/v1/bookings', hotel);
  assert.deepEqual([sellerList.body.bookings.length, sellerList.body.bookings[0].status, sellerList.body.bookings[0].guestDetails, sellerList.body.bookings[0].viewerRole], [1, 'awarded', null, 'seller']);
  assert.equal((await api(baseUrl, guestPath, hotel)).body.error.code, 'GUEST_DETAILS_NOT_RELEASED');
  assert.equal((await api(baseUrl, `/v1/bookings/${awardId}`, dmc)).response.status, 404);
  assert.equal((await api(baseUrl, '/v1/bookings', dmc)).body.bookings.length, 0);
  assert.equal((await api(baseUrl, `/v1/bookings/${awardId}/seller-confirmation`, hotel, { method: 'POST', body: { confirmation_number: 'KY-48213' } })).body.error.code, 'BOOKING_NOT_CONFIRMED');

  const guests = [
    { full_name: 'Asha Rao', traveller_type: 'adult', nationality: 'IN', room_number: 1 },
    { full_name: 'Vikram Rao', traveller_type: 'adult', nationality: 'IN', room_number: 1 },
  ];
  const details = { guests, lead_guest_index: 0, arrival_date: '2027-04-14', arrival_time: '14:30', arrival_details: 'Flight AI 314', departure_date: '2027-04-21' };
  const confirm = (account, body) => api(baseUrl, `/v1/bookings/${awardId}/confirm`, account, { method: 'POST', body });
  assert.equal((await confirm(hotel, details)).response.status, 403);
  assert.match((await confirm(agency, { ...details, guests: guests.slice(0, 1) })).body.error.message, /exactly 2 adult/);
  assert.match((await confirm(agency, { ...details, guests: guests.map((guest) => ({ ...guest, room_number: null })) })).body.error.message, /rooming list/);
  assert.match((await confirm(agency, { ...details, special_requests: 'Call 9876543210 on arrival' })).body.error.message, /phone numbers/);
  assert.match((await confirm(agency, { ...details, departure_date: '2027-04-22' })).body.error.message, /awarded travel dates/);
  assert.match((await confirm(agency, { ...details, lead_guest_index: 5 })).body.error.message, /lead guest/);

  const confirmed = await confirm(agency, details);
  assert.equal(confirmed.response.status, 201);
  assert.deepEqual([confirmed.body.booking.status, confirmed.body.booking.guestDetails.guestCount, confirmed.body.booking.guestDetails.sellerCanView], ['confirmation_pending', 2, true]);
  assert.equal((await confirm(agency, details)).body.error.code, 'BOOKING_ALREADY_CONFIRMED');
  const stored = await pool.query('SELECT ciphertext FROM booking_guest_details WHERE award_id = $1', [awardId]);
  assert.equal(stored.rows[0].ciphertext.includes('Asha'), false);
  assert.equal((await api(baseUrl, `/v1/marketplace/awards/${awardId}`, agency)).body.award.guestDetailsReleased, true);
  assert.ok((await api(baseUrl, '/v1/notifications', hotel)).body.notifications.some((item) => item.type === 'booking_confirmed'));

  const sellerView = await api(baseUrl, guestPath, hotel);
  assert.equal(sellerView.response.status, 200);
  assert.equal(sellerView.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(sellerView.body.guestDetails.guests.map((guest) => [guest.fullName, guest.lead, guest.roomNumber]), [['Asha Rao', true, 1], ['Vikram Rao', false, 1]]);
  assert.equal(sellerView.body.guestDetails.arrival.details, 'Flight AI 314');
  assert.equal((await api(baseUrl, guestPath, dmc)).response.status, 404);

  const sellerConfirmed = await api(baseUrl, `/v1/bookings/${awardId}/seller-confirmation`, hotel, { method: 'POST', body: { confirmation_number: 'KY-48213', note: 'Twin beds noted.' } });
  assert.deepEqual([sellerConfirmed.body.booking.status, sellerConfirmed.body.booking.sellerConfirmationNumber], ['booked', 'KY-48213']);
  assert.ok((await api(baseUrl, '/v1/notifications', agency)).body.notifications.some((item) => item.type === 'booking_seller_confirmed'));

  assert.equal((await uploadVoucher(baseUrl, agency, awardId, pdfBytes('voucher'))).response.status, 403);
  const voucher = await uploadVoucher(baseUrl, hotel, awardId, pdfBytes('voucher'));
  assert.equal(voucher.response.status, 201);
  const voucherUrl = `/v1/bookings/${awardId}/vouchers/${voucher.body.voucher.id}/download-url`;
  assert.equal((await api(baseUrl, voucherUrl, agency, { method: 'POST', body: {} })).body.error.code, 'DOCUMENT_NOT_SCANNED');
  assert.deepEqual(await processDocumentScans(pool, { storage, scanner: { scan: async () => ({ infected: false }) } }), { clean: 1, infected: 0, retrying: 0, failed: 0 });
  assert.ok((await api(baseUrl, '/v1/notifications', agency)).body.notifications.some((item) => item.type === 'booking_voucher_ready'));
  assert.match((await api(baseUrl, voucherUrl, agency, { method: 'POST', body: {} })).body.url, /disposition=attachment/);
  assert.equal((await api(baseUrl, voucherUrl, dmc, { method: 'POST', body: {} })).response.status, 404);

  const corrected = await api(baseUrl, guestPath, agency, { method: 'PUT', body: { ...details, guests: [{ ...guests[0], full_name: 'Asha V. Rao' }, guests[1]] } });
  assert.equal(corrected.body.booking.guestDetails.version, 2);
  assert.equal((await api(baseUrl, guestPath, hotel)).body.guestDetails.guests[0].fullName, 'Asha V. Rao');
  assert.equal((await api(baseUrl, guestPath, hotel, { method: 'PUT', body: details })).response.status, 403);

  const revoked = await api(baseUrl, `${guestPath}/revoke`, agency, { method: 'POST', body: { reason: 'Guests changed hotel.' } });
  assert.equal(revoked.body.booking.guestDetails.sellerCanView, false);
  assert.equal((await api(baseUrl, guestPath, hotel)).body.error.code, 'GUEST_DETAILS_REVOKED');
  assert.equal((await api(baseUrl, voucherUrl, hotel, { method: 'POST', body: {} })).body.error.code, 'GUEST_DETAILS_REVOKED');
  assert.equal((await api(baseUrl, guestPath, agency)).response.status, 200);
  assert.equal((await api(baseUrl, `${guestPath}/restore`, agency, { method: 'POST', body: {} })).response.status, 200);
  assert.equal((await api(baseUrl, guestPath, hotel)).response.status, 200);

  const log = await api(baseUrl, `${guestPath}/access-log`, agency);
  assert.deepEqual([...new Set(log.body.entries.map((entry) => entry.action))].sort(), ['corrected', 'released', 'restored', 'revoked', 'viewed', 'voucher_opened']);
  assert.ok(log.body.entries.some((entry) => entry.action === 'viewed' && entry.organizationName === 'Kyoto Booking Inn' && entry.userName === 'Booking Hotel'));
  assert.equal((await api(baseUrl, `${guestPath}/access-log`, hotel)).response.status, 404);

  const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  await pool.query('UPDATE booking_guest_details SET trip_end_date = $2 WHERE award_id = $1', [awardId, daysAgo(31)]);
  assert.equal((await api(baseUrl, guestPath, hotel)).body.error.code, 'GUEST_DETAILS_ACCESS_EXPIRED');
  assert.equal((await api(baseUrl, guestPath, agency)).response.status, 200);
  assert.deepEqual(await processGuestDataRetention(pool, { storage }), { purgedGuestDetails: 0, deletedVouchers: 0, failures: 0 });
  await pool.query('UPDATE booking_guest_details SET trip_end_date = $2 WHERE award_id = $1', [awardId, daysAgo(90)]);
  assert.deepEqual(await processGuestDataRetention(pool, { storage }), { purgedGuestDetails: 1, deletedVouchers: 1, failures: 0 });
  assert.equal((await api(baseUrl, guestPath, agency)).body.error.code, 'GUEST_DETAILS_DELETED');
  assert.equal((await api(baseUrl, `/v1/marketplace/awards/${awardId}`, agency)).body.award.guestDetailsReleased, false);
  assert.equal([...storage.objects.keys()].some((key) => key.includes(awardId)), false);
});

async function uploadAttachment(baseUrl, account, path, body, { filename = 'itinerary.pdf', fields = {} } = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('file', new Blob([body]), filename);
  const response = await fetch(`${baseUrl}/v1/attachments${path}`, {
    method: 'POST',
    headers: { cookie: account.cookie, 'x-csrf-token': account.session.csrfToken },
    body: form,
  });
  return { response, body: await response.json() };
}

test('offers and request messages carry scanned attachments that only the two parties can open', async (context) => {
  const { pool, baseUrl, storage } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Files Admin', organization: 'Files Ops', email: 'files-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Files Agent', organization: 'Files Agency', email: 'files-agency@example.test', role: 'agency', countryCode: 'IN' });
  const dmc = await register(baseUrl, { name: 'Files DMC', organization: 'Kyoto Files DMC', email: 'files-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  const rival = await register(baseUrl, { name: 'Rival DMC', organization: 'Kyoto Rival DMC', email: 'files-rival@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  await approveSellers(baseUrl, admin, [dmc, rival]);
  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const requestId = draft.body.request.id;
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/publish`, agency, { method: 'POST', body: {} });
  const offer = (await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, dmc, { method: 'POST', body: { total_minor: 150000, currency: 'INR', validity_until: new Date(Date.now() + 5 * 86400000).toISOString() } })).body.offer;
  const offerPath = `/offers/${offer.id}`;
  const scan = () => processDocumentScans(pool, { storage, scanner: { scan: async () => ({ infected: false }) } });
  const downloadUrl = (account, attachmentId) => api(baseUrl, `/v1/attachments/${attachmentId}/download-url`, account, { method: 'POST', body: {} });
  const comparedAttachments = async () => (await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, agency)).body.offers[0].attachments;

  assert.equal((await uploadAttachment(baseUrl, agency, offerPath, pdfBytes())).response.status, 403);
  assert.equal((await uploadAttachment(baseUrl, rival, offerPath, pdfBytes())).response.status, 404);
  assert.equal((await uploadAttachment(baseUrl, dmc, offerPath, Buffer.from('plain text itinerary'), { filename: 'itinerary.txt' })).body.error.code, 'UNSUPPORTED_FILE_TYPE');
  const itinerary = await uploadAttachment(baseUrl, dmc, offerPath, pdfBytes('itinerary'));
  assert.deepEqual([itinerary.response.status, itinerary.body.attachment.scanStatus, itinerary.body.attachment.filename], [201, 'pending', 'itinerary.pdf']);
  const renamed = await uploadAttachment(baseUrl, dmc, offerPath, pdfBytes('photos'), { filename: 'call 9876543210.pdf' });
  assert.equal(renamed.body.attachment.filename, 'offer-attachment.pdf');
  assert.equal((await comparedAttachments()).length, 2);
  assert.equal((await downloadUrl(agency, itinerary.body.attachment.id)).body.error.code, 'DOCUMENT_NOT_SCANNED');
  assert.deepEqual(await scan(), { clean: 2, infected: 0, retrying: 0, failed: 0 });
  assert.match((await downloadUrl(agency, itinerary.body.attachment.id)).body.url, /disposition=attachment/);
  assert.equal((await downloadUrl(rival, itinerary.body.attachment.id)).response.status, 404);

  assert.equal((await api(baseUrl, `/v1/attachments/${renamed.body.attachment.id}`, agency, { method: 'DELETE', body: {} })).response.status, 404);
  assert.equal((await api(baseUrl, `/v1/attachments/${renamed.body.attachment.id}`, dmc, { method: 'DELETE', body: {} })).response.status, 204);
  assert.deepEqual((await comparedAttachments()).map((item) => item.filename), ['itinerary.pdf']);
  assert.equal([...storage.objects.keys()].some((key) => key.includes(renamed.body.attachment.id)), false);

  await pool.query("UPDATE marketplace_requests SET response_deadline = NOW() - INTERVAL '1 minute' WHERE id = $1", [requestId]);
  assert.equal((await uploadAttachment(baseUrl, dmc, offerPath, pdfBytes('late'))).body.error.code, 'RESPONSE_DEADLINE_PASSED');
  await api(baseUrl, `/v1/marketplace/offers/${offer.id}/negotiations`, agency, { method: 'POST', body: { kind: 'revision_request', message: 'Please attach the day-by-day plan.' } });
  assert.equal((await uploadAttachment(baseUrl, dmc, offerPath, pdfBytes('day plan'))).response.status, 201);

  const messagePath = `/requests/${requestId}/messages`;
  assert.equal((await uploadAttachment(baseUrl, agency, messagePath, pdfBytes(), { fields: { seller_organization_id: dmc.session.organization.id, body: 'Mail me at someone@example.com' } })).response.status, 400);
  const shared = await uploadAttachment(baseUrl, agency, messagePath, pdfBytes('brief'), { filename: 'client-brief.pdf', fields: { seller_organization_id: dmc.session.organization.id } });
  assert.deepEqual([shared.response.status, shared.body.message.body, shared.body.message.attachments.length], [201, 'Shared a file: client-brief.pdf', 1]);
  const sellerThread = await api(baseUrl, `/v1/marketplace/requests/${requestId}/messages`, dmc);
  assert.equal(sellerThread.body.messages.at(-1).attachments[0].filename, 'client-brief.pdf');
  assert.ok((await api(baseUrl, '/v1/notifications', dmc)).body.notifications.some((item) => item.type === 'request_message' && item.message.includes('New file')));

  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${requestId}/award`, agency, { method: 'POST', body: { offer_id: offer.id } })).response.status, 201);
  const afterAward = await uploadAttachment(baseUrl, dmc, messagePath, pdfBytes('vouchers'), { filename: 'transfer-plan.pdf', fields: { body: 'Transfer plan for arrival day.' } });
  assert.equal(afterAward.response.status, 201);
  assert.equal((await uploadAttachment(baseUrl, rival, messagePath, pdfBytes('late'))).body.error.code, 'CONVERSATION_NOT_FOUND');
  await scan();
  assert.equal((await downloadUrl(agency, afterAward.body.message.attachments[0].id)).response.status, 200);
  assert.equal((await downloadUrl(dmc, shared.body.message.attachments[0].id)).response.status, 200);
  assert.equal((await downloadUrl(rival, shared.body.message.attachments[0].id)).response.status, 404);
});

test('booking parties request and answer amendments and cancellations with guest access revoked on cancellation', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Change Admin', organization: 'Change Ops', email: 'change-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Change Agent', organization: 'Change Agency', email: 'change-agency@example.test', role: 'agency', countryCode: 'IN' });
  const hotel = await register(baseUrl, { name: 'Change Hotel', organization: 'Kyoto Change Inn', email: 'change-hotel@example.test', role: 'hotelier', countryCode: 'JP', propertyCity: 'Kyoto' });
  await approveSellers(baseUrl, admin, [hotel]);
  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const requestId = draft.body.request.id;
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/publish`, agency, { method: 'POST', body: {} });
  const offer = await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, hotel, { method: 'POST', body: { rate_per_night_minor: 18500, room_type: 'Garden Twin', currency: 'JPY', validity_until: new Date(Date.now() + 5 * 86400000).toISOString(), room_count: 1 } });
  const awarded = await api(baseUrl, `/v1/marketplace/requests/${requestId}/award`, agency, { method: 'POST', body: { offer_id: offer.body.offer.id } });
  const awardId = awarded.body.award.id;
  const details = { guests: [{ full_name: 'Asha Rao', traveller_type: 'adult', nationality: 'IN', room_number: 1 }, { full_name: 'Vikram Rao', traveller_type: 'adult', nationality: 'IN', room_number: 1 }], lead_guest_index: 0, arrival_date: '2027-04-14', arrival_time: '14:30', departure_date: '2027-04-21' };
  assert.equal((await api(baseUrl, `/v1/bookings/${awardId}/confirm`, agency, { method: 'POST', body: details })).response.status, 201);
  assert.equal((await api(baseUrl, `/v1/bookings/${awardId}/seller-confirmation`, hotel, { method: 'POST', body: { confirmation_number: 'KY-48213' } })).body.booking.status, 'booked');
  const changesPath = `/v1/bookings/${awardId}/changes`;
  const propose = (account, body) => api(baseUrl, changesPath, account, { method: 'POST', body });
  const respond = (account, changeId, action, body = {}) => api(baseUrl, `/v1/bookings/${awardId}/changes/${changeId}/${action}`, account, { method: 'POST', body });

  assert.equal((await propose(agency, { change_type: 'amendment', message: 'Please change the dates.' })).body.error.code, 'VALIDATION_ERROR');
  assert.equal((await propose(agency, { change_type: 'amendment', message: 'Please move the trip.', proposed_changes: { travel_start_date: '2027-04-15', travel_end_date: '2027-04-22', nights: 6 } })).body.error.code, 'VALIDATION_ERROR');
  assert.equal((await propose(agency, { change_type: 'amendment', message: 'Call 9876543210 to discuss.', proposed_changes: { nights: 8 } })).body.error.code, 'VALIDATION_ERROR');
  const amendment = await propose(agency, { change_type: 'amendment', message: 'Please move the arrival by one day.', proposed_changes: { travel_start_date: '2027-04-15', travel_end_date: '2027-04-22', nights: 7, room_count: 2 } });
  assert.equal(amendment.response.status, 201);
  assert.equal(amendment.body.change.isMine, true);
  assert.equal((await propose(hotel, { change_type: 'cancellation', message: 'We need to cancel this stay.' })).body.error.code, 'CHANGE_ALREADY_PENDING');
  assert.equal((await respond(agency, amendment.body.change.id, 'accept')).body.error.code, 'CHANGE_SELF_RESPONSE');
  const accepted = await respond(hotel, amendment.body.change.id, 'accept');
  assert.equal(accepted.body.change.status, 'accepted');
  assert.deepEqual([accepted.body.booking.travelStartDate, accepted.body.booking.travelEndDate, accepted.body.booking.nights, accepted.body.booking.roomCount], ['2027-04-15', '2027-04-22', 7, 2]);
  const amendedGuests = await api(baseUrl, `/v1/bookings/${awardId}/guest-details`, hotel);
  assert.deepEqual([amendedGuests.body.guestDetails.arrival.date, amendedGuests.body.guestDetails.departure.date], ['2027-04-15', '2027-04-22']);
  const agencyBooking = await api(baseUrl, `/v1/bookings/${awardId}`, agency);
  assert.deepEqual(agencyBooking.body.booking.changes.map((change) => [change.type, change.status, change.proposedChanges.nights]), [['amendment', 'accepted', 7]]);
  assert.ok((await api(baseUrl, '/v1/notifications', agency)).body.notifications.some((item) => item.type === 'booking_change_accepted'));

  const sellerCancel = await propose(hotel, { change_type: 'cancellation', message: 'Property maintenance makes this stay unavailable.' });
  assert.equal(sellerCancel.response.status, 201);
  assert.equal((await respond(agency, sellerCancel.body.change.id, 'decline', { note: 'We can keep the original reservation.' })).body.change.status, 'declined');
  const agencyCancel = await propose(agency, { change_type: 'cancellation', message: 'The travellers can no longer make the trip.' });
  assert.equal(agencyCancel.response.status, 201);
  const cancelled = await respond(hotel, agencyCancel.body.change.id, 'accept');
  assert.deepEqual([cancelled.body.change.status, cancelled.body.booking.status, cancelled.body.booking.guestDetails.revokedReason], ['accepted', 'cancelled', 'Booking cancellation accepted']);
  assert.equal((await api(baseUrl, `/v1/bookings/${awardId}/guest-details`, hotel)).body.error.code, 'GUEST_DETAILS_NOT_AVAILABLE');
  assert.equal((await api(baseUrl, '/v1/bookings', agency)).body.bookings[0].status, 'cancelled');
  assert.ok((await api(baseUrl, '/v1/notifications', agency)).body.notifications.some((item) => item.type === 'booking_cancelled'));
  assert.equal((await propose(agency, { change_type: 'cancellation', message: 'Cancel again please.' })).body.error.code, 'BOOKING_NOT_CHANGEABLE');
});

test('agencies split an award across sellers and can undo it within the window before booking', async (context) => {
  const { pool, baseUrl } = await startMarketplaceApp(context);
  const admin = await register(baseUrl, { name: 'Split Admin', organization: 'Split Ops', email: 'split-admin@example.test', role: 'agency', countryCode: 'IN' });
  await promoteTestAdmin(pool, admin);
  const agency = await register(baseUrl, { name: 'Split Agent', organization: 'Split Agency', email: 'split-agency@example.test', role: 'agency', countryCode: 'IN' });
  const dmc = await register(baseUrl, { name: 'Split DMC', organization: 'Kyoto Split DMC', email: 'split-dmc@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  const hotel = await register(baseUrl, { name: 'Split Hotel', organization: 'Kyoto Split Inn', email: 'split-hotel@example.test', role: 'hotelier', countryCode: 'JP', propertyCity: 'Kyoto' });
  const rival = await register(baseUrl, { name: 'Split Rival', organization: 'Kyoto Split Rival', email: 'split-rival@example.test', role: 'dmc', countryCode: 'JP', coverage: 'kyoto' });
  await approveSellers(baseUrl, admin, [dmc, hotel, rival]);
  const draft = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: requestInput() });
  const requestId = draft.body.request.id;
  await api(baseUrl, `/v1/marketplace/requests/${requestId}/publish`, agency, { method: 'POST', body: {} });
  const validityUntil = new Date(Date.now() + 5 * 86400000).toISOString();
  const submit = async (account, body) => (await api(baseUrl, `/v1/marketplace/requests/${requestId}/offers`, account, { method: 'POST', body: { currency: 'INR', validity_until: validityUntil, ...body } })).body.offer;
  const groundOffer = await submit(dmc, { total_minor: 90000 });
  const roomOffer = await submit(hotel, { rate_per_night_minor: 8000, room_type: 'Deluxe Twin', room_count: 1 });
  const rivalOffer = await submit(rival, { total_minor: 150000 });
  const award = (body) => api(baseUrl, `/v1/marketplace/requests/${requestId}/award`, agency, { method: 'POST', body });
  const undo = (account, body = {}) => api(baseUrl, `/v1/marketplace/requests/${requestId}/award/undo`, account, { method: 'POST', body });
  const notices = async (account, type) => (await api(baseUrl, '/v1/notifications', account)).body.notifications.filter((item) => item.type === type);

  assert.match((await award({ selections: [1, 2, 3, 4].map(() => ({ offer_id: randomUUID() })) })).body.error.message, /at most 3/);
  assert.match((await award({ selections: [{ offer_id: groundOffer.id }, { offer_id: groundOffer.id }] })).body.error.message, /only once/);
  assert.equal((await award({})).body.error.message, 'Choose an offer to award.');
  const split = await award({ selections: [{ offer_id: groundOffer.id }, { offer_id: roomOffer.id }], not_selected_reason: 'Split between a DMC and the hotel.' });
  assert.equal(split.response.status, 201);
  assert.deepEqual(split.body.awards.map((item) => item.sellerOrganizationId).sort(), [dmc.session.organization.id, hotel.session.organization.id].sort());
  assert.match((await notices(hotel, 'offer_awarded'))[0].message, /Shared award/);
  assert.match((await notices(rival, 'offer_not_selected'))[0].message, /Split between/);
  assert.deepEqual([(await api(baseUrl, '/v1/bookings', agency)).body.bookings.length, (await api(baseUrl, '/v1/bookings', hotel)).body.bookings.length], [2, 1]);
  const awardedView = (await api(baseUrl, `/v1/marketplace/requests/${requestId}`, agency)).body.request;
  assert.ok(awardedView.awardedAt && new Date(awardedView.awardUndoUntil) > new Date());
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', rival)).body.requests.length, 0);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', hotel)).body.requests[0].status, 'awarded');

  assert.equal((await undo(hotel)).response.status, 403);
  assert.equal((await undo(agency, { reason: 'Call 9876543210' })).response.status, 400);
  const undone = await undo(agency, { reason: 'Client changed hotel preference.' });
  assert.deepEqual(undone.body, { requestId, status: 'open', restoredOffers: 3 });
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM awards WHERE request_id = $1', [requestId])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT jsonb_array_length(awards) AS count FROM award_reversals WHERE request_id = $1', [requestId])).rows[0].count, 2);
  assert.deepEqual((await pool.query('SELECT DISTINCT status FROM offers WHERE request_id = $1', [requestId])).rows, [{ status: 'submitted' }]);
  assert.match((await notices(rival, 'award_undone'))[0].message, /Client changed hotel preference/);
  assert.equal((await api(baseUrl, '/v1/marketplace/requests', rival)).body.requests[0].hasActiveOffer, true);
  assert.equal((await undo(agency)).body.error.code, 'REQUEST_NOT_AWARDED');

  const single = await award({ offer_id: rivalOffer.id });
  assert.equal(single.response.status, 201);
  await pool.query("UPDATE awards SET status = 'confirmation_pending' WHERE id = $1", [single.body.award.id]);
  assert.equal((await undo(agency)).body.error.code, 'AWARD_IN_PROGRESS');
  await pool.query("UPDATE awards SET status = 'awarded', created_at = NOW() - INTERVAL '20 minutes' WHERE id = $1", [single.body.award.id]);
  assert.equal((await undo(agency)).body.error.code, 'UNDO_WINDOW_PASSED');
});