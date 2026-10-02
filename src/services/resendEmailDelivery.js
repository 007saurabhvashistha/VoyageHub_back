import { decryptEmailActionToken } from '../utils/emailActionTokens.js';

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
    let text = notification.message;
    const actionTokenId = notification.data?.authEmailTokenId;
    if (actionTokenId) {
      const action = await pool.query(
        'SELECT purpose, token_ciphertext, expires_at FROM auth_email_tokens WHERE id = $1 AND used_at IS NULL',
        [actionTokenId],
      );
      if (!action.rowCount || !action.rows[0].token_ciphertext || new Date(action.rows[0].expires_at) <= new Date()) {
        throw providerError('email_action_token_unavailable', false);
      }
      const token = decryptEmailActionToken(action.rows[0].token_ciphertext, tokenEncryptionKey);
      const route = action.rows[0].purpose === 'verify_email' ? 'verify-email' : 'reset-password';
      const link = new URL(`/${route}`, baseUrl);
      link.searchParams.set('token', token);
      text = `${text}\n\n${link.toString()}\n\nThis link expires soon and can be used once.`;
    }

    let response;
    try {
      response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ from, to: [recipientEmail], subject: notification.title, text }),
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