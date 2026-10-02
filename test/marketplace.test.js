import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { EmbeddedPostgresPool } from '../src/db/embeddedPool.js';
import { processNotificationOutbox } from '../src/jobs/notificationOutbox.js';
import { processRequestDeadlines } from '../src/jobs/requestDeadlines.js';
import { createResendEmailDelivery } from '../src/services/resendEmailDelivery.js';
import { createTotpEnrollment } from '../src/services/totp.js';

const migrationNames = ['001_identity.sql', '002_marketplace.sql', '003_platform_admin.sql', '004_hotel_offers.sql', '005_notifications.sql', '006_offer_revisions.sql', '007_seller_profile_changes.sql', '008_request_messages.sql', '009_notification_outbox.sql', '010_email_verification_and_recovery.sql', '011_multi_factor_auth.sql', '012_marketplace_rules.sql'];
const migrations = await Promise.all(migrationNames.map(async (name) => {
  const migrationUrl = new URL(`../db/migrations/${name}`, import.meta.url);
  return readFile(fileURLToPath(migrationUrl), 'utf8');
}));
const testPools = new Map();
const testTokenEncryptionKey = Buffer.alloc(32, 29);
const testMfaEncryptionKey = Buffer.alloc(32, 31);

async function startMarketplaceApp(context) {
  const database = new PGlite();
  await database.waitReady;
  const pool = new EmbeddedPostgresPool(database);
  for (const migration of migrations) await pool.exec(migration);
  const server = createApp({ pool, secureCookies: false, emailDelivery: async () => {}, tokenEncryptionKey: testTokenEncryptionKey, mfaEncryptionKey: testMfaEncryptionKey }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  testPools.set(baseUrl, pool);
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    testPools.delete(baseUrl);
    await pool.end();
  });
  return { pool, baseUrl };
}

async function register(baseUrl, { name, organization, email, role, countryCode, coverage, propertyCity }) {
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: name,
      organization_name: organization,
      email,
      country_code: countryCode,
      business_type: role,
      coverage_destinations: coverage,
      property_city: propertyCity,
      password: 'marketplace-test-password',
    }),
  });
  assert.equal(response.status, 201);
  const account = await response.json();
  const pool = testPools.get(baseUrl);
  await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [account.user.id]);
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
    destination: 'Kyoto',
    destination_country: 'JP',
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

  const update = await api(baseUrl, '/v1/auth/profile', dmc, { method: 'PUT', body: { coverage_destinations: ['kyoto', 'osaka'] } });
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
  assert.equal(settings.body.settings.maxOffersPerRequest, 10);
  assert.equal((await api(baseUrl, '/v1/admin/settings/max-offers-per-request', agency, { method: 'PUT', body: { value: 1 } })).response.status, 403);
  assert.equal((await api(baseUrl, '/v1/admin/settings/max-offers-per-request', admin, { method: 'PUT', body: { value: 0 } })).response.status, 400);
  assert.equal((await api(baseUrl, '/v1/admin/settings/max-offers-per-request', admin, { method: 'PUT', body: { value: 1 } })).response.status, 200);
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
  await api(baseUrl, '/v1/admin/settings/max-offers-per-request', admin, { method: 'PUT', body: { value: 10 } });
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