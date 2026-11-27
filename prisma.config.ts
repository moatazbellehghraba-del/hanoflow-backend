import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// CLI loads only migration credentials; runtime/Compose configuration is separate.
config({
  path: process.env.HANOFLOW_MIGRATION_ENV ?? '.env.migrations',
  quiet: true,
});

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Generation and validation do not require a running database or credentials.
  // Database commands require DATABASE_URL from the environment or .env.
  datasource: { url: process.env.DATABASE_MIGRATION_URL ?? '' },
});
