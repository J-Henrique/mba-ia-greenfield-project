---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-19T10:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-19T10:00:00-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-05-12T12:21:12-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Telas de upload, player, gerenciamento de vídeos no frontend — toda a interface de vídeo é diferida para fases posteriores (Fase 04+). Comentários, likes, inscrições e demais interações sociais.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — interface de vídeo, player e upload UI ficam diferidos para fases futuras.

**Sequencing notes:** Depende de Fases 01 e 02 (infraestrutura base, autenticação, usuários e canais). A entidade Video é vinculada ao Channel (criado na Fase 02).

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Queue Technology for Async Video Processing | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.0.5, bullmq@^6.2.0, ioredis@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload Strategy for 10GB Files | decided | A (Presigned Multipart Upload) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Worker Architecture — FFmpeg Processing | decided | A (Same-codebase worker, FFmpeg CLI) | fluent-ffmpeg (optional) |
| phase-03-videos/TD-04a | technical-decisions-phase-03-videos.md | Backend | Unique URL Strategy | decided | A (UUID v4) | — |
| phase-03-videos/TD-04b | technical-decisions-phase-03-videos.md | Backend | Streaming Strategy | decided | A (Presigned GET with HTTP Range) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | A (Four-status: draft → processing → ready/error) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-04b |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-01, phase-03-videos/TD-03 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04a |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04b |
| Download do vídeo pelo usuário | phase-03-videos/TD-04b |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ) — The project has a single queue + single consumer (the video worker), all in Node.js. BullMQ's native NestJS integration (`@nestjs/bullmq`) gives decorator-based workers, built-in retries, and concurrency control with minimal code. Redis is a small, well-understood dependency. RabbitMQ's advanced routing is unnecessary, and PostgreSQL-as-queue is an anti-pattern for this workload.

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^6.2.0`, `ioredis@^5.x`

### phase-03-videos/TD-02

**Recommendation:** Option A (Presigned Multipart Upload) — The only option that satisfies the 10GB requirement without blocking the API. The multipart workflow is a well-documented S3 pattern. The `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` packages handle the backend side.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Option A (Same-codebase worker) — The worker is simple (3 operations: metadata, thumbnail, DB update). Sharing entities, config, and database code from the existing NestJS project avoids duplication. The separate container runs the same image with a different entrypoint. FFmpeg CLI is the standard approach.

**Libraries:** `fluent-ffmpeg` (optional, for metadata extraction convenience)

### phase-03-videos/TD-04a

**Recommendation:** Option A (UUID v4) — Consistent with the project's existing convention. Zero new dependencies. The database already has `uuid-ossp`. Collision impossibility is guaranteed.

**Libraries:** —

### phase-03-videos/TD-04b

**Recommendation:** Option A (Presigned GET with HTTP Range) — Matches the architecture diagram, bypasses the API for video traffic, and is the simplest implementation. MinIO/S3 natively support HTTP Range requests — no custom streaming code needed.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Option A (Four-status lifecycle) — The project plan explicitly mentions "pronto/erro". An error state is essential for usability. BullMQ's retry mechanism handles transient failures (3 attempts with exponential backoff), and after max retries, the status transitions to `error` with a stored error message.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- NestJS modules follow the standard structure: `@Module({ imports, controllers, providers, exports })` with `TypeOrmModule.forFeature([...])` in domain module imports. _(from phase 02)_
- JWT auth guard is global (`APP_GUARD`), with `@Public()` decorator for public endpoints. _(from phase 02)_
- Error responses follow `{ statusCode, error, message }` format via `DomainExceptionFilter`. _(from phase 02)_
- Test suffixes: `*.spec.ts` (unit), `*.integration-spec.ts` (integration), `*.e2e-spec.ts` (e2e). _(from phase 02)_
- Integration tests use the real database; tests run with `--runInBand`. _(from phase 02)_
- All commands run inside Docker container, never on host (`docker compose exec nestjs-api`). _(from phase 01/02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Telas de upload, player e gerenciamento de vídeos | deferred | Frontend (next-frontend/) fora do escopo da Fase 03 — será abordado em fase futura (Fase 04+) | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces:

- **New domain module:** `videos/` — entity, service, controller (unit + integration + e2e)
- **New infrastructure modules:** `storage/` (MinIO/S3), `queue/` (BullMQ) — integration tests with real MinIO and Redis containers
- **New worker:** `video-worker/` — integration tests with real MinIO, Redis, and FFmpeg
- **New Docker services:** MinIO, Redis, video-worker — all must be exercised by tests

Specific layer coverage by SI will be recorded in `progress.md`.