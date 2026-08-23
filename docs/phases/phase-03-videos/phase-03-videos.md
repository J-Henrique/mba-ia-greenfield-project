---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-19T10:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-19T10:00:00-03:00"
  docs/phases/phase-03-videos/context.md: "2026-08-19T10:00:00-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-05-12T12:21:12-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video pipeline for StreamTube — upload files up to 10GB without blocking the API (presigned multipart upload direct to MinIO/S3), async processing with BullMQ and FFmpeg worker, unique video URLs, streaming via HTTP Range requests, and download.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose

**Description:** Install all Phase 03 production dependencies, create `storage` and `queue` config namespaces following the `registerAs` pattern from Phase 01, extend the Joi validation schema, and add MinIO, Redis, and video-worker services to Docker Compose.

**Technical actions:**

1. Install production dependencies in nestjs-project:
   - `npm install @nestjs/bullmq@^11.0.5 bullmq@^6.2.0 ioredis@^5.x`
   - `npm install @aws-sdk/client-s3@^3.x @aws-sdk/s3-request-presigner@^3.x`

2. Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading:
   - `MINIO_ENDPOINT` (string, default `'minio'`)
   - `MINIO_PORT` (number, default `9000`)
   - `MINIO_ACCESS_KEY` (string, default `'streamtube'`)
   - `MINIO_SECRET_KEY` (string, default `'streamtube-secret'`)
   - `MINIO_BUCKET` (string, default `'streamtube-videos'`)
   - `MINIO_USE_SSL` (boolean, default `false`)
   - `PRESIGNED_URL_EXPIRATION_SECONDS` (number, default `86400` — 24h)

3. Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading:
   - `REDIS_HOST` (string, default `'redis'`)
   - `REDIS_PORT` (number, default `6379`)
   - `QUEUE_VIDEO_PROCESSING` (string, default `'video-processing'`)

4. Update `src/config/env.validation.ts` — add all new env vars to the Joi schema. Update `.env.example`.

5. Update `nestjs-project/compose.yaml`:
   - Add `minio` service: image `minio/minio`, ports `9000:9000` (API) and `9001:9001` (console), env vars `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, volume `minio_data:/data`, command `server /data --console-address ":9001"`, healthcheck
   - Add `redis` service: image `redis:7-alpine`, port `6379`, healthcheck
   - Add `video-worker` service: build from `Dockerfile.worker`, depends_on: `redis`, `minio`, `db`

6. Create `nestjs-project/Dockerfile.worker`:
   - Same base as API (Node.js)
   - Install FFmpeg: `apt-get update && apt-get install -y ffmpeg`
   - Copy `package.json`, install deps, copy source
   - No build step (dev mode) — entrypoint runs via ts-node

7. Register `ConfigModule.forRoot({ load: [storageConfig, queueConfig] })` — already global, just add to the existing load array in `app.module.ts`.

**Tests:** No tests — infrastructure setup (configs, compose, Dockerfile). Verify by starting the services and confirming the API still boots.

**Dependencies:** None

**Acceptance criteria:**
- Application starts without errors when all new env vars are provided
- Starting without `MINIO_ACCESS_KEY` causes a Joi validation error
- `docker compose up -d` starts MinIO (port 9000), Redis (port 6379), and video-worker containers successfully
- MinIO is reachable via S3 API at `http://localhost:9000`
- Redis is reachable via `redis-cli ping` on port 6379

---

### SI-03.2 — StorageModule (MinIO/S3 Client)

**Description:** Create the `StorageModule` and `StorageService` that encapsulates all MinIO/S3 operations: presigned multipart upload URLs, presigned GET URLs for streaming/download, and lifecycle configuration.

**Technical actions:**

1. Create `src/storage/storage.module.ts` — `StorageModule` with `StorageService` provider, exports `StorageService`. Uses `BullModule.registerQueueAsync({ name: 'video-processing' })` in imports.

2. Create `src/storage/storage.service.ts` — injects `ConfigType<typeof storageConfig>` via `@Inject(storageConfig.KEY)`:
   - **`createS3Client()`** — private factory: creates `S3Client` with `region: 'us-east-1'`, `endpoint: http://${host}:${port}`, `forcePathStyle: true` (required for MinIO), `credentials: { accessKeyId, secretAccessKey }`
   - **`initiateMultipartUpload(key: string): Promise<{ uploadId: string, key: string }>`** — calls `CreateMultipartUploadCommand` for the video file
   - **`generatePresignedUrls(uploadId: string, key: string, partCount: number): Promise<string[]>`** — generates N presigned URLs (one per part) via `getSignedUrl(s3Client, new UploadPartCommand({...}), { expiresIn })`. Part size is 100MB (passed as metadata, not enforced server-side).
   - **`completeMultipartUpload(uploadId: string, key: string, parts: { ETag: string, PartNumber: number }[]): Promise<void>`** — calls `CompleteMultipartUploadCommand`
   - **`abortMultipartUpload(uploadId: string, key: string): Promise<void>`** — calls `AbortMultipartUploadCommand` (for error recovery)
   - **`getPresignedUrl(key: string): Promise<string>`** — generates presigned GET URL via `getSignedUrl(s3Client, new GetObjectCommand({...}), { expiresIn })`
   - **`uploadThumbnail(key: string, buffer: Buffer, contentType: string): Promise<void>`** — calls `PutObjectCommand` for thumbnail files

3. Create `src/storage/` directory with barrel `index.ts`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Real MinIO: initiate multipart, generate presigned URLs, complete upload, get presigned URL, abort multipart. Upload a small file via presigned URL and verify it's retrievable. |

**Dependencies:** SI-03.1 (MinIO service, storage config)

**Acceptance criteria:**
- `initiateMultipartUpload` returns an UploadId from MinIO
- `generatePresignedUrls` returns N valid presigned PUT URLs
- A file PUT to a presigned URL is stored in MinIO and readable via `getPresignedUrl`
- `abortMultipartUpload` cleans up in-progress multipart upload
- `uploadThumbnail` stores a Buffer as a content-type-aware object in MinIO

---

### SI-03.3 — QueueModule (BullMQ)

**Description:** Create the `QueueModule` and `QueueService` that wraps BullMQ queue operations. This module publishes video processing jobs and will be consumed by the worker.

**Technical actions:**

1. Create `src/queue/queue.module.ts` — imports `BullModule.forRootAsync({ useFactory: ... })` configuring Redis connection from `queue.config.ts`. Registers the `video-processing` queue via `BullModule.registerQueueAsync({ name: 'video-processing' })`. Exports `QueueService` and `BullModule` (so the worker module can access the queue).

2. Create `src/queue/queue.service.ts`:
   - **`publishVideoProcessingJob(videoId: string): Promise<Job>`** — adds a job to the `video-processing` queue with payload `{ videoId }`, options: `{ attempts: 3, backoff: { type: 'exponential', delay: 60000 } }`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/queue.module.spec.ts` | Unit | Module compiles |
| `src/queue/queue.service.integration-spec.ts` | Integration | Real Redis: publish job, verify it's in the queue, verify job payload |

**Dependencies:** SI-03.1 (Redis service, queue config)

**Acceptance criteria:**
- `publishVideoProcessingJob` adds a job to the `video-processing` queue
- Job payload contains the correct `videoId`
- Queue client connects to Redis successfully

---

### SI-03.4 — Video Entity and Migration

**Description:** Create the `Video` entity with a many-to-one relationship to `Channel`. Generate the migration for the `videos` table.

**Technical actions:**

1. Create `src/videos/entities/video.entity.ts`:
   ```
   @Entity('videos')
   export class Video {
     @PrimaryGeneratedColumn('uuid')
     id: string;

     @Column({ length: 255 })
     title: string;

     @Column({ type: 'text', nullable: true })
     description: string;

     @Column({
       type: 'enum',
       enum: ['draft', 'processing', 'ready', 'error'],
       default: 'draft',
     })
     status: VideoStatus;

     @Column({ name: 'storage_key', length: 500 })
     storageKey: string;        // MinIO key: videos/{uuid}.mp4

     @Column({ name: 'thumbnail_key', length: 500, nullable: true })
     thumbnailKey: string;       // MinIO key: thumbnails/{uuid}.jpg

     @Column({ name: 'file_size', type: 'bigint', nullable: true })
     fileSize: number;

     @Column({ length: 50, nullable: true })
     mimeType: string;

     @Column({ type: 'int', nullable: true })
     duration: number;            // in seconds

     @Column({ type: 'int', nullable: true })
     width: number;

     @Column({ type: 'int', nullable: true })
     height: number;

     @Column({ length: 50, nullable: true })
     codec: string;

     @Column({ type: 'text', nullable: true })
     errorMessage: string;        // stored when status = error

     @Column({ name: 'channel_id' })
     channelId: string;

     @ManyToOne(() => Channel)
     @JoinColumn({ name: 'channel_id' })
     channel: Channel;

     @CreateDateColumn({ name: 'created_at' })
     createdAt: Date;

     @UpdateDateColumn({ name: 'updated_at' })
     updatedAt: Date;
   }
   ```

2. Create `src/videos/enums/video-status.enum.ts` — `VideoStatus` enum with `DRAFT = 'draft'`, `PROCESSING = 'processing'`, `READY = 'ready'`, `ERROR = 'error'`.

3. Update `src/channels/entities/channel.entity.ts` — add `@OneToMany(() => Video, video => video.channel)` relation (no migration change — just TypeScript).

4. Generate migration via: `docker compose exec nestjs-api npm run migration:generate -- src/database/migrations/CreateVideos`. Review and adjust if needed.

5. Register `Video` entity in `TypeOrmModule.forFeature([Video])` in `VideosModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Create/save Video linked to Channel, query by ID, query by channel, verify defaults (status: draft, timestamps) |

**Dependencies:** SI-03.1 (database config, app.module.ts)

**Acceptance criteria:**
- Video is saved with `status: 'draft'` by default
- Video is linked to a Channel via `channel_id` FK
- Read/Write operations work correctly in integration test
- Migration runs without errors both for `up` and `down`

---

### SI-03.5 — Upload Flow (Initiate and Complete Multipart Upload)

**Description:** Create the `VideosController` and `VideosService` with endpoints to initiate the multipart upload (pre-cadastro as draft) and complete it. This is the core of the upload flow.

**Technical actions:**

1. Create `src/videos/videos.module.ts` — imports `TypeOrmModule.forFeature([Video])`, `QueueModule`, `StorageModule`. Registers `VideosController`, `VideosService`. Exports `VideosService` (needed by worker in the same process context, though worker is separate).

2. Create `src/videos/videos.service.ts`:
   - **`initiateUpload(channelId: string, fileName: string, fileSize: number, mimeType: string): Promise<InitiateUploadResponse>`** —
     a. Determines file extension from mimeType
     b. Generates UUID for the video
     c. Creates storage key: `videos/{videoId}.{ext}`
     d. Calls `storageService.initiateMultipartUpload(key)` → gets `uploadId`
     e. Calculates part count: `Math.ceil(fileSize / PART_SIZE)` where `PART_SIZE = 100 * 1024 * 1024`
     f. Calls `storageService.generatePresignedUrls(uploadId, key, partCount)` → gets presigned URLs
     g. Creates `Video` record with `status: 'draft'`, `storageKey`, `fileSize`, `mimeType`, `channelId`
     h. Returns `{ videoId, uploadId, partSize: PART_SIZE, parts: presignedUrls }`
   - **`completeUpload(videoId: string, parts: { ETag: string; PartNumber: number }[]): Promise<void>`** —
     a. Finds video by ID, validates status is `draft`
     b. Calls `storageService.completeMultipartUpload(video.uploadId, video.storageKey, parts)`
     c. Updates video status to `'processing'`
     d. Publishes job via `queueService.publishVideoProcessingJob(videoId)`
   - **`abortUpload(videoId: string): Promise<void>`** —
     a. Finds video by ID
     b. Calls `storageService.abortMultipartUpload(...)`
     c. Removes video record (or marks as cancelled)

3. Create `src/videos/dto/initiate-upload.dto.ts`:
   ```typescript
   export class InitiateUploadDto {
     @IsString()
     @IsNotEmpty()
     @MaxLength(255)
     title: string;

     @IsString()
     @IsNotEmpty()
     fileName: string;

     @IsNumber()
     @IsPositive()
     @Max(10 * 1024 * 1024 * 1024) // 10GB
     fileSize: number;

     @IsString()
     @IsNotEmpty()
     mimeType: string;
   }
   ```

4. Create `src/videos/dto/complete-upload.dto.ts`:
   ```typescript
   export class CompleteUploadDto {
     @IsArray()
     @ArrayMinSize(1)
     parts: UploadPartDto[];
   }

   export class UploadPartDto {
     @IsNumber()
     @IsPositive()
     partNumber: number;

     @IsString()
     @IsNotEmpty()
     etag: string;
   }
   ```

5. Create `src/videos/videos.controller.ts`:
   - `POST /videos` (authenticated) — `initiateUpload(req.user.channelId, dto)` → `201 { videoId, uploadId, partSize, parts: [urls] }`
   - `POST /videos/:id/complete` (authenticated) — `completeUpload(id, dto.parts)` → `200 { status: 'processing' }`
   - `POST /videos/:id/abort` (authenticated) — `abortUpload(id)` → `204`

6. Create response DTOs for type safety.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Initiate upload logic (mocked storage/queue), complete/abort flows, status validation |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + real MinIO + real Redis: initiate multipart, upload parts via presigned URLs, complete, verify status, verify job in queue |
| `src/videos/videos.controller.spec.ts` | Unit | HTTP status codes, request validation |
| `test/videos.e2e-spec.ts` | E2E | Full HTTP flow: register user → login → initiate upload → upload part → complete → verify status |

**Dependencies:** SI-03.2 (StorageModule), SI-03.3 (QueueModule), SI-03.4 (Video entity)

**Acceptance criteria:**
- `POST /videos` with valid auth returns 201 with `videoId`, `uploadId`, `partSize`, and `parts` array
- Video record is created with `status: 'draft'`
- A file uploaded via the presigned URLs is stored in MinIO
- `POST /videos/:id/complete` changes status to `'processing'` and publishes a job
- `POST /videos/:id/abort` aborts the multipart upload and cleans up
- Attempting to complete a non-draft video returns an error

---

### SI-03.6 — Video Worker (FFmpeg Processing)

**Description:** Create the video worker — a separate container process that consumes jobs from the BullMQ queue, downloads video from MinIO, extracts metadata with ffprobe, generates a thumbnail with FFmpeg, uploads the thumbnail to MinIO, and updates the video record in the database.

**Technical actions:**

1. Create `src/video-worker/main.ts` — worker entrypoint:
   - Connects to BullMQ queue
   - Listens for `video-processing` jobs
   - Processes each job by calling `VideoProcessor.process(videoId)`

2. Create `src/video-worker/video-processor.ts` — BullMQ `@Processor('video-processing')` class:
   - `@Process()` — `async process(job: Job<{ videoId: string }>)`:
     a. Updates video status to `'processing'`
     b. Calls `ffmpegService.extractMetadata(video.storageKey)` → gets `{ duration, width, height, codec, size }`
     c. Calls `ffmpegService.generateThumbnail(video.storageKey)` → gets `{ buffer, contentType }`
     d. Uploads thumbnail via `storageService.uploadThumbnail(thumbKey, buffer, contentType)`
     e. Updates video: status `'ready'`, thumbnailKey, duration, width, height, codec, fileSize
   - On failure: updates video status to `'error'`, stores error message

3. Create `src/video-worker/ffmpeg.service.ts`:
   - **`generatePresignedUrl(storageKey: string): Promise<string>`** — gets presigned GET URL from storage service
   - **`extractMetadata(presignedUrl: string): Promise<VideoMetadata>`** — runs `ffprobe -v quiet -print_format json -show_format -show_streams {presignedUrl}` and parses JSON output
   - **`generateThumbnail(presignedUrl: string): Promise<{ buffer: Buffer, contentType: string }>`** — runs `ffmpeg -ss 00:00:04 -i {presignedUrl} -vframes 1 -q:v 2 -f image2pipe -` and captures stdout as Buffer

4. Reference the worker in `nest-cli.json` as an additional entry (for `ts-node` support in dev):
   ```json
   "compilerOptions": {
     "assets": [...]
   }
   ```

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/video-worker/ffmpeg.service.integration-spec.ts` | Integration | Real FFmpeg: extract metadata from a sample video, generate thumbnail, verify output format |
| `src/video-worker/video-processor.integration-spec.ts` | Integration | Real Redis + MinIO + DB: publish job, process, verify video status is 'ready', verify thumbnail exists in MinIO |

**Dependencies:** SI-03.2 (StorageModule), SI-03.3 (QueueModule), SI-03.4 (Video entity), SI-03.5 (upload flow)

**Acceptance criteria:**
- Worker starts, connects to Redis, and listens for jobs
- Processing a video extracts: duration (seconds), width, height, codec
- Thumbnail JPEG is generated and stored in MinIO
- Video status transitions from `'draft'` → `'processing'` → `'ready'`
- On failure after 3 retries, status transitions to `'error'` with error message

---

### SI-03.7 — Streaming and Download Endpoints

**Description:** Create endpoints that return presigned GET URLs for streaming (with Range support) and download of processed videos.

**Technical actions:**

1. Add to `VideosController`:
   - `GET /videos/:id` (public) — returns video metadata: title, duration, status, thumbnail URL, channel info, etc.
   - `GET /videos/:id/view` (public) — returns a presigned streaming URL (redirect or JSON). The client uses this URL directly with MinIO, which handles Range requests natively.
   - `GET /videos/:id/download` (authenticated, only video owner) — returns a presigned download URL with `Content-Disposition: attachment` header hint.

2. Add to `VideosService`:
   - **`getVideo(videoId: string)`** — returns video metadata DTO. Only returns if status is `'ready'`.
   - **`getStreamUrl(videoId: string): Promise<string>`** — generates presigned GET URL for the video's storageKey, expires in 24h.
   - **`getDownloadUrl(videoId: string, userId: string): Promise<string>`** — verifies ownership (video belongs to user's channel), generates presigned GET URL.

3. Create response DTOs:
   - `VideoResponseDto` — id, title, status, duration, width, height, thumbnailUrl, channelId, channelName, createdAt
   - `StreamUrlResponseDto` — `{ streamUrl: string, expiresIn: number }`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Get video (various statuses), get stream URL, get download URL with ownership check |
| `test/videos.e2e-spec.ts` (extend) | E2E | Register user → upload video → process → get stream URL → fetch video metadata |

**Dependencies:** SI-03.5 (upload flow), SI-03.6 (worker — must have a processed video to stream)

**Acceptance criteria:**
- `GET /videos/:id` returns video metadata only when status is `'ready'`
- `GET /videos/:id` returns 404 if video status is `'draft'` or `'error'`
- `GET /videos/:id/view` returns a valid presigned streaming URL
- The presigned URL can be used with MinIO to fetch byte ranges (206 Partial Content)
- `GET /videos/:id/download` returns a presigned URL only for the video owner
- Unauthenticated users cannot access download

---

## Technical Specifications

### Data Model

**New entities:**

```
┌─────────────────────────────────────────────────────────────┐
│                       videos                                  │
├─────────────────────────────────────────────────────────────┤
│ id              │ uuid (PK) │ DEFAULT uuid_generate_v4()     │
│ title           │ varchar(255) │ NOT NULL                    │
│ description     │ text │ nullable                            │
│ status          │ enum('draft','processing','ready','error') │
│ storage_key     │ varchar(500) │ NOT NULL                    │
│ thumbnail_key   │ varchar(500) │ nullable                    │
│ file_size       │ bigint │ nullable                          │
│ mime_type       │ varchar(50) │ nullable                     │
│ duration        │ int │ nullable                             │
│ width           │ int │ nullable                             │
│ height          │ int │ nullable                             │
│ codec           │ varchar(50) │ nullable                     │
│ error_message   │ text │ nullable                            │
│ channel_id      │ uuid (FK → channels.id) │ NOT NULL         │
│ created_at      │ TIMESTAMP │ DEFAULT now()                   │
│ updated_at      │ TIMESTAMP │ DEFAULT now()                   │
├─────────────────────────────────────────────────────────────┤
│ INDEXES: channel_id, status                                  │
└─────────────────────────────────────────────────────────────┘
```

**Modified entities:**

- `channels` — add `@OneToMany(() => Video, video => video.channel)` relation (TypeScript only, no schema change)

### API Contracts

All endpoints prefixed with `/videos`.

| Method | Path | Auth | Description | Request | Response |
|--------|------|------|-------------|---------|----------|
| `POST` | `/videos` | Required (channel) | Initiate multipart upload | `{ title, fileName, fileSize, mimeType }` | `201 { videoId, uploadId, partSize, parts: [urls] }` |
| `POST` | `/videos/:id/complete` | Required (owner) | Complete multipart upload | `{ parts: [{ partNumber, etag }] }` | `200 { status: 'processing' }` |
| `POST` | `/videos/:id/abort` | Required (owner) | Abort upload (multipart cleanup) | — | `204` |
| `GET` | `/videos/:id` | Public | Get video metadata | — | `200 VideoResponseDto` or `404` |
| `GET` | `/videos/:id/view` | Public | Get streaming URL | — | `200 { streamUrl, expiresIn }` |
| `GET` | `/videos/:id/download` | Required (owner) | Get download URL | — | `200 { downloadUrl, expiresIn }` |

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner only |
|----------|-----------|---------------|------------|
| `POST /videos` | ❌ | ✅ | — |
| `POST /videos/:id/complete` | ❌ | ✅ | ✅ (must own channel) |
| `POST /videos/:id/abort` | ❌ | ✅ | ✅ (must own channel) |
| `GET /videos/:id` | ✅ | ✅ | ✅ (anyone, if ready) |
| `GET /videos/:id/view` | ✅ | ✅ | ✅ (anyone, if ready) |
| `GET /videos/:id/download` | ❌ | ✅ | ✅ (must own channel) |

**Note:** The JwtAuthGuard is global (from phase-02). Video endpoints that are public (`GET /videos/:id`, `GET /videos/:id/view`) must use `@Public()` decorator. The `Owner only` check is done in the service layer by comparing the authenticated user's channel ID with the video's `channelId`.

### Error Catalog

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `VIDEO_NOT_FOUND` | 404 | Video does not exist (or status is not ready) |
| `VIDEO_NOT_READY` | 409 | Video is not in a playable state (draft/processing/error) |
| `VIDEO_INVALID_STATUS` | 409 | Cannot perform operation on current status (e.g., completing a non-draft video) |
| `VIDEO_UPLOAD_FAILED` | 500 | MinIO multipart upload failed |
| `VIDEO_PROCESSING_FAILED` | 500 | Worker processing failed |
| `VIDEO_FILE_TOO_LARGE` | 413 | File size exceeds 10GB limit |
| `VIDEO_NOT_OWNER` | 403 | User does not own the video's channel |

### Events/Messages

**BullMQ Queue: `video-processing`**

Job payload:
```typescript
interface VideoProcessingJob {
  videoId: string;
}
```

Job options:
- `attempts: 3` — retry up to 3 times
- `backoff: { type: 'exponential', delay: 60000 }` — 1min, then 5min, then 15min

Worker flow:
```
1. Receive job → update video status to 'processing'
2. Get presigned URL from StorageService
3. ffprobe → extract metadata (duration, width, height, codec)
4. ffmpeg → generate thumbnail JPEG buffer
5. Upload thumbnail to MinIO (PutObject)
6. Update video: status='ready', metadata fields, thumbnailKey
7. On error: status='error', errorMessage set
```

## Dependency Map

```
SI-03.1 (Config + Docker)
    ├── SI-03.2 (StorageModule)
    │     └── SI-03.5 (Upload Flow)
    │           ├── SI-03.3 (QueueModule)
    │           │     └── SI-03.6 (Video Worker)
    │           │           └── SI-03.7 (Stream + Download)
    │           └── SI-03.4 (Video Entity)
    │                 └── SI-03.5
    └── SI-03.3
```

**Flow of execution:**
1. SI-03.1 — foundation (no deps)
2. SI-03.2 → depends on 03.1
3. SI-03.3 → depends on 03.1
4. SI-03.4 → depends on 03.1 (app.module.ts has DB config)
5. SI-03.5 → depends on 03.2, 03.3, 03.4
6. SI-03.6 → depends on 03.2, 03.3, 03.5
7. SI-03.7 → depends on 03.5, 03.6 (needs processed video)

## Deliverables

1. **Infrastructure:**
   - Docker Compose with MinIO, Redis, and video-worker services
   - Dockerfile.worker with FFmpeg
   - Named volumes for MinIO persistent storage

2. **Backend modules:**
   - `videos/` — entity, controller, service, DTOs
   - `storage/` — MinIO/S3 client (presigned URLs)
   - `queue/` — BullMQ queue (job publishing)

3. **Worker:**
   - `video-worker/` — main.ts, video-processor.ts, ffmpeg.service.ts

4. **Config:**
   - `storage.config.ts` — MinIO config namespace
   - `queue.config.ts` — Redis/queue config namespace
   - Updated `env.validation.ts` with new vars
   - Updated `.env.example` with storage and queue vars

5. **Database:**
   - Migration creating `videos` table
   - Updated `channels` entity with OneToMany relation

6. **Tests:**
   - Storage: integration tests with real MinIO
   - Queue: integration tests with real Redis
   - Video entity: integration tests with real DB
   - Upload flow: unit + integration + e2e
   - Worker: integration tests with real MinIO + Redis + FFmpeg
   - Streaming/download: e2e tests

7. **Documentation:**
   - Updated project `CLAUDE.md` with video module section
   - Updated `nestjs-project/CLAUDE.md` with new commands and services