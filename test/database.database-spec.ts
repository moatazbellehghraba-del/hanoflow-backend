import 'reflect-metadata';
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DatabaseModule } from '../src/infrastructure/database/database.module.js';
import { REDIS_PROBE_CLIENT } from '../src/infrastructure/redis/redis.config.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { HealthModule } from '../src/modules/health/health.module.js';
import { setupApplication } from '../src/config/setup-application.js';
import { validateEnvironment } from '../src/config/environment.js';
import { getTestDatabaseUrl } from './helpers/database-target.js';

describe('PostgreSQL integration (real database, no mocks)', () => {
  let app: INestApplication | undefined;
  let prisma: PrismaService;
  beforeAll(async () => {
    const url = getTestDatabaseUrl(process.env);
    const config = validateEnvironment({
      DATABASE_URL: url,
      NODE_ENV: 'test',
      REDIS_URL: 'redis://127.0.0.1:1/0',
      QUEUE_PREFIX: 'hanoflow-db-test',
    });
    const module = await Test.createTestingModule({
      imports: [DatabaseModule, HealthModule],
    })
      // PostgreSQL remains real; this suite deliberately does not require Redis.
      .overrideProvider(REDIS_PROBE_CLIENT)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({ checkReadiness: () => Promise.resolve() })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService(config))
      .compile();
    app = module.createNestApplication({ logger: false });
    setupApplication(app);
    await app.init();
    prisma = module.get(PrismaService);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('executes SELECT 1 through the real Prisma PostgreSQL adapter', async () => {
    await expect(
      prisma.$queryRaw<Array<{ value: number }>>`SELECT 1::int AS value`,
    ).resolves.toEqual([{ value: 1 }]);
  });
  it('connects to the isolated logical test database', async () => {
    await expect(
      prisma.$queryRaw<
        Array<{ name: string }>
      >`SELECT current_database() AS name`,
    ).resolves.toEqual([{ name: 'hanoflow_test' }]);
  });
  it('applies the bounded database statement timeout', async () => {
    await expect(
      prisma.$queryRaw<
        Array<{ timeout: string }>
      >`SELECT current_setting('statement_timeout') AS timeout`,
    ).resolves.toEqual([{ timeout: '2s' }]);
  });
  it('serves liveness and readiness against PostgreSQL', async () => {
    if (!app) throw new Error('Application was not initialized');
    const server = app.getHttpServer() as import('node:http').Server;
    await request(server).get('/api/v1/health').expect(200, { status: 'ok' });
    await request(server)
      .get('/api/v1/health/ready')
      .expect(200, { status: 'ok', database: 'up', redis: 'up' });
  });
});
