import { createHash, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { decryptSecret, encryptSecret } from '../utils/encryption.js';

export function createTotpEnrollment(email, encryptionKey) {
  const secret = generateSecret();
  return {
    secret,
    secretCiphertext: encryptSecret(secret, encryptionKey),
    uri: generateURI({ issuer: 'Lead Exchange', label: email, secret }),
  };
}

export async function verifyTotpCode(secret, token) {
  if (!/^\d{6}$/.test(token)) return false;
  const result = await verify({ secret, token });
  return result.valid;
}

export function decryptTotpSecret(ciphertext, encryptionKey) {
  return decryptSecret(ciphertext, encryptionKey);
}

export function hashTotpCode(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g).join('-'));
}

export function normalizeRecoveryCode(code) {
  return typeof code === 'string' ? code.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
}

export function hashRecoveryCode(code) {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}