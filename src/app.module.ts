import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { validateEnvironment } from './config/environment.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { HealthModule } from './modules/health/health.module.js';
import { ApiGraphqlModule } from './infrastructure/graphql/api-graphql.module.js';
import { QueuesModule } from './infrastructure/queues/queues.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { SessionsModule } from './modules/sessions/sessions.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    HealthModule,
    QueuesModule,
    ApiGraphqlModule,
    IdentityModule,
    SessionsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class AppModule {}
