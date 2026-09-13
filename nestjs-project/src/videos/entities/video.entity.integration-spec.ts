import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    // videos must be cleared before channels/users due to the FK videos.channel_id -> channels.id
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `v_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Channel',
        nickname: `vchan${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  function createVideo(channelId: string): Video {
    return videoRepository.create({
      channel_id: channelId,
      video_key: `videos/uuid-${userCounter}.mp4`,
      mime_type: 'video/mp4',
    });
  }

  it('should default status to draft', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(createVideo(channel.id));

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should generate a uuid v4 id', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(createVideo(channel.id));

    expect(video.id).toMatch(UUID_V4);
  });

  it('should persist the processing/ready/error statuses', async () => {
    const channel = await createChannel();

    for (const status of [
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.ERROR,
    ]) {
      const video = await videoRepository.save({
        ...createVideo(channel.id),
        status,
      });
      expect(video.status).toBe(status);
    }
  });

  it('should reject a status outside the enum', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "video_key", "mime_type", "status") VALUES ($1, $2, $3, 'bogus')`,
        [channel.id, `videos/${channel.id}.mp4`, 'video/mp4'],
      ),
    ).rejects.toThrow();
  });

  it('should enforce channel_id FK not null', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          video_key: 'videos/without-channel.mp4',
          mime_type: 'video/mp4',
          // channel_id intentionally omitted
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a channel_id that does not reference an existing channel', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-4000-8000-000000000000',
          video_key: 'videos/ghost.mp4',
          mime_type: 'video/mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should allow null for nullable metadata fields', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        video_key: 'videos/nullable.mp4',
        mime_type: 'video/mp4',
        title: null,
        description: null,
        duration_seconds: null,
        width: null,
        height: null,
        codec: null,
        file_size_bytes: null,
        thumbnail_key: null,
        error_message: null,
      }),
    );

    expect(video.title).toBeNull();
    expect(video.description).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.width).toBeNull();
    expect(video.height).toBeNull();
    expect(video.codec).toBeNull();
    expect(video.file_size_bytes).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.error_message).toBeNull();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(createVideo(channel.id));

    const found = await videoRepository.findOne({
      where: { channel_id: channel.id },
      relations: ['channel'],
    });

    expect(found?.channel.name).toBe(channel.name);
  });
});
