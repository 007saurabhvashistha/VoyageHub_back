import { getSetting } from '../services/platformSettings.js';

const batchSize = 100;

// Decision 2: guest details, and the vouchers that carry guest names, are deleted a set number of days after the trip ends.
export async function processGuestDataRetention(pool, { storage = null, now = () => new Date() } = {}) {
  const summary = { purgedGuestDetails: 0, deletedVouchers: 0, failures: 0 };
  const current = now();
  const retentionDays = await getSetting(pool, 'guest_data_retention_days');
  const purged = await pool.query(
    `WITH due AS (
       UPDATE booking_guest_details SET ciphertext = NULL, purged_at = $3, updated_at = $3
       WHERE award_id IN (
         SELECT award_id FROM booking_guest_details
         WHERE purged_at IS NULL AND trip_end_date + $1::int <= $2::date
         ORDER BY trip_end_date LIMIT $4
       )
       RETURNING award_id
     )
     INSERT INTO booking_guest_access_log (id, award_id, action)
     SELECT gen_random_uuid(), award_id, 'purged' FROM due RETURNING award_id`,
    [retentionDays, current.toISOString().slice(0, 10), current, batchSize],
  );
  summary.purgedGuestDetails = purged.rowCount;
  if (!storage) return summary;

  const vouchers = await pool.query(
    `SELECT v.id, v.storage_key, v.storage_provider FROM booking_vouchers v
     JOIN booking_guest_details g ON g.award_id = v.award_id
     WHERE v.deleted_at IS NULL AND g.purged_at IS NOT NULL
     ORDER BY v.created_at LIMIT $1`,
    [batchSize],
  );
  for (const voucher of vouchers.rows) {
    try {
      if (voucher.storage_provider !== storage.provider) throw new Error('Voucher is held by a storage provider that is not configured.');
      await storage.deleteObject(voucher.storage_key);
      await pool.query('UPDATE booking_vouchers SET deleted_at = $2 WHERE id = $1 AND deleted_at IS NULL', [voucher.id, current]);
      summary.deletedVouchers += 1;
    } catch {
      summary.failures += 1;
    }
  }
  return summary;
}
