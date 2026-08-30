import { Injectable, OnModuleInit } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Garante que o bucket de vídeos exista no MinIO quando a API inicia.
 * Roda via lifecycle `OnModuleInit`.
 */
@Injectable()
export class BucketInitializer implements OnModuleInit {
  constructor(private readonly storageService: StorageService) {}

  async onModuleInit(): Promise<void> {
    await this.storageService.ensureBucket();
  }
}
