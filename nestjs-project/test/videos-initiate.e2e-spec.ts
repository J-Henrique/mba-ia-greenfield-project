import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('POST /videos/initiate (e2e)', () => {
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

  async function createUserAndChannel(
    email = 'initiate@example.com',
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    // registra e confirma manualmente via banco (evita mock de email)
    const { id } = await authService.register({ email, password });
    await dataSource.getRepository(User).update(id, { is_confirmed: true });
    // login
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return loginRes.body.access_token;
  }

  describe('1. Initiation of upload', () => {
    it('1.1 initiate-valid-upload — returns 201 with presigned parts', async () => {
      const token = await createUserAndChannel();

      const res = await request(app.getHttpServer())
        .post('/videos/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'aula.mp4',
          mimeType: 'video/mp4',
          fileSize: 200_000_000,
        })
        .expect(201);

      expect(res.body.video.status).toBe('draft');
      expect(res.body.video.channelId).toBeDefined();
      expect(res.body.video.id).toBeDefined();
      expect(res.body.parts.length).toBeGreaterThanOrEqual(2);
      expect(res.body.parts[0].partNumber).toBe(1);
      expect(res.body.parts[0].presignedUrl).toContain('X-Amz-Signature');
      expect(res.body.uploadId).toBeDefined();
      expect(res.body.completionUrl).toBe(
        `/videos/${res.body.video.id}/complete`,
      );

      // DB row exists with status draft
      const videos = await app
        .get(DataSource)
        .query('SELECT * FROM videos WHERE id = $1', [res.body.video.id]);
      expect(videos.length).toBe(1);
      expect(videos[0].status).toBe('draft');
      expect(videos[0].video_key).toBe(`videos/${res.body.video.id}.mp4`);
    });

    it('1.2 initiate-without-auth — returns 401', async () => {
      await request(app.getHttpServer())
        .post('/videos/initiate')
        .send({
          filename: 'aula.mp4',
          mimeType: 'video/mp4',
          fileSize: 200_000_000,
        })
        .expect(401);
    });

    it('1.3 initiate-file-too-big — returns 413 with FILE_TOO_BIG', async () => {
      const token = await createUserAndChannel();

      const res = await request(app.getHttpServer())
        .post('/videos/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          filename: 'huge.mp4',
          mimeType: 'video/mp4',
          fileSize: 11_000_000_000, // 11GB > 10GB
        })
        .expect(413);

      expect(res.body.error).toBe('FILE_TOO_BIG');
    });
  });
});
