import 'dotenv/config';
import { createDatabase } from './db/connect.js';
import { createApp } from './app.js';
import { startNotificationOutboxWorker } from './jobs/notificationOutbox.js';
import { startRequestDeadlineWorker } from './jobs/requestDeadlines.js';
import { createResendEmailDelivery } from './services/resendEmailDelivery.js';
import { resolveEmailTokenEncryptionKey } from './utils/emailActionTokens.js';

const port = Number(process.env.PORT ?? 4000);
const database = await createDatabase();
const { pool } = database;
const tokenEncryptionKey = resolveEmailTokenEncryptionKey();
const mfaEncryptionKey = resolveEmailTokenEncryptionKey(process.env.MFA_ENCRYPTION_KEY || null);
const emailDelivery = createResendEmailDelivery({ pool, tokenEncryptionKey });
const app = createApp({ pool, emailDelivery, tokenEncryptionKey, mfaEncryptionKey });
const stopOutboxWorker = startNotificationOutboxWorker(pool, { deliver: emailDelivery });
const stopDeadlineWorker = startRequestDeadlineWorker(pool);

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`VoyageHub API listening on port ${port}`);
  console.log(`Database mode: ${database.mode}`);
  console.log(`External email delivery: ${emailDelivery ? 'Resend configured' : 'blocked until provider settings are configured.'}`);
});

async function shutdown() {
  stopOutboxWorker();
  stopDeadlineWorker();
  server.close(async () => {
    await database.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);