import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { GqlArgumentsHost } from '@nestjs/graphql';
import type { GqlContextType } from '@nestjs/graphql';
import { toGraphqlError } from '../../infrastructure/graphql/graphql-errors.js';
import type { ApiGraphqlContext } from '../../infrastructure/graphql/graphql-context.js';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);
  catch(exception: unknown, host: ArgumentsHost): unknown {
    if (host.getType<GqlContextType>() === 'graphql') {
      const context =
        GqlArgumentsHost.create(host).getContext<ApiGraphqlContext>();
      const error = toGraphqlError(exception, context.requestId);
      if (
        !(exception instanceof HttpException) ||
        exception.getStatus() >= 500
      ) {
        this.logger.error({
          event: 'graphql_error',
          code: error.extensions.code,
          requestId: context.requestId,
        });
      }
      return error;
    }
    if (host.getType() !== 'http') throw exception;
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const requestPath = request.originalUrl.split('?')[0] ?? request.path;
    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] =
      statusCode === 503 ? 'Service unavailable' : 'Internal server error';
    if (exception instanceof HttpException && statusCode < 500) {
      const body = exception.getResponse();
      message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ??
            exception.message);
    }
    if (statusCode === 404) message = 'Not found';
    if (statusCode >= 500) {
      this.logger.error({
        event: 'http_error',
        statusCode,
        method: request.method,
        path: requestPath,
        requestId: request.requestId,
      });
    }
    response.status(statusCode).json({
      statusCode,
      message,
      path: requestPath,
      timestamp: new Date().toISOString(),
    });
  }
}
