import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config/index.js';

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
};

export function settingSchema(key) {
  const definition = platformSettingDefinitions[key];
  return z.coerce.number().int().min(definition.min).max(definition.max);
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
      unit: definition.unit,
      min: definition.min,
      max: definition.max,
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
