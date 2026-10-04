import { config } from '../config/index.js';
import { anonymizeUser, closeOrganization, purgeUnverifiedUser } from '../services/accountLifecycle.js';
import { getSetting } from '../services/platformSettings.js';
import { processDocumentRetention } from './verificationDocuments.js';
import { processGuestDataRetention } from './bookingGuestData.js';
import { processWebhookDeliveryRetention } from './webhookDeliveries.js';

const batchSize = 100;

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Each account is handled in its own transaction so one failure does not block the rest.
async function processEach(pool, ids, work, failures) {
  let count = 0;
  for (const id of ids) {
    try {
      if (await inTransaction(pool, (client) => work(client, id))) count += 1;
    } catch {
      failures.push(id);
    }
  }
  return count;
}

export async function processAccountRetention(pool, { now = () => new Date() } = {}) {
  const current = now();
  const failures = [];
  const unverifiedDays = await getSetting(pool, 'unverified_account_retention_days');
  const unverifiedCutoff = new Date(current.getTime() - unverifiedDays * 24 * 60 * 60 * 1000);

  const dueUsers = await pool.query(
    `SELECT id FROM users WHERE deletion_scheduled_for <= $1 AND anonymized_at IS NULL
     ORDER BY deletion_scheduled_for LIMIT $2`,
    [current, batchSize],
  );
  const dueOrganizations = await pool.query(
    `SELECT id FROM organizations WHERE closure_scheduled_for <= $1 AND closed_at IS NULL
     ORDER BY closure_scheduled_for LIMIT $2`,
    [current, batchSize],
  );
  const unverified = await pool.query(
    `SELECT id FROM users WHERE email_verified_at IS NULL AND anonymized_at IS NULL AND created_at <= $1
     ORDER BY created_at LIMIT $2`,
    [unverifiedCutoff, batchSize],
  );

  const result = {
    anonymizedUsers: await processEach(pool, dueUsers.rows.map((row) => row.id), anonymizeUser, failures),
    closedOrganizations: await processEach(pool, dueOrganizations.rows.map((row) => row.id), closeOrganization, failures),
    purgedUnverifiedUsers: await processEach(pool, unverified.rows.map((row) => row.id), purgeUnverifiedUser, failures),
    failures: failures.length,
  };
  return result;
}

export function startAccountRetentionWorker(pool, { storage = null, intervalMs = config.retention.intervalMs, logger = console } = {}) {
  let active = false;
  let stopped = false;
  const run = async () => {
    if (active || stopped) return;
    active = true;
    try {
      const result = await processAccountRetention(pool);
      if (result.failures) logger.error(`Account retention left ${result.failures} record(s) for the next run.`);
      const documents = await processDocumentRetention(pool, { storage });
      if (documents.failures) logger.error(`Document retention left ${documents.failures} file(s) for the next run.`);
      const guestData = await processGuestDataRetention(pool, { storage });
      if (guestData.failures) logger.error(`Guest-data retention left ${guestData.failures} voucher file(s) for the next run.`);
      await processWebhookDeliveryRetention(pool);
    } catch {
      logger.error('Account retention processing failed.');
    } finally {
      active = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  void run();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
