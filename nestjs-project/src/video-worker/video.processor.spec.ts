import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessor, ProcessingJobData } from './video.processor';

// ── helpers ────────────────────────────────────────────────────────
function makeRepository(): jest.Mocked<Pick<Repository<Video>, 'update'>> {
  return { update: jest.fn().mockResolvedValue({ affected: 1 }) };
}

function makeStorageService(): jest.Mocked<
  Pick<StorageService, 'generatePresignedGetUrl' | 'uploadThumbnail'>
> {
  return {
    generatePresignedGetUrl: jest
      .fn()
      .mockResolvedValue('https://minio/presigned-url'),
    uploadThumbnail: jest.fn().mockResolvedValue(undefined),
  };
}

function makeFfmpegService(): jest.Mocked<
  Pick<FfmpegService, 'probe' | 'extractThumbnail'>
> {
  return {
    probe: jest.fn().mockResolvedValue({
      durationSeconds: 6,
      width: 640,
      height: 360,
      codec: 'h264',
    }),
    extractThumbnail: jest.fn().mockResolvedValue(Buffer.alloc(1024, 0xff)),
  };
}

function makeJob(
  overrides: Partial<ProcessingJobData> = {},
): Job<ProcessingJobData> {
  return {
    id: 'job-1',
    data: {
      videoId: 'test-video-uuid',
      channelId: 'test-channel-uuid',
      videoKey: 'videos/test-video-uuid.mp4',
      ...overrides,
    },
  } as Job<ProcessingJobData>;
}

describe('VideoProcessor (unit)', () => {
  let processor: VideoProcessor;
  let repo: ReturnType<typeof makeRepository>;
  let storage: ReturnType<typeof makeStorageService>;
  let ffmpeg: ReturnType<typeof makeFfmpegService>;

  beforeEach(() => {
    repo = makeRepository();
    storage = makeStorageService();
    ffmpeg = makeFfmpegService();
    processor = new (VideoProcessor as any)(
      repo as any,
      storage as any,
      ffmpeg as any,
    );
  });

  // ── process() ────────────────────────────────────────────────────
  describe('process()', () => {
    it('should generate presigned URL, probe, extract thumbnail, upload, and update DB', async () => {
      const job = makeJob();
      await processor.process(job);

      // 1 — presigned URL
      expect(storage.generatePresignedGetUrl).toHaveBeenCalledTimes(1);
      expect(storage.generatePresignedGetUrl).toHaveBeenCalledWith(
        'videos/test-video-uuid.mp4',
      );

      // 2 — probe na URL
      expect(ffmpeg.probe).toHaveBeenCalledTimes(1);
      expect(ffmpeg.probe).toHaveBeenCalledWith('https://minio/presigned-url');

      // 3 — thumbnail na mesma URL
      expect(ffmpeg.extractThumbnail).toHaveBeenCalledTimes(1);
      expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith(
        'https://minio/presigned-url',
      );

      // 4 — upload do thumbnail
      expect(storage.uploadThumbnail).toHaveBeenCalledTimes(1);
      expect(storage.uploadThumbnail).toHaveBeenCalledWith(
        'thumbnails/test-video-uuid.jpg',
        expect.any(Buffer),
        'image/jpeg',
      );

      // 5 — update DB
      expect(repo.update).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'test-video-uuid' },
        {
          status: VideoStatus.READY,
          duration_seconds: 6,
          width: 640,
          height: 360,
          codec: 'h264',
          thumbnail_key: 'thumbnails/test-video-uuid.jpg',
        },
      );
    });

    it('should propagate an error from ffmpeg probe', async () => {
      ffmpeg.probe.mockRejectedValue(new Error('ffprobe: Invalid data found'));
      const job = makeJob();

      await expect(processor.process(job)).rejects.toThrow(
        'ffprobe: Invalid data found',
      );

      // Se o probe falhou, nada depois deve ter sido chamado
      expect(storage.generatePresignedGetUrl).toHaveBeenCalledTimes(1);
      expect(ffmpeg.extractThumbnail).not.toHaveBeenCalled();
      expect(storage.uploadThumbnail).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should propagate an error from thumbnail extraction', async () => {
      ffmpeg.extractThumbnail.mockRejectedValue(
        new Error('ffmpeg: corrupt stream'),
      );
      const job = makeJob();

      await expect(processor.process(job)).rejects.toThrow(
        'ffmpeg: corrupt stream',
      );

      expect(ffmpeg.probe).toHaveBeenCalledTimes(1);
      expect(storage.uploadThumbnail).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should propagate an error from thumbnail upload to MinIO', async () => {
      storage.uploadThumbnail.mockRejectedValue(
        new Error('MinIO: BucketNotFound'),
      );
      const job = makeJob();

      await expect(processor.process(job)).rejects.toThrow(
        'MinIO: BucketNotFound',
      );

      expect(ffmpeg.extractThumbnail).toHaveBeenCalledTimes(1);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('should propagate an error from DB update', async () => {
      repo.update.mockRejectedValue(new Error('DB: deadlock detected'));
      const job = makeJob();

      await expect(processor.process(job)).rejects.toThrow(
        'DB: deadlock detected',
      );
    });
  });

  // ── onFailed() ──────────────────────────────────────────────────
  describe('onFailed()', () => {
    it('should mark the video as ERROR with the error message', async () => {
      const job = makeJob();
      const error = new Error('All 3 retries exhausted — corrupt file');

      await processor.onFailed(job, error);

      expect(repo.update).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'test-video-uuid' },
        {
          status: VideoStatus.ERROR,
          error_message: 'All 3 retries exhausted — corrupt file',
        },
      );
    });

    it('should not crash when the job data is partially missing', async () => {
      const job = makeJob({ videoId: 'partial-uuid' }); // channelId undefined
      const error = new Error('Something failed');

      await processor.onFailed(job, error);

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'partial-uuid' },
        { status: VideoStatus.ERROR, error_message: 'Something failed' },
      );
    });
  });
});
