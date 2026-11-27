import 'reflect-metadata';
import { jest } from '@jest/globals';
import { BadRequestException, Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  Args,
  Context,
  Field,
  GraphQLSchemaHost,
  InputType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { IsString, MinLength } from 'class-validator';
import {
  getIntrospectionQuery,
  printSchema,
  lexicographicSortSchema,
} from 'graphql';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppModule } from '../src/app.module.js';
import { setupApplication } from '../src/config/setup-application.js';
import { REDIS_PROBE_CLIENT } from '../src/infrastructure/redis/redis.config.js';
import { RedisService } from '../src/infrastructure/redis/redis.service.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import type { ApiGraphqlContext } from '../src/infrastructure/graphql/graphql-context.js';

@InputType()
class VerificationInput {
  @Field(() => String)
  @IsString()
  @MinLength(3)
  name!: string;
}

// These resolvers are registered only by this test module, never production.
@Resolver()
class VerificationResolver {
  @Query(() => String)
  fixtureInput(@Args('input') input: VerificationInput): string {
    return input.name;
  }

  @Query(() => String)
  fixtureContext(@Context() context: ApiGraphqlContext): string {
    return context.req.method + ':' + context.requestId;
  }

  @Query(() => String, { nullable: true })
  fixtureFailure(): never {
    throw new Error(
      'postgresql://private:secret-password@internal/database SELECT secret',
    );
  }

  @Query(() => String, { nullable: true })
  fixturePublicCode(): never {
    throw new BadRequestException({
      code: 'APP_INVALID_INPUT',
      message: 'private implementation details',
    });
  }
}

@Module({ imports: [AppModule], providers: [VerificationResolver] })
class VerificationModule {}

interface GraphqlBody {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string; extensions: Record<string, unknown> }>;
}

async function createApp(environment: string): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports: [VerificationModule],
  })
    .overrideProvider(REDIS_PROBE_CLIENT)
    .useValue({})
    .overrideProvider(RedisService)
    .useValue({
      checkReadiness: jest.fn<() => Promise<void>>().mockResolvedValue(),
    })
    .overrideProvider(PrismaService)
    .useValue({
      verifyIdentity: () => Promise.resolve(),
      $queryRaw: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue([{ value: 1 }]),
    })
    .overrideProvider(ConfigService)
    .useValue(
      new ConfigService({
        NODE_ENV: environment,
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
        QUEUE_PREFIX: process.env.QUEUE_PREFIX,
      }),
    )
    .compile();
  const app = module.createNestApplication({ logger: false });
  setupApplication(app);
  await app.init();
  return app;
}

describe('hybrid API infrastructure (offline)', () => {
  let app: INestApplication;
  let server: Server;
  beforeAll(async () => {
    app = await createApp('development');
    server = app.getHttpServer() as Server;
  });
  afterAll(async () => {
    await app?.close();
  });

  it('initializes and generates a deterministic code-first schema in memory', () => {
    const schema = app.get(GraphQLSchemaHost).schema;
    expect(printSchema(schema)).toBe(
      printSchema(lexicographicSortSchema(schema)),
    );
    expect(printSchema(schema)).toContain('health: HealthStatus!');
    expect(printSchema(schema)).toContain('type HealthStatus');
  });
  it('executes the operational query with the standard GraphQL response', async () => {
    const response = await request(server)
      .post('/graphql')
      .send({ query: '{ health { status } }' })
      .expect(200);
    expect(response.body).toEqual({ data: { health: { status: 'ok' } } });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('exposes the same server-generated correlation ID and request object in context', async () => {
    const response = await request(server)
      .post('/graphql')
      .set('x-request-id', 'untrusted-client-id')
      .send({ query: '{ fixtureContext }' })
      .expect(200);
    expect((response.body as GraphqlBody).data?.fixtureContext).toBe(
      'POST:' + String(response.headers['x-request-id']),
    );
    expect(response.headers['x-request-id']).not.toBe('untrusted-client-id');
  });
  it('keeps REST liveness and database readiness at their original URLs', async () => {
    await request(server).get('/api/v1/health').expect(200, { status: 'ok' });
    await request(server)
      .get('/api/v1/health/ready')
      .expect(200, { status: 'ok', database: 'up', redis: 'up' });
  });
  it.each(['/api/graphql', '/api/v1/graphql', '/graphql/extra'])(
    'does not expose duplicate GraphQL route %s',
    async (url) => {
      await request(server)
        .post(url)
        .send({ query: '{ health { status } }' })
        .expect(404);
    },
  );
  it('validates input DTOs through the global ValidationPipe', async () => {
    const response = await request(server)
      .post('/graphql')
      .send({
        query:
          'query($input: VerificationInput!) { fixtureInput(input: $input) }',
        variables: { input: { name: 'x' } },
      })
      .expect(200);
    expect((response.body as GraphqlBody).errors?.[0]?.extensions.code).toBe(
      'BAD_USER_INPUT',
    );
    expect(JSON.stringify(response.body)).not.toContain('stacktrace');
  });
  it('accepts valid input', async () => {
    const response = await request(server)
      .post('/graphql')
      .send({ query: '{ fixtureInput(input: {name: "valid"}) }' })
      .expect(200);
    expect(response.body).toEqual({ data: { fixtureInput: 'valid' } });
  });
  it('sanitizes unexpected resolver errors and correlates them without changing GraphQL execution semantics', async () => {
    const response = await request(server)
      .post('/graphql')
      .send({ query: '{ fixtureFailure }' })
      .expect(200);
    const body = response.body as GraphqlBody;
    expect(body.data?.fixtureFailure).toBeNull();
    expect(body.errors?.[0]?.message).toBe('Internal server error');
    expect(body.errors?.[0]?.extensions).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      requestId: response.headers['x-request-id'],
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private|secret|postgresql|stacktrace|SELECT/,
    );
    expect(body).not.toHaveProperty('statusCode');
  });
  it('preserves deliberate public application codes while masking messages', async () => {
    const response = await request(server)
      .post('/graphql')
      .send({ query: '{ fixturePublicCode }' })
      .expect(200);
    expect((response.body as GraphqlBody).errors?.[0]?.extensions.code).toBe(
      'APP_INVALID_INPUT',
    );
    expect(JSON.stringify(response.body)).not.toContain('private');
  });
  it.each(['{ health { unknown } }', '{ invalid syntax'])(
    'sanitizes invalid GraphQL documents',
    async (query) => {
      const response = await request(server)
        .post('/graphql')
        .send({ query })
        .expect(400);
      expect(
        (response.body as GraphqlBody).errors?.[0]?.extensions.requestId,
      ).toBe(response.headers['x-request-id']);
      expect(JSON.stringify(response.body)).not.toMatch(
        /stacktrace|Did you mean/,
      );
    },
  );
  it('does not echo sensitive variable values in GraphQL coercion errors', async () => {
    const response = await request(server)
      .post('/graphql')
      .send({
        query:
          'query($input: VerificationInput!) { fixtureInput(input: $input) }',
        variables: { input: { name: { secret: 'private-secret' } } },
      })
      .expect(400);
    expect(JSON.stringify(response.body)).not.toContain('private-secret');
  });
  it('rejects HTTP query batching', async () => {
    const response = await request(server)
      .post('/graphql')
      .send([{ query: '{ health { status } }' }])
      .expect(400);
    expect((response.body as GraphqlBody).errors).toBeDefined();
  });
  it('enforces the field ceiling on an otherwise valid aliased operation', async () => {
    const fields = Array.from(
      { length: 251 },
      (_, i) => 'h' + String(i) + ': health { status }',
    ).join(' ');
    const response = await request(server)
      .post('/graphql')
      .send({ query: '{ ' + fields + ' }' })
      .expect(400);
    expect((response.body as GraphqlBody).errors).toBeDefined();
    expect((response.body as GraphqlBody).data).toBeUndefined();
  });
  it('retains Apollo CSRF prevention for simple content types', async () => {
    await request(server)
      .post('/graphql')
      .set('content-type', 'text/plain')
      .send('{"query":"{ health { status } }"}')
      .expect(400);
  });
  it('logs correlated metadata for both transports without bodies or query strings', async () => {
    const log = jest.spyOn(Logger.prototype, 'log');
    const errors = jest.spyOn(Logger.prototype, 'error');
    try {
      const response = await request(server)
        .post('/graphql?token=private-query-value')
        .send({
          query: '{ fixtureFailure }',
          variables: { secret: 'private-body-value' },
        })
        .expect(200);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'http_request',
          path: '/graphql',
          requestId: response.headers['x-request-id'],
        }),
      );
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'graphql_error',
          code: 'INTERNAL_SERVER_ERROR',
          requestId: response.headers['x-request-id'],
        }),
      );
      const rest = await request(server)
        .get('/api/v1/health?token=private-query-value')
        .expect(200);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'http_request',
          path: '/api/v1/health',
          requestId: rest.headers['x-request-id'],
        }),
      );
      expect(JSON.stringify([log.mock.calls, errors.mock.calls])).not.toMatch(
        /private-query-value|private-body-value|secret-password|SELECT secret/,
      );
    } finally {
      log.mockRestore();
      errors.mockRestore();
    }
  });
  it('enforces the request body size ceiling', async () => {
    await request(server)
      .post('/graphql')
      .send({
        query: '{ health { status } }',
        variables: { oversized: 'x'.repeat(110000) },
      })
      .expect(413);
  });
  it('allows development introspection and current GraphiQL tooling', async () => {
    const response = await request(server)
      .post('/graphql')
      .send({ query: getIntrospectionQuery() })
      .expect(200);
    expect((response.body as GraphqlBody).data?.__schema).toBeDefined();
    await request(server)
      .get('/graphql')
      .set('accept', 'text/html')
      .expect(200)
      .expect(/graphiql/i);
  });
});

describe('production GraphQL policy (offline)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp('production');
  });
  afterAll(async () => {
    await app?.close();
  });
  it('serves queries while disabling introspection', async () => {
    const server = app.getHttpServer() as Server;
    await request(server)
      .post('/graphql')
      .send({ query: '{ health { status } }' })
      .expect(200, { data: { health: { status: 'ok' } } });
    const response = await request(server)
      .post('/graphql')
      .send({ query: '{ __schema { queryType { name } } }' })
      .expect(400);
    expect((response.body as GraphqlBody).errors?.[0]?.extensions.code).toBe(
      'GRAPHQL_VALIDATION_FAILED',
    );
  });
  it('does not serve an interactive IDE', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/graphql')
      .set('accept', 'text/html')
      .expect(400);
    expect(response.text).not.toMatch(/graphiql|<!doctype html/i);
  });
});
