import { HttpException } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import type { GraphQLFormattedError } from 'graphql';

const codes: Record<number, string> = {
  400: 'BAD_USER_INPUT',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  503: 'SERVICE_UNAVAILABLE',
};
const messages: Record<string, string> = {
  BAD_USER_INPUT: 'Invalid input',
  UNAUTHENTICATED: 'Unauthenticated',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  SERVICE_UNAVAILABLE: 'Service unavailable',
  INTERNAL_SERVER_ERROR: 'Internal server error',
  GRAPHQL_PARSE_FAILED: 'Invalid GraphQL document',
  GRAPHQL_VALIDATION_FAILED: 'Invalid GraphQL request',
  BAD_REQUEST: 'Invalid request',
  OPERATION_RESOLUTION_FAILURE: 'Invalid operation',
  QUERY_LIMIT_EXCEEDED: 'Query exceeds supported limits',
};

export function toGraphqlError(
  exception: unknown,
  requestId: string,
): GraphQLError {
  const status =
    exception instanceof HttpException ? exception.getStatus() : 500;
  let code = codes[status] ?? 'INTERNAL_SERVER_ERROR';
  // A deliberate public application code on a client error is preserved; raw
  // exception messages, validation values and arbitrary extensions are not.
  if (exception instanceof HttpException && status >= 400 && status < 500) {
    const body = exception.getResponse();
    if (
      typeof body === 'object' &&
      'code' in body &&
      typeof body.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(body.code)
    )
      code = body.code;
  }
  return new GraphQLError(messages[code] ?? 'Request failed', {
    extensions: { code, requestId },
  });
}

export function formatGraphqlError(
  error: GraphQLFormattedError,
): GraphQLFormattedError {
  const rawCode = error.extensions?.code;
  const code =
    typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
      ? rawCode
      : 'INTERNAL_SERVER_ERROR';
  const requestId = error.extensions?.requestId;
  return {
    message: messages[code] ?? 'Request failed',
    ...(error.locations ? { locations: error.locations } : {}),
    ...(error.path ? { path: error.path } : {}),
    extensions: {
      code,
      ...(typeof requestId === 'string' ? { requestId } : {}),
    },
  };
}
