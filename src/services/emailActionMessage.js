import { decryptEmailActionToken } from '../utils/emailActionTokens.js';

export async function buildEmailActionMessage({ pool, tokenEncryptionKey, appBaseUrl, recipientEmail, notification }) {
  let text = notification.message;
  const actionTokenId = notification.data?.authEmailTokenId;
  if (actionTokenId) {
    const action = await pool.query(
      'SELECT purpose, token_ciphertext, expires_at FROM auth_email_tokens WHERE id = $1 AND used_at IS NULL',
      [actionTokenId],
    );
    if (!action.rowCount || !action.rows[0].token_ciphertext || new Date(action.rows[0].expires_at) <= new Date()) {
      throw Object.assign(new Error('Email action token is unavailable.'), { code: 'email_action_token_unavailable', retryable: false });
    }
    const token = decryptEmailActionToken(action.rows[0].token_ciphertext, tokenEncryptionKey);
    const route = action.rows[0].purpose === 'verify_email' ? 'verify-email' : 'reset-password';
    const link = new URL(`/${route}`, appBaseUrl);
    link.searchParams.set('token', token);
    text = `${text}\n\n${link.toString()}\n\nThis link expires soon and can be used once.`;
  }

  return { to: recipientEmail, subject: notification.title, text };
}