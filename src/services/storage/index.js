import { config } from '../../config/index.js';
import { createAzureStorage } from './azureStorage.js';
import { createS3Storage } from './s3Storage.js';

/**
 * Private object storage. Every connector implements:
 *   putObject({ key, body, contentType }), getObject(key) -> Buffer, deleteObject(key),
 *   createDownloadUrl(key, { expiresInSeconds, contentDisposition, contentType }) -> short-lived signed URL.
 * Returns null when no provider is configured so callers can answer "not configured" honestly.
 */
export function createStorage(storageConfig = config.storage) {
  if (!storageConfig) return null;
  if (storageConfig.provider === 's3') return { ...createS3Storage(storageConfig.s3), keyPrefix: storageConfig.keyPrefix };
  if (storageConfig.provider === 'azure') return { ...createAzureStorage(storageConfig.azure), keyPrefix: storageConfig.keyPrefix };
  throw new Error(`Unsupported storage provider: ${storageConfig.provider}`);
}
