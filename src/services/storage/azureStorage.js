import { BlobSASPermissions, BlobServiceClient, SASProtocol, StorageSharedKeyCredential } from '@azure/storage-blob';

export function createAzureStorage({ container, connectionString, accountName, accountKey, endpoint }) {
  const serviceClient = connectionString
    ? BlobServiceClient.fromConnectionString(connectionString)
    : new BlobServiceClient(endpoint ?? `https://${accountName}.blob.core.windows.net`, new StorageSharedKeyCredential(accountName, accountKey));
  const containerClient = serviceClient.getContainerClient(container);
  // Plain HTTP is only used by the local Azurite emulator.
  const sasProtocol = serviceClient.url.startsWith('http://') ? SASProtocol.HttpsAndHttp : SASProtocol.Https;

  return {
    provider: 'azure',
    async putObject({ key, body, contentType }) {
      await containerClient.getBlockBlobClient(key).uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } });
    },
    async getObject(key) {
      return containerClient.getBlockBlobClient(key).downloadToBuffer();
    },
    async deleteObject(key) {
      await containerClient.getBlockBlobClient(key).deleteIfExists({ deleteSnapshots: 'include' });
    },
    // Needs a shared-key credential (account key or a connection string that contains one).
    createDownloadUrl(key, { expiresInSeconds, contentDisposition, contentType }) {
      return containerClient.getBlockBlobClient(key).generateSasUrl({
        permissions: BlobSASPermissions.parse('r'),
        expiresOn: new Date(Date.now() + expiresInSeconds * 1000),
        protocol: sasProtocol,
        contentDisposition,
        contentType,
      });
    },
  };
}
