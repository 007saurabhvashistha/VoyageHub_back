import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config, isCountryCode } from '../config/index.js';
import { destinationKinds } from '../config/referenceData.js';

const nonCountryKinds = destinationKinds.filter((kind) => kind.value !== 'country');

// Admin-changeable settings; the config value is the default until an admin overrides it.
export const platformSettingDefinitions = {
  max_offers_per_request: {
    label: 'Active offers per request',
    description: 'Maximum active offers a request accepts. Withdrawn offers free a slot.',
    unit: 'offers',
    min: 1,
    max: 50,
    defaultValue: () => 10,
  },
  account_deletion_grace_days: {
    label: 'Account deletion grace period',
    description: 'Days a closed account can still be restored before personal data is anonymized.',
    unit: 'days',
    min: 1,
    max: 90,
    defaultValue: () => config.retention.accountDeletionGraceDays,
  },
  unverified_account_retention_days: {
    label: 'Unverified account retention',
    description: 'Days an account may stay without email verification before it is deleted.',
    unit: 'days',
    min: 1,
    max: 365,
    defaultValue: () => config.retention.unverifiedAccountDays,
  },
  rejected_document_retention_days: {
    label: 'Rejected application document retention',
    description: 'Days verification documents are kept after a seller application is rejected, unless the seller uploads again.',
    unit: 'days',
    min: 1,
    max: 3650,
    defaultValue: () => config.documents.retention.rejectedDays,
  },
  closed_organization_document_retention_days: {
    label: 'Closed organization document retention',
    description: 'Days verification documents are kept after an organization is closed.',
    unit: 'days',
    min: 1,
    max: 3650,
    defaultValue: () => config.documents.retention.closedOrganizationDays,
  },
  guest_data_seller_access_days: {
    label: 'Seller access to guest details',
    description: 'Days after the trip ends that the winning seller can still open guest details.',
    unit: 'days',
    min: 1,
    max: 365,
    defaultValue: () => config.bookings.guestData.sellerAccessDays,
  },
  guest_data_retention_days: {
    label: 'Guest details retention',
    description: 'Days after the trip ends before guest details and booking vouchers are deleted.',
    unit: 'days',
    min: 1,
    max: 3650,
    defaultValue: () => config.bookings.guestData.retentionDays,
  },
  destination_countries: {
    label: 'Destination countries',
    description: 'ISO country codes whose destinations are imported and offered in pickers.',
    type: 'list',
    item: 'country',
    maxItems: 60,
    defaultValue: () => config.routing.destinationCountries,
  },
  destination_place_feature_codes: {
    label: 'Imported tourist feature codes',
    description: 'GeoNames feature codes imported as places besides towns (parks, lakes, passes...).',
    type: 'list',
    item: 'code',
    maxItems: 100,
    defaultValue: () => config.geonames.placeFeatureCodes,
  },
  destination_alias_languages: {
    label: 'Alias languages',
    description: 'GeoNames alternate-name language codes kept as searchable aliases.',
    type: 'list',
    item: 'language',
    maxItems: 20,
    defaultValue: () => config.geonames.aliasLanguages,
  },
  destination_min_place_population: {
    label: 'Minimum town population',
    description: 'Towns below this population are not imported (tourist features are always imported).',
    unit: 'people',
    min: 0,
    max: 10000000,
    defaultValue: () => config.geonames.minPlacePopulation,
  },
  hotel_lead_allowed_destination_kinds: {
    label: 'Hotel-only lead levels',
    description: 'Destination levels an agency may choose for a hotel-only lead.',
    type: 'list',
    item: 'kind',
    options: nonCountryKinds.map((kind) => kind.value),
    maxItems: nonCountryKinds.length,
    defaultValue: () => config.routing.hotelLeadAllowedDestinationKinds,
  },
  max_request_destinations: {
    label: 'Stops per itinerary lead',
    description: 'Maximum destinations (stops) on one itinerary lead.',
    unit: 'stops',
    min: 1,
    max: 30,
    defaultValue: () => config.routing.maxRequestDestinations,
  },
  max_offers_per_hotel_org_per_request: {
    label: 'Hotel offers per account per lead',
    description: 'A hotel account may send one offer per matching property, up to this number per lead.',
    unit: 'offers',
    min: 1,
    max: 20,
    defaultValue: () => config.routing.maxOffersPerHotelOrgPerRequest,
  },
  max_instant_alerts_per_request: {
    label: 'Instant alerts per lead',
    description: 'Sellers beyond this number get the lead in their daily digest instead of an instant alert.',
    unit: 'alerts',
    min: 1,
    max: 100000,
    defaultValue: () => config.routing.maxInstantAlertsPerRequest,
  },
  digest_send_hour_utc: {
    label: 'Daily digest hour (UTC)',
    description: 'Hour of the day, in UTC, when daily lead digests are sent.',
    unit: 'hour',
    min: 0,
    max: 23,
    defaultValue: () => config.routing.digestSendHourUtc,
  },
  max_hotel_properties_per_organization: {
    label: 'Hotels per hotel account',
    description: 'Maximum properties one hotel account can list.',
    unit: 'hotels',
    min: 1,
    max: 5000,
    defaultValue: () => config.routing.maxHotelPropertiesPerOrganization,
  },
};

const listItemSchemas = {
  country: z.string().trim().toUpperCase().refine(isCountryCode, 'Use ISO country codes.'),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, 'Use GeoNames feature codes.'),
  language: z.string().trim().toLowerCase().regex(/^[a-z]{0,8}$/, 'Use language codes.'),
};

export function settingSchema(key) {
  const definition = platformSettingDefinitions[key];
  if (definition.type === 'list') {
    const item = definition.item === 'kind' ? z.enum(definition.options) : listItemSchemas[definition.item];
    return z.array(item).max(definition.maxItems).transform((values) => [...new Set(values)]);
  }
  return z.coerce.number().int().min(definition.min).max(definition.max);
}

export function settingErrorMessage(key) {
  const definition = platformSettingDefinitions[key];
  if (definition.type === 'list') return `${definition.label} must be a list of up to ${definition.maxItems} valid values${definition.options ? ` (${definition.options.join(', ')})` : ''}.`;
  return `${definition.label} must be a whole number from ${definition.min} to ${definition.max}.`;
}

export async function getSetting(db, key) {
  const result = await db.query('SELECT setting_value FROM platform_settings WHERE setting_key = $1', [key]);
  const parsed = settingSchema(key).safeParse(result.rows[0]?.setting_value);
  return parsed.success ? parsed.data : platformSettingDefinitions[key].defaultValue();
}

export async function getMaxOffersPerRequest(db) {
  return getSetting(db, 'max_offers_per_request');
}

export async function listSettings(db) {
  const stored = await db.query('SELECT setting_key, setting_value, updated_at FROM platform_settings');
  const byKey = new Map(stored.rows.map((row) => [row.setting_key, row]));
  return Object.entries(platformSettingDefinitions).map(([key, definition]) => {
    const row = byKey.get(key);
    const parsed = settingSchema(key).safeParse(row?.setting_value);
    return {
      key,
      label: definition.label,
      description: definition.description,
      type: definition.type ?? 'number',
      options: definition.options ?? null,
      unit: definition.unit ?? null,
      min: definition.min ?? null,
      max: definition.max ?? null,
      defaultValue: definition.defaultValue(),
      value: parsed.success ? parsed.data : definition.defaultValue(),
      updatedAt: parsed.success ? row.updated_at : null,
    };
  });
}

export async function updateSetting(client, key, value, userId) {
  const previous = await client.query('SELECT setting_value FROM platform_settings WHERE setting_key = $1 FOR UPDATE', [key]);
  await client.query(
    `INSERT INTO platform_settings (setting_key, setting_value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, JSON.stringify(value), userId],
  );
  await client.query(
    `INSERT INTO platform_setting_changes (id, setting_key, old_value, new_value, changed_by)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
    [randomUUID(), key, previous.rowCount ? JSON.stringify(previous.rows[0].setting_value) : null, JSON.stringify(value), userId],
  );
}
