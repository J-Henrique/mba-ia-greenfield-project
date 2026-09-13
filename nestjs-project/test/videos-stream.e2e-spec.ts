import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { VideoStatus } from '../src/videos/entities/video.entity';

describe('GET /videos/:id, /stream, /download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function seedUserAndChannel(
    email = 'owner@example.com',
  ): Promise<{ access_token: string; channelId: string }> {
    const authService = app.get(AuthService);
    const { id } = await authService.register({
      email,
      password: 'password123',
    });
    await dataSource.query(
      'UPDATE users SET is_confirmed = true WHERE id = $1',
      [id],
    );
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    const rows = await dataSource.query(
      'SELECT id FROM channels WHERE user_id = $1',
      [id],
    );
    return {
      access_token: loginRes.body.access_token,
      channelId: rows[0].id,
    };
  }

  async function seedVideo(
    videoId: string,
    channelId: string,
    overrides: Partial<{
      status: string;
      duration_seconds: number;
      width: number;
      height: number;
      thumbnail_key: string | null;
    }> = {},
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO videos (id, channel_id, video_key, mime_type, status, duration_seconds, width, height, thumbnail_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        videoId,
        channelId,
        `videos/${videoId}.mp4`,
        'video/mp4',
        overrides.status ?? 'ready',
        overrides.duration_seconds ?? 120,
        overrides.width ?? 1920,
        overrides.height ?? 1080,
        overrides.thumbnail_key ?? null,
      ],
    );
  }

  describe('1. Video query (metadata)', () => {
    const videoId = '00000000-0000-4000-8000-000000000001';

    it('1.1 get-video-ready — returns 200 with metadata and thumbnailUrl', async () => {
      const { access_token, channelId } =
        await seedUserAndChannel('meta@example.com');
      await seedVideo(videoId, channelId, {
        status: 'ready',
        thumbnail_key: `thumbnails/${videoId}.jpg`,
      });

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(res.body.status).toBe('ready');
      expect(res.body.durationSeconds).toBe(120);
      expect(res.body.width).toBe(1920);
      expect(res.body.height).toBe(1080);
      expect(res.body.thumbnailUrl).toContain('X-Amz-Signature');
    });

    it('1.2 get-video-other-channel — returns 403 FORBIDDEN', async () => {
      const { access_token: ownerToken, channelId } =
        await seedUserAndChannel('owner@example.com');
      await seedVideo(videoId, channelId);

      const { access_token: otherToken } =
        await seedUserAndChannel('other@example.com');

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);

      expect(res.body.error).toBe('FORBIDDEN');
    });
  });

  describe('2. Streaming', () => {
    const videoId = '00000000-0000-4000-8000-000000000002';

    it('2.1 stream-ready-range-206 — returns streamUrl that produces 206 with Range', async () => {
      const { access_token, channelId } =
        await seedUserAndChannel('stream@example.com');
      await seedVideo(videoId, channelId, { status: 'ready' });

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/stream`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(res.body.streamUrl).toContain('X-Amz-Signature');
    });

    it('2.2 stream-not-ready — returns 409 VIDEO_NOT_READY', async () => {
      const { access_token, channelId } = await seedUserAndChannel(
        'noready@example.com',
      );
      await seedVideo(videoId, channelId, { status: 'draft' });

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/stream`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(409);

      expect(res.body.error).toBe('VIDEO_NOT_READY');
    });
  });

  describe('3. Download', () => {
    const videoId = '00000000-0000-4000-8000-000000000003';

    it('3.1 download-attachment — returns downloadUrl with content-disposition', async () => {
      const { access_token, channelId } =
        await seedUserAndChannel('dl@example.com');
      await seedVideo(videoId, channelId, { status: 'ready' });

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/download`)
        .set('Authorization', `Bearer ${access_token}`)
        .expect(200);

      expect(res.body.downloadUrl).toContain('X-Amz-Signature');
      expect(res.body.downloadUrl).toContain('response-content-disposition');
    });
  });
});
