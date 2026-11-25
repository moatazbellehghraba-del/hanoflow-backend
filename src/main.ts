import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setupApplication } from './config/setup-application.js';

const logger = new ConsoleLogger({ json: true });
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger });
  setupApplication(app);
  const config = app.get(ConfigService);
  await app.listen(config.getOrThrow<number>('PORT'));
}
bootstrap().catch(() => {
  logger.error(
    'Application startup failed. Check environment configuration and runtime diagnostics.',
  );
  process.exitCode = 1;
});
