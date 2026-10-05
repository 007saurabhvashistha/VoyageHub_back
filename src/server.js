import 'dotenv/config';
import { createDatabase } from './db/connect.js';
import { createApp } from './app.js';
import { startNotificationOutboxWorker } from './jobs/notificationOutbox.js';
import { startRequestDeadlineWorker } from './jobs/requestDeadlines.js';
import { startReminderWorker } from './jobs/reminders.js';
import { startAccountRetentionWorker } from './jobs/accountRetention.js';
import { startDocumentScanWorker } from './jobs/verificationDocuments.js';
import { startWebhookDeliveryWorker } from './jobs/webhookDeliveries.js';
import { startAlertDigestWorker } from './jobs/alertDigests.js';
import { config } from './config/index.js';
import { createResendEmailDelivery } from './services/resendEmailDelivery.js';
import { createSmtpEmailDelivery } from './services/smtpEmailDelivery.js';
import { createStorage } from './services/storage/index.js';
import { createMalwareScanner } from './services/malwareScanner.js';
import { resolveEmailTokenEncryptionKey } from './utils/emailActionTokens.js';

const port = Number(process.env.PORT ?? 4000);
const database = await createDatabase();
const { pool } = database;
const tokenEncryptionKey = resolveEmailTokenEncryptionKey();
const mfaEncryptionKey = resolveEmailTokenEncryptionKey(process.env.MFA_ENCRYPTION_KEY || null);
const guestDataEncryptionKey = resolveEmailTokenEncryptionKey(process.env.GUEST_DATA_ENCRYPTION_KEY || null);
const webhookEncryptionKey = resolveEmailTokenEncryptionKey(process.env.WEBHOOK_SECRET_ENCRYPTION_KEY || null);
const emailDelivery = process.env.EMAIL_PROVIDER === 'smtp'
  ? createSmtpEmailDelivery({ pool, tokenEncryptionKey })
  : createResendEmailDelivery({ pool, tokenEncryptionKey });
const storage = createStorage();
const malwareScanner = createMalwareScanner();
const app = createApp({ pool, emailDelivery, tokenEncryptionKey, mfaEncryptionKey, storage, guestDataEncryptionKey, webhookEncryptionKey });
const stopOutboxWorker = startNotificationOutboxWorker(pool, { deliver: emailDelivery });
const stopDeadlineWorker = startRequestDeadlineWorker(pool);
const stopReminderWorker = startReminderWorker(pool);
const stopRetentionWorker = startAccountRetentionWorker(pool, { storage });
const stopDocumentScanWorker = startDocumentScanWorker(pool, { storage, scanner: malwareScanner });
const stopWebhookWorker = startWebhookDeliveryWorker(pool, { encryptionKey: webhookEncryptionKey });
const stopDigestWorker = startAlertDigestWorker(pool, { intervalMs: config.routing.digestIntervalMs });

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`VoyageHub API listening on port ${port}`);
  console.log(`Database mode: ${database.mode}`);
  console.log(`External email delivery: ${emailDelivery ? 'configured' : 'blocked until provider settings are configured.'}`);
  console.log(`Document storage: ${storage ? storage.provider : 'not configured; uploads are disabled.'}`);
  console.log(`Malware scanning: ${malwareScanner ? malwareScanner.provider : 'not configured; uploaded documents stay unreadable until a scanner is configured.'}`);
  console.log(`Guest-data encryption: ${guestDataEncryptionKey ? 'configured' : 'not configured; booking confirmation and guest details are disabled.'}`);
  console.log(`Webhook signing: ${webhookEncryptionKey ? 'configured' : 'not configured; webhook endpoints cannot be created and queued events wait unsent.'}`);
});

async function shutdown() {
  stopOutboxWorker();
  stopDeadlineWorker();
  stopReminderWorker();
  stopRetentionWorker();
  stopDocumentScanWorker();
  stopWebhookWorker();
  stopDigestWorker();
  server.close(async () => {
    await database.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);