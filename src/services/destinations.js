import { randomUUID } from 'node:crypto';
import { countryName, isCountryCode } from '../config/index.js';

export function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function destinationDto(row) {
  const countryLabel = countryName(row.country_code);
  const context = row.kind === 'country' ? null : [row.parent_kind === 'region' ? row.parent_name : null, countryLabel].filter(Boolean).join(', ');
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    countryCode: row.country_code,
    countryName: countryLabel,
    parentId: row.parent_id ?? null,
    parentName: row.parent_name ?? null,
    label: context ? `${row.name}, ${context}` : row.name,
    aliases: row.aliases ?? [],
    active: row.active,
  };
}

const selectDestination = `SELECT d.id, d.kind, d.name, d.country_code, d.parent_id, d.aliases, d.active, d.population, d.path,
  parent.name AS parent_name, parent.kind AS parent_kind
  FROM destinations d LEFT JOIN destinations parent ON parent.id = d.parent_id`;

export async function ensureCountryDestination(db, countryCode, { createdBy = null, id = randomUUID() } = {}) {
  if (!isCountryCode(countryCode)) throw Object.assign(new Error('Unknown country code.'), { code: 'INVALID_COUNTRY' });
  const existing = await db.query("SELECT id FROM destinations WHERE kind = 'country' AND country_code = $1", [countryCode]);
  if (existing.rowCount) return existing.rows[0].id;
  const name = countryName(countryCode);
  const inserted = await db.query(
    `INSERT INTO destinations (id, kind, name, search_name, country_code, path, created_by)
     VALUES ($1, 'country', $2, $3, $4, ARRAY[$1]::uuid[], $5)
     ON CONFLICT (country_code) WHERE kind = 'country' DO NOTHING RETURNING id`,
    [id, name, normalizeSearchText(name), countryCode, createdBy],
  );
  if (inserted.rowCount) return id;
  const raced = await db.query("SELECT id FROM destinations WHERE kind = 'country' AND country_code = $1", [countryCode]);
  return raced.rows[0].id;
}

export async function createDestination(db, { id = randomUUID(), kind, name, countryCode, parentId = null, aliases = [], geonamesId = null, population = null, createdBy = null }) {
  if (kind === 'country') {
    const countryId = await ensureCountryDestination(db, countryCode, { createdBy, id });
    return findDestination(db, countryId);
  }
  const parent = parentId
    ? (await db.query('SELECT id, kind, country_code, path FROM destinations WHERE id = $1', [parentId])).rows[0]
    : (await db.query('SELECT id, kind, country_code, path FROM destinations WHERE id = $1', [await ensureCountryDestination(db, countryCode, { createdBy })])).rows[0];
  if (!parent) throw Object.assign(new Error('Parent destination was not found.'), { code: 'INVALID_PARENT' });
  if (parent.country_code !== countryCode) throw Object.assign(new Error('Parent destination is in another country.'), { code: 'INVALID_PARENT' });
  if (parent.kind === 'city' || (kind === 'region' && parent.kind !== 'country')) throw Object.assign(new Error('Regions belong to a country and cities to a region or country.'), { code: 'INVALID_PARENT' });
  const duplicate = await db.query('SELECT id FROM destinations WHERE parent_id = $1 AND kind = $2 AND search_name = $3', [parent.id, kind, normalizeSearchText(name)]);
  if (duplicate.rowCount) throw Object.assign(new Error('This destination already exists under the same parent.'), { code: 'DUPLICATE_DESTINATION' });
  await db.query(
    `INSERT INTO destinations (id, kind, name, search_name, country_code, parent_id, path, aliases, geonames_id, population, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[] || $1::uuid, $8, $9, $10, $11)`,
    [id, kind, name, normalizeSearchText(name), countryCode, parent.id, parent.path, aliases.map(normalizeSearchText), geonamesId, population, createdBy],
  );
  return findDestination(db, id);
}

export async function findDestination(db, id) {
  const result = await db.query(`${selectDestination} WHERE d.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function searchDestinations(db, { query = '', countryCode = null, kinds = null, limit, includeInactive = false }) {
  const term = normalizeSearchText(query);
  const pattern = term ? `${escapeLike(term)}%` : null;
  const result = await db.query(
    `${selectDestination}
     WHERE ($1::text IS NULL OR d.search_name LIKE $1 OR EXISTS (SELECT 1 FROM unnest(d.aliases) alias WHERE alias LIKE $1))
       AND ($2::text IS NULL OR d.country_code = $2)
       AND ($3::text[] IS NULL OR d.kind = ANY($3::text[]))
       AND ($4::boolean OR d.active)
     ORDER BY (d.search_name = $5) DESC, array_position(ARRAY['country', 'region', 'city'], d.kind::text),
       d.population DESC NULLS LAST, d.name ASC
     LIMIT $6`,
    [pattern, countryCode, kinds?.length ? kinds : null, includeInactive, term, limit],
  );
  return result.rows;
}

// Returns the active destinations for the given ids, or an error message when any id is unknown/inactive/wrong kind.
export async function resolveActiveDestinations(db, ids, { kinds = null } = {}) {
  if (!ids.length) return { rows: [] };
  const result = await db.query(`${selectDestination} WHERE d.id = ANY($1::uuid[]) AND d.active`, [ids]);
  if (result.rowCount !== new Set(ids).size) return { error: 'Choose destinations from the destination list.' };
  if (kinds && result.rows.some((row) => !kinds.includes(row.kind))) return { error: `Choose a destination of type: ${kinds.join(', ')}.` };
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  return { rows: ids.map((id) => byId.get(id)) };
}

export async function loadCoverage(db, organizationId) {
  const result = await db.query(
    `${selectDestination} JOIN seller_coverage c ON c.destination_id = d.id WHERE c.organization_id = $1 ORDER BY d.name`,
    [organizationId],
  );
  return result.rows;
}

export async function replaceCoverage(client, organizationId, destinationIds) {
  await client.query('DELETE FROM seller_coverage WHERE organization_id = $1', [organizationId]);
  if (destinationIds.length) {
    await client.query(
      'INSERT INTO seller_coverage (organization_id, destination_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING',
      [organizationId, destinationIds],
    );
  }
  await refreshProfileDisplayNames(client, { organizationId });
}

// seller_profiles keeps display copies of coverage and city names for listings and search.
export async function refreshProfileDisplayNames(client, { organizationId = null, destinationId = null }) {
  await client.query(
    `UPDATE seller_profiles p SET
       coverage_destinations = ARRAY(SELECT d.name FROM seller_coverage c JOIN destinations d ON d.id = c.destination_id
         WHERE c.organization_id = p.organization_id ORDER BY d.name),
       property_city = COALESCE((SELECT d.name FROM destinations d WHERE d.id = p.property_destination_id), p.property_city)
     WHERE ($1::uuid IS NOT NULL AND p.organization_id = $1)
        OR ($2::uuid IS NOT NULL AND (p.property_destination_id = $2
          OR p.organization_id IN (SELECT organization_id FROM seller_coverage WHERE destination_id = $2)))`,
    [organizationId, destinationId],
  );
}

export async function sellerProfileResponse(db, organizationId) {
  const result = await db.query(
    'SELECT coverage_destinations, property_city, property_destination_id, verification_status, verification_reason FROM seller_profiles WHERE organization_id = $1',
    [organizationId],
  );
  if (!result.rowCount) return null;
  const profile = result.rows[0];
  const coverage = await loadCoverage(db, organizationId);
  const propertyDestination = profile.property_destination_id ? await findDestination(db, profile.property_destination_id) : null;
  return {
    coverageDestinations: profile.coverage_destinations,
    coverage: coverage.map(destinationDto),
    propertyCity: profile.property_city,
    propertyDestination: propertyDestination ? destinationDto(propertyDestination) : null,
    verificationStatus: profile.verification_status,
    verificationReason: profile.verification_reason,
  };
}

// SQL predicate: seller organization `seller` with profile `profile` matches request `r` by destination.
export const sellerMatchesRequestDestination = `(
  (seller.business_type = 'dmc' AND EXISTS (
    SELECT 1 FROM seller_coverage coverage JOIN destinations requested ON requested.id = r.destination_id
    WHERE coverage.organization_id = seller.id AND coverage.destination_id = ANY(requested.path)))
  OR (seller.business_type = 'hotelier' AND profile.property_destination_id = r.destination_id)
)`;
