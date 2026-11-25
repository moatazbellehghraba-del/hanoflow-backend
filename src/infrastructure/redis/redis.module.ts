import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { REDIS_PROBE_CLIENT, redisProbeOptions } from './redis.config.js';
import { RedisService } from './redis.service.js';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_PROBE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(redisProbeOptions(config.getOrThrow<string>('REDIS_URL'))),
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
