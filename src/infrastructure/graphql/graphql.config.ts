import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import type { ApolloServerPlugin } from '@apollo/server';
import { createGraphqlContext } from './graphql-context.js';
import type { ApiGraphqlContext } from './graphql-context.js';
import { formatGraphqlError } from './graphql-errors.js';
import { queryLimits } from './query-limits.js';

const correlationPlugin: ApolloServerPlugin<ApiGraphqlContext> = {
  requestDidStart: () =>
    Promise.resolve({
      didEncounterErrors: ({ errors, contextValue }) => {
        for (const error of errors)
          error.extensions.requestId = contextValue.requestId;
        return Promise.resolve();
      },
    }),
};

export function createGraphqlOptions(
  config: ConfigService,
): Omit<ApolloDriverConfig, 'driver'> {
  const development = config.getOrThrow<string>('NODE_ENV') === 'development';
  const logger = new Logger('GraphQLServer');
  return {
    path: '/graphql',
    useGlobalPrefix: false,
    autoSchemaFile: true,
    sortSchema: true,
    graphiql: development,
    introspection: development,
    includeStacktraceInErrorResponses: false,
    autoTransformHttpErrors: false,
    preserveHttpStatusForExecutionErrors: true,
    allowBatchedHttpRequests: false,
    csrfPrevention: true,
    persistedQueries: false,
    parseOptions: { maxTokens: 2000 },
    validationRules: [queryLimits],
    context: createGraphqlContext,
    formatError: formatGraphqlError,
    plugins: [correlationPlugin],
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => logger.warn({ event: 'graphql_server_warning' }),
      error: () => logger.error({ event: 'graphql_server_error' }),
    },
  };
}
