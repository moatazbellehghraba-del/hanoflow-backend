import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DatabaseModule } from './database.module.js';
import { PrismaService } from './prisma.service.js';
import {
  DatabaseSecurityConfigurationError,
  isDatabaseUnavailable,
} from './runtime-identity.js';

describe('database infrastructure (offline)', () => {
  it('recognizes PrismaPg database unavailability without classifying bad privileges as an outage', () => {
    expect(
      isDatabaseUnavailable({
        code: 'P2010',
        meta: {
          driverAdapterError: { cause: { kind: 'DatabaseNotReachable' } },
        },
      }),
    ).toBe(true);
    expect(isDatabaseUnavailable({ code: '42501' })).toBe(false);
  });
  const config = new ConfigService({
    DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:1/unit',
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('initializes and disconnects the client through Nest lifecycle hooks', async () => {
    const service = new PrismaService(config);
    const connect = jest.spyOn(service, '$connect').mockResolvedValue();
    const identity = jest.spyOn(service, 'verifyIdentity').mockResolvedValue();
    const disconnect = jest.spyOn(service, '$disconnect').mockResolvedValue();
    await service.onModuleInit();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(identity).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps startup available and logs no private details on connection failure', async () => {
    const service = new PrismaService(config);
    jest
      .spyOn(service, '$connect')
      .mockRejectedValue(
        Object.assign(new Error('private-password'), { code: 'ECONNREFUSED' }),
      );
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({
      event: 'database_initial_connection_unavailable',
    });
  });

  it('exports one shared PrismaService instance for dependent modules', async () => {
    const module = await Test.createTestingModule({ imports: [DatabaseModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      .compile();
    // Prisma returns a proxy; assert its API and DI identity rather than instanceof.
    expect(typeof module.get(PrismaService).$queryRaw).toBe('function');
    expect(module.get(PrismaService)).toBe(module.get(PrismaService));
    // No connection is opened by compile(); close still exercises safe cleanup.
    await module.close();
  });

  it('fails startup closed when a reachable connection has unsafe authority', async () => {
    const service = new PrismaService(config);
    jest.spyOn(service, '$connect').mockResolvedValue();
    jest
      .spyOn(service, 'verifyIdentity')
      .mockRejectedValue(new DatabaseSecurityConfigurationError());
    await expect(service.onModuleInit()).rejects.toBeInstanceOf(
      DatabaseSecurityConfigurationError,
    );
    await service.$disconnect();
  });
});
