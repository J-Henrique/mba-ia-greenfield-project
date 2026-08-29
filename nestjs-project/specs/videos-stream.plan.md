---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-stream.e2e-spec.ts
---

# GET /videos/:id, /videos/:id/stream, /videos/:id/download Test Plan

## Application Overview

Os endpoints de leitura expõem o vídeo processado: `GET /videos/:id` retorna metadados/status e a thumbnail; `GET /videos/:id/stream` retorna uma presigned GET URL do arquivo no MinIO que suporta HTTP Range (streaming sem download completo); `GET /videos/:id/download` retorna uma presigned URL com `Content-Disposition: attachment`. Todos exigem JWT e só liberam o stream/download quando o vídeo está `ready` (per ciclo de status da Fase 03).

## Test Scenarios

### 1. Consulta de vídeo (metadados)

**Setup:** `beforeEach` limpa tabelas de teste; bootstrap com `AppModule` + supertest; seed de vídeos `ready` e não-`ready` de um canal dono + token do dono e token de outro canal.

#### 1.1. get-video-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. GET /videos/{id} com `Authorization: Bearer {dono}` para vídeo `ready`
    - expect: 200 com `status: "ready"`, `durationSeconds`, `width`, `height` e `thumbnailUrl` não-nulo

#### 1.2. get-video-other-channel

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. GET /videos/{id} com `Authorization: Bearer {outro-canal}` para vídeo de outro canal
    - expect: 403 com `errorCode: "FORBIDDEN"`

### 2. Streaming

**Setup:** seed de vídeo `ready` (para os casos de sucesso) e vídeo não-`ready` (para o erro).

#### 2.1. stream-ready-range-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. GET /videos/{id}/stream com `Authorization: Bearer {dono}` para vídeo `ready`
    - expect: 200 com `streamUrl` (presigned GET URL assinada)
  2. Fazer GET na `streamUrl` com header `Range: bytes=0-1023`
    - expect: 206 Partial Content (comportamento nativo MinIO/S3)

#### 2.2. stream-not-ready

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. GET /videos/{id}/stream com `Authorization: Bearer {dono}` para vídeo com `status !== "ready"`
    - expect: 409 com `errorCode: "VIDEO_NOT_READY"`

### 3. Download

**Setup:** seed de vídeo `ready`.

#### 3.1. download-attachment

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-08-29T19:47:28Z

**Steps:**
  1. GET /videos/{id}/download com `Authorization: Bearer {dono}` para vídeo `ready`
    - expect: 200 com `downloadUrl` (presigned GET URL assinada)
  2. Inspecionar a `downloadUrl`
    - expect: contém `response-content-disposition=attachment` (download em vez de inline)
