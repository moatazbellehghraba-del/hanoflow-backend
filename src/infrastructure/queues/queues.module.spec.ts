import 'reflect-metadata';
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Redis } from 'ioredis';
import { QueuesModule } from './queues.module.js';
import { QueueRuntime } from './queue-runtime.service.js';
import { InfrastructureQueueModule } from '../../../test/fixtures/infrastructure-queue.module.js';
import {
  INFRASTRUCTURE_QUEUE,
  InfrastructureProcessor,
} from '../../../test/fixtures/infrastructure.processor.js';

describe('queue module registration (offline)', () => {
  const config = new ConfigService({
    REDIS_URL: 'redis://127.0.0.1:1/0',
    QUEUE_PREFIX: 'hanoflow-unit',
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts and closes the production root module without opening connections', async () => {
    const connect = jest.spyOn(Redis.prototype, 'connect');
    const module = await Test.createTestingModule({ imports: [QueuesModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      .compile();
    await module.init();
    expect(connect).not.toHaveBeenCalled();
    await module.close();
  });

  it('registers test-only producers and processors through explicit Nest providers', async () => {
    const client = new Redis({ lazyConnect: true });
    const queue = { name: INFRASTRUCTURE_QUEUE };
    const runtime = {
      createProducerConnection: jest.fn<() => Redis>().mockReturnValue(client),
      registerQueue: jest.fn(),
      registerWorker: jest.fn().mockReturnValue({}),
      close: jest.fn<() => Promise<void>>().mockResolvedValue(),
    };
    try {
      const module = await Test.createTestingModule({
        imports: [InfrastructureQueueModule],
      })
        .overrideProvider(ConfigService)
        .useValue(config)
        .overrideProvider(QueueRuntime)
        .useValue(runtime)
        .overrideProvider(getQueueToken(INFRASTRUCTURE_QUEUE))
        .useValue(queue)
        .compile();
      await module.init();
      expect(module.get(getQueueToken(INFRASTRUCTURE_QUEUE))).toBe(queue);
      expect(runtime.createProducerConnection).toHaveBeenCalledWith(
        INFRASTRUCTURE_QUEUE,
      );
      expect(runtime.registerQueue).toHaveBeenCalledWith(queue);
      expect(runtime.registerWorker.mock.calls[0]?.[0]).toBe(
        INFRASTRUCTURE_QUEUE,
      );
      expect(runtime.registerWorker.mock.calls[0]?.[1]).toBeInstanceOf(
        InfrastructureProcessor,
      );
      await module.close();
      expect(runtime.close).toHaveBeenCalled();
    } finally {
      client.disconnect();
    }
  });

  it('rejects invalid names before creating registration metadata', () => {
    expect(() => QueuesModule.registerQueue('invalid:name')).toThrow(
      'Invalid queue name',
    );
  });

  it('drains through the root queue module before deeper persistence teardown', async () => {
    const order: string[] = [];
    @Module({
      providers: [
        {
          provide: 'TEST_PERSISTENCE',
          useValue: {
            onModuleDestroy: () => {
              order.push('persistence');
            },
          },
        },
      ],
    })
    class PersistenceFixtureModule {}
    @Module({ imports: [PersistenceFixtureModule] })
    class FeatureFixtureModule {}
    const module = await Test.createTestingModule({
      imports: [FeatureFixtureModule, QueuesModule],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(QueueRuntime)
      .useValue({
        close: () => {
          order.push('queues');
          return Promise.resolve();
        },
      })
      .compile();
    await module.init();
    await module.close();
    expect(order.indexOf('queues')).toBeLessThan(order.indexOf('persistence'));
  });
});
