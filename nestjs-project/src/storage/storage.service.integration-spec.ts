import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration — MinIO)', () => {
  let storageService: StorageService;
  let s3Client: S3Client;

  const bucket = 'streamtube-videos';
  const testKey = `videos/integration-test-${Date.now()}.mp4`;
  const partSizeBytes = 5 * 1024 * 1024; // 5 MiB (mínimo aceito pelo S3/MinIO)
  const partCount = 2;
  const totalBytes = partCount * partSizeBytes;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
    s3Client = module.get(S3Client);

    // Garante o bucket — o BucketInitializer rodaria no app.init(),
    // mas chamamos explicitamente para isolar o setup.
    await storageService.ensureBucket();
  });

  afterAll(async () => {
    try {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: testKey }),
      );
    } catch {
      // ignorar — objeto já não existe ou foi removido
    }
    await s3Client.destroy();
  }, 15000);

  it('should have the configured part size (100 MB default)', () => {
    // Valida a parte configurável do AC sem enviar 100 MB reais
    expect(storageService.getPartSizeBytes()).toBe(100 * 1024 * 1024);
  });

  it('should ensure the bucket exists', async () => {
    await expect(
      s3Client.send(new HeadBucketCommand({ Bucket: bucket })),
    ).resolves.toBeDefined();
  });

  describe('multipart upload flow', () => {
    let uploadId: string;
    const parts: { PartNumber: number; ETag: string }[] = [];

    it('should create a multipart upload', async () => {
      uploadId = await storageService.createMultipartUpload(
        testKey,
        'video/mp4',
      );
      expect(uploadId).toBeDefined();
      expect(typeof uploadId).toBe('string');
    });

    it('should generate presigned part URLs and upload parts', async () => {
      const urls = await storageService.generatePresignedPartUrls(
        uploadId,
        testKey,
        partCount,
      );
      expect(urls).toHaveLength(partCount);
      urls.forEach((url) => expect(url).toContain('X-Amz-Signature'));

      for (let i = 0; i < partCount; i++) {
        const body = Buffer.alloc(partSizeBytes, 0x61); // 'aaa...'
        const response = await fetch(urls[i], { method: 'PUT', body });
        expect(response.status).toBe(200);
        const etag = response.headers.get('ETag');
        expect(etag).toBeDefined();
        parts.push({ PartNumber: i + 1, ETag: etag! });
      }
    });

    it('should complete the multipart upload and persist the object', async () => {
      await storageService.completeMultipartUpload(uploadId, testKey, parts);

      const head = await s3Client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: testKey }),
      );
      expect(head.ContentLength).toBe(totalBytes);
    });
  });

  describe('abort multipart upload', () => {
    it('should abort an in-progress multipart and clean up', async () => {
      const abortKey = `${testKey}.abort`;
      const uploadId = await storageService.createMultipartUpload(
        abortKey,
        'video/mp4',
      );

      await storageService.abortMultipartUpload(uploadId, abortKey);

      const list = await s3Client.send(
        new ListMultipartUploadsCommand({ Bucket: bucket }),
      );
      expect((list.Uploads ?? []).some((u) => u.UploadId === uploadId)).toBe(
        false,
      );
    });
  });

  describe('thumbnail upload', () => {
    it('should upload a thumbnail buffer to MinIO', async () => {
      const thumbKey = `thumbnails/integration-test-${Date.now()}.jpg`;
      const contentType = 'image/jpeg';
      const body = Buffer.alloc(1024, 0x62); // 'bbb...'

      await storageService.uploadThumbnail(thumbKey, body, contentType);

      const head = await s3Client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: thumbKey }),
      );
      expect(head.ContentLength).toBe(1024);
      expect(head.ContentType).toBe('image/jpeg');
    });
  });

  describe('presigned GET URL', () => {
    it('should return a presigned URL that returns 206 with range', async () => {
      const url = await storageService.generatePresignedGetUrl(testKey);

      // O caller adiciona o header Range (não assinado) — padrão S3/MinIO para streaming
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-9' },
      });
      expect(response.status).toBe(206);
      const body = await response.arrayBuffer();
      expect(body.byteLength).toBe(10);
      expect(new Uint8Array(body)).toEqual(
        new Uint8Array(Buffer.alloc(10, 0x61)),
      );
    });

    it('should return a presigned URL with content-disposition for download', async () => {
      const url = await storageService.generatePresignedGetUrl(testKey, {
        responseContentDisposition: 'attachment; filename="video.mp4"',
      });

      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
    });
  });
});
