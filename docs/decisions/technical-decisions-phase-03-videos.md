---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-19
scope_description: "Backend video pipeline: object storage integration, async processing queue, FFmpeg worker, large-file upload, streaming, and thumbnail generation."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that receives the VideosModule, StorageModule, QueueModule, and infrastructure for MinIO, Redis, and the FFmpeg worker.
- `next-frontend/` — Frontend out of scope: video upload UI, player, and management screens are deferred to a future phase.

---

## TD-01: Queue Technology for Async Video Processing

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan leaves the queue technology explicitly open ("TBD"). After a video is uploaded, the system must process it asynchronously — extract metadata, generate a thumbnail — without blocking the API response. The queue must support job retries, concurrency control, and integration with NestJS DI. The project already uses PostgreSQL (no Redis yet), and all workers are Node.js.

**Options:**

### Option A: BullMQ (Redis-backed job queue)

BullMQ is a TypeScript job queue built on top of Redis. NestJS provides `@nestjs/bullmq` — an official module with first-class DI integration, decorator-based workers (`@Processor`, `@Process`), and built-in retry, backoff, and rate limiting.

- **Pros:** Native NestJS integration via `@nestjs/bullmq` (`@Processor`, `@Process` decorators). Built-in job retries with exponential backoff (3 attempts, auto-retry). Concurrency control (limit workers per CPU). Job scheduling, rate limiting, and progress reporting out of the box. BullMQ is the standard NestJS queue solution — most documentation and community examples use it. Redis is lightweight (~5MB Docker image).
- **Cons:** Requires Redis — new infrastructure dependency (not in the current stack). Redis is in-memory — persistence requires AOF/RDB configuration (acceptable for dev). No native fan-out or complex routing (not needed — only one consumer type: the video worker).

### Option B: RabbitMQ (AMQP message broker)

RabbitMQ is a full-featured message broker supporting AMQP, MQTT, and STOMP protocols. NestJS integrates via `@nestjs/microservices` or `amqplib`.

- **Pros:** Mature, battle-tested broker (10M+ weekly downloads). Persistent queues (messages survive broker restarts). Advanced routing (topics, exchanges, bindings) — useful if multiple worker types emerge. Multi-language support (workers in Python/Go/Java possible).
- **Cons:** No native NestJS job-queue module — must use `@nestjs/microservices` (client/server pattern) or raw `amqplib`. No built-in retry mechanism — must implement dead-letter queues manually. Heavier than Redis (~30MB image). Overkill for a single queue + single consumer pattern. No built-in job scheduling or rate limiting.

### Option C: PostgreSQL-based queue (SKIP)

Use PostgreSQL tables as a queue, polled by the worker.

- **Pros:** No new infrastructure — reuses existing PostgreSQL. Transactional consistency with the database. Simple to understand — it's just a table with status.
- **Cons:** Polling is inefficient — requires constant SELECT queries. No built-in retry, backoff, or delayed jobs. No concurrency control. Blocking: `SELECT ... FOR UPDATE SKIP LOCKED` is error-prone. Not a real queue — lacks monitoring, TTL, and job lifecycle management. **Not recommended** for a production video pipeline.

**Recommendation:** **Option A (BullMQ)** — The project has a single queue + single consumer (the video worker), all in Node.js. BullMQ's native NestJS integration (`@nestjs/bullmq`) gives decorator-based workers, built-in retries, and concurrency control with minimal code. Redis is a small, well-understood dependency. RabbitMQ's advanced routing is unnecessary, and PostgreSQL-as-queue is a anti-pattern for this workload.

**Decision:** **A (BullMQ)**

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^6.2.0`, `ioredis@^5.x`

---

## TD-02: Upload Strategy for 10GB Files

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The API must handle video uploads up to 10GB without blocking the Node.js event loop or tying up HTTP connections. The naive approach — receiving the full file body in the API — would consume all available memory, block the event loop during the upload, and make the API unresponsive. The architecture diagram shows the frontend streaming directly from object storage, indicating the upload path should also bypass the API.

**Options:**

### Option A: Presigned Multipart Upload (direct to storage)

The client uploads directly to MinIO/S3 via presigned URLs. The API never touches the file bytes: it initiates a multipart upload, generates one presigned URL per part (~100MB each), and the client uploads parts in parallel. After all parts are uploaded, the client (or API) calls CompleteMultipartUpload.

- **Pros:** **Zero bytes through the API** — the API is never blocked by file I/O. Scales to any file size (AWS S3 supports up to 5TB). Parts can be retried individually (only failed chunks, not the whole file). Parallel upload (faster for large files). Standard S3 API — works identically with MinIO and AWS S3. The API stays responsive during uploads.
- **Cons:** More complex workflow — 4 steps (initiate → presign parts → client upload → complete). Client must handle the multipart logic (splitting, parallel uploads, ETag collection). Requires a backend endpoint to initiate the upload and return presigned URLs. MinIO has a 5GB limit for single PUT — multipart is required for 10GB.

### Option B: API proxy upload (file passes through NestJS)

Client uploads to `POST /videos/upload`, the API receives the file as a stream, writes it to a temporary location, then uploads to storage.

- **Pros:** Simple client logic — single POST with `multipart/form-data`. Backend controls where the file goes. No presigned URL infrastructure needed.
- **Cons:** **Blocks the API** — the Node.js event loop is busy receiving and buffering 10GB. Memory exhaustion risk (file buffer in RAM). Timeout issues (10GB upload takes minutes). The API cannot serve other requests during the upload. **Reprova automática** — the criteria explicitly state: "Passar o arquivo de 10GB pela API de forma que trave o sistema (sem estratégia de upload assíncrono/direto)".

### Option C: Presigned Single PUT (simpler, but limited to 5GB)

Client uploads directly to a single presigned PUT URL. Backend generates one URL, client sends the full file.

- **Pros:** Simpler than multipart — single URL, single PUT. No part splitting or ETag collection. Direct to storage, bypasses API.
- **Cons:** **Limited to 5GB** by MinIO/S3 specification. 10GB is not supported. No retry granularity — failure means re-uploading the entire 10GB. No upload progress tracking on the server side.

**Recommendation:** **Option A (Presigned Multipart Upload)** — The only option that satisfies the 10GB requirement without blocking the API. The multipart workflow is a well-documented S3 pattern. The `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` packages handle the backend side. The client (initially our API tests, later the frontend) manages parts and parallel uploads.

**Specific decisions:**
- **Part size:** 100MB per part (for 10GB → ~100 parts)
- **Bucket:** Single bucket named `streamtube-videos`
- **Key naming:** `videos/{videoId}.{ext}` for video files, `thumbnails/{videoId}.jpg` for thumbnails
- **Lifecycle:** Implement MinIO bucket lifecycle rule to abort incomplete multipart uploads after 1 day, only if implementation is trivial

**Decision:** **A (Presigned Multipart Upload)**

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

---

## TD-03: Worker Architecture — FFmpeg Processing

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados), Geração automática de thumbnail a partir de um frame do vídeo

**Context:** After a video is uploaded to storage, a worker must process it: extract metadata (duration, resolution, codec) using ffprobe, and generate a thumbnail (a single frame from the video, typically at 4-6 seconds) using FFmpeg. The worker runs as a separate container consuming jobs from the BullMQ queue. Since the video is in MinIO, the worker must download it or stream it to FFmpeg. The project is a monorepo, so the worker code can live alongside the NestJS API.

**Options:**

### Option A: Worker as a separate Node.js process, same codebase, using exec/spawn for FFmpeg

The worker is a script in the `nestjs-project/` directory (e.g., `src/video-worker/`). It connects to the same BullMQ queue, downloads the video from MinIO to a temp directory, runs `ffprobe` for metadata, runs `ffmpeg` for thumbnail, uploads the thumbnail back to MinIO, and updates the database. The worker container uses a **separate Dockerfile (`Dockerfile.worker`)** that includes FFmpeg and runs a different entrypoint (`node dist/video-worker/main.js`).

- **Pros:** Single codebase — shares TypeScript types, entities, config, and database connection code. FFmpeg CLI is invoked via `child_process.exec` — no Node.js binding needed. No transpilation step — uses the same `ts-node` setup as the API. Easy to test alongside the API code. Separate Dockerfile means FFmpeg is isolated from the API image.
- **Cons:** FFmpeg must be installed in the container (separate Dockerfile stage or multi-stage build). The worker and API share the same image — different concerns in one image. If the worker crashes, it doesn't affect the API (separate container).

### Option B: Worker in a separate microservice directory

Create a new directory `video-worker/` at the monorepo root with its own `package.json`, Dockerfile, and codebase. Duplicates TypeScript config, entity definitions, and database connection logic.

- **Pros:** Clean separation of concerns — the worker is independent. Can use different Node.js version or runtime. Independent deployment.
- **Cons:** **Duplicates code** — entity definitions, config, database connection, and MinIO client must be duplicated or extracted to a shared lib. The monorepo has no shared lib package. Adds significant complexity for a simple worker that only does 3 things (metadata, thumbnail, update DB).

### Option C: FFmpeg WASM / Node.js binding (fluent-ffmpeg)

Use a Node.js wrapper for FFmpeg such as `fluent-ffmpeg` instead of calling the CLI directly.

- **Pros:** Programmatic API — no raw CLI strings. Error handling is cleaner. Progress events available.
- **Cons:** Still requires FFmpeg binary on the system (fluent-ffmpeg wraps the CLI). Same dependency as Option A. Adds another npm package. More abstraction for a simple use case — `child_process.exec` with 3-4 FFmpeg calls is straightforward. The project already has a pattern of simple exec calls from the NestJS testing guide.

**Recommendation:** **Option A (Worker as same-codebase process)** — The worker is simple (3 operations: metadata, thumbnail, DB update). Sharing entities, config, and database code from the existing NestJS project avoids duplication. The separate container runs the same image with a different entrypoint. FFmpeg CLI is the standard approach — `fluent-ffmpeg` adds an unnecessary wrapper.

**Decision:** **A (Same-codebase worker, FFmpeg CLI via `child_process`)**

**Key detail:** FFmpeg can read directly from a URL (presigned MinIO URL) using HTTP range requests — it does not need to download the full video before processing. The `-ss` flag seeks to the correct position, and FFmpeg only fetches the bytes it needs. This makes thumbnail generation fast even for 10GB videos.

**Libraries:** `fluent-ffmpeg` (optional, for metadata extraction convenience), or raw `child_process` + `ffprobe` for metadata. FFmpeg binary installed in the container image.

---

## TD-04: Unique URL and Streaming Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos; Reprodução via streaming (sem necessidade de download completo)

**Context:** Each video must have a unique, collision-free identifier that forms its public URL. The video must be streamable without requiring the client to download the entire file. The streaming solution must work with MinIO/S3 as the storage backend.

### TD-04a: Unique URL Strategy

**Options:**

### Option A: UUID v4 as the public identifier

Use `uuid_generate_v4()` (already available in PostgreSQL via the `uuid-ossp` extension) as the video's public ID. This is the project's existing convention — all entities use UUIDs.

- **Pros:** Already in the stack — `uuid-ossp` extension is created by the first migration. Collision probability is negligible (2^122 possible values). URL-safe as a string. No generation logic needed — PostgreSQL handles it. Consistent with existing entities (`User`, `Channel`, `RefreshToken`, etc.).
- **Cons:** Longer than a short slug (36 characters with hyphens). Not human-readable. Not sortable by creation time.

### Option B: Short unique slug (e.g., NanoID, base62 hash)

Generate a short alphanumeric string (e.g., 8-12 characters) using a library like NanoID or a base62 encoding of a database sequence.

- **Pros:** Shorter URLs (e.g., `video/abc123xyz`). More user-friendly. Popular in video platforms (YouTube-style).
- **Cons:** New dependency (NanoID). Collision risk increases with shorter IDs — requires collision checking or IDs long enough to make collision negligible. Not consistent with the existing UUID convention. Extra generation logic beyond what PostgreSQL provides.

**Recommendation:** **Option A (UUID v4)** — Consistent with the project's existing convention. Zero new dependencies. The database already has `uuid-ossp`. Collision impossibility is guaranteed. URL length is not a concern for an API — the frontend handles routing.

**Decision:** **A (UUID v4)**

### TD-04b: Streaming Strategy

**Options:**

### Option A: Presigned GET URLs with HTTP Range support

The API generates a presigned GET URL for the video file in MinIO/S3. The client (browser/media player) uses this URL directly. By default, range requests work with presigned URLs — the browser sends `Range` headers, and MinIO responds with `206 Partial Content`. The API endpoint returns the presigned URL, and the client streams directly from storage. **Presigned URL expiration: 24 hours.**

- **Pros:** **Zero bytes through the API** — the API does not proxy video data. Scales to any number of concurrent viewers. MinIO/S3 handles range requests natively. Simple implementation — one endpoint returns a presigned URL. No additional dependencies. The architecture diagram already shows `Rel(frontend, storage, "Streams", "HTTPS")` — this is the intended pattern.
- **Cons:** Presigned URLs expire — must refresh periodically for long videos (mitigated by setting a generous expiration, e.g., 24h). The API must be contacted to get the stream URL (one-time, not per-chunk). No server-side control over streaming (can't throttle, log per-chunk progress).

### Option B: API proxy streaming (NestJS streams the file)

The API receives a request, streams the file from MinIO, and pipes it to the client with `Range` header support.

- **Pros:** Full control over the streaming — logging, throttling, authentication per chunk. The client never talks to MinIO directly. The API can transform the stream (e.g., add watermark).
- **Cons:** **All video traffic goes through the API** — the API becomes a bottleneck. Every byte of every view consumes API resources. The architecture diagram explicitly shows `Rel(frontend, storage, "Streams", "HTTPS")` — not through the API. For a video platform, this is the wrong architecture.

### Option C: HLS (HTTP Live Streaming)

Transcode the video into multiple quality levels and segment it into `.ts` chunks. Serve via HLS manifests (`.m3u8`). Requires transcoding during processing.

- **Pros:** Adaptive bitrate — client switches quality based on network. Industry standard for video platforms. Supported by all modern browsers. Seeking is precise (segment-based).
- **Cons:** Requires video transcoding during processing — significantly more complex worker (multiple resolutions, segmenting). Much more CPU-intensive in the worker. At least 3x the storage cost (multiple quality versions). **HLS is a Phase 05 concern** (video player) — the Fase 03 deliverable is "streaming funcionando", not "adaptive streaming". Over-engineering for this phase.

**Recommendation:** **Option A (Presigned GET with Range support)** — Matches the architecture diagram, bypasses the API for video traffic, and is the simplest implementation. MinIO/S3 natively support HTTP Range requests — no custom streaming code needed. HLS can be added in a future phase if adaptive streaming becomes a requirement.

**Decision:** **A (Presigned GET with HTTP Range)**

---

## TD-05: Video Status Lifecycle

**Scope:** Backend

**Capability:** Transversal — covers all Phase 03 capabilities

**Context:** A video goes through multiple states from creation to playback. The status must be tracked in the database so the API can inform clients of the current state, and the worker knows what to process. The status also determines what operations are allowed (e.g., a video in "processing" cannot be streamed yet).

**Options:**

### Option A: Four-status lifecycle with explicit error state

Statuses: `draft` (upload initiated, pre-cadastro) → `processing` (worker is running) → `ready` (processing succeeded, playable) | `error` (processing failed).

- **draft:** The video record is created immediately when the upload is initiated. No file is fully available yet. The upload is in progress (multipart parts being uploaded). The client can query this status to show "Uploading..." in the UI.
- **processing:** All parts have been uploaded and the upload is complete. The worker has picked up the job and is running FFmpeg/ffprobe. The video is not playable yet.
- **ready:** Processing succeeded. Metadata is populated, thumbnail is generated. The video is playable and downloadable.
- **error:** Processing failed. An error message is stored. The client can retry or the user can re-upload.

- **Pros:** Explicit error state allows the user to know something went wrong and take action. Clear separation between "uploading" and "processing". Follows the project plan's suggestion: "rascunho → processando → pronto/erro".
- **Cons:** Four states to manage and test. Recovery from error requires a new upload.

### Option B: Three-status lifecycle (no error state)

Statuses: `draft` → `processing` → `ready`. On failure, the video stays in `processing` and the worker retries.

- **Pros:** Simpler — fewer states, less code. Retries are handled automatically by BullMQ (TD-01).
- **Cons:** No way to distinguish "still processing" from "failed permanently". After max retries, the video is stuck in `processing` with no feedback to the user. The client cannot display an error state. **Worse user experience** — the user sees "processing" forever.

**Recommendation:** **Option A (Four-status lifecycle)** — The project plan explicitly mentions "pronto/erro". An error state is essential for usability: when processing fails, the user needs to know and act. BullMQ's retry mechanism (TD-01) handles transient failures (3 attempts with exponential backoff), and after max retries, the status transitions to `error` with a stored error message.

**Status flow:**
```
draft → processing → ready
                  ↘ error
```

**Recovery from error:** A new upload must be initiated (the original video file is still in storage, but the processing failed). The plan does not include "reprocess" — this can be added in a future phase.

**Decision:** **A (Four-status: draft → processing → ready/error)**

---

## Decisions Summary

| ID | Decision | Recommendation | Choice |
|----|----------|---------------|--------|
| TD-01 | Queue Technology | BullMQ (Redis-backed) | **A (BullMQ)** |
| TD-02 | Upload Strategy for 10GB | Presigned Multipart Upload | **A (Presigned Multipart Upload)** |
| TD-03 | Worker Architecture | Same-codebase process, FFmpeg CLI via child_process | **A (Same-codebase worker)** |
| TD-04a | Unique URL Strategy | UUID v4 | **A (UUID v4)** |
| TD-04b | Streaming Strategy | Presigned GET with HTTP Range | **A (Presigned GET + Range)** |
| TD-05 | Video Status Lifecycle | Four states: draft → processing → ready/error | **A (Four-status)** |

---

## New Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@nestjs/bullmq` | `^11.0.5` | NestJS queue integration (BullMQ) |
| `bullmq` | `^6.2.0` | Redis-backed job queue |
| `ioredis` | `^5.x` | Redis client (peer dependency of BullMQ) |
| `@aws-sdk/client-s3` | `^3.x` | S3-compatible storage client (MinIO) |
| `@aws-sdk/s3-request-presigner` | `^3.x` | Presigned URL generation for S3/MinIO |
| `fluent-ffmpeg` | (optional) | Metadata extraction and FFmpeg wrapper |

## New Infrastructure (Docker Compose)

| Service | Image | Purpose |
|---------|-------|---------|
| `minio` | `minio/minio` | S3-compatible object storage (video files + thumbnails) |
| `redis` | `redis:7-alpine` | BullMQ queue backend |
| `video-worker` | Custom Dockerfile | FFmpeg processing worker (consumes BullMQ queue) |

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/config/storage.config.ts` | Create | MinIO/S3 config with `registerAs('storage', ...)` |
| `src/config/queue.config.ts` | Create | BullMQ config with `registerAs('queue', ...)` |
| `src/config/env.validation.ts` | Modify | Add storage and queue env vars to Joi schema |
| `src/videos/videos.module.ts` | Create | `VideosModule` with entity, controller, service |
| `src/videos/entities/video.entity.ts` | Create | `Video` entity (linked to Channel) |
| `src/videos/videos.controller.ts` | Create | REST endpoints: initiate upload, get video, stream, download |
| `src/videos/videos.service.ts` | Create | Business logic: upload initiation, status queries, streaming |
| `src/videos/dto/` | Create | DTOs for requests (initiate-upload, etc.) |
| `src/storage/storage.module.ts` | Create | MinIO/S3 client module |
| `src/storage/storage.service.ts` | Create | Presigned URL generation, file operations |
| `src/queue/queue.module.ts` | Create | BullMQ queue module |
| `src/queue/queue.service.ts` | Create | Job publishing helper |
| `src/video-worker/main.ts` | Create | Worker entrypoint (separate process) |
| `src/video-worker/video-processor.ts` | Create | BullMQ consumer: metadata extraction, thumbnail generation |
| `src/video-worker/ffmpeg.service.ts` | Create | FFmpeg/ffprobe CLI wrapper |
| `src/database/migrations/<timestamp>-CreateVideos.ts` | Create | Migration for `videos` table |
| `compose.yaml` | Modify | Add MinIO, Redis, video-worker services |
| `Dockerfile.dev` | Modify | Add FFmpeg installation |
| `.env.example` | Modify | Add storage, queue, and MinIO env vars |
| `CLAUDE.md` (nestjs-project + root) | Modify | Add video section |
| `nest-cli.json` | Modify | Add `video-worker` as a project entry for `ts-node` support |