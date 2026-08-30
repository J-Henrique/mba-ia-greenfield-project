# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/9 completed

### SI-03.1 — Infra: dependências, config namespaces e Docker Compose
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Instaladas 5 dependências (as listadas no technical action do SI). O AC cita "6 novas dependências", mas o `fluent-ffmpeg` (6ª na tabela do decisions doc) é marcado como opcional e não é usado — o worker usa `child_process` para FFmpeg (TD-03 Option A), então não é instalado.
  - `storageConfig` e `queueConfig` também foram registradas no `load[]` do `app.module.ts` (padrão do repo) — o SI não listava explicitamente esse passo, mas sem ele os namespaces não seriam injetáveis.
  - `.env.example` atualizado com as envs de storage/queue (item do decisions doc, encaixado aqui no SI de config).

### SI-03.2 — Entidade Video + migration CreateVideos
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.2.1 — Atualizar suíte de teste existente para a tabela `videos`
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.3 — StorageModule com MinIO (S3)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.4 — QueueModule com BullMQ
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.5 — VideosModule + POST /videos/initiate
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.6 — POST /videos/:id/complete
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.7 — Video Worker (FFmpeg)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.8 — GET /videos/:id, /videos/:id/stream, /videos/:id/download
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
