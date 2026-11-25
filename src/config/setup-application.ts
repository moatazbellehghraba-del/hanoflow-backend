import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { requestMetadata } from '../common/http/request-metadata.js';

export function setupApplication(app: INestApplication): void {
  app.use(requestMetadata);
  const adapter = app.getHttpAdapter();
  if (adapter instanceof ExpressAdapter) {
    adapter.useBodyParser('json', false, { limit: '100kb' });
    adapter.useBodyParser('urlencoded', false, {
      limit: '100kb',
      extended: true,
    });
  }
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validationError: { target: false, value: false },
    }),
  );
  app.enableShutdownHooks();
}
