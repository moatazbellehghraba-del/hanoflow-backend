import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { HealthResolver } from './health.resolver.js';
import { RedisModule } from '../../infrastructure/redis/redis.module.js';
@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [HealthController],
  providers: [HealthService, HealthResolver],
})
export class HealthModule {}
