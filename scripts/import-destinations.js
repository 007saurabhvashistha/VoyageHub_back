import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { strFromU8, unzipSync } from 'fflate';
import { config, countryList, isCountryCode } from '../src/config/index.js';
import { createDatabase } from '../src/db/connect.js';
import { ensureCountryDestination, normalizeSearchText, refreshProfileDisplayNames } from '../src/services/destinations.js';

const batchSize = 1000;
const maxNameLength = 120;
const usage = 'Usage: npm run destinations:import -- [--country IN,AE] [--dataset cities15000] [--skip-backfill]';

const { values } = parseArgs({
  options: {
    country: { type: 'string' },
    dataset: { type: 'string', default: config.geonames.citiesDataset },
    'skip-backfill': { type: 'boolean', default: false },
  },
});
const countryCodes = values.country
  ? values.country.split(',').map((code) => code.trim().toUpperCase()).filter(Boolean)
  : countryList().map((country) => country.code);
if (!countryCodes.length || countryCodes.some((code) => !isCountryCode(code)) || !/^cities\d+$/.test(values.dataset)) {
  console.error(usage);
  process.exit(1);
}
const scope = new Set(countryCodes);

async function download(path) {
  const response = await fetch(`${config.geonames.dumpUrl}/${path}`);
  if (!response.ok) throw new Error(`GeoNames download failed for ${path} (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

function tsvRows(text) {
  return text.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => line.split('\t'));
}

async function insertBatches(pool, rows, kind) {
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    await pool.query(
      `INSERT INTO destinations (id, kind, name, search_name, country_code, parent_id, path, geonames_id, population)
       SELECT row.id, $1, row.name, row.search_name, row.country_code, row.parent_id,
              string_to_array(row.path, ',')::uuid[], row.geonames_id, row.population
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::text[], $8::bigint[], $9::bigint[])
         AS row(id, name, search_name, country_code, parent_id, path, geonames_id, population)
       ON CONFLICT (geonames_id) DO NOTHING`,
      [
        kind,
        batch.map((row) => row.id),
        batch.map((row) => row.name),
        batch.map((row) => normalizeSearchText(row.name)),
        batch.map((row) => row.countryCode),
        batch.map((row) => row.parentId),
        batch.map((row) => row.path.join(',')),
        batch.map((row) => row.geonamesId),
        batch.map((row) => row.population),
      ],
    );
  }
}

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
      const id = await findLegacyMatch(pool, term, { kindOrder: ['country', 'region', 'city'] });
      if (id) ids.add(id);
      else unmatched.push(`seller ${seller.organization_id} coverage "${term}"`);
    }
    if (ids.size) {
      await pool.query('INSERT INTO seller_coverage (organization_id, destination_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING', [seller.organization_id, [...ids]]);
      await refreshProfileDisplayNames(pool, { organizationId: seller.organization_id });
    }
  }

  const hotels = await pool.query(
    `SELECT p.organization_id, p.property_city, o.country_code FROM seller_profiles p JOIN organizations o ON o.id = p.organization_id
     WHERE p.property_destination_id IS NULL AND p.property_city IS NOT NULL AND o.business_type = 'hotelier'`,
  );
  for (const hotel of hotels.rows) {
    const id = await findLegacyMatch(pool, hotel.property_city, { countryCode: hotel.country_code, kindOrder: ['city'] });
    if (id) await pool.query('UPDATE seller_profiles SET property_destination_id = $2 WHERE organization_id = $1', [hotel.organization_id, id]);
    else unmatched.push(`hotel ${hotel.organization_id} city "${hotel.property_city}"`);
  }

  const requests = await pool.query('SELECT id, request_code, destination, destination_country FROM marketplace_requests WHERE destination_id IS NULL');
  for (const request of requests.rows) {
    const id = await findLegacyMatch(pool, request.destination, { countryCode: request.destination_country, kindOrder: ['city', 'region', 'country'] });
    if (id) await pool.query('UPDATE marketplace_requests SET destination_id = $2 WHERE id = $1', [request.id, id]);
    else unmatched.push(`request ${request.request_code} destination "${request.destination}"`);
  }
  return { sellers: sellers.rowCount, hotels: hotels.rowCount, requests: requests.rowCount, unmatched };
}

const { pool, close } = await createDatabase();
try {
  console.log(`Downloading GeoNames admin regions and ${values.dataset} for ${scope.size} countr${scope.size === 1 ? 'y' : 'ies'}...`);
  const admin1 = tsvRows(strFromU8(await download('admin1CodesASCII.txt')));
  const archive = unzipSync(await download(`${values.dataset}.zip`));
  const citiesFile = archive[`${values.dataset}.txt`];
  if (!citiesFile) throw new Error(`The ${values.dataset}.zip archive did not contain ${values.dataset}.txt.`);
  const cities = tsvRows(strFromU8(citiesFile));

  const countryIds = new Map();
  for (const code of scope) countryIds.set(code, await ensureCountryDestination(pool, code));
  const existing = await pool.query('SELECT geonames_id, id, path FROM destinations WHERE geonames_id IS NOT NULL');
  const existingByGeonamesId = new Map(existing.rows.map((row) => [String(row.geonames_id), row]));

  const regionByCode = new Map();
  const regions = [];
  for (const [code, name, , geonamesId] of admin1) {
    const countryCode = code.split('.')[0];
    if (!scope.has(countryCode) || !name || name.length > maxNameLength) continue;
    const known = existingByGeonamesId.get(geonamesId);
    const id = known?.id ?? randomUUID();
    const path = known?.path ?? [countryIds.get(countryCode), id];
    regionByCode.set(code, { id, path });
    if (!known) regions.push({ id, name, countryCode, parentId: countryIds.get(countryCode), path, geonamesId, population: null });
  }
  await insertBatches(pool, regions, 'region');

  const newCities = [];
  for (const columns of cities) {
    const [geonamesId, name, , , , , , , countryCode, , admin1Code, , , , population] = columns;
    if (!scope.has(countryCode) || !name || name.length > maxNameLength || existingByGeonamesId.has(geonamesId)) continue;
    const region = regionByCode.get(`${countryCode}.${admin1Code}`);
    const id = randomUUID();
    const parentId = region?.id ?? countryIds.get(countryCode);
    const path = region ? [...region.path, id] : [countryIds.get(countryCode), id];
    newCities.push({ id, name, countryCode, parentId, path, geonamesId, population: Number(population) || null });
  }
  await insertBatches(pool, newCities, 'city');
  console.log(`Imported ${regions.length} new regions and ${newCities.length} new cities (existing GeoNames entries were left unchanged).`);

  if (!values['skip-backfill']) {
    const result = await backfill(pool);
    console.log(`Backfill checked ${result.sellers} seller coverage lists, ${result.hotels} hotel cities and ${result.requests} requests.`);
    for (const line of result.unmatched) console.log(`  Not matched, fix manually: ${line}`);
  }
  console.log('Destination data from GeoNames (geonames.org) is licensed under CC BY 4.0.');
} catch (error) {
  console.error(error.message.startsWith('GeoNames') || error.message.startsWith('The ') ? error.message : 'Destination import failed. Verify network and database access.');
  process.exitCode = 1;
} finally {
  await close();
}
