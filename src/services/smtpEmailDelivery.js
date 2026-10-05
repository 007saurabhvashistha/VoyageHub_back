import { createTransport } from 'nodemailer';
import { buildEmailActionMessage } from './emailActionMessage.js';

function providerError(code, retryable) {
  return Object.assign(new Error('SMTP delivery failed.'), { code, retryable });
}

export function createSmtpEmailDelivery({
  pool,
  provider = process.env.EMAIL_PROVIDER,
  host = process.env.SMTP_HOST,
  port = Number(process.env.SMTP_PORT ?? 587),
  secureSetting = process.env.SMTP_SECURE,
  user = process.env.SMTP_USER,
  pass = process.env.SMTP_PASS,
  from = process.env.NOTIFICATION_EMAIL_FROM,
  appBaseUrl = process.env.APP_BASE_URL,
  tokenEncryptionKey,
  transportFactory = createTransport,
} = {}) {
  const secureValue = typeof secureSetting === 'string' ? secureSetting.toLowerCase() : undefined;
  if (
    provider !== 'smtp'
    || !host
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || !['true', 'false', undefined].includes(secureValue)
    || !user
    || !pass
    || !from
    || !appBaseUrl
    || !tokenEncryptionKey
    || !pool
  ) return null;

  let baseUrl;
  try {
    baseUrl = new URL(appBaseUrl);
    if (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  const transport = transportFactory({
    host,
    port,
    secure: secureValue === undefined ? port === 465 : secureValue === 'true',
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });

  return async ({ recipientEmail, notification }) => {
    const email = await buildEmailActionMessage({ pool, tokenEncryptionKey, appBaseUrl: baseUrl, recipientEmail, notification });
    try {
      await transport.sendMail({ from, ...email });
    } catch (error) {
      const responseCode = Number(error?.responseCode);
      if (error?.code === 'EAUTH') throw providerError('smtp_auth_failed', false);
      if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode < 600) {
        throw providerError('smtp_server_rejected', responseCode < 500);
      }
      throw providerError('smtp_delivery_failed', true);
    }
  };
}