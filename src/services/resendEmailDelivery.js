import { buildEmailActionMessage } from './emailActionMessage.js';

function providerError(code, retryable) {
  return Object.assign(new Error('Email provider request failed.'), { code, retryable });
}

export function createResendEmailDelivery({
  pool,
  provider = process.env.EMAIL_PROVIDER,
  apiKey = process.env.RESEND_API_KEY,
  from = process.env.NOTIFICATION_EMAIL_FROM,
  appBaseUrl = process.env.APP_BASE_URL,
  tokenEncryptionKey,
  fetchImpl = fetch,
} = {}) {
  if (provider !== 'resend' || !apiKey || !from || !appBaseUrl || !tokenEncryptionKey || !pool) return null;
  let baseUrl;
  try {
    baseUrl = new URL(appBaseUrl);
    if (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:') return null;
  } catch {
    return null;
  }

  return async ({ idempotencyKey, recipientEmail, notification }) => {
    const email = await buildEmailActionMessage({ pool, tokenEncryptionKey, appBaseUrl: baseUrl, recipientEmail, notification });

    let response;
    try {
      response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ from, ...email, to: [email.to] }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw providerError('provider_unavailable', true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw providerError(retryable ? 'provider_temporary_failure' : 'provider_rejected', retryable);
    }
  };
}