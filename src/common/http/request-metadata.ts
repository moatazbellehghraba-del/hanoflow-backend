import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

const logger = new Logger('HttpRequest');

export function requestMetadata(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Correlation is server-assigned metadata, never authentication or tenant identity.
  req.requestId = randomUUID();
  res.setHeader('x-request-id', req.requestId);
  const started = performance.now();
  res.once('finish', () => {
    logger.log({
      event: 'http_request',
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      statusCode: res.statusCode,
      durationMs: Math.round(performance.now() - started),
    });
  });
  next();
}
