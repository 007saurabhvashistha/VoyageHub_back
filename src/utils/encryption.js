import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function encryptSecret(plaintext, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(ciphertext, key) {
  const [nonceText, tagText, encryptedText] = typeof ciphertext === 'string' ? ciphertext.split('.') : [];
  if (!nonceText || !tagText || !encryptedText) throw new Error('Invalid encrypted secret.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
}