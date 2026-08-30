import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import type { ConfigType } from '@nestjs/config';
import { BucketInitializer } from './bucket.init';
import { StorageService } from './storage.service';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: S3Client,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) => {
        const protocol = config.useSsl ? 'https' : 'http';
        return new S3Client({
          endpoint: `${protocol}://${config.endpoint}:${config.port}`,
          forcePathStyle: true,
          region: 'us-east-1',
          credentials: {
            accessKeyId: config.accessKey,
            secretAccessKey: config.secretKey,
          },
        });
      },
    },
    StorageService,
    BucketInitializer,
  ],
  exports: [StorageService],
})
export class StorageModule {}
