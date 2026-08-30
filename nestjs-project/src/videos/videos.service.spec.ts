import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { FileTooBigException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import { MAX_FILE_SIZE_BYTES } from './dto/initiate-upload.dto';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    getPartSizeBytes: jest.Mock;
    createMultipartUpload: jest.Mock;
    generatePresignedPartUrls: jest.Mock;
  };

  const channel: Channel = Object.assign(new Channel(), {
    id: 'channel-id',
    name: 'Channel',
    nickname: 'chan',
    user_id: 'user-id',
    description: null,
  });

  const dto = {
    filename: 'aula.mp4',
    mimeType: 'video/mp4',
    fileSize: 200_000_000, // 200MB -> 2 parts of 100MB
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
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('pre-registers the video as draft and returns presigned part URLs', async () => {
      const result = await service.initiateUpload('user-id', dto);

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
          ...dto,
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
        ...dto,
        fileSize: 50_000_000, // 50MB -> 1 part
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
        Object.assign(new Error('CHANNEL_NOT_FOUND'), { errorCode: 'CHANNEL_NOT_FOUND' }),
      );

      await expect(service.initiateUpload('user-id', dto)).rejects.toThrow(
        'CHANNEL_NOT_FOUND',
      );
      expect(videoRepository.save).not.toHaveBeenCalled();
    });
  });
});
