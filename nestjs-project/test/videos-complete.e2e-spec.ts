import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Queue } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { QUEUE_NAME } from '../src/queue/queue.constants';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('POST /videos/:id/complete (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;

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
    queue = moduleFixture.get(getQueueToken(QUEUE_NAME));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
  });

  async function registerAndLogin(
    email: string,
  ): Promise<{ access_token: string; userId: string }> {
    const authService = app.get(AuthService);
    const { id } = await authService.register({ email, password: 'password123' });
    await dataSource.query('UPDATE users SET is_confirmed = true WHERE id = $1', [id]);
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return { access_token: loginRes.body.access_token, userId: id };
  }

  async function runRealMultipartCycle(
    token: string,
  ): Promise<{ videoId: string; parts: { partNumber: number; etag: string }[] }> {
    const initiateRes = await request(app.getHttpServer())
      .post('/videos/initiate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'aula.mp4',
        mimeType: 'video/mp4',
        fileSize: 200_000_000, // 2 parts of 100MB
      })
      .expect(201);

    const videoId: string = initiateRes.body.video.id;
    const presignedUrls: string[] = initiateRes.body.parts.map(
      (p: { presignedUrl: string }) => p.presignedUrl,
    );

    const parts: { partNumber: number; etag: string }[] = [];
    for (let i = 0; i < presignedUrls.length; i++) {
      const body = Buffer.alloc(5 * 1024 * 1024, 0x61); // 5MB (mínimo exigido pelo S3/MinIO)
      const putRes = await fetch(presignedUrls[i], { method: 'PUT', body });
      expect(putRes.status).toBe(200);
      const etag = putRes.headers.get('ETag');
      expect(etag).toBeDefined();
      parts.push({ partNumber: i + 1, etag: etag! });
    }

    return { videoId, parts };
  }

  describe('1. Upload completion', () => {
    it('1.1 complete-valid-upload — returns 204, marks processing, enqueues job', async () => {
      const { access_token, userId } = await registerAndLogin('owner@example.com');
      const { videoId, parts } = await runRealMultipartCycle(access_token);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts })
        .expect(204);

      expect(res.body).toEqual({});

      const rows = await dataSource.query(
        'SELECT status FROM videos WHERE id = $1',
        [videoId],
      );
      expect(rows[0].status).toBe('processing');

      const jobs = await queue.getJobs(['waiting', 'active']);
      expect(jobs.length).toBe(1);
      expect(jobs[0].data).toEqual({
        videoId,
        channelId: expect.any(String),
        videoKey: `videos/${videoId}.mp4`,
      });
      expect(jobs[0].data.channelId).toBeDefined();
      expect(userId).toBeDefined();
    });

    it('1.2 complete-other-channel-forbidden — returns 403 FORBIDDEN', async () => {
      const { access_token: ownerToken } = await registerAndLogin('owner2@example.com');
      const { videoId, parts } = await runRealMultipartCycle(ownerToken);

      const { access_token: otherToken } = await registerAndLogin('other@example.com');

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts })
        .expect(403);

      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('1.3 complete-invalid-status — returns 400 INVALID_STATUS when video is not draft', async () => {
      const { access_token } = await registerAndLogin('owner3@example.com');
      const { videoId, parts } = await runRealMultipartCycle(access_token);

      // Force status to processing before completing
      await dataSource.query(
        'UPDATE videos SET status = $1 WHERE id = $2',
        ['processing', videoId],
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${access_token}`)
        .send({ parts })
        .expect(400);

      expect(res.body.error).toBe('INVALID_STATUS');
    });
  });
});