import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export interface PublishProcessingJobData {
  videoId: string;
  channelId: string;
  videoKey: string;
}

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue('video-processing')
    private readonly videoProcessingQueue: Queue,
  ) {}

  async publishProcessingJob(data: PublishProcessingJobData): Promise<string> {
    const job = await this.videoProcessingQueue.add('process-video', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    });
    return job.id!;
  }
}
