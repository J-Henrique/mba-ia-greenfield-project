import queueConfig from '../config/queue.config';

/**
 * Nome da fila de processamento — derivado do config (QUEUE_NAME env)
 * para permitir que a suíte de testes isole do worker ao vivo (R3).
 * Avaliado em tempo de import; dotenv (Jest setupFiles) e o Compose
 * garantem que as envs já estejam carregadas neste ponto.
 */
export const QUEUE_NAME = queueConfig().name;

export const PROCESSING_JOB_NAME = 'process-video';
