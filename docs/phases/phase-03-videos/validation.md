---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-19T10:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-19T10:00:00-03:00"
issues: []
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None — frontend out of scope for this phase._

## Resolved Issues

### I-01 — Estratégia de organização de buckets e chaves no MinIO
**Resolution:** Bucket único `streamtube-videos`. Chaves: `videos/{videoId}.{ext}` para arquivos de vídeo, `thumbnails/{videoId}.jpg` para thumbnails. Lifecycle de multiparts órfãos: implementar apenas se for trivial.

### I-02 — Worker depende de FFmpeg no container
**Resolution:** Dockerfile separado (`Dockerfile.worker`) com FFmpeg instalado. O worker container usa este Dockerfile.

### I-03 — Tamanho das partes do multipart upload
**Resolution:** 100MB por parte. Para 10GB, ~100 partes.

### I-04 — Novas configurações de env (MinIO, Redis)
**Resolution:** Adicionar `storage.config.ts` e `queue.config.ts` no padrão registerAs. Validar via Joi. Atualizar .env.example.

### I-05 — Expiração da presigned URL para streaming
**Resolution:** 24 horas.

### I-06 — Worker precisa de entrypoint separado e Dockerfile
**Resolution:** Dockerfile separado (`Dockerfile.worker`) com FFmpeg e entrypoint para `video-worker/main.ts`.