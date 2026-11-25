import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
        max: 5,
        connectionTimeoutMillis: 2000,
        idleTimeoutMillis: 30000,
        statement_timeout: 2000,
        query_timeout: 3000,
      }),
      // Never forward Prisma errors or query parameters to application logs.
      log: [],
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch {
      // Keep liveness available during outages; readiness performs a real query
      // on every request and can recover when PostgreSQL becomes reachable.
      this.logger.warn({ event: 'database_initial_connection_unavailable' });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
