import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.service.js';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  getLiveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async getReadiness(): Promise<{ status: 'ok'; database: 'up'; redis: 'up' }> {
    try {
      await Promise.all([
        this.prisma.$queryRaw`SELECT 1`,
        this.redis.checkReadiness(),
      ]);
      return { status: 'ok', database: 'up', redis: 'up' };
    } catch {
      throw new ServiceUnavailableException('Service unavailable');
    }
  }
}
