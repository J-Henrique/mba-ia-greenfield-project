# phase-03-videos — Progress

**Status:** completed
**SIs:** 9/9 completed

### SI-03.1 — Infra: dependências, config namespaces e Docker Compose
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Instaladas 5 dependências (as listadas no technical action do SI). O AC cita "6 novas dependências", mas o `fluent-ffmpeg` (6ª na tabela do decisions doc) é marcado como opcional e não é usado — o worker usa `child_process` para FFmpeg (TD-03 Option A), então não é instalado.
  - `storageConfig` e `queueConfig` também foram registradas no `load[]` do `app.module.ts` (padrão do repo) — o SI não listava explicitamente esse passo, mas sem ele os namespaces não seriam injetáveis.
  - `.env.example` atualizado com as envs de storage/queue (item do decisions doc, encaixado aqui no SI de config).

### SI-03.2 — Entidade Video + migration CreateVideos
- **Status:** completed
- **Tests:** 8 passing
- **Observations:**
  - A ação 4 do plano ("Registrar `Video` no `VideosModule`") é deferida para SI-03.5: o `VideosModule` ainda não existe (o próprio plano anota isso como "referencia criado no SI-03.5"). A entidade funciona standalone; o `forFeature` entra quando o módulo for criado.
  - Timestamp da migration gerado como `1788123805882` (ms epoch atual). Verificado `pg_extension` (uuid-ossp presente) e o schema da tabela via `information_schema` — schema clips (16 colunas) conforme Data Model.

### SI-03.2.1 — Atualizar suíte de teste existente para a tabela `videos`
- **Status:** completed
- **Tests:** 152 passing (full suite: 24 suites, 152 tests)
- **Observations:**
  - O teste `should revert the last migration and remove token tables` quebrava porque `undoLastMigration()` agora reverte `CreateVideos` (a nova última migration), não `CreateAuthTokens`. Corrigido para verificar remoção da tabela `videos` e atualizado o comentário no `afterAll`.

### SI-03.3 — StorageModule com MinIO (S3)
- **Status:** completed
- **Tests:** 9 passing
- **Observations:**
  - `generatePresignedGetUrl` NÃO inclui Range nos signed headers — o cliente adiciona `Range` como header HTTP não assinado (padrão S3 para streaming). A URL pré-assinada com range assinado causa 400 AccessDenied no MinIO porque o fetch não envia o header que está em X-Amz-SignedHeaders.
  - `BucketInitializer` (OnModuleInit) garante bucket na inicialização.
  - Validação tsc e teste: OK.

### SI-03.4 — QueueModule com BullMQ
- **Status:** completed
- **Tests:** 2 passing
- **Observations:**
  - `publishProcessingJob` enfileira com 3 tentativas e backoff exponencial (1s)
  - Nome da fila configurável via `QUEUE_NAME` env (R3) — `queue.constants.ts` exporta `QUEUE_NAME` usado tanto no registro quanto na injeção
  - Redis connection usa REDIS_HOST/REDIS_PORT do `queue.config`

### SI-03.5 — VideosModule + POST /videos/initiate
- **Status:** completed
- **Tests:** 8 passing (4 unit + 1 module compile + 3 E2E)
- **Observations:**
  - `@Max` removido do `InitiateUploadDto`: o limite de 10GB é verificado apenas no service (`FileTooBigException` → 413 FILE_TOO_BIG), alinhado ao Error Catalog e ao spec E2E — com `@Max` o class-validator devolveria 400 VALIDATION_ERROR.
  - `findByUserId` adicionado ao `ChannelsService` (lança `ChannelNotFoundException`); novas exceções de domínio (Video/Channel/FileTooBig/InvalidStatus/NotReady/Forbidden) adicionadas em `domain.exception.ts`.
  - `InitiateUploadResponse` exportado do service (TS4053: controller referencia tipo não exportado).

### SI-03.6 — POST /videos/:id/complete
- **Status:** completed
- **Tests:** 11 passing (4 unit + 3 E2E)
- **Observations:**
  - `findMultipartUploadIdByKey` adicionado ao StorageService (ListMultipartUploadsCommand com Prefix) — necessário porque o complete não recebe uploadId do frontend; localiza o upload ativo pela video_key
  - E2E executa ciclo multipart real: initiate → PUT real (5MB cada parte) → complete com ETags reais
  - `CompleteUploadDto` com `@ValidateNested` + `@ArrayMinSize(1)`

### SI-03.7 — Video Worker (FFmpeg)
- **Status:** completed
- **Tests:** 9 passing (7 unit processor + 2 integration ffmpeg service)
- **Observations:**
  - `FfmpegService` chamado via `child_process.execFile` (CLI puro, sem fluent-ffmpeg) — ffprobe para metadados, ffmpeg stdout pipe para thumbnail JPEG
  - Worker é bootstrap separado via `NestFactory.createApplicationContext(WorkerModule)` — sem servidor HTTP, só consome fila BullMQ
  - `@OnWorkerEvent('failed')` marca status ERROR quando as 3 tentativas se esgotam (TD-05)
  - `Dockerfile.worker` com ffmpeg instalado; `Dockerfile.dev` também atualizado (testes precisam do binário)
  - Testes unitários do processor mockam todas as dependências (7 cenários: happy path + 4 falhas + 2 onFailed) — roda em <1s sem infra real

### SI-03.8 — GET /videos/:id, /videos/:id/stream, /videos/:id/download
- **Status:** completed
- **Tests:** 22 passing (9 unit GET + 5 E2E stream + 8 preserved from previous SIs)
- **Observations:**
  - Ownership checks nos 3 endpoints (FORBIDDEN para outro canal)
  - Stream exige `status === ready` (VIDEO_NOT_READY caso contrário)
  - Download URL contém `response-content-disposition=attachment` no query string da presigned URL
  - Suíte completa: 30 suites / 190 tests unit+int + 6 suites / 63 tests E2E
