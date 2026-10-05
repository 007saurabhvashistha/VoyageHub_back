import 'dotenv/config';
import { parseArgs } from 'node:util';
import { config, isCountryCode } from '../src/config/index.js';
import { createDatabase } from '../src/db/connect.js';
import { ensureCountryDestination, normalizeSearchText, refreshProfileDisplayNames } from '../src/services/destinations.js';
import { importCountryDestinations } from '../src/services/destinationImport.js';
import { getSetting } from '../src/services/platformSettings.js';
import { recordOperationRun } from '../src/services/databaseBackup.js';

const usage = 'Usage: npm run destinations:import -- [--country IN,AE] [--skip-backfill]\nWithout --country the admin setting "Destination countries" is used.';

const { values } = parseArgs({
  options: {
    country: { type: 'string' },
    'skip-backfill': { type: 'boolean', default: false },
  },
});

async function findLegacyMatch(pool, term, { countryCode = null, kindOrder }) {
  const normalized = normalizeSearchText(term);
  if (/^[a-z]{2}$/.test(normalized) && isCountryCode(normalized.toUpperCase())) {
    return ensureCountryDestination(pool, normalized.toUpperCase());
  }
  const result = await pool.query(
    `SELECT id FROM destinations
     WHERE active AND (search_name = $1 OR $1 = ANY(aliases)) AND ($2::text IS NULL OR country_code = $2)
     ORDER BY array_position($3::text[], kind::text), population DESC NULLS LAST LIMIT 1`,
    [normalized, countryCode, kindOrder],
  );
  return result.rows[0]?.id ?? null;
}

// Links free-text data saved before destinations existed; anything not matched is listed for manual fixing.
async function backfill(pool) {
  const unmatched = [];
  const sellers = await pool.query(
    `SELECT p.organization_id, p.coverage_destinations FROM seller_profiles p
     WHERE cardinality(p.coverage_destinations) > 0
       AND NOT EXISTS (SELECT 1 FROM seller_coverage c WHERE c.organization_id = p.organization_id)`,
  );
  for (const seller of sellers.rows) {
    const ids = new Set();
    for (const term of seller.coverage_destinations) {
      const id = await findLegacyMatch(pool, term, { kindOrder: ['country', 'region', 'district', 'city'] });
      if (id) ids.add(id);
      else unmatched.push(`seller ${seller.organization_id} coverage "${term}"`);
    }
    if (ids.size) {
      await pool.query('INSERT INTO seller_coverage (organization_id, destination_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING', [seller.organization_id, [...ids]]);
      await refreshProfileDisplayNames(pool, { organizationId: seller.organization_id });
    }
  }

  const hotels = await pool.query(
    `SELECT p.organization_id, p.property_city, o.country_code, o.name, p.verification_status FROM seller_profiles p JOIN organizations o ON o.id = p.organization_id
     WHERE p.property_destination_id IS NULL AND p.property_city IS NOT NULL AND o.business_type = 'hotelier'`,
  );
  for (const hotel of hotels.rows) {
    const id = await findLegacyMatch(pool, hotel.property_city, { countryCode: hotel.country_code, kindOrder: ['city', 'district'] });
    if (!id) {
      unmatched.push(`hotel ${hotel.organization_id} city "${hotel.property_city}"`);
      continue;
    }
    await pool.query('UPDATE seller_profiles SET property_destination_id = $2 WHERE organization_id = $1', [hotel.organization_id, id]);
    await pool.query(
      `INSERT INTO hotel_properties (id, organization_id, name, destination_id, verification_status)
       SELECT gen_random_uuid(), $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM hotel_properties WHERE organization_id = $1)`,
      [hotel.organization_id, hotel.name, id, hotel.verification_status === 'approved' ? 'approved' : 'pending'],
    );
  }

  const requests = await pool.query('SELECT id, request_code, destination, destination_country FROM marketplace_requests WHERE destination_id IS NULL');
  for (const request of requests.rows) {
    const id = await findLegacyMatch(pool, request.destination, { countryCode: request.destination_country, kindOrder: ['city', 'district', 'region', 'country'] });
    if (!id) {
      unmatched.push(`request ${request.request_code} destination "${request.destination}"`);
      continue;
    }
    await pool.query('UPDATE marketplace_requests SET destination_id = $2, destination_unresolved = FALSE WHERE id = $1', [request.id, id]);
    await pool.query('INSERT INTO request_destinations (request_id, sequence, destination_id) VALUES ($1, 1, $2) ON CONFLICT DO NOTHING', [request.id, id]);
  }
  return { sellers: sellers.rowCount, hotels: hotels.rowCount, requests: requests.rowCount, unmatched };
}

const { pool, close } = await createDatabase();
const startedAt = new Date();
try {
  const countryCodes = values.country
    ? values.country.split(',').map((code) => code.trim().toUpperCase()).filter(Boolean)
    : await getSetting(pool, 'destination_countries');
  if (!countryCodes.length || countryCodes.some((code) => !isCountryCode(code))) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    const settings = {
      featureCodes: await getSetting(pool, 'destination_place_feature_codes'),
      aliasLanguages: await getSetting(pool, 'destination_alias_languages'),
      minPopulation: await getSetting(pool, 'destination_min_place_population'),
    };
    const results = {};
    for (const countryCode of countryCodes) {
      results[countryCode] = await importCountryDestinations(pool, {
        countryCode,
        dumpUrl: config.geonames.dumpUrl,
        excludedFeatureCodes: config.geonames.excludedFeatureCodes,
        maxAliases: config.geonames.maxAliases,
        ...settings,
        logger: (message) => console.log(message),
      });
      console.log(`[${countryCode}] ${JSON.stringify(results[countryCode])}`);
    }
    if (!values['skip-backfill']) {
      const result = await backfill(pool);
      results.backfill = { sellers: result.sellers, hotels: result.hotels, requests: result.requests, unmatched: result.unmatched.length };
      console.log(`Backfill checked ${result.sellers} seller coverage lists, ${result.hotels} hotel cities and ${result.requests} requests.`);
      for (const line of result.unmatched) console.log(`  Not matched, fix manually: ${line}`);
    }
    await recordOperationRun(pool, { kind: 'destination_import', status: 'succeeded', startedAt, finishedAt: new Date(), details: results });
    console.log('Destination data from GeoNames (geonames.org) is licensed under CC BY 4.0.');
  }
} catch (error) {
  console.error(error.message.startsWith('GeoNames') || error.message.startsWith('The ') ? error.message : 'Destination import failed. Verify network and database access.');
  await recordOperationRun(pool, { kind: 'destination_import', status: 'failed', startedAt, finishedAt: new Date(), details: { error: error.message.slice(0, 300) } }).catch(() => {});
  process.exitCode = 1;
} finally {
  await close();
}
