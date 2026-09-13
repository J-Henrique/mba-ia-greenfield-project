import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooBigException,
  ForbiddenException,
  InvalidStatusException,
  VideoNotReadyException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  InitiateUploadDto,
  MAX_FILE_SIZE_BYTES,
} from './dto/initiate-upload.dto';
import type { CompleteUploadDto } from './dto/complete-upload.dto';

export interface InitiateUploadResponse {
  video: {
    id: string;
    status: VideoStatus;
    title: string | null;
    channelId: string;
  };
  uploadId: string;
  parts: { partNumber: number; presignedUrl: string }[];
  completionUrl: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly queueService: QueueService,
  ) {}

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<void> {
    const channel = await this.channelsService.findByUserId(userId);

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel_id !== channel.id) {
      throw new ForbiddenException();
    }
    if (video.status !== VideoStatus.DRAFT) {
      throw new InvalidStatusException();
    }

    const uploadId = await this.storageService.findMultipartUploadIdByKey(
      video.video_key,
    );

    await this.storageService.completeMultipartUpload(
      uploadId,
      video.video_key,
      dto.parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
    );

    await this.videoRepository.update(
      { id: videoId },
      { status: VideoStatus.PROCESSING },
    );

    await this.queueService.publishProcessingJob({
      videoId,
      channelId: channel.id,
      videoKey: video.video_key,
    });
  }

  async getVideo(
    videoId: string,
    userId: string,
  ): Promise<{
    id: string;
    title: string | null;
    description: string | null;
    status: VideoStatus;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    thumbnailUrl: string | null;
  }> {
    const channel = await this.channelsService.findByUserId(userId);

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.channel_id !== channel.id) throw new ForbiddenException();

    const thumbnailUrl =
      video.status === VideoStatus.READY && video.thumbnail_key
        ? await this.storageService.generatePresignedGetUrl(video.thumbnail_key)
        : null;

    return {
      id: video.id,
      title: video.title,
      description: video.description,
      status: video.status,
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      thumbnailUrl,
    };
  }

  async getStreamUrl(
    videoId: string,
    userId: string,
  ): Promise<{ streamUrl: string }> {
    const channel = await this.channelsService.findByUserId(userId);

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.channel_id !== channel.id) throw new ForbiddenException();
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();

    return {
      streamUrl: await this.storageService.generatePresignedGetUrl(
        video.video_key,
      ),
    };
  }

  async getDownloadUrl(
    videoId: string,
    userId: string,
  ): Promise<{ downloadUrl: string }> {
    const channel = await this.channelsService.findByUserId(userId);

    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.channel_id !== channel.id) throw new ForbiddenException();
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();

    return {
      downloadUrl: await this.storageService.generatePresignedGetUrl(
        video.video_key,
        { responseContentDisposition: 'attachment' },
      ),
    };
  }

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponse> {
    if (dto.fileSize > MAX_FILE_SIZE_BYTES) {
      throw new FileTooBigException();
    }

    const channel = await this.channelsService.findByUserId(userId);

    const id = randomUUID();
    const ext = dto.filename.split('.').pop() || 'mp4';
    const videoKey = `videos/${id}.${ext}`;

    const video = this.videoRepository.create({
      id,
      channel_id: channel.id,
      title: null,
      video_key: videoKey,
      mime_type: dto.mimeType,
    });

    const saved = await this.videoRepository.save(video);

    const partSizeBytes = this.storageService.getPartSizeBytes();
    const partCount = Math.ceil(dto.fileSize / partSizeBytes);

    const uploadId = await this.storageService.createMultipartUpload(
      videoKey,
      dto.mimeType,
    );

    const presignedUrls = await this.storageService.generatePresignedPartUrls(
      uploadId,
      videoKey,
      partCount,
    );

    const parts = presignedUrls.map((url, index) => ({
      partNumber: index + 1,
      presignedUrl: url,
    }));

    return {
      video: {
        id: saved.id,
        status: saved.status,
        title: saved.title,
        channelId: saved.channel_id,
      },
      uploadId,
      parts,
      completionUrl: `/videos/${saved.id}/complete`,
    };
  }
}
