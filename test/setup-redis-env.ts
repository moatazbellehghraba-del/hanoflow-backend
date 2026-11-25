import { config } from 'dotenv';
import { getRedisTestTarget } from './helpers/redis-target.js';
config({ path: '.env.redis-test', quiet: true });
const target = getRedisTestTarget(process.env);
process.env.NODE_ENV = 'test';
// Redis suite substitutes PostgreSQL only; actual DB coverage remains test:db.
process.env.DATABASE_URL =
  'postgresql://unit:unit@127.0.0.1:1/hanoflow_redis_only';
process.env.REDIS_URL = target.url;
process.env.QUEUE_PREFIX = 'hanoflow-test-bootstrap';
