import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { FileTooBigException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { InitiateUploadDto, MAX_FILE_SIZE_BYTES } from './dto/initiate-upload.dto';

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
  ) {}

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