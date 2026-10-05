import 'dotenv/config';
import { parseArgs } from 'node:util';
import { config } from '../src/config/index.js';
import { createDatabase } from '../src/db/connect.js';
import { recordOperationRun } from '../src/services/databaseBackup.js';
import { launchRouting } from '../src/services/routing.js';

// Applies destination + lead-type routing to leads that were already open. --dry-run reports without saving.
const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dryRun = values['dry-run'];
const { pool, close } = await createDatabase();
const startedAt = new Date();
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const report = await launchRouting(client, { minimumAlertHours: config.requestDeadline.minHours });
  if (dryRun) {
    await client.query('ROLLBACK');
    console.log('Dry run (nothing saved):');
  } else {
    await recordOperationRun(client, { kind: 'routing_launch', status: 'succeeded', startedAt, finishedAt: new Date(), details: report });
    await client.query('COMMIT');
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Routing launch failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await close();
}
