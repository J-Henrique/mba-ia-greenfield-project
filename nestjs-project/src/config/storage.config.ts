import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.MINIO_ENDPOINT || 'minio',
  port: parseInt(process.env.MINIO_PORT || '9000', 10),
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  bucket: process.env.MINIO_BUCKET || 'streamtube-videos',
  useSsl: process.env.MINIO_USE_SSL === 'true',
  presignedUrlExpirationSeconds: parseInt(
    process.env.PRESIGNED_URL_EXPIRATION_SECONDS || '86400',
    10,
  ),
  partSizeMb: parseInt(process.env.STORAGE_PART_SIZE_MB || '100', 10),
}));
