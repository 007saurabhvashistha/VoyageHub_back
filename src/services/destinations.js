import { randomUUID } from 'node:crypto';
import { countryName, isCountryCode } from '../config/index.js';
import { destinationKinds, destinationParentKinds } from '../config/referenceData.js';

const genericKindLabels = new Map(destinationKinds.map((kind) => [kind.value, kind.label]));
const kindOrderSql = `array_position(ARRAY[${destinationKinds.map((kind) => `'${kind.value}'`).join(', ')}]::text[], d.kind::text)`;

export function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function destinationError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function destinationDto(row) {
  const countryLabel = countryName(row.country_code);
  const context = row.kind === 'country' ? [] : [...(row.ancestor_names ?? []), countryLabel].filter(Boolean);
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: row.kind_label ?? genericKindLabels.get(row.kind) ?? row.kind,
    name: row.name,
    countryCode: row.country_code,
    countryName: countryLabel,
    parentId: row.parent_id ?? null,
    parentName: row.parent_name ?? null,
    label: context.length ? `${row.name}, ${context.join(', ')}` : row.name,
    aliases: row.aliases ?? [],
    featured: Boolean(row.featured),
    active: row.active,
    ...(row.has_children != null ? { hasChildren: Boolean(row.has_children) } : {}),
    ...(row.mode ? { mode: row.mode } : {}),
  };
}

// Ancestor names run nearest-first so labels read "Place, District, Region, Country".
const selectDestination = `SELECT d.id, d.kind, d.name, d.country_code, d.parent_id, d.aliases, d.active, d.population, d.path,
  d.match_path, d.featured, d.lead_count,
  parent.name AS parent_name, parent.kind AS parent_kind, level.label AS kind_label,
  ARRAY(SELECT ancestor.name FROM unnest(d.path) WITH ORDINALITY AS step(id, position)
        JOIN destinations ancestor ON ancestor.id = step.id
        WHERE ancestor.id <> d.id AND ancestor.kind <> 'country' ORDER BY step.position DESC) AS ancestor_names
  FROM destinations d
  LEFT JOIN destinations parent ON parent.id = d.parent_id
  LEFT JOIN country_destination_levels level ON level.country_code = d.country_code AND level.kind = d.kind`;

export async function ensureCountryDestination(db, countryCode, { createdBy = null, id = randomUUID() } = {}) {
  if (!isCountryCode(countryCode)) throw destinationError('Unknown country code.', 'INVALID_COUNTRY');
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

function assertParentKind(kind, parentKind) {
  if (!destinationParentKinds[kind]?.includes(parentKind)) {
    throw destinationError(`A ${genericKindLabels.get(kind)?.toLowerCase() ?? kind} cannot be placed under a ${genericKindLabels.get(parentKind)?.toLowerCase() ?? parentKind}.`, 'INVALID_PARENT');
  }
}

export async function createDestination(db, { id = randomUUID(), kind, name, countryCode, parentId = null, aliases = [], geonamesId = null, population = null, createdBy = null, featured = false }) {
  if (kind === 'country') {
    const countryId = await ensureCountryDestination(db, countryCode, { createdBy, id });
    return findDestination(db, countryId);
  }
  const parentLookupId = parentId ?? await ensureCountryDestination(db, countryCode, { createdBy });
  const parent = (await db.query('SELECT id, kind, country_code, path FROM destinations WHERE id = $1', [parentLookupId])).rows[0];
  if (!parent) throw destinationError('Parent destination was not found.', 'INVALID_PARENT');
  if (parent.country_code !== countryCode) throw destinationError('Parent destination is in another country.', 'INVALID_PARENT');
  assertParentKind(kind, parent.kind);
  const duplicate = await db.query('SELECT id FROM destinations WHERE parent_id = $1 AND kind = $2 AND search_name = $3', [parent.id, kind, normalizeSearchText(name)]);
  if (duplicate.rowCount) throw destinationError('This destination already exists under the same parent.', 'DUPLICATE_DESTINATION');
  await db.query(
    `INSERT INTO destinations (id, kind, name, search_name, country_code, parent_id, path, aliases, geonames_id, population, created_by, featured, admin_edited_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[] || $1::uuid, $8, $9, $10, $11, $12, CASE WHEN $11::uuid IS NULL THEN NULL ELSE NOW() END)`,
    [id, kind, name, normalizeSearchText(name), countryCode, parent.id, parent.path, aliases.map(normalizeSearchText), geonamesId, population, createdBy, featured],
  );
  return findDestination(db, id);
}

export async function findDestination(db, id) {
  const result = await db.query(`${selectDestination} WHERE d.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function searchDestinations(db, { query = '', countryCode = null, countryCodes = null, kinds = null, limit, includeInactive = false, featuredOnly = false }) {
  const term = normalizeSearchText(query);
  const pattern = term ? `${escapeLike(term)}%` : null;
  const result = await db.query(
    `${selectDestination}
     WHERE ($1::text IS NULL OR d.search_name LIKE $1 OR EXISTS (SELECT 1 FROM unnest(d.aliases) alias WHERE alias LIKE $1))
       AND ($2::text IS NULL OR d.country_code = $2)
       AND ($3::text[] IS NULL OR d.kind = ANY($3::text[]))
       AND ($4::boolean OR d.active)
       AND ($7::text[] IS NULL OR d.country_code = ANY($7::text[]))
       AND (NOT $8::boolean OR d.featured)
     ORDER BY (d.search_name = $5 OR $5 = ANY(d.aliases)) DESC, d.featured DESC, d.lead_count DESC, ${kindOrderSql},
       d.population DESC NULLS LAST, d.name ASC
     LIMIT $6`,
    [pattern, countryCode, kinds?.length ? kinds : null, includeInactive, term, limit, countryCodes?.length ? countryCodes : null, featuredOnly],
  );
  return result.rows;
}

// Direct children for tree pickers; hasChildren lets the client lazy-load the next level.
export async function listChildren(db, parentId, { limit, includeInactive = false }) {
  const result = await db.query(
    `SELECT * FROM (${selectDestination} WHERE d.parent_id = $1 AND ($2::boolean OR d.active)) d
     ORDER BY d.featured DESC, ${kindOrderSql}, d.name ASC LIMIT $3`,
    [parentId, includeInactive, limit],
  );
  const ids = result.rows.map((row) => row.id);
  const parents = ids.length
    ? await db.query('SELECT DISTINCT parent_id FROM destinations WHERE parent_id = ANY($1::uuid[]) AND active', [ids])
    : { rows: [] };
  const withChildren = new Set(parents.rows.map((row) => row.parent_id));
  return result.rows.map((row) => ({ ...row, has_children: withChildren.has(row.id) }));
}

export async function listCountryRoots(db, countryCodes) {
  if (!countryCodes.length) return [];
  for (const code of countryCodes) await ensureCountryDestination(db, code);
  const result = await db.query(
    `${selectDestination} WHERE d.kind = 'country' AND d.country_code = ANY($1::text[]) AND d.active ORDER BY d.name`,
    [countryCodes],
  );
  const children = await db.query('SELECT DISTINCT parent_id FROM destinations WHERE parent_id = ANY($1::uuid[]) AND active', [result.rows.map((row) => row.id)]);
  const withChildren = new Set(children.rows.map((row) => row.parent_id));
  return result.rows.map((row) => ({ ...row, has_children: withChildren.has(row.id) }));
}

// Returns the active destinations for the given ids, or an error message when any id is unknown/inactive/wrong kind.
export async function resolveActiveDestinations(db, ids, { kinds = null } = {}) {
  if (!ids.length) return { rows: [] };
  const result = await db.query(`${selectDestination} WHERE d.id = ANY($1::uuid[]) AND d.active`, [ids]);
  if (result.rowCount !== new Set(ids).size) return { error: 'Choose destinations from the destination list.' };
  if (kinds && result.rows.some((row) => !kinds.includes(row.kind))) {
    return { error: `Choose a destination of type: ${kinds.map((kind) => genericKindLabels.get(kind)?.toLowerCase() ?? kind).join(', ')}.` };
  }
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  return { rows: ids.map((id) => byId.get(id)) };
}

export async function loadCoverage(db, organizationId) {
  const result = await db.query(
    `SELECT * FROM (${selectDestination}) d JOIN seller_coverage c ON c.destination_id = d.id WHERE c.organization_id = $1 ORDER BY c.mode, d.name`,
    [organizationId],
  );
  return result.rows;
}

// Accepts destination ids (all "include") or { destinationId, mode } rules.
export function normalizeCoverageRules(rules) {
  const byId = new Map();
  for (const rule of rules) {
    const normalized = typeof rule === 'string' ? { destinationId: rule, mode: 'include' } : { destinationId: rule.destinationId, mode: rule.mode ?? 'include' };
    byId.set(normalized.destinationId, normalized);
  }
  return [...byId.values()];
}

export async function replaceCoverage(client, organizationId, rules) {
  const normalized = normalizeCoverageRules(rules);
  await client.query('DELETE FROM seller_coverage WHERE organization_id = $1', [organizationId]);
  if (normalized.length) {
    await client.query(
      `INSERT INTO seller_coverage (organization_id, destination_id, mode)
       SELECT $1, rule.destination_id, rule.mode FROM unnest($2::uuid[], $3::text[]) AS rule(destination_id, mode)
       ON CONFLICT DO NOTHING`,
      [organizationId, normalized.map((rule) => rule.destinationId), normalized.map((rule) => rule.mode)],
    );
  }
  await refreshProfileDisplayNames(client, { organizationId });
}

// seller_profiles keeps display copies of covered places and the first hotel city for listings and search.
export async function refreshProfileDisplayNames(client, { organizationId = null, destinationId = null }) {
  await client.query(
    `UPDATE seller_profiles p SET
       coverage_destinations = ARRAY(SELECT d.name FROM seller_coverage c JOIN destinations d ON d.id = c.destination_id
         WHERE c.organization_id = p.organization_id AND c.mode = 'include' ORDER BY d.name),
       property_city = COALESCE((SELECT d.name FROM destinations d WHERE d.id = p.property_destination_id), p.property_city)
     WHERE ($1::uuid IS NOT NULL AND p.organization_id = $1)
        OR ($2::uuid IS NOT NULL AND (p.property_destination_id = $2
          OR p.organization_id IN (SELECT organization_id FROM seller_coverage WHERE destination_id = $2)))`,
    [organizationId, destinationId],
  );
}

export async function sellerProfileResponse(db, organizationId) {
  const result = await db.query(
    `SELECT coverage_destinations, property_city, property_destination_id, verification_status, verification_reason,
            handled_group_types, minimum_group_size, budget_min_minor, budget_max_minor, budget_currency, languages, accepting_requests
     FROM seller_profiles WHERE organization_id = $1`,
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
    handledGroupTypes: profile.handled_group_types ?? [],
    minimumGroupSize: profile.minimum_group_size ?? null,
    budgetMinMinor: profile.budget_min_minor == null ? null : Number(profile.budget_min_minor),
    budgetMaxMinor: profile.budget_max_minor == null ? null : Number(profile.budget_max_minor),
    budgetCurrency: profile.budget_currency ?? null,
    languages: profile.languages ?? [],
    acceptingRequests: profile.accepting_requests !== false,
  };
}

// Recomputes match_path for a destination and everything below it (primary or secondary descendants).
export async function rebuildMatchPaths(db, rootId) {
  await db.query(
    `UPDATE destinations SET match_path = destination_match_path(id), updated_at = NOW()
     WHERE match_path @> ARRAY[$1]::uuid[] OR path @> ARRAY[$1]::uuid[]`,
    [rootId],
  );
}

export async function moveDestination(db, id, newParentId) {
  const node = (await db.query('SELECT id, kind, country_code, path FROM destinations WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!node) throw destinationError('Destination was not found.', 'DESTINATION_NOT_FOUND');
  const parent = (await db.query('SELECT id, kind, country_code, path FROM destinations WHERE id = $1', [newParentId])).rows[0];
  if (!parent) throw destinationError('Parent destination was not found.', 'INVALID_PARENT');
  if (parent.country_code !== node.country_code) throw destinationError('Parent destination is in another country.', 'INVALID_PARENT');
  if (parent.path.includes(id)) throw destinationError('A destination cannot be moved under itself.', 'INVALID_PARENT');
  assertParentKind(node.kind, parent.kind);
  await db.query(
    `UPDATE destinations SET path = $2::uuid[] || path[array_position(path, $1::uuid):], updated_at = NOW()
     WHERE path @> ARRAY[$1]::uuid[]`,
    [id, parent.path],
  );
  await db.query('UPDATE destinations SET parent_id = $2, admin_edited_at = NOW() WHERE id = $1', [id, parent.id]);
  await rebuildMatchPaths(db, id);
}

export async function replaceSecondaryParents(db, id, parentIds, { createdBy = null } = {}) {
  const node = (await db.query('SELECT id, kind, country_code, parent_id FROM destinations WHERE id = $1', [id])).rows[0];
  if (!node) throw destinationError('Destination was not found.', 'DESTINATION_NOT_FOUND');
  const unique = [...new Set(parentIds)].filter((parentId) => parentId !== node.parent_id);
  if (unique.length) {
    const parents = await db.query('SELECT id, kind, country_code, match_path FROM destinations WHERE id = ANY($1::uuid[])', [unique]);
    if (parents.rowCount !== unique.length) throw destinationError('Choose extra parents from the destination list.', 'INVALID_PARENT');
    for (const parent of parents.rows) {
      if (parent.country_code !== node.country_code) throw destinationError('Extra parents must be in the same country.', 'INVALID_PARENT');
      if (parent.match_path.includes(id)) throw destinationError('A destination cannot be its own ancestor.', 'INVALID_PARENT');
      assertParentKind(node.kind, parent.kind);
    }
  }
  await db.query('DELETE FROM destination_parents WHERE destination_id = $1', [id]);
  if (unique.length) {
    await db.query(
      'INSERT INTO destination_parents (destination_id, parent_id, created_by) SELECT $1, unnest($2::uuid[]), $3',
      [id, unique, createdBy],
    );
  }
  await db.query('UPDATE destinations SET admin_edited_at = NOW() WHERE id = $1', [id]);
  await rebuildMatchPaths(db, id);
}

export async function loadSecondaryParents(db, id) {
  const result = await db.query(
    `SELECT * FROM (${selectDestination}) d JOIN destination_parents link ON link.parent_id = d.id WHERE link.destination_id = $1 ORDER BY d.name`,
    [id],
  );
  return result.rows;
}

export async function loadLevelLabels(db, countryCodes) {
  if (!countryCodes.length) return [];
  const result = await db.query('SELECT country_code, kind, label, enabled FROM country_destination_levels WHERE country_code = ANY($1::text[])', [countryCodes]);
  return countryCodes.map((code) => ({
    countryCode: code,
    countryName: countryName(code),
    levels: destinationKinds.map((kind) => {
      const row = result.rows.find((item) => item.country_code === code && item.kind === kind.value);
      return { kind: kind.value, label: row?.label ?? kind.label, enabled: row?.enabled ?? true, custom: Boolean(row) };
    }),
  }));
}
