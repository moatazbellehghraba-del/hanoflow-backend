import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Generation and validation do not require a running database or credentials.
  // Database commands require DATABASE_URL from the environment or .env.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
