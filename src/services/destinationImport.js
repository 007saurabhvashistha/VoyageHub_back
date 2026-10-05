import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { unzipSync } from 'fflate';
import { ensureCountryDestination, normalizeSearchText } from './destinations.js';

const batchSize = 1000;
const maxNameLength = 120;
const chunkBytes = 1 << 20;

async function download(fetchImpl, dumpUrl, path) {
  const response = await fetchImpl(`${dumpUrl}/${path}`);
  if (!response.ok) throw new Error(`GeoNames download failed for ${path} (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

function unzipEntry(bytes, entryName) {
  const archive = unzipSync(bytes, { filter: (file) => file.name === entryName });
  if (!archive[entryName]) throw new Error(`The GeoNames archive did not contain ${entryName}.`);
  return archive[entryName];
}

// Streams GeoNames TSV (no quoting) through csv-parse in 1 MB slices to keep memory flat.
async function* tsvRecords(bytes) {
  const source = Readable.from((function* slices() {
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      yield Buffer.from(bytes.buffer, bytes.byteOffset + offset, Math.min(chunkBytes, bytes.length - offset));
    }
  })());
  const parser = source.pipe(parse({ delimiter: '\t', quote: false, relax_column_count: true, skip_empty_lines: true }));
  for await (const record of parser) {
    if (!record[0]?.startsWith('#')) yield record;
  }
}

async function existingByGeonamesId(db, countryCode) {
  const result = await db.query(
    'SELECT id, geonames_id, parent_id, path, admin_edited_at FROM destinations WHERE country_code = $1 AND geonames_id IS NOT NULL',
    [countryCode],
  );
  return new Map(result.rows.map((row) => [String(row.geonames_id), row]));
}

async function insertRows(db, kind, rows) {
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    await db.query(
      `INSERT INTO destinations (id, kind, name, search_name, country_code, parent_id, path, match_path, geonames_id, population, admin1_code, admin2_code, feature_code)
       SELECT row.id, $1, row.name, row.search_name, row.country_code, row.parent_id,
              string_to_array(row.path, ',')::uuid[], string_to_array(row.path, ',')::uuid[], row.geonames_id, row.population,
              row.admin1_code, row.admin2_code, row.feature_code
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::text[], $8::bigint[], $9::bigint[], $10::text[], $11::text[], $12::text[])
         AS row(id, name, search_name, country_code, parent_id, path, geonames_id, population, admin1_code, admin2_code, feature_code)
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
        batch.map((row) => row.admin1Code ?? null),
        batch.map((row) => row.admin2Code ?? null),
        batch.map((row) => row.featureCode ?? null),
      ],
    );
  }
}

// Updates codes for rows an admin has not edited, and re-parents them (e.g. a town moving under its new district).
async function updateRows(db, rows) {
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    await db.query(
      `UPDATE destinations d SET name = row.name, search_name = row.search_name, parent_id = row.parent_id,
         path = string_to_array(row.path, ',')::uuid[], match_path = string_to_array(row.path, ',')::uuid[],
         population = COALESCE(row.population, d.population), admin1_code = row.admin1_code, admin2_code = row.admin2_code,
         feature_code = COALESCE(row.feature_code, d.feature_code), updated_at = NOW()
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::text[], $6::bigint[], $7::text[], $8::text[], $9::text[])
         AS row(id, name, search_name, parent_id, path, population, admin1_code, admin2_code, feature_code)
       WHERE d.id = row.id AND d.admin_edited_at IS NULL`,
      [
        batch.map((row) => row.id),
        batch.map((row) => row.name),
        batch.map((row) => normalizeSearchText(row.name)),
        batch.map((row) => row.parentId),
        batch.map((row) => row.path.join(',')),
        batch.map((row) => row.population),
        batch.map((row) => row.admin1Code ?? null),
        batch.map((row) => row.admin2Code ?? null),
        batch.map((row) => row.featureCode ?? null),
      ],
    );
  }
}

function plan(existing, { geonamesId, parentId, parentPath }) {
  const known = existing.get(geonamesId);
  if (known?.admin_edited_at) return { id: known.id, path: known.path, skip: true };
  const id = known?.id ?? randomUUID();
  return { id, path: [...parentPath, id], parentId, known: Boolean(known) };
}

/**
 * Imports one country's level-1 and level-2 areas, towns above a population floor and selected tourist features,
 * with aliases from GeoNames alternate names. Safe to re-run; admin-edited rows are left alone.
 */
export async function importCountryDestinations(db, { countryCode, fetchImpl = globalThis.fetch, dumpUrl, featureCodes, excludedFeatureCodes = [], aliasLanguages, minPopulation, maxAliases, logger = null }) {
  const counts = { regions: 0, districts: 0, places: 0, updated: 0, aliased: 0 };
  const countryId = await ensureCountryDestination(db, countryCode);
  const countryPath = [countryId];
  let existing = await existingByGeonamesId(db, countryCode);

  logger?.(`[${countryCode}] level 1 areas`);
  const regionByCode = new Map();
  const newRegions = [];
  const changedRegions = [];
  for await (const [code, name, , geonamesId] of tsvRecords(await download(fetchImpl, dumpUrl, 'admin1CodesASCII.txt'))) {
    if (!code?.startsWith(`${countryCode}.`) || !name || name.length > maxNameLength || !geonamesId) continue;
    const admin1Code = code.slice(countryCode.length + 1);
    const target = plan(existing, { geonamesId, parentId: countryId, parentPath: countryPath });
    regionByCode.set(admin1Code, { id: target.id, path: target.path });
    if (target.skip) continue;
    const row = { id: target.id, name, countryCode, parentId: countryId, path: target.path, geonamesId, population: null, admin1Code, featureCode: 'ADM1' };
    (target.known ? changedRegions : newRegions).push(row);
  }
  await insertRows(db, 'region', newRegions);
  await updateRows(db, changedRegions);
  counts.regions = newRegions.length;
  counts.updated += changedRegions.length;

  logger?.(`[${countryCode}] level 2 areas`);
  existing = await existingByGeonamesId(db, countryCode);
  const districtByCode = new Map();
  const newDistricts = [];
  const changedDistricts = [];
  for await (const [code, name, , geonamesId] of tsvRecords(await download(fetchImpl, dumpUrl, 'admin2Codes.txt'))) {
    if (!code?.startsWith(`${countryCode}.`) || !name || name.length > maxNameLength || !geonamesId) continue;
    const [, admin1Code, admin2Code] = code.split('.');
    const region = regionByCode.get(admin1Code);
    if (!region || !admin2Code) continue;
    const target = plan(existing, { geonamesId, parentId: region.id, parentPath: region.path });
    districtByCode.set(`${admin1Code}.${admin2Code}`, { id: target.id, path: target.path });
    if (target.skip) continue;
    const row = { id: target.id, name, countryCode, parentId: region.id, path: target.path, geonamesId, population: null, admin1Code, admin2Code, featureCode: 'ADM2' };
    (target.known ? changedDistricts : newDistricts).push(row);
  }
  await insertRows(db, 'district', newDistricts);
  await updateRows(db, changedDistricts);
  counts.districts = newDistricts.length;
  counts.updated += changedDistricts.length;

  logger?.(`[${countryCode}] places`);
  existing = await existingByGeonamesId(db, countryCode);
  const wanted = new Set(featureCodes);
  const excluded = new Set(excludedFeatureCodes);
  const newPlaces = [];
  const changedPlaces = [];
  const countryDump = unzipEntry(await download(fetchImpl, dumpUrl, `${countryCode}.zip`), `${countryCode}.txt`);
  for await (const columns of tsvRecords(countryDump)) {
    const [geonamesId, name, , , , , featureClass, featureCode, rowCountry, , admin1Code, admin2Code, , , population] = columns;
    if (rowCountry !== countryCode || !name || name.length > maxNameLength || excluded.has(featureCode)) continue;
    const people = Number(population) || 0;
    const isTown = featureClass === 'P' && people >= minPopulation;
    if (!isTown && !wanted.has(featureCode)) continue;
    const parent = districtByCode.get(`${admin1Code}.${admin2Code}`) ?? regionByCode.get(admin1Code) ?? { id: countryId, path: countryPath };
    const target = plan(existing, { geonamesId, parentId: parent.id, parentPath: parent.path });
    if (target.skip) continue;
    const row = { id: target.id, name, countryCode, parentId: parent.id, path: target.path, geonamesId, population: people || null, admin1Code: admin1Code || null, admin2Code: admin2Code || null, featureCode };
    (target.known ? changedPlaces : newPlaces).push(row);
  }
  await insertRows(db, 'city', newPlaces);
  await updateRows(db, changedPlaces);
  counts.places = newPlaces.length;
  counts.updated += changedPlaces.length;
  await db.query(
    `UPDATE destinations SET match_path = destination_match_path(id)
     WHERE country_code = $1 AND (id IN (SELECT destination_id FROM destination_parents) OR match_path && ARRAY(SELECT destination_id FROM destination_parents))`,
    [countryCode],
  );

  logger?.(`[${countryCode}] aliases`);
  existing = await existingByGeonamesId(db, countryCode);
  const idByGeonamesId = new Map([...existing].map(([geonamesId, row]) => [geonamesId, row.admin_edited_at ? null : row.id]));
  const languages = new Set(aliasLanguages);
  const aliases = new Map();
  const alternateNames = unzipEntry(await download(fetchImpl, dumpUrl, `alternatenames/${countryCode}.zip`), `${countryCode}.txt`);
  for await (const [, geonamesId, language = '', alternateName] of tsvRecords(alternateNames)) {
    const id = idByGeonamesId.get(geonamesId);
    if (!id || !languages.has(language) || !alternateName || alternateName.length > maxNameLength) continue;
    const list = aliases.get(id) ?? new Set();
    if (list.size < maxAliases) list.add(normalizeSearchText(alternateName));
    aliases.set(id, list);
  }
  const aliasRows = [...aliases].map(([id, list]) => ({ id, aliases: [...list] }));
  for (let start = 0; start < aliasRows.length; start += batchSize) {
    const batch = aliasRows.slice(start, start + batchSize);
    await db.query(
      `UPDATE destinations d SET aliases = ARRAY(SELECT alias FROM unnest(string_to_array(row.aliases, chr(31))) alias WHERE alias <> d.search_name), updated_at = NOW()
       FROM unnest($1::uuid[], $2::text[]) AS row(id, aliases) WHERE d.id = row.id AND d.admin_edited_at IS NULL`,
      [batch.map((row) => row.id), batch.map((row) => row.aliases.join('\u001f'))],
    );
  }
  counts.aliased = aliasRows.length;
  return counts;
}
