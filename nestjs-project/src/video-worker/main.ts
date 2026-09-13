import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Bootstrap do worker de vídeo como um contexto de aplicação NestJS
 * (sem servidor HTTP). Conecta Redis (fila QUEUE_NAME) + DB (TypeORM)
 * e inicia o consumo via @Processor (TD-03, R7).
 */
async function bootstrap(): Promise<void> {
  await NestFactory.createApplicationContext(WorkerModule);
}

void bootstrap();
