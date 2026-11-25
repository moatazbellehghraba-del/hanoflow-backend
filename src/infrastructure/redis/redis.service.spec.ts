import 'reflect-metadata';
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { RedisModule } from './redis.module.js';
import { RedisService } from './redis.service.js';
import { redisProbeOptions, REDIS_PROBE_CLIENT } from './redis.config.js';

describe('Redis readiness client (offline)', () => {
  let client: Redis;
  let service: RedisService;
  let warn = jest.fn<Logger['warn']>();
  let log = jest.fn<Logger['log']>();
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    client = new Redis(redisProbeOptions('redis://127.0.0.1:1/0'));
    service = new RedisService(client);
    warn = jest.fn<Logger['warn']>();
    log = jest.fn<Logger['log']>();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(warn);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(log);
  });
  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('connects through the initialization hook and clears its deadline', async () => {
    const connect = jest.spyOn(client, 'connect').mockResolvedValue();
    await service.onModuleInit();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds startup even when the connection handshake never settles', async () => {
    jest
      .spyOn(client, 'connect')
      .mockImplementation(() => new Promise(() => undefined));
    const startup = service.onModuleInit();
    await jest.advanceTimersByTimeAsync(2000);
    await expect(startup).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({
      event: 'redis_connection_unavailable',
    });
  });

  it('handles connection rejection and error events without logging secrets', async () => {
    jest
      .spyOn(client, 'connect')
      .mockRejectedValue(new Error('redis://private:secret@internal/0'));
    await service.onModuleInit();
    client.emit('error', new Error('private credentials'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({
      event: 'redis_connection_unavailable',
    });
  });

  it('fails promptly while disconnected without issuing or buffering PING', async () => {
    const ping = jest.spyOn(client, 'ping');
    await expect(service.checkReadiness()).rejects.toThrow('Redis unavailable');
    expect(ping).not.toHaveBeenCalled();
  });

  it('probes a ready connection and recovers after an error', async () => {
    client.status = 'ready';
    const ping = jest
      .spyOn(client, 'ping')
      .mockRejectedValueOnce(new Error('secret'))
      .mockResolvedValue('PONG');
    await expect(service.checkReadiness()).rejects.toThrow('Redis unavailable');
    await expect(service.checkReadiness()).resolves.toBeUndefined();
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled PING and clears its timer', async () => {
    client.status = 'ready';
    jest
      .spyOn(client, 'ping')
      .mockImplementation(() => new Promise(() => undefined));
    const check = expect(service.checkReadiness()).rejects.toThrow(
      'Redis unavailable',
    );
    await jest.advanceTimersByTimeAsync(1000);
    await check;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects an unexpected PING response', async () => {
    client.status = 'ready';
    jest.spyOn(client, 'ping').mockResolvedValue('unexpected');
    await expect(service.checkReadiness()).rejects.toThrow('Redis unavailable');
  });

  it('logs only state transitions when reconnecting', () => {
    client.emit('close');
    client.emit('error', new Error('private'));
    client.emit('ready');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({
      event: 'redis_connection_recovered',
    });
  });

  it('disconnects during shutdown even when Redis is unavailable', () => {
    const disconnect = jest.spyOn(client, 'disconnect');
    service.onModuleDestroy();
    expect(disconnect).toHaveBeenCalledWith();
  });

  it('exports a singleton and cleans up through Nest lifecycle hooks', async () => {
    jest.useRealTimers();
    const module = await Test.createTestingModule({ imports: [RedisModule] })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ REDIS_URL: 'redis://127.0.0.1:1/0' }))
      .overrideProvider(REDIS_PROBE_CLIENT)
      .useValue(client)
      .compile();
    jest.spyOn(client, 'connect').mockResolvedValue();
    const disconnect = jest.spyOn(client, 'disconnect');
    await module.init();
    expect(module.get(RedisService)).toBe(module.get(RedisService));
    await module.close();
    expect(disconnect).toHaveBeenCalled();
  });
});
