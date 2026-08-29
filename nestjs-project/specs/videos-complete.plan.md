---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos-complete.e2e-spec.ts
---

# POST /videos/:id/complete Test Plan

## Application Overview

O endpoint `POST /videos/:id/complete` conclui um upload multipart previamente iniciado: valida ownership (canal dono) e status (`draft`), consolida as partes no MinIO via `CompleteMultipartUpload`, marca o vídeo como `processing` e publica um job na fila `video-processing` (BullMQ) para o worker processar. Este spec cobre o contrato HTTP, os erros de domínio e o efeito colateral de fila.

## Test Scenarios

### 1. Conclusão de upload

**Setup:** `beforeEach` limpa as tabelas de teste (via `cleanAllTables`), limpa a fila Redis (dedicated test queue) e chama `throttlerStorage.storage.clear()` (R4 — limpa o contador do rate limiter global de 10 req/min entre testes; mesmo padrão do `auth.e2e-spec.ts`); bootstrap com `AppModule` + supertest; seed de um vídeo `draft` de um canal dono + token JWT do dono; token de um segundo canal (outro) para os casos de ownership.

**Ciclo multipart real (R2):** para os casos de sucesso, os `parts` NÃO usam etag fake — o teste executa o ciclo real:
1. `POST /videos/initiate` (com o mesmo token do dono) para obter `uploadId` + `parts[]` com presigned URLs reais;
2. `PUT` em cada presigned URL com payload real (`Buffer` pequeno, ex. 1KB — partes configuráveis via `STORAGE_PART_SIZE_MB`); o `ETag` do header de resposta do PUT é capturado;
3. `POST /videos/:id/complete` com `{ partNumber, etag }` dos PUTs reais.
*(Se o ambiente de teste não tiver MinIO, a assinatura pode ser obtida sem rede via presigned URL — mas o contrato de `etag` real é obrigatório.)*

#### 1.1. complete-valid-upload

**Covers AC:** #1, #4
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. Executar o ciclo multipart real (ver Setup): `POST /videos/initiate` com `Authorization: Bearer {dono}` → `PUT` nas presigned URLs com payload pequeno capturando `ETag` → `POST /videos/{id}/complete` com `Authorization: Bearer {dono}` e body `{ parts: [{ partNumber: 1, etag: "<etag-real-1>" }, { partNumber: 2, etag: "<etag-real-2>" }] }`
    - expect: 204 No Content
  2. Consultar o banco (repo `Video` ou SQL)
    - expect: `status === "processing"` no registro
  3. Inspecionar a fila `video-processing` (via `getQueueToken('video-processing')` e `queue.getJobs(['waiting','active'])`)
    - expect: 1 job com payload `{ videoId, channelId, videoKey }` coerente

#### 1.2. complete-other-channel-forbidden

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. POST /videos/{id}/complete com `Authorization: Bearer {outro-canal}` (vídeo de outro canal) e body de parts válido
    - expect: 403 com `errorCode: "FORBIDDEN"`

#### 1.3. complete-invalid-status

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. Pré-condição: vídeo já em `processing` (não `draft`)
  2. POST /videos/{id}/complete com `Authorization: Bearer {dono}` e body de parts válido
    - expect: 400 com `errorCode: "INVALID_STATUS"`
