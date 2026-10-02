import { createHash } from 'node:crypto';
import { decryptSecret, encryptSecret } from './encryption.js';

export function resolveEmailTokenEncryptionKey(value = process.env.EMAIL_TOKEN_ENCRYPTION_KEY) {
  if (Buffer.isBuffer(value)) return value.length === 32 ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const key = Buffer.from(value, 'base64');
  return key.length === 32 ? key : null;
}

export function hashEmailActionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function encryptEmailActionToken(token, key) {
  return encryptSecret(token, key);
}

export function decryptEmailActionToken(ciphertext, key) {
  return decryptSecret(ciphertext, key);
}