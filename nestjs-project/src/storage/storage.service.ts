import { Inject, Injectable } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import type { ConfigType } from '@nestjs/config';

export interface CompletedPart {
  PartNumber: number;
  ETag: string;
}

export interface PresignedGetOptions {
  responseContentDisposition?: string;
}

const MINIO_REGION = 'us-east-1';

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3Client) private readonly s3Client: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  private get bucket(): string {
    return this.config.bucket;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3Client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  /** Inicia um multipart upload e retorna o uploadId. */
  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return response.UploadId!;
  }

  /** Gera uma presigned URL de PUT por parte (1..partCount). */
  async generatePresignedPartUrls(
    uploadId: string,
    key: string,
    partCount: number,
  ): Promise<string[]> {
    const urls: string[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const command = new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      });
      urls.push(
        await getSignedUrl(this.s3Client, command, {
          expiresIn: this.config.presignedUrlExpirationSeconds,
        }),
      );
    }
    return urls;
  }

  /** Consolida o objeto após todas as partes terem sido enviadas. */
  async completeMultipartUpload(
    uploadId: string,
    key: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  }

  /** Cancela um multipart em andamento e remove as partes órfãs. */
  async abortMultipartUpload(uploadId: string, key: string): Promise<void> {
    await this.s3Client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Grava o thumbnail em `thumbnails/{videoId}.jpg`. */
  async uploadThumbnail(
    thumbnailKey: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: thumbnailKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Gera presigned GET — o caller adiciona `Range` como header HTTP não assinado para streaming (206). */
  async generatePresignedGetUrl(
    key: string,
    options: PresignedGetOptions = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.responseContentDisposition
        ? { ResponseContentDisposition: options.responseContentDisposition }
        : {}),
    });
    return getSignedUrl(this.s3Client, command, {
      expiresIn: this.config.presignedUrlExpirationSeconds,
    });
  }

  /** Tamanho de cada parte do multipart em bytes (part size configurável). */
  getPartSizeBytes(): number {
    return this.config.partSizeMb * 1024 * 1024;
  }
}
