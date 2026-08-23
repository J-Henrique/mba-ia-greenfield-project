---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-22T22:00:56.648506940-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-23T16:43:00.122181501-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-22T22:00:56.644499386-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-22T22:00:56.647056573-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-22T22:00:56.647671188-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-22T22:00:56.647124143-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-22T22:00:56.614095184-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

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

**Out of scope:** Telas de upload, player de vídeo e gerenciamento de vídeos no frontend — toda a interface de vídeo é diferida para fases posteriores (Fase 04+). Comentários, likes, inscrições e demais interações sociais. HLS/streaming adaptativo (Fase 05). Edição/gestão pós-upload de vídeo (Fase 04).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (API + worker + infra de storage/fila). Não há interfaces de vídeo.

**Deferred subprojects:** `next-frontend/` — interface de vídeo, player e upload UI ficam diferidos para fases futuras.

**Sequencing notes:** Depende de: Fase 01, Fase 02. A entidade Video é vinculada ao Channel (criado na Fase 02). É pré-requisito da Fase 04.

**Neighbors (for boundary detection only):**

- **Phase 2:** Cadastro, login, confirmação de conta e recuperação de senha — completa autenticação/usuários/canais (depende da Fase 01).
- **Phase 4:** Gerenciamento de Vídeos e Canal — edição de informações do vídeo, rascunho/publicação, painel do canal (depende das Fases 02 e 03).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Queue Technology for Async Video Processing | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.0.5, bullmq@^6.2.0, ioredis@^5.x |
| phase-03-videos/TD-02 | phase | Backend | Upload Strategy for 10GB Files | decided | A (Presigned Multipart Upload) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | phase | Backend | Worker Architecture — FFmpeg Processing | decided | A (Same-codebase worker, FFmpeg CLI via child_process) | fluent-ffmpeg (optional), child_process + ffprobe |
| phase-03-videos/TD-04a | phase | Backend | Unique URL Strategy | decided | A (UUID v4) | — |
| phase-03-videos/TD-04b | phase | Backend | Streaming Strategy | decided | A (Presigned GET with HTTP Range) | — |
| phase-03-videos/TD-05 | phase | Backend | Video Status Lifecycle | decided | A (Four-status: draft → processing → ready/error) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-04b, phase-03-videos/TD-05 (transversal) |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05 (transversal) |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-05 (transversal) |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-05, phase-03-videos/TD-02 (draft = pre-cadastro) |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-01, phase-03-videos/TD-03, phase-03-videos/TD-05 (transversal) |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-05 (transversal) |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04a, phase-03-videos/TD-05 (transversal) |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04b, phase-03-videos/TD-05 (transversal) |
| Download do vídeo pelo usuário | phase-03-videos/TD-04b, phase-03-videos/TD-05 (transversal) |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** The project has a single queue + single consumer (the video worker), all in Node.js. BullMQ's native NestJS integration (`@nestjs/bullmq`) gives decorator-based workers, built-in retries, and concurrency control with minimal code. Redis is a small, well-understood dependency. RabbitMQ's advanced routing is unnecessary, and PostgreSQL-as-queue is an anti-pattern for this workload.

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^6.2.0`, `ioredis@^5.x`

### phase-03-videos/TD-02

**Recommendation:** The only option that satisfies the 10GB requirement without blocking the API. The multipart workflow is a well-documented S3 pattern. The `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` packages handle the backend side. The client (initially our API tests, later the frontend) manages parts and parallel uploads.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** The worker is simple (3 operations: metadata, thumbnail, DB update). The worker lives in the same NestJS codebase to share entities, config, and the MinIO/DB clients — a separate codebase would duplicate all of them. The monorepo shares Dockerfiles, so the worker container reuses the API image with a different entrypoint, keeping FFmpeg isolated. FFmpeg CLI via `child_process` is the standard approach; `fluent-ffmpeg` adds an unnecessary wrapper.

**Libraries:** `fluent-ffmpeg` (optional, for metadata convenience), or raw `child_process` + `ffprobe` for metadata. FFmpeg binary installed in the container image.

### phase-03-videos/TD-04a

**Recommendation:** Consistent with the project's existing convention. Zero new dependencies. The DB already has `uuid-ossp` (created by the first migration). UUID collision is guaranteed-impossible, and URL length is not a concern for the API.

**Libraries:** —

### phase-03-videos/TD-04b

**Recommendation:** Matches the architecture diagram — the frontend streams directly from storage, bypassing the API. MinIO/S3 natively support HTTP Range requests, so no custom streaming code is needed. HLS can be added in a future phase if adaptive streaming becomes a requirement.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** The plan explicitly mentions "pronto/erro". An error state is essential for usability. BullMQ's retry mechanism (TD-01) handles transient failures (3 attempts with exponential backoff), and after max retries the status transitions to `error` with a stored error message. The `draft → processing → ready/error` flow with four explicit statuses cleanly separates "uploading" from "processing" and gives clients a clear state to display.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (`@nestjs/config`) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. `registerAs()` factory solves the TypeORM CLI sharing problem (plain-importable function + DI token).

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class `validationSchema` integration in `@nestjs/config`, zero custom wiring, native coercion of strings to numbers.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — per-domain file boundaries (auth, email, storage), typed `ConfigType` injection, dual-purpose factory (DI token + plain-importable function).

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication.

**Libraries:** `@nestjs/config` (dotenv transitive)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended for a 2026 greenfield; native build is a one-time Docker cost; no bcrypt legacy. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (`@nestjs/passport`) — low-cost plugin architecture for possible social login later; aligns with official NestJS docs.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — strongest security model with automatic theft detection; DB write overhead acceptable (auth refresh is infrequent); PostgreSQL already in stack.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — revocability for password resets, trivial table, also serves future needs (API keys); decoupled from JWT.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (`@nestjs-modules/mailer`) — best NestJS integration, SMTP matching architecture, MailHog/Mailpit local dev, Handlebars, no vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — backend-only project, so Zod's shared-schema edge is minor; noted NestJS approach; decorators consistent with TypeORM/NestJS.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — machine-readable error codes, `{ statusCode, error, message }` format, no RFC 9456 overhead, cost low.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (`@nestjs/throttler`) — native guard, scopes rate limiting to AuthModule via `APP_GUARD` + `@SkipThrottle()`.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque tokens) — DB lookup is mandatory (TD-03), so JWT signature adds no extra security. **Divergence note:** JWT kept to reuse `@nestjs/jwt` infrastructure (per implementation decision).

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — video platform handle = URL-based channel handle; strict `[a-z0-9_]` allowlist, `user_<random>` fallback.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Cookie session (iron-session) over Auth.js — strict-BFF fit, small blast radius, Next.js 16/React 19 compatibility.

**Libraries:** `iron-session`

### phase-02-auth-frontend/TD-02

**Recommendation:** Encrypted cookie — defense-in-depth (`httpOnly` + encryption), single cookie simplifies logout, minimal metadata in cookie.

**Libraries:** `iron-session`

### phase-02-auth-frontend/TD-03

**Recommendation:** Single-flight refresh in the session helper from day one.

**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** react-hook-form + @hookform/resolvers — matches shadcn form primitive, Zod-first consistency.

**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Option A (Route Handlers-as-functions for all mutations) — strict-BFF alignment, single mutation surface, MSW/BFF scaffold reused.

**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** RSC owns the session, Client Provider hydrates from initial state — no first-render flicker, no round-trip.

**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** RSC owns the token, Client Component owns the input for both token flows — first-paint-correct, single integration pattern.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — the only option that preserves prior decisions (`class-validator` via phase-02/TD-06) without re-platform; CLI plugin with `classValidatorShim: true` infers DTO schemas from existing `class-validator` decorators, keeping boilerplate low. OpenAPI for Fase 03's new endpoints (upload, streaming, download) follows this policy.

**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Runtime UI + `openapi.json` exported) — one small npm script plus interactive UI; correct foundation for future FE codegen without compromising dev/QA use.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (dev/staging only via env flag) — aligns with the defensive posture already set in phase 02 (`@nestjs/throttler`); `openapi.json` committed covers the consult case; re-open to A/C is trivial if a public API case appears.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env vars are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import "dotenv/config"` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- NestJS modules follow the standard structure: `@Module({ imports, controllers, providers, exports })` with `TypeOrmModule.forFeature([...])` in domain module imports. _(from phase 02)_
- JWT auth guard is global (`APP_GUARD`), with `@Public()` decorator for public endpoints. _(from phase 02)_
- Error responses follow `{ statusCode, error, message }` format via the custom `DomainExceptionFilter`. _(from phase 02)_
- Test suffixes: `*.spec.ts` (unit), `*.integration-spec.ts` (integration), `*.e2e-spec.ts` (e2e). _(from phase 02)_
- Integration tests use the real database; tests run with `--runInBand`. _(from phase 02)_
- All commands run inside Docker container, never on host (`docker compose exec nestjs-api`). _(from phase 01/02)_

## Inherited Deferred Capabilities

No inherited deferred capabilities.

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Telas de upload, player e gerenciamento de vídeos no frontend | deferred | Frontend (next-frontend/) fora do escopo da Fase 03 — será abordado em fase futura (Fase 04+) | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces:

- **New domain module:** `videos/` — entity, service, controller (unit + integration + e2e)
- **New infrastructure modules:** `storage/` (MinIO/S3), `queue/` (BullMQ) — integration tests with real MinIO and Redis containers
- **New worker:** `video-worker/` — integration tests with real MinIO, Redis, and FFmpeg
- **New Docker services:** MinIO, Redis, video-worker — all must be exercised by tests

**Test layer key expectation derived from the skill:**
- Entity (`Video`) → integration (constraints, defaults).
- VideoService (branching + DB + storage/queue side-effect deps) → unit (mock repo at the bound: branch transitions, draft pre-cadastro, presigned generation) + integration (real DB queries, real MinIO local adapter, real Redis/BullMQ enqueue).
- StorageService (side-effect dep) → integration via local filesystem adapter or MinIO; no mocks.
- QueueService → integration (real Redis container, assert job enqueued).
- Controllers → e2e only (not unit).
- VideoWorker (BullMQ consumer + FFmpeg) → integration with real MinIO, Redis, FFmpeg.
- Exception mapping must stay in `DomainExceptionFilter` (already tested in phase 02) — new domain exceptions map there.
- Mock boundary rule: mock `UsersService`/`ChannelsService`—not internals; use real `JwtModule`/`BullMQ` with test config when they are configured libs.

---