import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Works with AWS S3 and S3-compatible services (Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO).
export function createS3Storage({ bucket, region, endpoint, forcePathStyle, credentials, serverSideEncryption, kmsKeyId }) {
  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle,
    ...(credentials ? { credentials } : {}),
    // Several S3-compatible providers reject the SDK's default extra checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return {
    provider: 's3',
    async putObject({ key, body, contentType }) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        ...(serverSideEncryption ? { ServerSideEncryption: serverSideEncryption } : {}),
        ...(kmsKeyId ? { SSEKMSKeyId: kmsKeyId } : {}),
      }));
    },
    async getObject(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await result.Body.transformToByteArray());
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    createDownloadUrl(key, { expiresInSeconds, contentDisposition, contentType }) {
      return getSignedUrl(client, new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition,
        ResponseContentType: contentType,
      }), { expiresIn: expiresInSeconds });
    },
  };
}
