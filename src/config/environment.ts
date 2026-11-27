import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  Matches,
  validateSync,
} from 'class-validator';
import { parseRedisUrl } from '../infrastructure/redis/redis.config.js';

enum Environment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}
export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;
  @IsString()
  @MinLength(1)
  APP_NAME = 'HanoFlow';
  @IsUrl({
    protocols: ['postgresql', 'postgres'],
    require_protocol: true,
    require_tld: false,
  })
  DATABASE_URL = '';
  @IsString()
  @MinLength(1)
  REDIS_URL = '';
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{0,63}$/)
  QUEUE_PREFIX = '';
}
export function validateEnvironment(
  input: Record<string, unknown>,
): EnvironmentVariables {
  if (
    [
      'DATABASE_MIGRATION_URL',
      'TEST_DATABASE_MIGRATION_URL',
      'TEST_DATABASE_FIXTURE_URL',
      'POSTGRES_PASSWORD',
    ].some((key) => input[key] !== undefined)
  )
    throw new Error(
      'Privileged database credentials must not be loaded by runtime',
    );
  const config = plainToInstance(EnvironmentVariables, {
    NODE_ENV: input.NODE_ENV ?? 'development',
    PORT: input.PORT === undefined ? 3000 : Number(input.PORT),
    APP_NAME: input.APP_NAME ?? 'HanoFlow',
    DATABASE_URL: input.DATABASE_URL,
    REDIS_URL: input.REDIS_URL,
    QUEUE_PREFIX: input.QUEUE_PREFIX,
  });
  const errors = validateSync(config);
  if (errors.length) {
    throw new Error(
      'Invalid environment configuration: ' +
        errors.map((error) => error.property).join(', '),
    );
  }
  parseRedisUrl(config.REDIS_URL);
  return config;
}
