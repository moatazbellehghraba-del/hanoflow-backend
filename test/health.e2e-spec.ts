import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IsString } from 'class-validator';
import { AppModule } from '../src/app.module.js';
import { setupApplication } from '../src/config/setup-application.js';
import { REDIS_PROBE_CLIENT } from '../src/infrastructure/redis/redis.config.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';

class TestDto {
  @IsString()
  name!: string;
}
@Controller('test-error')
class ErrorController {
  @Post()
  validate(@Body() dto: TestDto): TestDto {
    return dto;
  }
  @Get()
  fail(): never {
    throw new Error('private internal details');
  }
}
@Module({ imports: [AppModule], controllers: [ErrorController] })
class TestModule {}

describe('HTTP foundation', () => {
  let app: INestApplication;
  const query = jest.fn<() => Promise<unknown>>();
  const redis = jest.fn<() => Promise<void>>();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [TestModule],
    })
      .overrideProvider(REDIS_PROBE_CLIENT)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({ checkReadiness: redis })
      .overrideProvider(PrismaService)
      .useValue({ verifyIdentity: () => Promise.resolve(), $queryRaw: query })
      .compile();
    app = module.createNestApplication({ logger: false });
    setupApplication(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    query.mockReset();
    redis.mockReset().mockResolvedValue();
  });
  it('returns application liveness only', async () => {
    const response = await request(
      app.getHttpServer() as import('node:http').Server,
    )
      .get('/api/v1/health')
      .expect(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
    expect(redis).not.toHaveBeenCalled();
  });
  it('reports database readiness after a successful query', async () => {
    query.mockResolvedValueOnce([{ value: 1 }]);
    const response = await request(
      app.getHttpServer() as import('node:http').Server,
    )
      .get('/api/v1/health/ready')
      .expect(200);
    expect(response.body).toEqual({
      status: 'ok',
      database: 'up',
      redis: 'up',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('returns a safe 503 and keeps liveness available during a database outage', async () => {
    query.mockRejectedValueOnce(
      new Error('postgresql://private:password@internal/database'),
    );
    const response = await request(
      app.getHttpServer() as import('node:http').Server,
    )
      .get('/api/v1/health/ready')
      .expect(503);
    expect(response.body).toMatchObject({
      statusCode: 503,
      message: 'Service unavailable',
      path: '/api/v1/health/ready',
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /password|postgresql|internal/,
    );
    await request(app.getHttpServer() as import('node:http').Server)
      .get('/api/v1/health')
      .expect(200);
    query.mockResolvedValueOnce([{ value: 1 }]);
    await request(app.getHttpServer() as import('node:http').Server)
      .get('/api/v1/health/ready')
      .expect(200);
  });
  it('sanitizes Redis failures and restores readiness without replacing the app', async () => {
    query.mockResolvedValue([{ value: 1 }]);
    redis.mockRejectedValueOnce(
      new Error('redis://private:password@internal/0'),
    );
    const server = app.getHttpServer() as import('node:http').Server;
    const response = await request(server)
      .get('/api/v1/health/ready')
      .expect(503);
    expect(response.body).toMatchObject({
      statusCode: 503,
      message: 'Service unavailable',
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /password|private|internal/,
    );
    await request(server).get('/api/v1/health').expect(200, { status: 'ok' });
    await request(server)
      .post('/graphql')
      .send({ query: '{ health { status } }' })
      .expect(200, { data: { health: { status: 'ok' } } });
    expect(redis).toHaveBeenCalledTimes(1);
    await request(server)
      .get('/api/v1/health/ready')
      .expect(200, { status: 'ok', database: 'up', redis: 'up' });
  });
  it.each(['/api/health', '/api/v2/health'])(
    'rejects unsupported route %s',
    async (url) => {
      const response = await request(
        app.getHttpServer() as import('node:http').Server,
      )
        .get(url)
        .expect(404);
      expect(response.body).toMatchObject({ statusCode: 404, path: url });
      expect(response.body).toHaveProperty('timestamp');
    },
  );
  it('rejects routes outside the API prefix', async () => {
    await request(app.getHttpServer() as import('node:http').Server)
      .get('/health')
      .expect(404);
  });
  it('validates request DTOs and rejects unknown properties', async () => {
    const response = await request(
      app.getHttpServer() as import('node:http').Server,
    )
      .post('/api/v1/test-error')
      .send({ name: 123, extra: true })
      .expect(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      path: '/api/v1/test-error',
    });
    expect(Array.isArray((response.body as { message: unknown }).message)).toBe(
      true,
    );
  });
  it('accepts valid request DTOs', async () => {
    const response = await request(
      app.getHttpServer() as import('node:http').Server,
    )
      .post('/api/v1/test-error')
      .send({ name: 'valid' })
      .expect(201);
    expect(response.body).toEqual({ name: 'valid' });
  });
  it('hides unexpected exception details and query strings', async () => {
    const response = await request(
      app.getHttpServer() as import('node:http').Server,
    )
      .get('/api/v1/test-error?token=private')
      .expect(500);
    expect(response.body).toMatchObject({
      statusCode: 500,
      message: 'Internal server error',
      path: '/api/v1/test-error',
    });
    expect(JSON.stringify(response.body)).not.toContain('private');
  });
});
