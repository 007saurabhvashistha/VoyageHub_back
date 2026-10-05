import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { strToU8, zipSync } from 'fflate';
import { createApp } from '../src/app.js';
import { EmbeddedPostgresPool } from '../src/db/embeddedPool.js';
import { createDestination } from '../src/services/destinations.js';
import { importCountryDestinations } from '../src/services/destinationImport.js';
import { launchRouting } from '../src/services/routing.js';
import { processAlertDigests } from '../src/jobs/alertDigests.js';
import { createTotpEnrollment } from '../src/services/totp.js';

// Every place name in this file is synthetic; the hard rule forbids real geography in code and tests.
const migrationDirectory = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const migrations = await Promise.all((await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort()
  .map((name) => readFile(`${migrationDirectory}${name}`, 'utf8')));
const tokenKey = Buffer.alloc(32, 51);
const mfaKey = Buffer.alloc(32, 53);
const pools = new Map();

// Synthetic hierarchy:  Country(ZZ-like via a real ISO code) > Region North > District N1 > Spot N1a, Spot N1b
//                                                                          > District N2 > Spot N2a
//                                                            Region South > District S1 > Spot S1a
async function seedHierarchy(pool) {
  const country = await createDestination(pool, { kind: 'country', countryCode: 'AQ' });
  const north = await createDestination(pool, { kind: 'region', name: 'Region North', countryCode: 'AQ', parentId: country.id });
  const south = await createDestination(pool, { kind: 'region', name: 'Region South', countryCode: 'AQ', parentId: country.id });
  const n1 = await createDestination(pool, { kind: 'district', name: 'District N1', countryCode: 'AQ', parentId: north.id });
  const n2 = await createDestination(pool, { kind: 'district', name: 'District N2', countryCode: 'AQ', parentId: north.id });
  const s1 = await createDestination(pool, { kind: 'district', name: 'District S1', countryCode: 'AQ', parentId: south.id });
  const n1a = await createDestination(pool, { kind: 'city', name: 'Spot N1a', countryCode: 'AQ', parentId: n1.id });
  const n1b = await createDestination(pool, { kind: 'city', name: 'Spot N1b', countryCode: 'AQ', parentId: n1.id });
  const n2a = await createDestination(pool, { kind: 'city', name: 'Spot N2a', countryCode: 'AQ', parentId: n2.id });
  const s1a = await createDestination(pool, { kind: 'city', name: 'Spot S1a', countryCode: 'AQ', parentId: s1.id });
  return { country, north, south, n1, n2, s1, n1a, n1b, n2a, s1a };
}

async function startApp(context) {
  const database = new PGlite();
  await database.waitReady;
  const pool = new EmbeddedPostgresPool(database);
  for (const migration of migrations) await pool.exec(migration);
  const places = await seedHierarchy(pool);
  const server = createApp({ pool, secureCookies: false, tokenEncryptionKey: tokenKey, mfaEncryptionKey: mfaKey, emailDelivery: async () => {} }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  pools.set(baseUrl, pool);
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    pools.delete(baseUrl);
    await pool.end();
  });
  return { pool, baseUrl, places };
}

let accountCounter = 0;
async function register(baseUrl, { role, coverage = [], property = null, approve = true }) {
  accountCounter += 1;
  const email = `routing-${accountCounter}-${role}@example.test`;
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      full_name: `Person ${accountCounter}`, organization_name: `Org ${accountCounter}`, email, country_code: 'AQ', business_type: role,
      coverage_destination_ids: coverage, property_destination_id: property, password: 'routing-test-password',
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const account = await response.json();
  const pool = pools.get(baseUrl);
  await pool.query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [account.user.id]);
  if (role !== 'agency' && approve) {
    await pool.query("UPDATE seller_profiles SET verification_status = 'approved' WHERE organization_id = $1", [account.organization.id]);
    await pool.query("UPDATE hotel_properties SET verification_status = 'approved' WHERE organization_id = $1", [account.organization.id]);
  }
  const login = await fetch(`${baseUrl}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'routing-test-password', business_type: role }) });
  assert.equal(login.status, 200);
  return { session: await login.json(), cookie: login.headers.get('set-cookie').split(';')[0], organizationId: account.organization.id };
}

async function promoteAdmin(pool, account) {
  await pool.query('UPDATE users SET is_platform_admin = TRUE WHERE id = $1', [account.session.user.id]);
  const enrollment = createTotpEnrollment(account.session.user.email, mfaKey);
  await pool.query('INSERT INTO user_mfa (user_id, secret_ciphertext, enabled) VALUES ($1, $2, TRUE)', [account.session.user.id, enrollment.secretCiphertext]);
}

async function api(baseUrl, path, account, { method = 'GET', body } = {}) {
  const headers = { cookie: account.cookie };
  if (body) {
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = account.session.csrfToken;
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { response, body: response.status === 204 ? null : await response.json() };
}

function lead(overrides = {}) {
  return {
    travel_start_date: '2027-05-01', travel_end_date: '2027-05-05', nights: 4, adults: 2, children: 0, infants: 0,
    group_type: 'family', services: ['hotel', 'sightseeing'], requirement_type: 'itinerary',
    response_deadline: new Date(Date.now() + 48 * 3600000).toISOString(),
    ...overrides,
  };
}

async function publishLead(baseUrl, agency, body) {
  const created = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const published = await api(baseUrl, `/v1/marketplace/requests/${created.body.request.id}/publish`, agency, { method: 'POST', body: {} });
  assert.equal(published.response.status, 200, JSON.stringify(published.body));
  return { id: created.body.request.id, published: published.body };
}

const feedIds = async (baseUrl, account) => (await api(baseUrl, '/v1/marketplace/requests', account)).body.requests.map((item) => item.id);

test('hard rule: hotel-only leads reach only hotels and itinerary leads reach only DMCs', async (context) => {
  const { baseUrl, places } = await startApp(context);
  const agency = await register(baseUrl, { role: 'agency' });
  const hotel = await register(baseUrl, { role: 'hotelier', property: places.n1a.id });
  const dmc = await register(baseUrl, { role: 'dmc', coverage: [places.north.id] });

  const hotelLead = await publishLead(baseUrl, agency, lead({ requirement_type: 'hotel_only', services: ['hotel'], destinations: [{ destination_id: places.n1a.id }] }));
  const itineraryLead = await publishLead(baseUrl, agency, lead({ destinations: [{ destination_id: places.n1a.id }] }));

  assert.deepEqual(await feedIds(baseUrl, hotel), [hotelLead.id]);
  assert.deepEqual(await feedIds(baseUrl, dmc), [itineraryLead.id]);
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${itineraryLead.id}`, hotel)).response.status, 404);
  assert.equal((await api(baseUrl, `/v1/marketplace/requests/${hotelLead.id}`, dmc)).response.status, 404);
  const sneakyOffer = await api(baseUrl, `/v1/marketplace/requests/${itineraryLead.id}/offers`, hotel, {
    method: 'POST',
    body: { rate_per_night_minor: 1000, room_type: 'Double', currency: 'USD', inclusions: [], exclusions: [], validity_until: new Date(Date.now() + 86400000).toISOString() },
  });
  assert.equal(sneakyOffer.response.status, 404);

  const badInvite = await api(baseUrl, '/v1/marketplace/requests', agency, {
    method: 'POST', body: lead({ destinations: [{ destination_id: places.n1a.id }], visibility: 'invite_only', invited_seller_ids: [hotel.organizationId] }),
  });
  assert.equal(badInvite.response.status, 409);
  assert.equal(badInvite.body.error.code, 'SELLER_TYPE_NOT_ELIGIBLE');

  const hotelNotifications = (await api(baseUrl, '/v1/notifications', hotel)).body.notifications;
  assert.ok(hotelNotifications.every((item) => item.data?.requestId !== itineraryLead.id));
});

test('lead type is validated and locked after publishing; repost switches type', async (context) => {
  const { baseUrl, places } = await startApp(context);
  const agency = await register(baseUrl, { role: 'agency' });
  const extraService = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: lead({ requirement_type: 'hotel_only', destinations: [{ destination_id: places.n1a.id }] }) });
  assert.equal(extraService.response.status, 400);
  assert.equal(extraService.body.error.code, 'REQUIREMENT_TYPE_MISMATCH');
  const twoStops = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: lead({ requirement_type: 'hotel_only', services: ['hotel'], destinations: [{ destination_id: places.n1a.id }, { destination_id: places.s1a.id }] }) });
  assert.equal(twoStops.body.error.code, 'REQUIREMENT_TYPE_MISMATCH');
  const missingType = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: lead({ requirement_type: undefined, destinations: [{ destination_id: places.n1a.id }] }) });
  assert.equal(missingType.response.status, 400);
  const badNights = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: lead({ destinations: [{ destination_id: places.n1a.id, nights: 2 }, { destination_id: places.s1a.id, nights: 1 }] }) });
  assert.equal(badNights.response.status, 400);

  const published = await publishLead(baseUrl, agency, lead({ destinations: [{ destination_id: places.n1a.id, nights: 2 }, { destination_id: places.s1a.id, nights: 2 }] }));
  const typeChange = await api(baseUrl, `/v1/marketplace/requests/${published.id}/trip`, agency, {
    method: 'PATCH', body: { ...lead(), requirement_type: 'hotel_only', trip_version: 1 },
  });
  assert.equal(typeChange.response.status, 409);
  assert.equal(typeChange.body.error.code, 'REQUIREMENT_TYPE_LOCKED');

  const repost = await api(baseUrl, `/v1/marketplace/requests/${published.id}/repost`, agency, { method: 'POST', body: { requirement_type: 'hotel_only', cancel_original: true } });
  assert.equal(repost.response.status, 201);
  assert.equal(repost.body.request.status, 'draft');
  assert.equal(repost.body.request.requirementType, 'hotel_only');
  assert.deepEqual(repost.body.request.services, ['hotel']);
  assert.equal(repost.body.request.destinations.length, 1);
  assert.equal(repost.body.originalCancelled, true);
});

test('hotel matching covers the destination subtree and supports several hotels per account', async (context) => {
  const { pool, baseUrl, places } = await startApp(context);
  const agency = await register(baseUrl, { role: 'agency' });
  const chain = await register(baseUrl, { role: 'hotelier', property: places.n1a.id });
  const sibling = await register(baseUrl, { role: 'hotelier', property: places.n1b.id });
  const southern = await register(baseUrl, { role: 'hotelier', property: places.s1a.id });

  const added = await api(baseUrl, '/v1/hotel-properties', chain, { method: 'POST', body: { name: 'Second Hotel', destination_id: places.s1a.id, star_category: 4 } });
  assert.equal(added.response.status, 201);
  assert.equal(added.body.property.verificationStatus, 'pending');
  const regionOnly = await api(baseUrl, '/v1/hotel-properties', chain, { method: 'POST', body: { name: 'Vague Hotel', destination_id: places.north.id } });
  assert.equal(regionOnly.response.status, 400);

  const admin = await register(baseUrl, { role: 'agency' });
  await promoteAdmin(pool, admin);
  const pending = await api(baseUrl, '/v1/admin/hotel-properties/pending', admin);
  assert.equal(pending.body.properties.length, 1);
  const decision = await api(baseUrl, `/v1/admin/hotel-properties/${added.body.property.id}/decision`, admin, { method: 'POST', body: { decision: 'approved', reason: 'Property documents checked.' } });
  assert.equal(decision.response.status, 200);

  const placeLead = await publishLead(baseUrl, agency, lead({ requirement_type: 'hotel_only', services: ['hotel'], destinations: [{ destination_id: places.n1a.id }] }));
  assert.ok((await feedIds(baseUrl, chain)).includes(placeLead.id));
  assert.ok(!(await feedIds(baseUrl, sibling)).includes(placeLead.id), 'a place lead must not reach sibling places');

  const countryLead = await api(baseUrl, '/v1/marketplace/requests', agency, { method: 'POST', body: lead({ requirement_type: 'hotel_only', services: ['hotel'], destinations: [{ destination_id: places.country.id }] }) });
  assert.equal(countryLead.response.status, 400, 'country level is not an allowed hotel lead level by default');
  const northLead = await publishLead(baseUrl, agency, lead({ requirement_type: 'hotel_only', services: ['hotel'], destinations: [{ destination_id: places.north.id }] }));
  assert.ok((await feedIds(baseUrl, sibling)).includes(northLead.id));
  assert.ok(!(await feedIds(baseUrl, southern)).includes(northLead.id));

  const southLead = await publishLead(baseUrl, agency, lead({ requirement_type: 'hotel_only', services: ['hotel'], destinations: [{ destination_id: places.south.id }] }));
  const chainFeed = (await api(baseUrl, '/v1/marketplace/requests', chain)).body.requests.find((item) => item.id === southLead.id);
  assert.deepEqual(chainFeed.matchingProperties.map((item) => item.name), ['Second Hotel']);
  const offerBody = { rate_per_night_minor: 9000, room_type: 'Double', currency: 'USD', inclusions: [], exclusions: [], validity_until: new Date(Date.now() + 86400000).toISOString() };
  const wrongProperty = await api(baseUrl, `/v1/marketplace/requests/${southLead.id}/offers`, chain, { method: 'POST', body: { ...offerBody, hotel_property_id: (await api(baseUrl, '/v1/hotel-properties', chain)).body.properties[0].id } });
  assert.equal(wrongProperty.body.error.code, 'HOTEL_PROPERTY_REQUIRED');
  const offer = await api(baseUrl, `/v1/marketplace/requests/${southLead.id}/offers`, chain, { method: 'POST', body: { ...offerBody, hotel_property_id: added.body.property.id } });
  assert.equal(offer.response.status, 201);
  const compared = await api(baseUrl, `/v1/marketplace/requests/${southLead.id}/offers`, agency);
  assert.equal(compared.body.offers[0].hotelPropertyName, 'Second Hotel');
});

test('DMC coverage matches in both directions with full and partial match types and exclusions', async (context) => {
  const { pool, baseUrl, places } = await startApp(context);
  const agency = await register(baseUrl, { role: 'agency' });
  const regional = await register(baseUrl, { role: 'dmc', coverage: [places.north.id] });
  const districtOnly = await register(baseUrl, { role: 'dmc', coverage: [places.n2.id] });
  const excluding = await register(baseUrl, { role: 'dmc', coverage: [places.north.id] });
  await pool.query("INSERT INTO seller_coverage (organization_id, destination_id, mode) VALUES ($1, $2, 'exclude')", [excluding.organizationId, places.n1.id]);
  const reInclude = await register(baseUrl, { role: 'dmc', coverage: [places.north.id] });
  await pool.query("INSERT INTO seller_coverage (organization_id, destination_id, mode) VALUES ($1, $2, 'exclude'), ($1, $3, 'include')", [reInclude.organizationId, places.n1.id, places.n1a.id]);

  const placeLead = await publishLead(baseUrl, agency, lead({ destinations: [{ destination_id: places.n1a.id }] }));
  const regionLead = await publishLead(baseUrl, agency, lead({ destinations: [{ destination_id: places.north.id }] }));
  const multiStop = await publishLead(baseUrl, agency, lead({ destinations: [{ destination_id: places.n2a.id, nights: 2 }, { destination_id: places.s1a.id, nights: 2 }] }));

  const matchOf = async (account, id) => (await api(baseUrl, '/v1/marketplace/requests', account)).body.requests.find((item) => item.id === id)?.matchType ?? null;
  assert.equal(await matchOf(regional, placeLead.id), 'full');
  assert.equal(await matchOf(districtOnly, placeLead.id), null);
  assert.equal(await matchOf(districtOnly, regionLead.id), 'partial', 'a district DMC still gets the whole-region lead');
  assert.equal(await matchOf(excluding, placeLead.id), null);
  assert.equal(await matchOf(excluding, regionLead.id), 'partial');
  assert.equal(await matchOf(reInclude, placeLead.id), 'full', 'the more specific include wins');
  assert.equal(await matchOf(regional, multiStop.id), 'partial');
  assert.equal(await matchOf(districtOnly, multiStop.id), 'partial');

  const notifications = (await api(baseUrl, '/v1/notifications', districtOnly)).body.notifications;
  assert.ok(notifications.some((item) => item.type === 'request_matched' && item.data.requestId === regionLead.id));

  const preview = await api(baseUrl, '/v1/marketplace/requests/audience-preview', agency, { method: 'POST', body: { requirement_type: 'itinerary', destinations: [{ destination_id: places.north.id }] } });
  assert.equal(preview.body.sellers, 4);
  assert.equal(preview.body.audience, 'dmc');
});

test('secondary parents, coverage rules via profile, and destination search ordering', async (context) => {
  const { pool, baseUrl, places } = await startApp(context);
  const agency = await register(baseUrl, { role: 'agency' });
  const southDmc = await register(baseUrl, { role: 'dmc', coverage: [places.s1.id] });
  const admin = await register(baseUrl, { role: 'agency' });
  await promoteAdmin(pool, admin);
  const linked = await api(baseUrl, `/v1/admin/destinations/${places.n2a.id}`, admin, { method: 'PATCH', body: { secondary_parent_ids: [places.s1.id], featured: true } });
  assert.equal(linked.response.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.destination.secondaryParents[0].id, places.s1.id);
  const spanning = await publishLead(baseUrl, agency, lead({ destinations: [{ destination_id: places.n2a.id }] }));
  assert.ok((await feedIds(baseUrl, southDmc)).includes(spanning.id));

  const search = await api(baseUrl, '/v1/reference-data/destinations?q=spot', agency);
  assert.equal(search.body.destinations[0].id, places.n2a.id, 'featured destinations come first');
  assert.match(search.body.destinations[0].label, /District N2, Region North/);
  const children = await api(baseUrl, `/v1/reference-data/destinations/${places.north.id}/children`, agency);
  assert.deepEqual(children.body.destinations.map((item) => item.name), ['District N1', 'District N2']);
  assert.ok(children.body.destinations.every((item) => item.hasChildren));

  const levels = await api(baseUrl, '/v1/admin/destination-levels/AQ', admin, { method: 'PUT', body: { levels: [{ kind: 'region', label: 'Province' }, { kind: 'district', label: 'County' }] } });
  assert.equal(levels.response.status, 200);
  const relabelled = await api(baseUrl, '/v1/reference-data/destinations?q=district n1', agency);
  assert.equal(relabelled.body.destinations[0].kindLabel, 'County');

  const coverage = await api(baseUrl, '/v1/auth/profile', southDmc, { method: 'PUT', body: { coverage: [{ destination_id: places.country.id, mode: 'include' }, { destination_id: places.north.id, mode: 'exclude' }] } });
  assert.equal(coverage.response.status, 200, JSON.stringify(coverage.body));
  assert.deepEqual(coverage.body.coverage.map((item) => item.mode).sort(), ['exclude', 'include']);
});

test('destination changes re-route the lead and alert preferences control instant, digest and off', async (context) => {
  const { pool, baseUrl, places } = await startApp(context);
  const agency = await register(baseUrl, { role: 'agency' });
  const northDmc = await register(baseUrl, { role: 'dmc', coverage: [places.n1.id] });
  const southDmc = await register(baseUrl, { role: 'dmc', coverage: [places.s1.id] });
  const digestDmc = await register(baseUrl, { role: 'dmc', coverage: [places.s1.id] });
  const mutedDmc = await register(baseUrl, { role: 'dmc', coverage: [places.s1.id] });
  assert.equal((await api(baseUrl, '/v1/alert-preferences', digestDmc, { method: 'PUT', body: { delivery: 'digest' } })).response.status, 200);
  assert.equal((await api(baseUrl, '/v1/alert-preferences', mutedDmc, { method: 'PUT', body: { delivery: 'off' } })).response.status, 200);

  const moving = await publishLead(baseUrl, agency, lead({ destinations: [{ destination_id: places.n1a.id }] }));
  const changed = await api(baseUrl, `/v1/marketplace/requests/${moving.id}/trip`, agency, {
    method: 'PATCH', body: { ...lead(), destinations: [{ destination_id: places.s1a.id }], trip_version: 1 },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.routing.removed, 1);
  assert.equal(changed.body.routing.newlyMatched, 3);
  assert.equal(changed.body.request.destinations[0].name, 'Spot S1a');

  const events = async (account) => (await api(baseUrl, '/v1/notifications', account)).body.notifications.map((item) => item.type);
  assert.ok((await events(northDmc)).includes('request_no_longer_available'));
  assert.ok(!(await feedIds(baseUrl, northDmc)).includes(moving.id));
  assert.ok((await events(southDmc)).includes('request_matched'));
  assert.ok(!(await events(digestDmc)).includes('request_matched'));
  assert.ok(!(await events(mutedDmc)).includes('request_matched'));
  assert.ok((await feedIds(baseUrl, mutedDmc)).includes(moving.id), 'muted sellers still see the lead in the feed');

  await pool.query("UPDATE alert_digest_items SET queued_at = NOW() - INTERVAL '2 days'");
  const digests = await processAlertDigests(pool);
  assert.equal(digests.sent, 1);
  assert.ok((await events(digestDmc)).includes('request_matched_digest'));
});

test('launch routing removes wrong-audience targets and withdraws their offers', async (context) => {
  const { pool, baseUrl, places } = await startApp(context);
  const agency = await register(baseUrl, { role: 'agency' });
  const hotel = await register(baseUrl, { role: 'hotelier', property: places.n1a.id });
  const dmc = await register(baseUrl, { role: 'dmc', coverage: [places.north.id] });
  const itinerary = await publishLead(baseUrl, agency, lead({ destinations: [{ destination_id: places.n1a.id }] }));
  // Simulates a pre-routing target: hotels used to be targeted for any lead that included the hotel service.
  await pool.query('INSERT INTO request_targets (request_id, seller_organization_id, alerted_at) VALUES ($1, $2, NOW())', [itinerary.id, hotel.organizationId]);
  await pool.query(
    `INSERT INTO offers (id, request_id, seller_organization_id, offer_kind, rate_per_night_minor, room_type, currency, validity_until)
     VALUES (gen_random_uuid(), $1, $2, 'hotel_room', 5000, 'Double', 'USD', NOW() + INTERVAL '2 days')`,
    [itinerary.id, hotel.organizationId],
  );
  const report = await launchRouting(pool);
  assert.equal(report.withdrawnOffers, 1);
  assert.equal(report.removedTargets, 1);
  assert.ok(!(await feedIds(baseUrl, hotel)).includes(itinerary.id));
  assert.ok((await feedIds(baseUrl, dmc)).includes(itinerary.id));
  const again = await launchRouting(pool);
  assert.equal(again.removedTargets, 0, 'launch is idempotent');
});

test('GeoNames import builds districts, tourist features and aliases from data, idempotently', async (context) => {
  const { pool } = await startApp(context);
  const tsv = (rows) => strToU8(rows.map((columns) => columns.join('\t')).join('\n'));
  const placeRow = (id, name, featureClass, featureCode, admin1, admin2, population) => [id, name, name, '', '0', '0', featureClass, featureCode, 'AQ', '', admin1, admin2, '', '', String(population), '', '', '', '2026-01-01'];
  const files = {
    'admin1CodesASCII.txt': tsv([['AQ.01', 'Fixture Upland', 'Fixture Upland', '9000001'], ['ZZ.01', 'Other Country Area', 'Other', '9000099']]),
    'admin2Codes.txt': tsv([['AQ.01.A', 'Fixture Vale', 'Fixture Vale', '9000002']]),
    'AQ.zip': zipSync({ 'AQ.txt': tsv([
      placeRow('9000003', 'Fixture Town', 'P', 'PPL', '01', 'A', 20000),
      placeRow('9000004', 'Fixture Hamlet', 'P', 'PPL', '01', 'A', 10),
      placeRow('9000005', 'Fixture Lake', 'H', 'LK', '01', 'A', 0),
      placeRow('9000006', 'Fixture Quarter', 'P', 'PPLX', '01', 'A', 50000),
    ]) }),
    'alternatenames/AQ.zip': zipSync({ 'AQ.txt': tsv([
      ['1', '9000003', 'en', 'Old Fixture Name'],
      ['2', '9000003', 'xx', 'Ignored Language Name'],
      ['3', '9000005', 'abbr', 'FL'],
    ]) }),
  };
  const fetchImpl = async (url) => {
    const name = url.replace('https://geonames.test/', '');
    return files[name] ? { ok: true, arrayBuffer: async () => files[name].buffer.slice(files[name].byteOffset, files[name].byteOffset + files[name].byteLength) } : { ok: false, status: 404 };
  };
  const options = { countryCode: 'AQ', fetchImpl, dumpUrl: 'https://geonames.test', featureCodes: ['LK'], excludedFeatureCodes: ['PPLX'], aliasLanguages: ['en', 'abbr'], minPopulation: 1000, maxAliases: 10 };
  const first = await importCountryDestinations(pool, options);
  assert.deepEqual({ regions: first.regions, districts: first.districts, places: first.places }, { regions: 1, districts: 1, places: 2 });
  const town = (await pool.query("SELECT d.*, p.name AS parent_name FROM destinations d JOIN destinations p ON p.id = d.parent_id WHERE d.name = 'Fixture Town'")).rows[0];
  assert.equal(town.parent_name, 'Fixture Vale');
  assert.deepEqual(town.aliases, ['old fixture name']);
  assert.equal(town.match_path.length, 4);
  const second = await importCountryDestinations(pool, options);
  assert.equal(second.places, 0);
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS total FROM destinations WHERE name LIKE 'Fixture%'")).rows[0].total), 4);
});

test('featured CSV import marks only unambiguous rows and reports the rest', async (context) => {
  const { pool, baseUrl, places } = await startApp(context);
  const admin = await register(baseUrl, { role: 'agency' });
  await promoteAdmin(pool, admin);
  const form = new FormData();
  form.append('country_code', 'AQ');
  form.append('file', new Blob(['name,region,district,aliases\nSpot N1a,Region North,District N1,Alt Spot\nNowhere Spot,,,\n']), 'featured.csv');
  const response = await fetch(`${baseUrl}/v1/admin/destinations/featured-import`, { method: 'POST', headers: { cookie: admin.cookie, 'x-csrf-token': admin.session.csrfToken }, body: form });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.totals, { rows: 2, featured: 1, unresolved: 1 });
  assert.equal(body.report[1].status, 'not_found');
  const row = (await pool.query('SELECT featured, aliases FROM destinations WHERE id = $1', [places.n1a.id])).rows[0];
  assert.equal(row.featured, true);
  assert.ok(row.aliases.includes('alt spot'));
});

test('hard-rule guard: no country names are written as string literals in source code', async () => {
  const require = createRequire(import.meta.url);
  const names = Object.values(require('i18n-iso-countries/langs/en.json').countries).flat().filter((name) => name.length > 3);
  const roots = [new URL('../src/', import.meta.url), new URL('../../frontend/src/', import.meta.url)];
  const offenders = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => /\.(js|jsx)$/.test(name))) {
      const text = await readFile(new URL(entry.replaceAll('\\', '/'), root), 'utf8');
      for (const name of names) {
        if (text.includes(`'${name}'`) || text.includes(`"${name}"`)) offenders.push(`${entry}: ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
