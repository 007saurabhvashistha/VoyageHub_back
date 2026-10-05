import { parse } from 'csv-parse/sync';
import { normalizeSearchText } from './destinations.js';
import { isCountryCode } from '../config/index.js';

const columnAliases = {
  country_code: ['country_code', 'country'],
  name: ['name', 'destination', 'place'],
  region: ['region', 'level1', 'state'],
  district: ['district', 'level2'],
  aliases: ['aliases', 'alias'],
};

function pick(record, key) {
  for (const column of columnAliases[key]) {
    if (record[column] != null && String(record[column]).trim()) return String(record[column]).trim();
  }
  return null;
}

// Marks rows of an admin-supplied CSV as featured when each resolves to exactly one destination; never guesses.
export async function importFeaturedDestinations(db, { csvText, defaultCountryCode = null, maxRows, maxAliases }) {
  let records;
  try {
    records = parse(csvText, { columns: (header) => header.map((column) => normalizeSearchText(column).replace(/\s+/g, '_')), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  } catch (error) {
    return { error: `The file is not valid CSV: ${error.message}` };
  }
  if (!records.length) return { error: 'The file has no rows.' };
  if (records.length > maxRows) return { error: `Upload at most ${maxRows} rows at a time.` };
  const report = [];
  for (const [index, record] of records.entries()) {
    const line = index + 2;
    const name = pick(record, 'name');
    const countryCode = (pick(record, 'country_code') ?? defaultCountryCode ?? '').toUpperCase();
    if (!name || !isCountryCode(countryCode)) {
      report.push({ line, name, status: 'invalid', message: 'Each row needs a name and a valid country code.' });
      continue;
    }
    const region = pick(record, 'region');
    const district = pick(record, 'district');
    const matches = await db.query(
      `SELECT d.id, d.name, d.kind FROM destinations d
       WHERE d.active AND d.country_code = $1 AND d.kind <> 'country'
         AND (d.search_name = $2 OR $2 = ANY(d.aliases))
         AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM destinations a WHERE a.id = ANY(d.match_path) AND a.kind = 'region' AND (a.search_name = $3 OR $3 = ANY(a.aliases))))
         AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM destinations a WHERE a.id = ANY(d.match_path) AND a.kind = 'district' AND (a.search_name = $4 OR $4 = ANY(a.aliases))))
       ORDER BY d.population DESC NULLS LAST LIMIT 5`,
      [countryCode, normalizeSearchText(name), region ? normalizeSearchText(region) : null, district ? normalizeSearchText(district) : null],
    );
    if (matches.rowCount !== 1) {
      report.push({
        line, name, region, district,
        status: matches.rowCount ? 'ambiguous' : 'not_found',
        message: matches.rowCount ? 'More than one destination matches. Add the region or district, or fix it by hand.' : 'No destination matches. Create it or add an alias, then upload again.',
        candidates: matches.rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind })),
      });
      continue;
    }
    const aliases = (pick(record, 'aliases') ?? '').split('|').map(normalizeSearchText).filter((alias) => alias.length >= 2);
    await db.query(
      `UPDATE destinations SET featured = TRUE, updated_at = NOW(),
         aliases = (SELECT COALESCE(array_agg(DISTINCT alias), ARRAY[]::text[]) FROM (SELECT unnest(aliases || $2::text[]) AS alias LIMIT $3) merged)
       WHERE id = $1`,
      [matches.rows[0].id, aliases, maxAliases],
    );
    report.push({ line, name, region, district, status: 'featured', destinationId: matches.rows[0].id, kind: matches.rows[0].kind });
  }
  return {
    report,
    totals: {
      rows: report.length,
      featured: report.filter((row) => row.status === 'featured').length,
      unresolved: report.filter((row) => row.status !== 'featured').length,
    },
  };
}
