---
kind: phase
name: phase-03-videos
date: 2026-08-19
---

# phase-03-videos — Library References

## Production Dependencies

### @nestjs/bullmq@^11.0.5

**Purpose:** NestJS module for BullMQ queue integration. Provides `@Processor()`, `@Process()` decorators, `BullModule.registerQueueAsync()`, and DI integration.

**Alternatives considered:** RabbitMQ (via `@nestjs/microservices`), PostgreSQL-as-queue.

**Why chosen:** Native NestJS integration with decorator-based workers, built-in retry with exponential backoff, concurrency control, and rate limiting. Redis container is lightweight (~5MB image). Single queue + single consumer pattern makes BullMQ the natural fit.

**Usage:** `BullModule.registerQueueAsync({ name: 'video-processing' })` in QueueModule. Worker uses `@Processor('video-processing')` and `@Process()` decorators.

---

### bullmq@^6.2.0

**Purpose:** Core BullMQ library. Manages job queue on Redis, retries, backoff, concurrency.

**Alternatives considered:** N/A (paired with @nestjs/bullmq).

**Why chosen:** Industry standard for Node.js job queues. v6 supports Redis 7.

---

### ioredis@^5.x

**Purpose:** Redis client (peer dependency of BullMQ). Connects to Redis server for queue storage.

**Alternatives considered:** N/A (required by BullMQ).

---

### @aws-sdk/client-s3@^3.x

**Purpose:** AWS SDK v3 S3 client. Used to communicate with MinIO (S3-compatible storage). Handles `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `PutObject`, `GetObject`.

**Alternatives considered:** `minio` npm package (official MinIO client).

**Why chosen:** Works identically with MinIO (dev) and AWS S3 (prod). Zero code changes when switching storage providers. The `minio` package is MinIO-specific and would not work with S3 without changes.

**Usage:** Instantiated with custom endpoint pointing to MinIO (`http://minio:9000` in dev). Uses `forcePathStyle: true` for MinIO compatibility.

---

### @aws-sdk/s3-request-presigner@^3.x

**Purpose:** Generates presigned URLs from S3 commands. Used for multipart upload initiation (`UploadPartCommand`) and streaming/download (`GetObjectCommand`).

**Alternatives considered:** N/A (pairs with @aws-sdk/client-s3).

**Why chosen:** Official AWS presigner for SDK v3. Works with MinIO.

---

### fluent-ffmpeg (optional)

**Purpose:** Node.js wrapper for FFmpeg CLI. Used for metadata extraction (`ffprobe`) and thumbnail generation.

**Alternatives considered:** Raw `child_process.exec` with FFmpeg CLI directly.

**Why chosen (if used):** Provides a programmatic API instead of raw CLI strings. Still requires FFmpeg binary on the system (installed via Dockerfile). Marked optional — can be replaced by direct CLI calls if the abstraction adds unnecessary complexity.

**Usage (worker):** `ffprobe(path)` for metadata → `ffmpeg -ss 00:00:04 -i {videoUrl} -vframes 1 -q:v 2 thumb.jpg` for thumbnail.

## Infrastructure

### minio/minio (Docker image)

**Purpose:** S3-compatible object storage. Stores video files and thumbnails.

**Configuration:**
- Ports: `9000` (API), `9001` (console)
- Environment: `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`
- Volume: `/data` for persistent storage
- Bucket: `streamtube-videos` (created on startup via init script or console)

**Dev vs Prod:** MinIO in dev, AWS S3 in prod. Same SDK, zero code changes.

### redis:7-alpine (Docker image)

**Purpose:** In-memory data store for BullMQ queue backend.

**Configuration:**
- Port: `6379`
- No persistence needed for dev (queue jobs are ephemeral; if Redis restarts, unprocessed jobs fail and can be re-queued)

### Dockerfile.worker

**Purpose:** Custom Docker image for the video processing worker.

**Base image:** Same as `nestjs-api` (Node.js), plus FFmpeg installation.

**Entrypoint:** `node src/video-worker/main.ts` (via ts-node) or compiled `dist/video-worker/main.js`.

**FFmpeg installation:** `apt-get install -y ffmpeg` or multi-stage build.