import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  REDIS_PROBE_CLIENT,
  REDIS_CONNECT_TIMEOUT_MS,
  REDIS_READINESS_TIMEOUT_MS,
} from './redis.config.js';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private unavailable = false;
  private closing = false;

  constructor(@Inject(REDIS_PROBE_CLIENT) private readonly client: Redis) {
    // Never forward driver errors or credential-bearing connection options.
    this.client.on('error', () => this.markUnavailable());
    this.client.on('close', () => this.markUnavailable());
    this.client.on('ready', () => {
      if (this.closing) return;
      if (this.unavailable)
        this.logger.log({ event: 'redis_connection_recovered' });
      this.unavailable = false;
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      // The outer deadline also bounds DNS, TLS and the readiness handshake.
      // Its settlement does not cancel the client's background reconnection.
      await this.bounded(this.client.connect(), REDIS_CONNECT_TIMEOUT_MS);
    } catch {
      this.markUnavailable();
    }
  }

  async checkReadiness(): Promise<void> {
    try {
      if (this.client.status !== 'ready') throw new Error('Redis unavailable');
      const result = await this.bounded(
        this.client.ping(),
        REDIS_READINESS_TIMEOUT_MS,
      );
      if (result !== 'PONG') throw new Error('Redis unavailable');
    } catch {
      throw new Error('Redis unavailable');
    }
  }

  onModuleDestroy(): void {
    // This probe has no writes to drain. Immediate disconnect cancels reconnect
    // timers and pending commands even while Redis is unreachable.
    this.closing = true;
    this.client.disconnect();
  }

  private markUnavailable(): void {
    if (this.closing) return;
    if (!this.unavailable)
      this.logger.warn({ event: 'redis_connection_unavailable' });
    this.unavailable = true;
  }

  private async bounded<T>(operation: Promise<T>, timeout: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Redis unavailable')),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
