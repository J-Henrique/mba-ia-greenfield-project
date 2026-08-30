import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  FileTooBigException,
  ForbiddenException,
  InvalidStatusException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import { MAX_FILE_SIZE_BYTES } from './dto/initiate-upload.dto';
import type { CompleteUploadDto } from './dto/complete-upload.dto';

const makeVideo = (overrides: Partial<Video> = {}): Video =>
  Object.assign(new Video(), {
    id: 'video-id',
    channel_id: 'channel-id',
    title: null,
    description: null,
    status: VideoStatus.DRAFT,
    video_key: 'videos/video-id.mp4',
    mime_type: 'video/mp4',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    getPartSizeBytes: jest.Mock;
    createMultipartUpload: jest.Mock;
    generatePresignedPartUrls: jest.Mock;
    findMultipartUploadIdByKey: jest.Mock;
    completeMultipartUpload: jest.Mock;
  };
  let queueService: { publishProcessingJob: jest.Mock };

  const channel: Channel = Object.assign(new Channel(), {
    id: 'channel-id',
    name: 'Channel',
    nickname: 'chan',
    user_id: 'user-id',
    description: null,
  });

  const initiateDto = {
    filename: 'aula.mp4',
    mimeType: 'video/mp4',
    fileSize: 200_000_000,
  };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      save: jest.fn().mockImplementation((data) => ({
        ...data,
        status: VideoStatus.DRAFT,
        created_at: new Date(),
        updated_at: new Date(),
      })),
      findOne: jest.fn().mockResolvedValue(makeVideo()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue(channel),
    };
    storageService = {
      getPartSizeBytes: jest.fn().mockReturnValue(100 * 1024 * 1024),
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
      generatePresignedPartUrls: jest
        .fn()
        .mockResolvedValue(['https://presigned/1', 'https://presigned/2']),
      findMultipartUploadIdByKey: jest.fn().mockResolvedValue('upload-id'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    queueService = {
      publishProcessingJob: jest.fn().mockResolvedValue('job-id'),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('pre-registers the video as draft and returns presigned part URLs', async () => {
      const result = await service.initiateUpload('user-id', initiateDto);

      expect(channelsService.findByUserId).toHaveBeenCalledWith('user-id');

      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: expect.any(String),
          channel_id: channel.id,
          video_key: expect.stringMatching(/^videos\/.+\.mp4$/),
          mime_type: 'video/mp4',
        }),
      );

      expect(videoRepository.save).toHaveBeenCalledTimes(1);
      expect(result.video.status).toBe(VideoStatus.DRAFT);
      expect(result.video.channelId).toBe(channel.id);

      expect(storageService.getPartSizeBytes).toHaveBeenCalled();
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\.mp4$/),
        'video/mp4',
      );
      expect(storageService.generatePresignedPartUrls).toHaveBeenCalledWith(
        'upload-id',
        expect.any(String),
        2,
      );

      expect(result.uploadId).toBe('upload-id');
      expect(result.parts).toEqual([
        { partNumber: 1, presignedUrl: 'https://presigned/1' },
        { partNumber: 2, presignedUrl: 'https://presigned/2' },
      ]);
      expect(result.completionUrl).toMatch(/^\/videos\/.+\/complete$/);
    });

    it('throws FILE_TOO_BIG when fileSize exceeds 10GB', async () => {
      await expect(
        service.initiateUpload('user-id', {
          ...initiateDto,
          fileSize: MAX_FILE_SIZE_BYTES + 1,
        }),
      ).rejects.toThrow(FileTooBigException);

      expect(videoRepository.save).not.toHaveBeenCalled();
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('creates exactly one part URL for a file that fits in one part', async () => {
      storageService.generatePresignedPartUrls.mockResolvedValue([
        'https://presigned/1',
      ]);

      const result = await service.initiateUpload('user-id', {
        ...initiateDto,
        fileSize: 50_000_000,
      });

      expect(storageService.generatePresignedPartUrls).toHaveBeenCalledWith(
        'upload-id',
        expect.any(String),
        1,
      );
      expect(result.parts).toHaveLength(1);
    });

    it('propagates CHANNEL_NOT_FOUND when the user has no channel', async () => {
      channelsService.findByUserId.mockRejectedValue(
        Object.assign(new Error('CHANNEL_NOT_FOUND'), {
          errorCode: 'CHANNEL_NOT_FOUND',
        }),
      );

      await expect(
        service.initiateUpload('user-id', initiateDto),
      ).rejects.toThrow('CHANNEL_NOT_FOUND');
      expect(videoRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    const completeDto: CompleteUploadDto = {
      parts: [
        { partNumber: 1, etag: '"etag1"' },
        { partNumber: 2, etag: '"etag2"' },
      ],
    };

    it('completes multipart, updates status to processing, and enqueues job', async () => {
      await service.completeUpload('user-id', 'video-id', completeDto);

      expect(channelsService.findByUserId).toHaveBeenCalledWith('user-id');
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'video-id' },
      });

      expect(storageService.findMultipartUploadIdByKey).toHaveBeenCalledWith(
        'videos/video-id.mp4',
      );
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'upload-id',
        'videos/video-id.mp4',
        [
          { PartNumber: 1, ETag: '"etag1"' },
          { PartNumber: 2, ETag: '"etag2"' },
        ],
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-id' },
        { status: VideoStatus.PROCESSING },
      );

      expect(queueService.publishProcessingJob).toHaveBeenCalledWith({
        videoId: 'video-id',
        channelId: channel.id,
        videoKey: 'videos/video-id.mp4',
      });
    });

    it('throws VIDEO_NOT_FOUND when video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-id', 'nonexistent', completeDto),
      ).rejects.toThrow(VideoNotFoundException);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(queueService.publishProcessingJob).not.toHaveBeenCalled();
    });

    it('throws FORBIDDEN when video belongs to another channel', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ channel_id: 'other-channel-id' }),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', completeDto),
      ).rejects.toThrow(ForbiddenException);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('throws INVALID_STATUS when video is not in draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', completeDto),
      ).rejects.toThrow(InvalidStatusException);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });
});