---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-23T18:16:29.520913878-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-23T16:43:28.451490697-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-23T16:43:00.122181501-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-22T22:00:56.644499386-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o pipeline de vídeos do StreamTube — servico de armazenamento (MinIO/S3) e processamento assíncrono em fila (BullMQ + Redis + worker FFmpeg), upload de vídeos de até 10GB sem travar a API via presigned multipart upload, pré-cadastro automático como rascunho, processamento automático (duração/metadados + thumbnail), URLs únicas, streaming por HTTP Range e download.

---

## Step Implementations

### SI-03.1 — Infra: dependências, config namespaces e Docker Compose

**Description:** Instala as bibliotecas da fase, cria os namespaces de configuração (storage/fila) seguindo o padrão `registerAs`, estende o schema Joi e sobe MinIO, Redis e o worker no Docker Compose.

**Technical actions:**

1. Instalar dependências: `npm i @nestjs/bullmq@^11.0.5 bullmq@^6.2.0 ioredis@^5.x @aws-sdk/client-s3@^3.x @aws-sdk/s3-request-presigner@^3.x` (per `phase-03-videos/TD-01`, `TD-02`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `MINIO_USE_SSL`, `PRESIGNED_URL_EXPIRATION_SECONDS` (per `phase-03-videos/TD-02`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST`, `REDIS_PORT` (per `phase-03-videos/TD-01`)
4. Estender `src/config/env.validation.ts` (Joi) com storage/queue env vars (per convenção phase 01)
5. Adicionar ao `compose.yaml` os serviços `minio` (portas 9000/9001, `MINIO_ROOT_USER/PASSWORD`), `redis` (6379) e `video-worker` (Dockerfile.worker) (per `phase-03-videos/TD-01`, `TD-03`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `package.json` contém as 6 novas dependências em `dependencies`
- `storage.config.ts` e `queue.config.ts` existem e usam `registerAs`
- `env.validation.ts` valida as novas envs sem erro ao bootar
- `docker compose config` aceita os 3 novos serviços (minio, redis, video-worker)

---

### SI-03.2 — Entidade Video + migration CreateVideos

**Description:** Cria a entidade `Video` com todos os campos do Data Model (status, storage keys, metadados) ligada ao `Channel`, e a migration que materializa a tabela.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — campos do Data Model: `id` (uuid, PK), `channelId` (FK → channel), `title`, `description`, `status` (enum draft/processing/ready/error, default 'draft'), `durationSeconds`, `width`, `height`, `codec`, `fileSizeBytes`, `videoKey`, `thumbnailKey`, `mimeType`, `errorMessage`, timestamps (per `phase-03-videos/TD-04a` — URL única UUID, `TD-05` — ciclo de status)
2. Definir relation `@ManyToOne(() => Channel)` — `channel_id` FK not null (per `## Inherited Conventions` — fase 02)
3. Criar migration `<timestamp>-CreateVideos.ts` — `CREATE TABLE videos` com campos + FK p/ `channels` + índice em `channel_id`
4. Registrar `Video` no `VideosModule` (import até hoje inexistente — referencia criado no SI-03.5) e expor via `TypeOrmModule.forFeature`
5. Rodar `npm run migration:run` (dentro do container `nestjs-api`) e verificar tabela criada

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: constraints, defaults, `status` enum | `src/videos/video.entity.integration-spec.ts` |

**Dependencies:** none (any relation mas entity é stand-alone; requer `Channel` existente da fase 02)

**Acceptance criteria:**

- Migration cria `videos` com `channel_id` FK not null e índice em `channel_id`
- `status` default é `draft`; enum aceita draft/processing/ready/error
- `id` é uuid gerado via uuid-ossp
- `INSERT INTO videos` sem channel_id falha (constraint FK)

---

### SI-03.3 — StorageModule com MinIO (S3)

**Description:** Implementa o serviço de armazenamento por trás do presigned multipart upload e do streaming/download — cliente S3 apontando para MinIO (dev), factory `registerAs`, geração de presigned URLs e operações de multipart.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` — `@Module({ imports: [ConfigModule] })`, provider global `S3Client` custom (endpoint `http://minio:9000`, `forcePathStyle: true`, credentials do `storage.config`, per `phase-03-videos/TD-02`)
2. Criar `src/storage/storage.service.ts` — `createMultipartUpload`, `generatePresignedPartUrls`, `completeMultipartUpload`, `abortMultipartUpload` (limpeza de upload incompleto — não completado / cancelado), `uploadThumbnail` (PUT do thumbnail no MinIO), `generatePresignedGetUrl` (com range para stream e `response-content-disposition=attachment` para download, expiração 24h, per `phase-03-videos/TD-02`, `TD-04b`)
3. Criar `src/storage/bucket.init.ts` (ou equivalente) — cria o bucket `streamtube-videos` na inicialização se não existir (per convenção Docker — rodar dentro do container)
4. Registrar `StorageModule` no `AppModule`
5. Garantir `ensure-bucket` no boot da API (lifecycle `OnModuleInit`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: real MinIO (Docker) — upload/partes/presigned | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — config namespaces (storage) + service minio no compose

**Acceptance criteria:**

- `POST`-path do multipart aceita parte de 100MB e `completeMultipartUpload` consolida o objeto em MinIO
- `abortMultipartUpload` cancela um multipart em andamento e remove as partes órfãs do MinIO
- `uploadThumbnail` grava um buffer em `thumbnails/{videoId}.jpg` com content-type correto
- `generatePresignedGetUrl` retorna URL assinada que faz GET com `206` (range) e `200` com attachment (per `phase-03-videos/TD-04b`)
- Atributos do storage vêm de `storage.config` (não hardcoded), e o bucket `streamtube-videos` existe após boot

---

### SI-03.4 — QueueModule com BullMQ

**Description:** Configura a fila `video-processing` com BullMQ + Redis e expõe um serviço para publicar jobs de processamento após o upload completo.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync({ useFactory: queueConfig })` (host/port do `queue.config`, per `phase-03-videos/TD-01`) + `BullModule.registerQueue({ name: 'video-processing' })`
2. Criar `src/queue/queue.service.ts` — `publishProcessingJob({ videoId, channelId, videoKey })` com `queue.add()` e retry config (`attempts: 3`, backoff exponencial, per `phase-03-videos/TD-01`, `TD-05`)
3. Registrar `QueueModule` no `AppModule`
4. Garantir `ioredis` apontando para Redis (containers `redis` no compose)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueService` | Integration: real Redis (Docker) — job enfileirado com payload correto | `src/queue/queue.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — config namespace queue + serviço redis no compose

**Acceptance criteria:**

- `publishProcessingJob` enfileira job em `video-processing` com retry configurado (3 tentativas, backoff)
- Queue module compila e registra a fila sem erro (DI wiring)
- Redis connection usa `REDIS_HOST`/`REDIS_PORT` do `queue.config`

---

### SI-03.5 — VideosModule + POST /videos/initiate (pré-cadastro + multipart)

**Description:** Cria o `VideosModule` completo (entity, service, controller) e implementa o endpoint de iniciação de upload: pré-registra o vídeo como `draft`, inicia multipart no MinIO e retorna as presigned URLs das partes.

**Route:** POST /videos/initiate
**Test Specs:** _pending /plan-test-specs_

**Technical actions:**

1. Criar `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, importa `StorageModule` + `QueueModule`, providers do service, declara controller (per `## Inherited Conventions` — estrutura de módulo fase 02)
2. Criar `src/videos/videos.service.ts` — `initiateUpload(channelId, dto)`:
   - `repo.save()` cria `Video` com `status: 'draft'`, `videoKey: videos/{id}.{ext}`, timestamps (per `phase-03-videos/TD-05`)
   - chama `storageService.createMultipartUpload` + `generatePresignedPartUrls` (100MB/parte, per `phase-03-videos/TD-02`)
   - retorna `{ video, uploadId, parts, completionUrl }` (per API Contracts)
3. Criar `src/videos/initiate-upload.dto.ts` — `filename`, `mimeType`, `fileSize` com validação (`fileSize <= 10GB`, `class-validator`, per `## Inherited Decisions Detail` phase-02/TD-06)
4. Criar `src/videos/videos.controller.ts` — `@Post('initiate')` guardado por JWT (global, per fase 02), injeta `@CurrentUser()`, chama `videosService.initiate`
5. Registrar `VideosModule` no `AppModule`; aplicar `@ApiTags`/decorators OpenAPI (per `## Inherited Decisions Detail` → openapi-docs-nestjs/TD-01/02/03)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiate` | Unit: branch logic (mock repo + storage) — pre-cadastro draft + fileSize > 10GB | `src/videos/videos.service.spec.ts` |
| `VideosController` | E2E: POST /videos/initiate com/sem auth | `test/videos-initiate.e2e-spec.ts` |
| `VideosModule` | Unit: DI compilation | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.2 (entity), SI-03.3 (storage), SI-03.4 (queue service)

**Acceptance criteria:**

- `POST /videos/initiate` com JWT e body válido retorna `201` com `video.status === "draft"` + `parts` (≥2 partes para arquivo grande) 
- `POST /videos/initiate` sem JWT retorna `401`
- `fileSize > 10GB` retorna `413 FILE_TOO_BIG`
- `Video` é persistido com `status: draft` e `videoKey` `videos/{videoId}.{ext}`

---

### SI-03.6 — POST /videos/:id/complete (multipart completo + enfileirar)

**Description:** Implementa a conclusão do upload multipart: consolida as partes no MinIO, atualiza o video para `processing` e publica o job na fila `video-processing`.

**Route:** POST /videos/:id/complete
**Test Specs:** _pending /plan-test-specs_

**Technical actions:**

1. Estender `videos.service.ts` — `completeUpload(userId, videoId, dto)`:
   - verifica ownership (`channelId` do video == canal do user) e `status === 'draft'` (per `phase-03-videos/TD-05`)
   - chama `storageService.completeMultipartUpload(uploadId, parts)` (per `phase-03-videos/TD-02`)
   - `repo.update` → `status: 'processing'` e chama `queueService.publishProcessingJob(...)` (per `phase-03-videos/TD-01`)
2. Criar `src/videos/complete-upload.dto.ts` — `parts: [{ partNumber, etag }]` com validação
3. Estender `videos.controller.ts` — `@Post(':id/complete')`
4. Mapear erros de domínio (404 VIDEO_NOT_FOUND, 403 FORBIDDEN, 400 INVALID_STATUS, per Error Catalog)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.complete` | Unit: branch (mock repo/storage/queue) — status inválido, ownership, publish | `src/videos/videos.service.spec.ts` |
| `complete` integration | Integration: real DB + MinIO + Redis — job enfileirado | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` | E2E: POST /videos/:id/complete | `test/videos-complete.e2e-spec.ts` |

**Dependencies:** SI-03.4 (job publish), SI-03.5 (module/service base)

**Acceptance criteria:**

- `POST /videos/:id/complete` de canal dono com status `draft` retorna `204` e enfileira job `video-processing` com payload `{ videoId, channelId, videoKey }`
- `POST /videos/:id/complete` de outro canal retorna `403 FORBIDDEN`
- `POST /videos/:id/complete` com video em `processing` retorna `400 INVALID_STATUS`
- Após complete, status do video no banco é `processing`

---

### SI-03.7 — Video Worker (FFmpeg): metadados + thumbnail + update DB

**Description:** Implementa o consumidor da fila `video-processing` num processo separado: extrai duração e metadados com ffprobe, gera a thumbnail com FFmpeg, faz upload para o MinIO e atualiza `status` para `ready` (ou `error` após retries esgotarem).

**Technical actions:**

1. Criar `src/video-worker/main.ts` — bootstrap do worker: connecta Redis (fila) + DB (TypeORM) e processa com `@Processor('video-processing')` (per `phase-03-videos/TD-03`)
2. Criar `src/video-worker/video-processor.ts` — consumidor:
   - baixa/streama o video do MinIO via presigned URL (per `phase-03-videos/TD-03` — FFmpeg lê por HTTP Range)
   - ffprobe → `durationSeconds`, `width`, `height`, `codec` (per `phase-03-videos/TD-03`)
   - ffmpeg `-ss 4 -vframes 1` → thumbnail `thumbnails/{videoId}.jpg` (per `phase-03-videos/TD-03`)
   - `storageService.uploadThumbnail(videoId, buffer)` — grava `thumbnails/{videoId}.jpg` no MinIO + `repo.update` → `status: 'ready'` com metadados (per `phase-03-videos/TD-05`)
   - retries inerentes ao BullMQ (3 tentativas); após esgotar → `status: 'error'` com `errorMessage` (per `phase-03-videos/TD-05`)
3. Criar `src/video-worker/ffmpeg.service.ts` — wrapper de `child_process` para `ffprobe` e `ffmpeg` (substitui fluente pelo CLI puro, per `phase-03-videos/TD-03`)
4. Criar `Dockerfile.worker` — base Node do projeto + `apt-get install ffmpeg`; entrypoint `node dist/video-worker/main.js` (per `phase-03-videos/TD-03`, resolved in I-02/I-06)
5. Registrar `video-worker` no `compose.yaml` (image próprio, depends_on redis + minio, command `npm run start:worker` custom ou node dist)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: real MinIO + Redis + FFmpeg — job de processamento atualiza DB e gera thumbnail | `src/video-worker/video-processor.integration-spec.ts` |
| `FfmpegService` | Integration: real ffmpeg binário — metadados + frame | `src/video-worker/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.4 (consumo da fila), SI-03.6 (job producer), SI-03.3 (storage para vídeo/thumbnail)

**Acceptance criteria:**

- Enfileirar um job `video-processing` resulta em video com `status: ready`, `durationSeconds`/`width`/`height`/`codec` populados e `thumbnailKey` preenchido no DB	
- `video-worker` roda no Docker (compose) e consome jobs da mesma fila Redis que a API publica
- Após 3 falhas de processamento, `status` vira `error` com `errorMessage` preenchido
- Thumbnail `thumbnails/{videoId}.jpg` existe no MinIO após processamento bem-sucedido

---

### SI-03.8 — GET /videos/:id, /videos/:id/stream, /videos/:id/download

**Description:** Expõe a consulta do vídeo (metadata + status) e os endpoints de streaming e download que retornam presigned GET URLs direto do MinIO, com suporte a HTTP Range nativo.

**Route:** GET /videos/:id, GET /videos/:id/stream, GET /videos/:id/download
**Test Specs:** _pending /plan-test-specs_

**Technical actions:**

1. Estender `videos.service.ts`:
   - `getVideo(id)` — busca video, monta `thumbnailUrl` (presigned do `thumbnailKey` quando `ready`) e retorna shape do API Contracts
   - `getStreamUrl(videoId)` — gera presigned GET com Range; bloqueia se `status !== 'ready'` (`VIDEO_NOT_READY`, per `phase-03-videos/TD-04b`)
   - `getDownloadUrl(videoId)` — presigned GET com `response-content-disposition=attachment` (per `phase-03-videos/TD-04b`)
2. Estender `videos.controller.ts` — `@Get(':id')`, `@Get(':id/stream')`, `@Get(':id/download')`
3. Aplicar decorators OpenAPI nos 3 endpoints (per `## Inherited Decisions Detail` → openapi-docs-nestjs/TD-01/02/03)
4. Verificar range: presigned URL responde `206` para `Range` e `200` sem Range — comportamento nativo MinIO/S3 (per `phase-03-videos/TD-04b`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (get/stream/download) | Unit: branch — status não-ready, video não pertence | `src/videos/videos.service.spec.ts` |
| `GET /videos/:id` | E2E: retorna metadata/status e thumbnailUrl quando ready | `test/videos-get.e2e-spec.ts` |
| `GET /videos/:id/stream` + `/download` | E2E: presigned URL é assinada e faz GET com 206/attachment | `test/videos-stream.e2e-spec.ts` |

**Dependencies:** SI-03.3 (presigned GET), SI-03.5 (service/controller base), SI-03.7 (para estado ready)

**Acceptance criteria:**

- `GET /videos/:id` com JWT retorna `200` com `status`, metadados e `thumbnailUrl` quando `ready`
- `GET /videos/:id/stream` de video `ready` retorna presigned URL que pode ser acessada com `Range` produzindo `206 Partial Content`
- `GET /videos/:id/stream` de video não-ready retorna `409 VIDEO_NOT_READY`
- `GET /videos/:id/download` retorna presigned URL cujo `content-disposition` é `attachment`
- `GET /videos/:id` de video de outro canal retorna `403 FORBIDDEN`

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (uuid-ossp) |
| channel_id | uuid | FK → `channel.id`, not null |
| title | varchar(255) | nullable (populado após processamento) |
| description | text | nullable |
| status | varchar | enum ('draft','processing','ready','error'), not null, default 'draft' |
| duration_seconds | int | nullable |
| width | int | nullable |
| height | int | nullable |
| codec | varchar(50) | nullable |
| file_size_bytes | bigint | nullable |
| video_key | varchar(255) | not null — storage key `videos/{videoId}.{ext}` |
| thumbnail_key | varchar(255) | nullable — storage key `thumbnails/{videoId}.jpg` |
| mime_type | varchar(100) | not null |
| error_message | text | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

**Relations:** `Channel` has many `Video` (one-to-many, FK `channel_id`)
**Indexes:** unique on `id`; index on `channel_id`

---

### API Contracts

#### POST /videos/initiate (SI-03.N)

**Request headers:**
- Authorization: Bearer {jwt}
- Content-Type: application/json

**Request body:**
- filename: string, required — original arquivo (ex: `minha-aula.mp4`)
- mimeType: string, required
- fileSize: number, required — bytes

**Response 201:**
- video: { id (uuid), status: "draft", title, channelId }
- uploadId: string (multipart upload id)
- parts: [ { partNumber (number), presignedUrl (string) } ] — ~100 parts de 100MB
- completionUrl: string — `POST /videos/:id/complete`

**Error responses:**
- 401 Unauthorized: token ausente/inválido
- 413 FILE_TOO_BIG: quando `fileSize` excede 10GB
- 400 validation error: body sem filename/mimeType/fileSize

---

#### POST /videos/:id/complete (SI-03.N)

**Request headers:**
- Authorization: Bearer {jwt}
- Content-Type: application/json

**Request body:**
- parts: array of { partNumber: number, etag: string } — todos os parts concluídos

**Response 204:** No content — dispara processamento em fila.

**Error responses:**
- 404 VIDEO_NOT_FOUND: video id inexistente
- 403 FORBIDDEN: video pertence a outro canal
- 400 INVALID_STATUS: video não está em `draft`

---

#### GET /videos/:id/stream (SI-03.N)

**Request headers:**
- Range: bytes=0- (opcional — HTTP Range nativo)

**Response 200:**
```json
{ "streamUrl": "https://storage/videos/{videoId}.mp4?X-Amz-Expires=86400&X-Amz-Signature=..." }
```
*(presigned GET com Range; MinIO/S3 respondem `206 Partial Content` nativamente — per phase-03-videos/TD-04b)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: video inexistente
- 409 VIDEO_NOT_READY: status não é `ready`

---

#### GET /videos/:id/download (SI-03.N)

**Request headers:**
- Authorization: Bearer {jwt} _(opcional — acessível também após `ready`)_

**Response 200:**
```json
{ "downloadUrl": "https://storage/videos/{videoId}.mp4?X-Amz-Expires=86400&response-content-disposition=attachment" }
```

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: status não é `ready`

---

#### GET /videos/:id (SI-03.N)

**Request headers:**
- Authorization: Bearer {jwt}

**Response 200:**
```json
{
  "id": "uuid",
  "title": "string|null",
  "description": "string|null",
  "status": "draft|processing|ready|error",
  "durationSeconds": 123 | null,
  "width": 1920 | null,
  "height": 1080 | null,
  "thumbnailUrl": "presigned|url|null"
}
```

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 403 FORBIDDEN: requester não é dono/qualquer echo

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos/initiate | ✗ | ✓ | ✓ (cria video no próprio canal) |
| POST /videos/:id/complete | ✗ | ✓ | ✓ (só o canal dono) |
| GET /videos/:id/stream | ✗ | ✓ | ✓ |
| GET /videos/:id/download | ✗ | ✓ | ✓ |
| GET /videos/:id | ✗ | ✓ | ✓ |

**Nota de produção (Fase 05):** o streaming público (anon) é uma capacidade da Fase 05 (página de visualização); nesta fase o acesso é autenticado.

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| FILE_TOO_BIG | 413 | upload fileSize > 10GB |
| VIDEO_NOT_FOUND | 404 | GET/POST video inexistente |
| VIDEO_NOT_READY | 409 | stream/download quando status ≠ ready |
| INVALID_STATUS | 400 | complete quando status ≠ draft |
| FORBIDDEN | 403 | ação em video de outro canal |

### Events/Messages

#### video-processing.job

**Payload:**

```json
{ "videoId": "uuid", "channelId": "uuid", "videoKey": "videos/{videoId}.{ext}" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-01`)
**Consumer:** `video-worker` — `@Processor('video-processing')` (per `phase-03-videos/TD-03`)
**Trigger:** POST /videos/:id/complete
**Delivery semantics:** at-least-once (BullMQ com 3 retries com backoff exponencial; após esgotar → status `error`, per `phase-03-videos/TD-05`)
**Outputs do worker:** Popula duração/metadados + gera `thumbnails/{videoId}.jpg` e faz `UPDATE videos SET status='ready'` (ou `error` com `error_message`).

---

## Dependency Map

SI-03.1 (root — Infra/config/Docker)
├── SI-03.2 — depends on SI-03.1 (entity usa pattern config; roda no mesmo compose)
├── SI-03.3 — depends on SI-03.1 (config storage + service minio)
├── SI-03.4 — depends on SI-03.1 (config queue + service redis)
│   └── SI-03.7 — depends on SI-03.4 (consome fila) + SI-03.3 (storage) + SI-03.6 (job producer)
SI-03.5 — depends on SI-03.2, SI-03.3, SI-03.4 (entity + storage + fila)
└── SI-03.6 — depends on SI-03.5 (module/service base) + SI-03.4 (enfileira)
    └── SI-03.7 — (acima, cross-ref via SI-03.6)
SI-03.8 — depends on SI-03.3 (presigned GET) + SI-03.5 (service base) + SI-03.7 (estado ready)

Ordering de execução: SI-03.1 → {SI-03.2, SI-03.3, SI-03.4} → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, config namespaces e Docker Compose
- [ ] SI-03.2 — Entidade Video + migration CreateVideos
- [ ] SI-03.3 — StorageModule com MinIO (S3)
- [ ] SI-03.4 — QueueModule com BullMQ
- [ ] SI-03.5 — VideosModule + POST /videos/initiate (pré-cadastro + multipart)
- [ ] SI-03.6 — POST /videos/:id/complete (multipart completo + enfileirar)
- [ ] SI-03.7 — Video Worker (FFmpeg): metadados + thumbnail + update DB
- [ ] SI-03.8 — GET /videos/:id, /videos/:id/stream, /videos/:id/download

**Full test suites:**

- [ ] Testes de unidade/integração passam (`cd nestjs-project && npm test`)
- [ ] Testes de integração passam (`cd nestjs-project && npm run test:integration`)
- [ ] Testes E2E passam (`cd nestjs-project && npm run test:e2e`)
- [ ] Type check passa (`cd nestjs-project && npx tsc --noEmit`)
- [ ] Lint passa (`cd nestjs-project && npm run lint`)
- [ ] `docker compose up -d` sobe a API, MinIO, Redis e video-worker sem erro
- [ ] Supersizing: upload > 10GB rejeitado; upload + streaming + download funcionais end-to-end