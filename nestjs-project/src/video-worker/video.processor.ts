import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { PROCESSING_JOB_NAME, QUEUE_NAME } from '../queue/queue.constants';
import { FfmpegService } from './ffmpeg.service';

export interface ProcessingJobData {
  videoId: string;
  channelId: string;
  videoKey: string;
}

@Processor(QUEUE_NAME)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<ProcessingJobData>): Promise<void> {
    const { videoId, videoKey } = job.data;

    this.logger.log(`Processing video ${videoId} (key: ${videoKey})`);

    const presignedUrl =
      await this.storageService.generatePresignedGetUrl(videoKey);

    const metadata = await this.ffmpegService.probe(presignedUrl);
    this.logger.log(
      `Probe done: ${metadata.durationSeconds}s, ${metadata.width}x${metadata.height}, ${metadata.codec}`,
    );

    const thumbnailBuffer = await this.ffmpegService.extractThumbnail(
      presignedUrl,
    );
    const thumbnailKey = `thumbnails/${videoId}.jpg`;
    await this.storageService.uploadThumbnail(
      thumbnailKey,
      thumbnailBuffer,
      'image/jpeg',
    );
    this.logger.log(
      `Thumbnail uploaded: ${thumbnailKey} (${thumbnailBuffer.length} bytes)`,
    );

    await this.videoRepository.update(
      { id: videoId },
      {
        status: VideoStatus.READY,
        duration_seconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        codec: metadata.codec,
        thumbnail_key: thumbnailKey,
      },
    );

    this.logger.log(`Video ${videoId} processed successfully`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessingJobData>, error: Error): Promise<void> {
    this.logger.error(
      `Video ${job.data.videoId} failed after retries: ${error.message}`,
    );
    await this.videoRepository.update(
      { id: job.data.videoId },
      { status: VideoStatus.ERROR, error_message: error.message },
    );
  }
}