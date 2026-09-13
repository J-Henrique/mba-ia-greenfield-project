import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import queueConfig from '../config/queue.config';
import { QUEUE_NAME, PROCESSING_JOB_NAME } from './queue.constants';
import { QueueModule } from './queue.module';
import { QueueService } from './queue.service';

describe('QueueService (integration — Redis)', () => {
  let queueService: QueueService;
  let queue: Queue;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    queueService = module.get(QueueService);
    queue = module.get(getQueueToken(QUEUE_NAME));
  });

  afterAll(async () => {
    // Clean up jobs from the test queue
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('should enqueue a processing job with the correct payload', async () => {
    const jobId = await queueService.publishProcessingJob({
      videoId: 'test-video-uuid',
      channelId: 'test-channel-uuid',
      videoKey: 'videos/test-video-uuid.mp4',
    });

    expect(jobId).toBeDefined();
    expect(typeof jobId).toBe('string');

    // Busca o job pelo ID para verificar o payload e opções
    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESSING_JOB_NAME);
    expect(job!.data).toEqual({
      videoId: 'test-video-uuid',
      channelId: 'test-channel-uuid',
      videoKey: 'videos/test-video-uuid.mp4',
    });
  });

  it('should configure retry with 3 attempts and exponential backoff', async () => {
    const jobId = await queueService.publishProcessingJob({
      videoId: 'retry-test-uuid',
      channelId: 'retry-channel-uuid',
      videoKey: 'videos/retry-test.mp4',
    });

    const job = await queue.getJob(jobId);
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({
      type: 'exponential',
      delay: 1000,
    });
  });
});
