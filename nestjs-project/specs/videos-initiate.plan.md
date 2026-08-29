---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-initiate.e2e-spec.ts
---

# POST /videos/initiate Test Plan

## Application Overview

O endpoint `POST /videos/initiate` inicia o upload de um vídeo de até 10GB. Autenticado (JWT), ele pré-registra o vídeo como `draft` no banco, inicia um multipart upload no MinIO/S3 e retorna as presigned URLs das partes (~100MB cada) para o cliente enviar o arquivo direto ao storage, sem passar pela API. Este spec cobre o contrato HTTP do endpoint e o pré-cadastro.

## Test Scenarios

### 1. Iniciação de upload

**Setup:** `beforeEach` limpa as tabelas de teste (DELETE FROM videos/channels); bootstrap do módulo de teste com `Test.createTestingModule({ imports: [AppModule] })` + supertest; token JWT válido de um canal dono autenticado.

#### 1.1. initiate-valid-upload

**Covers AC:** #1, #4
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. POST /videos/initiate com `Authorization: Bearer {jwt}` e body `{ filename: "aula.mp4", mimeType: "video/mp4", fileSize: 200000000 }`
    - expect: 201 com `video.status === "draft"`, `parts` com ≥2 presigned URLs (arquivo de 200MB → 2 partes de 100MB)
  2. Consultar o banco (repo `Video` ou SQL direto)
    - expect: registro `videos` existe com `status: "draft"` e `video_key = "videos/{videoId}.mp4"`

#### 1.2. initiate-without-auth

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. POST /videos/initiate sem header `Authorization`
    - expect: 401 Unauthorized

#### 1.3. initiate-file-too-big

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. POST /videos/initiate com `Authorization: Bearer {jwt}` e body `{ filename: "huge.mp4", mimeType: "video/mp4", fileSize: 11000000000 }` (11GB > 10GB)
    - expect: 413 com `errorCode: "FILE_TOO_BIG"`
